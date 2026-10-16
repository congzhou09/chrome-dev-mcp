import { z } from 'zod';
import { NAVIGATION_TIMEOUT_MS, NOT_CONNECTED, PAGE_COMMAND_TIMEOUT_MS } from '../constants.js';
import { TIMED_OUT, withTimeout } from '../timeout.js';
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
const outcomeSchema = z.object({
    outcome: z
        .enum(['loaded', 'paused', 'same-document', 'still-loading', 'download'])
        .describe('"loaded": the load event fired. "paused": execution paused before it did — see callStack. ' +
        '"same-document": only the #hash changed, so there is no load to wait for. ' +
        '"still-loading": the page committed but its load event did not fire in time. ' +
        '"download": the URL was handed to the download manager and the page did not change.'),
    url: z.string().optional(),
    title: z.string().optional(),
    reason: z.string().optional().describe('Pause reason. Present only when paused.'),
    callStack: z.array(z.unknown()).optional().describe('Same shape as get_debugger_state. Present only when paused.'),
});
// ── Navigation tools ──────────────────────────────────────────────────────────
//
// Two tools over one wait. What either is worth over `location.href = …` / `location.reload()`
// in evaluate_js is not issuing the command — CDP does that in one call — but what happens
// after it: those return before the new document even exists, so the caller can neither tell
// when the page is ready nor learn that a breakpoint stopped it during startup, which is the
// most common reason to reload while debugging.
//
// Both work on a paused page with no special handling. Measured, Chrome 154: Page.reload and
// Page.navigate issued while paused at a breakpoint both completed in ~10ms, and breakpoints
// set by URL hit again in the new document. The old pause is discarded without a
// Debugger.resumed — the session clears it on frameNavigated (see inspector-session.ts).
export function registerNavigationTools(server, getClient, session) {
    // Issues `start` and waits for the first of: the new document's load event, a pause, or
    // the bound. Every listener goes on BEFORE the command, because on a fast page the load
    // event can arrive before the command's own answer does.
    const navigateAndSettle = async (client, what, start) => {
        // Attached here, not left lazy, because a pause is one of the two answers this waits for
        // and only an enabled Debugger domain hears it — including a pause on a breakpoint that
        // DevTools or another client set. Without it, a page stopped during startup would look
        // exactly like one that is slow to load.
        await session.attach(client);
        const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
        let committedUrl;
        const emitter = client;
        let dispose = () => { };
        const settled = new Promise((resolve) => {
            const onLoad = () => resolve('loaded');
            const onPaused = () => resolve('paused');
            const onNavigated = (event) => {
                if (event?.frame && !event.frame.parentId)
                    committedUrl = event.frame.url;
            };
            emitter.on('Page.loadEventFired', onLoad);
            emitter.on('Debugger.paused', onPaused);
            emitter.on('Page.frameNavigated', onNavigated);
            dispose = () => {
                emitter.removeListener('Page.loadEventFired', onLoad);
                emitter.removeListener('Debugger.paused', onPaused);
                emitter.removeListener('Page.frameNavigated', onNavigated);
            };
        });
        try {
            // Bounded by the same deadline as the wait: Page.navigate answers only once the new
            // document commits, and a renderer held in a synchronous loop does not let it commit
            // until the loop ends. Measured, Chrome 154: a 6s loop held Page.navigate's answer for
            // 6020ms. Page.reload answers at once in that state, but the reload itself waits just
            // the same — which is what `committedUrl` tells apart from a page merely slow to load.
            const response = await withTimeout(start().catch((e) => ({ rejected: e.message })), NAVIGATION_TIMEOUT_MS);
            if (response === TIMED_OUT)
                return notCommitted(what);
            if ('rejected' in response)
                return toolError(`Error: ${what} failed: ${response.rejected}`);
            // Chrome then shows its own error page, which does fire a load event — waiting for it
            // would report a failed navigation as "loaded".
            if (response.errorText)
                return toolError(`Error: ${what} failed: ${response.errorText}`);
            if (response.isDownload)
                return result({ outcome: 'download' });
            if (response.sameDocument)
                return result({ outcome: 'same-document', ...(await readPage(client)) });
            const waited = await withTimeout(settled, Math.max(0, deadline - Date.now()));
            if (waited === 'paused') {
                return result({
                    outcome: 'paused',
                    reason: session.state.pauseReason,
                    callStack: await session.formatCallStack(),
                });
            }
            if (waited === TIMED_OUT) {
                if (committedUrl === undefined)
                    return notCommitted(what);
                return result({ outcome: 'still-loading', url: committedUrl });
            }
            return result({ outcome: 'loaded', ...(await readPage(client)) });
        }
        finally {
            dispose();
        }
    };
    // Best-effort: the navigation has already succeeded, so a page that does not answer here
    // costs the caller a title, not the result.
    const readPage = async (client) => {
        const read = await withTimeout(client.Runtime.evaluate({ expression: '({ url: location.href, title: document.title })', returnByValue: true }), PAGE_COMMAND_TIMEOUT_MS).catch(() => TIMED_OUT);
        if (read === TIMED_OUT)
            return {};
        return read.result?.value ?? {};
    };
    const result = (data) => ({
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
    });
    const notCommitted = (what) => toolError(`Error: ${what} did not commit within ${NAVIGATION_TIMEOUT_MS}ms. The old page is still in place — its ` +
        'renderer may be blocked in a synchronous loop, which holds a navigation back until the loop ends.');
    server.registerTool('navigate', {
        description: "Navigate the connected tab to a URL and wait for the new page's load event — or for execution to pause " +
            'first, e.g. on a breakpoint the new page hits during startup, in which case the call stack is returned. ' +
            'Breakpoints set by URL carry over to the new page. Works while paused: the pause ends with the old page.',
        inputSchema: z.object({
            url: z.string().describe('Absolute URL, including the scheme.'),
        }),
        outputSchema: outcomeSchema,
        annotations: {
            title: 'Navigate',
            destructiveHint: true,
            openWorldHint: true,
        },
    }, async ({ url }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        return navigateAndSettle(client, 'navigate', async () => {
            // `isDownload` is in the protocol but not yet in chrome-remote-interface's typings.
            const { loaderId, errorText, isDownload } = (await client.Page.navigate({ url }));
            // No loaderId means no new document: a #hash change, which fires no load event at all.
            // Measured, Chrome 154: only Page.navigatedWithinDocument followed.
            return { sameDocument: !loaderId, errorText, isDownload };
        });
    });
    server.registerTool('reload', {
        description: "Reload the connected tab and wait for the new page's load event — or for execution to pause first, e.g. on " +
            'a breakpoint hit during startup, in which case the call stack is returned. Breakpoints set by URL carry over ' +
            'to the reloaded page. Works while paused: the pause ends with the old page.',
        inputSchema: z.object({
            ignoreCache: z.boolean().default(false).describe('Bypass the HTTP cache, as Shift+F5 does.'),
        }),
        outputSchema: outcomeSchema,
        annotations: {
            title: 'Reload',
            destructiveHint: true,
        },
    }, async ({ ignoreCache }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        return navigateAndSettle(client, 'reload', async () => {
            await client.Page.reload({ ignoreCache });
            return {};
        });
    });
}

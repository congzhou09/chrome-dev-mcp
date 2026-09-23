import { z } from 'zod';
import { BRING_TO_FRONT_TIMEOUT_MS, EVAL_EXECUTION_TIMEOUT_MS, EVAL_SETTLE_TIMEOUT_MS, FRAME_WAIT_TIMEOUT_MS, LAYOUT_METRICS_TIMEOUT_MS, MAX_HTML_LENGTH, NOT_CONNECTED, PAGE_COMMAND_TIMEOUT_MS, SCREENSHOT_TIMEOUT_MS, rendererTimedOut, } from '../constants.js';
import { releaseRemoteObject, renderValueFirst } from '../remote-object.js';
import { TIMED_OUT, withTimeout } from '../timeout.js';
// Chrome reports a `timeout` kill as a REJECTED command rather than through
// `exceptionDetails`, so it bypasses the normal error path entirely. The code it rejects
// with also degrades once replMode is on — measured, Chrome 141, reproducible over repeats:
//
//   replMode: false  ->  -32000  "Execution was terminated"
//   replMode: true   ->  -32603  "Internal error"
//
// Neither message is worth putting in front of a caller, and the second one says nothing at
// all, so both are recognised here and answered with our own text.
//
// -32603 is JSON-RPC's generic "Internal error" though, not a fingerprint for termination:
// every other internal failure in the protocol can carry it too. Claiming a timeout kill on
// the code alone would answer an unrelated fault with a confident, fully wrong sentence and
// swallow the real error, so it is only trusted once the kill we asked for is actually due.
// `elapsedMs` is measured from before the command is sent, while Chrome starts its own
// `timeout` clock only after receiving it, so a genuine kill always lands on the far side.
const isExecutionTerminated = (err, elapsedMs) => {
    const response = err?.response;
    if (response?.message === 'Execution was terminated')
        return true;
    return response?.code === -32603 && elapsedMs >= EVAL_EXECUTION_TIMEOUT_MS;
};
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
// Pixel dimensions straight out of a PNG's IHDR, which puts width at byte 16 and height at
// byte 20 — so the first 64 base64 characters decode to more than enough to reach them and
// the image itself is never decoded. Worth reading rather than calculating: Chrome rounds a
// scaled capture on its own, so this is the only way to report what actually arrived.
const pngSize = (base64) => {
    const head = Buffer.from(base64.slice(0, 64), 'base64');
    if (head.length < 24 || head.toString('ascii', 12, 16) !== 'IHDR')
        return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
};
// The visible area, in the DOCUMENT coordinates a CDP clip is expressed in.
//
// Measured against a page scrolled exactly one viewport down: a clip at `y: 0` captured the
// top of the document while `y: pageY` captured what was actually on screen. Leaving the
// origin(0,0) in would quietly return the wrong part of every scrolled page — a silent wrong
// answer, which is worse than any sizing mistake.
const viewportRect = (css) => ({
    x: css.pageX ?? 0,
    y: css.pageY ?? 0,
    width: css.clientWidth ?? 0,
    height: css.clientHeight ?? 0,
});
// A caller's region, moved into document coordinates and cut down to what is on screen.
// Null when the two do not overlap at all.
//
// The region arrives VIEWPORT-relative, which is the one choice that makes it free to use:
// it is the space `getBoundingClientRect()` reports in, so an element's box can be handed
// over untouched. Document coordinates would have read more naturally against CDP, at the
// price of making every caller remember to add the scroll offset — the same trap as above,
// just moved onto them, where this server could no longer see it being sprung.
const intersectViewport = (viewport, region) => {
    const left = Math.max(viewport.x, viewport.x + region.x);
    const top = Math.max(viewport.y, viewport.y + region.y);
    const right = Math.min(viewport.x + viewport.width, viewport.x + region.x + region.width);
    const bottom = Math.min(viewport.y + viewport.height, viewport.y + region.y + region.height);
    if (right <= left || bottom <= top)
        return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
};
// Solves the capture law for the `scale` that lands the delivered image's long edge on
// `maxEdge`:
//
//   delivered px = rect css px * devicePixelRatio * scale
//
// Measured, Chrome 153, a 1029x729 CSS viewport on a 1.25x display: a clip at scale 1 came
// back 1286x911, at 0.5 643x456, at 0.25 322x228. So `scale` multiplies ON TOP of the device
// scale factor rather than replacing it.
//
// That factor is also why the two arguments are in different units. `rect` is CSS pixels,
// which is what a clip and `getBoundingClientRect()` both speak; `maxEdge` counts pixels in
// the delivered PNG, because that is what the caller is actually rationing — an image costs
// its reader by real pixel area, and CSS pixels do not say how many of those there are.
// Measured: a 96x32 CSS box asked for `maxEdge: 48` came back 48x16 on a 1x tab and also 48x16 on
// a 2x one, the same picture for the same price. Without the conversion the 2x tab would
// have returned 96x32, twice the size that was requested.
//
// Never upscales: `maxEdge` is a ceiling, and pixels that do not exist cannot be handed over.
const scaleToFit = (rect, devicePixelRatio, maxEdge) => {
    if (maxEdge <= 0)
        return 1;
    const longEdge = Math.max(rect.width, rect.height) * devicePixelRatio;
    return longEdge > 0 ? Math.min(1, maxEdge / longEdge) : 1;
};
// The device scale factor the CAPTURE will use, which is not always the display's.
//
// `layoutViewport` is `cssLayoutViewport` in device pixels, so their ratio looks like the
// answer and is the answer right up until something has called
// `Emulation.setDeviceMetricsOverride` — DevTools' device toolbar, or any other CDP client
// sharing this tab. This server must assume that has already happened. Measured, Chrome 153,
// on a 1.25x display, comparing each candidate against the capture actually produced:
//
//   emulation(setDeviceMetricsOverride)         layoutViewport ratio   window.devicePixelRatio   capture used
//   none                                              1.251                    1.25                1.25
//   1920x1080 @1                                      1.251                    1.0                 1.0
//   1440x810  @2                                      1.251                    2.0                 2.0
//   390x844   @3                                      1.251                    3.0                 3.0
//   1280x800  @1.5                                    1.251                    1.5                 1.5
//
// The ratio is stuck on the host display's factor under emulation and mispredicts the
// capture by up to 3x — enough to hand back an image far over the budget this is enforcing,
// or a needlessly blurred one. So the page's own value is asked for first, and the ratio is
// kept only as the fallback for when evaluation is unavailable.
const captureScaleFactor = (metrics, reported) => {
    if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0)
        return reported;
    const cssWidth = metrics?.cssLayoutViewport?.clientWidth;
    const deviceWidth = metrics?.layoutViewport?.clientWidth;
    if (cssWidth && deviceWidth && deviceWidth > 0)
        return deviceWidth / cssWidth;
    // Assuming 1:1 under-states the output on a HiDPI display, so the capture comes back
    // larger than intended — the harmless direction to be wrong in, where over-stating it
    // would blur a screenshot that never needed shrinking.
    return 1;
};
// ── Page inspection tools ─────────────────────────────────────────────────────
//
// Every tool here is a bare Runtime.evaluate / Page.captureScreenshot, so this group
// needs nothing but getClient — no session state at all.
//
// Every one of them is also bounded. A CDP command sent to a renderer that is paused,
// looping, or sitting on a modal neither returns nor rejects (see timeout.ts), so "read the
// title" is just as capable of hanging forever as evaluating an arbitrary expression is —
// the difference is only in how surprising it looks when it happens.
export function registerPageTools(server, getClient) {
    server.registerTool('get_title', {
        description: 'Get the title of the currently connected tab (`document.title`).',
        inputSchema: z.object({}),
        annotations: {
            title: 'Get page title',
            readOnlyHint: true,
        },
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await withTimeout(client.Runtime.evaluate({ expression: 'document.title', returnByValue: true }), PAGE_COMMAND_TIMEOUT_MS);
        if (result === TIMED_OUT)
            return rendererTimedOut('get_title');
        return { content: [{ type: 'text', text: String(result.result.value) }] };
    });
    server.registerTool('get_url', {
        description: 'Get the URL of the currently connected tab (`location.href`).',
        inputSchema: z.object({}),
        annotations: {
            title: 'Get page URL',
            readOnlyHint: true,
        },
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await withTimeout(client.Runtime.evaluate({ expression: 'location.href', returnByValue: true }), PAGE_COMMAND_TIMEOUT_MS);
        if (result === TIMED_OUT)
            return rendererTimedOut('get_url');
        return { content: [{ type: 'text', text: String(result.result.value) }] };
    });
    server.registerTool('get_html', {
        description: 'Get the full HTML source of the currently connected tab (`document.documentElement.outerHTML`). ' +
            `Truncated to ${MAX_HTML_LENGTH} characters for large pages; a truncated result ends with a ` +
            '`…` marker giving how much was cut and the real length of the document, so a short result is never ' +
            'ambiguous between "small page" and "cut off here".',
        inputSchema: z.object({}),
        annotations: {
            title: 'Get page HTML',
            readOnlyHint: true,
        },
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await withTimeout(client.Runtime.evaluate({
            // Truncated in the page, not on arrival. Slicing here would mean serialising the
            // whole document AND putting all of it on the wire, only to keep the first 20k.
            // Measured, Chrome 141, a 500,000-node document — 25.5MB of outerHTML: 482ms to
            // serialise, 1127ms to transfer. Slicing at the source drops that second number
            // entirely, ~70% of the call, for a byte-identical result.
            //
            // The serialisation itself is not avoidable: `outerHTML` has to build the whole
            // string before anything can take a slice of it. `length` is read off that same
            // string, so reporting the real size costs one number rather than a second pass.
            expression: `
            (() => {
              const html = document.documentElement.outerHTML;
              return { html: html.slice(0, ${MAX_HTML_LENGTH}), totalLength: html.length };
            })()
          `,
            returnByValue: true,
        }), PAGE_COMMAND_TIMEOUT_MS);
        if (result === TIMED_OUT)
            return rendererTimedOut('get_html');
        const { html, totalLength } = result.result.value;
        // Marked rather than silently cut, and marked in the same `… (+N chars)` idiom formatUrl
        // uses. Without it a 20,000-character result is indistinguishable from a page that
        // happens to be exactly that size, and reading truncated markup as the whole document is
        // how "the element isn't in the DOM" gets concluded about an element that is.
        const text = totalLength > MAX_HTML_LENGTH
            ? `${html}
… (+${totalLength - MAX_HTML_LENGTH} chars truncated — document is ${totalLength} characters)`
            : html;
        return { content: [{ type: 'text', text }] };
    });
    server.registerTool('evaluate_js', {
        description: 'Evaluate a JavaScript expression in the page, in global scope, with the same semantics as the DevTools console. ' +
            'Returns the real value when it serialises; objects that cannot (DOM nodes, Errors, Maps, class instances) come back ' +
            'as a preview instead: class name plus a first level of properties, marked `…` where Chrome truncated it — readable, ' +
            'not parseable as the value. ' +
            'Top-level `await` works, but an expression that merely RETURNS a promise is NOT awaited — it comes back as a ' +
            'pending Promise, exactly as in the console. ' +
            'The call returns as soon as your expression finishes its synchronous work, before queued microtasks run, so the state ' +
            'triggered by a click is not visible in the same call: put `await Promise.resolve()` between the click and ' +
            'the read, or read in a second call. ' +
            'At a breakpoint this still evaluates globally and cannot see local or closure variables — use evaluate_at_frame for those. ' +
            'For the element selected in the Elements panel ($0), use get_inspected_element.',
        inputSchema: z.object({ expression: z.string() }),
        annotations: {
            title: 'Evaluate JS',
        },
    }, async ({ expression }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        // Evaluated exactly once, in preview mode. Asking for the value here instead would
        // silently flatten DOM nodes, Errors, Maps and class instances, and retrying after
        // its -32000 would re-run the expression — see remote-object.ts.
        //
        // `replMode` is what the DevTools console itself passes, and it is the switch that
        // enables top-level `await`; `awaitPromise` is deliberately NOT set alongside it.
        // The two are not freely combinable — measured, Chrome 141:
        //
        //   replMode  awaitPromise   `(async () => { await sleep(800); return 'R' })()`
        //   false     false          Promise            (3ms)
        //   false     true           'R'                (1217ms — really waited)
        //   true      false          Promise            (2ms)
        //   true      true           Promise            (2ms — awaitPromise is INERT)
        //
        // replMode wraps the expression in an async function and resolves that wrapper itself,
        // which is both how top-level `await` works under `awaitPromise: false` and why
        // `awaitPromise` has nothing left to act on. So "console semantics plus auto-await" is
        // not a reachable combination, and passing awaitPromise here would only be dead weight
        // that reads as if it did something.
        const startedAt = Date.now();
        const evaluation = client.Runtime.evaluate({
            expression,
            returnByValue: false,
            generatePreview: true,
            replMode: true,
            timeout: EVAL_EXECUTION_TIMEOUT_MS,
        });
        // The settle race below abandons this promise on timeout. Without a handler of its own,
        // a later rejection would surface as an unhandledRejection with nobody listening.
        evaluation.catch(() => { });
        let result;
        try {
            const settled = await withTimeout(evaluation, EVAL_SETTLE_TIMEOUT_MS);
            if (settled === TIMED_OUT) {
                return toolError(`Error: expression did not settle within ${EVAL_SETTLE_TIMEOUT_MS}ms. It is suspended on something ` +
                    'that has not resolved — a pending promise, a request that never returns. The page is still running it.');
            }
            result = settled;
        }
        catch (err) {
            if (!isExecutionTerminated(err, Date.now() - startedAt))
                throw err;
            return toolError(`Error: expression was terminated after ${EVAL_EXECUTION_TIMEOUT_MS}ms of execution — it was still ` +
                'running (an infinite loop, or a blocking computation). The tab was not left spinning.');
        }
        if (result.exceptionDetails) {
            const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
            return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
        }
        const text = await renderValueFirst(client, result.result);
        releaseRemoteObject(client, result.result);
        return { content: [{ type: 'text', text }] };
    });
    server.registerTool('get_computed_style', {
        description: 'Get computed CSS values for the given properties on the element matched by selector.',
        inputSchema: z.object({
            selector: z.string().describe('CSS selector for the target element'),
            properties: z.array(z.string()).min(1).describe('CSS property names to return (kebab-case or camelCase)'),
        }),
        outputSchema: z.object({
            styles: z
                .record(z.string(), z.string())
                .describe('Map of property name → computed value. Keys match the input `properties` verbatim (case preserved). Values are `getComputedStyle` output; unknown properties yield empty string.'),
        }),
        annotations: {
            title: 'Get computed style',
            readOnlyHint: true,
        },
    }, async ({ selector, properties }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const expression = `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const s = getComputedStyle(el);
          const out = {};
          for (const p of ${JSON.stringify(properties)}) {
            out[p] = s.getPropertyValue(p) || s[p] || '';
          }
          return out;
        })()
      `;
        const result = await withTimeout(client.Runtime.evaluate({ expression, returnByValue: true }), PAGE_COMMAND_TIMEOUT_MS);
        if (result === TIMED_OUT)
            return rendererTimedOut('get_computed_style');
        if (result.result.value === null) {
            return {
                content: [{ type: 'text', text: `No element matches selector: ${selector}` }],
                isError: true,
            };
        }
        const styles = result.result.value;
        return {
            content: [{ type: 'text', text: JSON.stringify(styles, null, 2) }],
            structuredContent: { styles },
        };
    });
    // `Page.captureScreenshot` is the one command here that is not a query: it waits for the
    // compositor to hand over a frame. A tab whose frames are not being produced — backgrounded
    // within its window, its window minimised or fully occluded — answers it with neither a
    // value nor an error, and the renderer itself is perfectly healthy throughout. So this tool
    // gets a recovery step rather than only a bound.
    //
    // Bringing the tab forward is what actually ends that wait, and it is the RETRY rather than
    // a precondition because it steals whatever tab the user is looking at — too rude to pay on
    // every call for a fault that is occasional. Measured, Chrome 141, against a page target
    // reporting `document.visibilityState === "hidden"` whose window was still on screen:
    // capture returned in 137ms. So `hidden` is not the trigger and a pre-emptive activate would
    // be spent for nothing nearly every time; frames were still being produced. What the hang
    // needs is the surface to be gone, which is why it reads as "worked all session, then one
    // call didn't".
    //
    // The abandoned first capture is left pending deliberately. Once the tab comes forward both
    // captures resolve off the same frame; nothing is listening to the first one.
    //
    // There is no `quality` knob, and not only because the format is png. The image crosses a
    // local pipe where bytes are close to free, while the reader is billed by pixel area — so
    // re-encoding the same frame smaller buys nothing anyone pays for, and on png the flag is
    // not even wired up. Measured, Chrome 153, a 1029x729 CSS viewport:
    //
    //   format: 'png'                  1287x912   69174 bytes
    //   format: 'png',  quality: 50    1287x912   69174 bytes   <- byte-identical; png ignores it
    //   format: 'jpeg', quality: 80      (same)   54359 bytes   <- 21% off the bytes, 0% off the cost
    //
    // Dimensions are the only lever that moves the number that matters, which is what `maxEdge`
    // is.
    //
    // On sizing, this tool deliberately holds NO opinion about how large a screenshot should
    // be. What an image costs is decided entirely on the receiving side — by which model reads
    // it and how that model tokenises pixels — and this server cannot see any of that. Every
    // ceiling it could pick would be a guess about someone else's budget, stale the moment that
    // budget changed. So `maxEdge` is the caller's to set and the default is the tab's own
    // pixels: the server reports what Chrome painted, and whoever knows the budget spends it.
    //
    // What stays here is the part that IS about Chrome: turning a requested long edge into a
    // correct clip. That needs the device scale factor (see captureScaleFactor) and the scroll
    // offset, and it is best-effort in every direction — a timeout or a rejection while asking
    // drops through to a native capture rather than failing a tool whose job is the image.
    //
    // The clip is also only built when it is needed, never as the default path. At scale 1 it
    // is not a no-op: measured on a page with a classic scrollbar, an unclipped capture came
    // back 1920x912 and a clipped one 1900x911, the missing column being the scrollbar, which
    // sits outside the layout viewport. So a default screenshot is byte-for-byte the plain
    // `Page.captureScreenshot` it always was, and only a `maxEdge` call changes shape.
    server.registerTool('screenshot', {
        description: 'Capture a PNG screenshot of the current viewport (the visible page area only — not the full scrollable page, not the browser chrome, not DevTools), or of one rectangle of it with `region`. ' +
            "Captured at the tab's native pixel size unless you cap it with `maxEdge`; a capture that was scaled or cut says so in a note beside the image, which for a `region` also gives the CSS rect the image covers and how many image pixels a CSS pixel became. " +
            'If the tab is not on screen it is brought to the front first, which changes what the user is looking at.',
        inputSchema: z.object({
            region: z
                .object({
                x: z.number(),
                y: z.number(),
                width: z.number().positive(),
                height: z.number().positive(),
            })
                .optional()
                .describe('Capture only this rectangle instead of the whole viewport. CSS pixels, measured from the ' +
                'top-left of the visible area — the same space `getBoundingClientRect()` reports in, so an ' +
                "element's box can be passed straight through. Usually the right way to answer a question " +
                'about exact pixels: a small region at native size costs far less than the whole viewport. ' +
                "Pad it a few pixels when judging alignment — an exact box crop puts the element's own " +
                'antialiased edge in its outer row, and an offset only reads against its surroundings. ' +
                'Cut down to whatever part of it is on screen; a region entirely off screen is an error.'),
            maxEdge: z
                .number()
                .int()
                .default(-1)
                .describe('Longest side of the returned image, counted in its own pixels rather than CSS pixels, so the ' +
                'same value gives the same image on a 1x and a 2x tab. Scales down `region` when one is given, ' +
                "the viewport otherwise. -1 (the default), or any value at or above the capture's native " +
                'pixel size, returns native pixels — use that when the answer ' +
                'depends on exact pixels (1px offsets, blurred edges, subpixel text). Otherwise size it for ' +
                'whatever will read the image: cost scales with AREA, so halving this quarters it.'),
        }),
        annotations: {
            title: 'Screenshot',
            readOnlyHint: true,
        },
    }, async ({ maxEdge, region }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        let clip = null;
        // The device scale factor the capture was sized against, kept for the note below —
        // which reports the exact factor rather than one back-solved from rounded pixels.
        let deviceScale = null;
        // Whether the page said it was hidden, or undefined when nothing asked it.
        let pageHidden;
        // What the image will actually cover, back in the viewport-relative CSS pixels the
        // caller passed `region` in — kept because the note below has to hand those numbers
        // back, and by then the viewport they were measured against is out of scope.
        let captured = null;
        // A plain full-viewport capture at native size needs to know nothing about the page,
        // so it asks nothing. Any non-positive `maxEdge` means native, which is why -1 needs
        // no special case and neither does a caller who sends 0.
        if (maxEdge > 0 || region) {
            // Both halves of the question, issued together so the pair costs one round-trip's
            // latency rather than two. Each carries its own catch, degrading to the same "no
            // answer" shape as a timeout — but the metrics side keeps its reason, because that
            // is the one a caller is told about below.
            let metricsError;
            const metrics = client.Page.getLayoutMetrics().catch((e) => {
                metricsError = e instanceof Error ? e.message : String(e);
                return undefined;
            });
            // Two answers from one evaluate, because the second is free here and a round-trip of
            // its own everywhere else. `hidden` decides whether the tab has to be raised before
            // it can be captured at all (see below); the ratio decides how large the result is.
            const ratio = client.Runtime.evaluate({
                expression: '({ dpr: devicePixelRatio, hidden: document.hidden })',
                returnByValue: true,
            })
                .then((r) => r.result?.value)
                .catch(() => undefined);
            // The annotation keeps the sentinel's own type, which a bare arrow would widen to
            // `symbol` and stop narrowing.
            const probed = await withTimeout(Promise.all([metrics, ratio]), LAYOUT_METRICS_TIMEOUT_MS).catch(() => TIMED_OUT);
            const resolved = probed === TIMED_OUT ? undefined : probed[0];
            const reported = probed === TIMED_OUT ? undefined : probed[1]?.dpr;
            pageHidden = probed === TIMED_OUT ? undefined : probed[1]?.hidden === true;
            const css = resolved?.cssLayoutViewport;
            // Without the viewport, the two requests degrade differently, and the difference is
            // whether the answer is still true. An uncapped `maxEdge` gives back a larger image
            // of the right thing, so it falls through; a `region` placed blind would be a
            // picture of the wrong thing, which no caller can detect from the image. So it fails.
            if (!css?.clientWidth || !css.clientHeight) {
                if (region) {
                    // Three different failures land here and they call for different next moves, so
                    // the message names the one that actually happened rather than blaming the clock
                    // for all of them.
                    const why = probed === TIMED_OUT
                        ? `the renderer did not answer within ${LAYOUT_METRICS_TIMEOUT_MS}ms — it may be paused at a ` +
                            'breakpoint, blocked in a synchronous loop, or blocked on a modal dialog'
                        : metricsError
                            ? `Page.getLayoutMetrics failed: ${metricsError}`
                            : 'Page.getLayoutMetrics answered without a usable layout viewport, which a tab reports when ' +
                                'it has no rendered size of its own — it may be hidden, minimized, or still being created';
                    return toolError(`Error: the viewport could not be measured, so a region cannot be placed on the page and was ` +
                        `not guessed at. ${why}. Retry without \`region\` to capture the whole viewport.`);
                }
            }
            else {
                const viewport = viewportRect(css);
                const rect = region ? intersectViewport(viewport, region) : viewport;
                if (!rect) {
                    return toolError(`Error: the requested region (${region.width}x${region.height} at ${region.x},${region.y}) ` +
                        `lies entirely outside the ${viewport.width}x${viewport.height} viewport, so there is nothing ` +
                        'to capture. Region coordinates are CSS pixels from the top-left of the visible area, as ' +
                        '`getBoundingClientRect()` reports them — scroll the element into view first if it is off screen.');
                }
                if (region) {
                    captured = { x: rect.x - viewport.x, y: rect.y - viewport.y, width: rect.width, height: rect.height };
                }
                deviceScale = captureScaleFactor(resolved, reported);
                const scale = scaleToFit(rect, deviceScale, maxEdge);
                // A clip is only built when it changes something. At scale 1 it is not a no-op:
                // measured on a page with a classic scrollbar, an unclipped capture came back
                // 1920x912 and a clipped one 1900x911, the missing column being the scrollbar,
                // which sits outside the layout viewport. So a plain full-viewport request stays
                // the plain `Page.captureScreenshot` it always was.
                if (region || scale < 1)
                    clip = { ...rect, scale };
            }
        }
        const params = clip ? { format: 'png', clip } : { format: 'png' };
        let broughtToFront = false;
        // A hidden tab is not painting, and a capture sent to a tab that is not painting does
        // not come back until something makes it paint. Raising it first turns a 10s stall
        // into a 700ms answer — measured, Chrome 153, a minimised window: raise, wait for a
        // double rAF (29ms), capture (71ms), pixels exact. The wait is what makes it safe;
        // capturing the instant the tab is raised is how a stale surface gets returned.
        //
        // Only on the path that already asked the page something. A plain `screenshot` with no
        // arguments still sends nothing but the capture, and reaches the same place through the
        // timeout below, a few seconds later.
        if (pageHidden) {
            const front = client.Page.bringToFront();
            front.catch(() => { });
            if ((await withTimeout(front, BRING_TO_FRONT_TIMEOUT_MS)) !== TIMED_OUT) {
                broughtToFront = true;
                const painted = client.Runtime.evaluate({
                    expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
                    returnByValue: true,
                    awaitPromise: true,
                });
                painted.catch(() => { });
                await withTimeout(painted, FRAME_WAIT_TIMEOUT_MS);
            }
        }
        // ONE capture request for the life of the call, waited on twice. A tab that is not
        // painting does not refuse a capture, it just never answers — and issuing a SECOND
        // request while the first is still pending is what turns that into a wrong answer.
        // Measured against a minimised window, Chrome 153, a 300x120 region on a static page:
        //
        //   first request, alone                       no answer in 10s
        //   ...then bringToFront, then a NEW request   answered in 62ms, 100% of pixels wrong
        //   ...then bringToFront, awaiting the SAME    answered in ~70ms, 0% wrong (twice)
        //   a plain capture issued alongside a pending one    99.9% of pixels wrong
        //
        // The wrong images are the dangerous case: they arrive fast, they are the right size,
        // and they carry no sign at all that they show another moment or another place. So the
        // retry is a second WAIT, never a second request, and nothing else is sent to this
        // target until the capture settles.
        const shot = client.Page.captureScreenshot(params);
        // Handled here because the wait below can be abandoned; without it a later rejection
        // would surface as an unhandledRejection with nobody listening.
        shot.catch(() => { });
        let result = await withTimeout(shot, SCREENSHOT_TIMEOUT_MS);
        if (result === TIMED_OUT) {
            const front = client.Page.bringToFront();
            front.catch(() => { });
            if ((await withTimeout(front, BRING_TO_FRONT_TIMEOUT_MS)) === TIMED_OUT) {
                return toolError(`Error: screenshot timed out after ${SCREENSHOT_TIMEOUT_MS}ms, and the tab could not be brought ` +
                    'to the front either. Chrome is not answering for this target at all — check the window still exists.');
            }
            broughtToFront = true;
            result = await withTimeout(shot, SCREENSHOT_TIMEOUT_MS);
        }
        if (result === TIMED_OUT) {
            return toolError(`Error: screenshot timed out after ${SCREENSHOT_TIMEOUT_MS}ms, then still did not answer within ` +
                `another ${SCREENSHOT_TIMEOUT_MS}ms after the tab was brought to the front. The tab is not ` +
                'producing frames (minimised or fully occluded window), or its renderer is blocked. Nothing was captured.');
        }
        const image = { type: 'image', data: result.data, mimeType: 'image/png' };
        // Only what the caller did not ask for is annotated, on the same principle as
        // get_html's truncation marker: an unmarked result is exactly what was requested, so
        // nobody has to wonder whether they are looking at the whole thing. A region that fit
        // and a capture that was not scaled therefore say nothing.
        const notes = [];
        const size = pngSize(result.data);
        // Raising a tab changes what the user is looking at, whether it happened because the
        // page said it was hidden or because the first wait ran out — so it is news, both
        // about the browser and about why the call took as long as it did.
        if (broughtToFront) {
            notes.push('Note: the tab was not on screen and so was not painting, so it was brought to the front to capture ' +
                'it. That changed which tab the user is looking at.');
        }
        // A region is the one capture whose image gets measured against page coordinates: it
        // was asked for in CSS pixels and comes back in image pixels, and the two differ by
        // the device scale factor times any `maxEdge` scaling — neither of which is visible in
        // the image. So when they differ, the note states the conversion instead of leaving it
        // to be back-solved, and when the rect moved, it states where the image actually
        // starts. The full-viewport capture needs neither: it covers the viewport whatever its
        // pixel count, so there is nothing to convert coordinates against.
        let sizeReported = false;
        if (captured && region) {
            const cut = captured.width !== region.width || captured.height !== region.height;
            // Two ways to get the factor, and they disagree in the last decimal: the delivered
            // width over the CSS width is what the image IS, but both are rounded, so an 81 CSS
            // px strip at 1.25 reports 101/81 = 1.247. The factor the capture was sized with is
            // exact. Prefer it, but only while the measurement agrees — if Chrome delivered
            // something other than what was asked for, the picture wins over the intention.
            const measured = size && captured.width > 0 ? size.width / captured.width : 1;
            const intended = (deviceScale ?? 1) * (clip?.scale ?? 1);
            const perCssPx = Math.abs(measured - intended) <= intended * 0.01 ? intended : measured;
            const rescaled = Math.abs(perCssPx - 1) > 0.005;
            const where = `${captured.width}x${captured.height} CSS px at (${captured.x},${captured.y}), ` +
                'measured from the top-left of the visible area';
            if (cut) {
                notes.push(`Note: the region ran past the visible area and was cut to ${where}.`);
            }
            if (rescaled && size) {
                sizeReported = true;
                notes.push(`Note: the ${size.width}x${size.height} image covers ${cut ? 'that' : where} — ` +
                    `1 CSS px = ${Math.round(perCssPx * 1000) / 1000} image px.`);
            }
        }
        if (clip && clip.scale < 1) {
            const percent = Math.round(clip.scale * 100);
            notes.push(`Note: downscaled to ${size && !sizeReported ? `${size.width}x${size.height}, ` : ''}${percent}% of ` +
                `native size, for the requested maxEdge of ${maxEdge}px. Omit maxEdge if the answer depends on exact pixels.`);
        }
        if (!notes.length)
            return { content: [image] };
        return { content: [image, { type: 'text', text: notes.join(' ') }] };
    });
    // Reads `window.$0` — a real page global the user has to create — rather than `$0` itself,
    // because `$0` is out of this server's reach entirely.
    //
    // `$0` is not a page variable. It resolves from the inspector's selected-node state, which is
    // held PER CDP SESSION, and nothing here ever sets it. Measured against a live Chrome with an
    // h2 selected in DevTools, from a separate session:
    //
    //   typeof window.$0                            -> "undefined"   (never a page global)
    //   typeof $0   with includeCommandLineAPI      -> "undefined"   (selection not shared)
    //   typeof $$   with includeCommandLineAPI      -> "function"    (the API itself IS live)
    //   ...then this session calls DOM.setInspectedNode itself:
    //   typeof $0   with includeCommandLineAPI      -> "object"
    //   $0.tagName                                  -> "H2"
    //
    // So turning on includeCommandLineAPI would not help: it hands over `$$` and not `$0`.
    // Neither would calling DOM.setInspectedNode — that WRITES the state, so we would have to
    // already know which node the user means, and CDP offers no way to read which node DevTools
    // has selected. Hence the manual `window.$0 = $0` step, which runs where the binding lives.
    server.registerTool('get_inspected_element', {
        description: 'Get the element marked for MCP inspection. To mark an element: select it in the Elements panel, then run `window.$0 = $0` in the DevTools console.',
        inputSchema: z.object({}),
        outputSchema: z.object({
            tagName: z.string(),
            id: z.string().optional(),
            className: z.string().optional(),
            attributes: z.record(z.string(), z.string()),
            outerHTML: z.string().describe('First 5000 characters of element outerHTML'),
        }),
        annotations: {
            title: 'Get inspected element',
            readOnlyHint: true,
        },
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await withTimeout(client.Runtime.evaluate({
            expression: `
          (() => {
            const el = window.$0;
            if (!(el instanceof Element)) return null;
            const attrs = {};
            for (const a of el.attributes) attrs[a.name] = a.value;
            return {
              tagName: el.tagName.toLowerCase(),
              id: el.id || undefined,
              className: el.className || undefined,
              attributes: attrs,
              outerHTML: el.outerHTML.slice(0, 5000),
            };
          })()
        `,
            returnByValue: true,
        }), PAGE_COMMAND_TIMEOUT_MS);
        if (result === TIMED_OUT)
            return rendererTimedOut('get_inspected_element');
        if (result.result.value === null) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'No element marked. Select an element in the Elements panel, then run `window.$0 = $0` in the DevTools console.',
                    },
                ],
                isError: true,
            };
        }
        const el = result.result.value;
        return {
            content: [{ type: 'text', text: JSON.stringify(el, null, 2) }],
            structuredContent: el,
        };
    });
}

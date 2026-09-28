import { z } from 'zod';
import { MAX_CONSOLE_LOGS, NOT_CONNECTED } from '../constants.js';
// ── Console log tool ──────────────────────────────────────────────────────────
export function registerConsoleTools(server, getClient, session) {
    server.registerTool('get_console_logs', {
        description: 'Return browser console messages and uncaught exceptions, including the history already visible in DevTools before this server connected. ' +
            'Exceptions are reported with their full stack trace (source-mapped when available). ' +
            'Reloading or navigating the page does NOT clear this buffer: output from the old document stays and the new one is appended to it, ' +
            'so an entry carries `from` when it predates the document showing now. ' +
            'Replayed entries carry no `timestamp` — Chrome hands its backlog over without one.',
        inputSchema: z.object({
            limit: z
                .number()
                .int()
                .min(1)
                .max(MAX_CONSOLE_LOGS)
                .default(100)
                .describe('Maximum number of most-recent entries to return'),
            level: z
                .enum(['log', 'info', 'debug', 'warning', 'error', 'exception'])
                .optional()
                .describe('Filter by log level / type. Omit to return all levels.'),
            since: z
                .enum(['before-connect', 'earlier-page-load', 'current-page-load'])
                .default('before-connect')
                .describe('How far back to read: a lower bound rather than a label to match, since each value INCLUDES the ' +
                'newer ones. `current-page-load` is only the document showing now, which answers "did my change ' +
                'introduce a new error" — reload, ask for it, and an empty result is a real answer. ' +
                '`earlier-page-load` adds the pages this connection watched come and go; `before-connect` (the ' +
                'default) adds the backlog that was already in DevTools before it attached.'),
        }),
        outputSchema: z.object({
            logs: z
                .array(z.object({
                timestamp: z
                    .string()
                    .optional()
                    .describe('When this server received the entry. Absent on `before-connect` entries.'),
                type: z.string(),
                text: z.string(),
                from: z.enum(['before-connect', 'earlier-page-load']).optional(),
                stackTrace: z
                    .array(z.object({
                    functionName: z.string(),
                    url: z.string(),
                    lineNumber: z.number(),
                    columnNumber: z.number(),
                }))
                    .optional(),
            }))
                .describe('Oldest first.'),
        }),
        annotations: {
            title: 'Get console logs',
            readOnlyHint: true,
        },
    }, async ({ limit, level, since }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        await session.attach(client);
        const logs = session.readConsoleLogs({ limit, level, since });
        // An empty result reads very differently depending on what was asked for: with
        // `current-page-load` it is the useful answer "this page has printed nothing", which
        // "nothing captured yet" would misreport as the buffer being empty.
        const empty = since === 'current-page-load'
            ? 'No console entries from the page currently loaded.'
            : since === 'earlier-page-load'
                ? 'No console entries since this server connected.'
                : 'No console entries captured yet.';
        return {
            content: logs.length === 0
                ? [{ type: 'text', text: empty }]
                : [{ type: 'text', text: JSON.stringify(logs, null, 2) }],
            structuredContent: { logs },
        };
    });
}

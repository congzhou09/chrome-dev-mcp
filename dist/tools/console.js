import { z } from 'zod';
import { MAX_CONSOLE_LOGS, NOT_CONNECTED } from '../constants.js';
// ── Console log tool ──────────────────────────────────────────────────────────
export function registerConsoleTools(server, getClient, session) {
    server.registerTool('get_console_logs', {
        description: 'Return browser console messages and uncaught exceptions. ' +
            'Includes messages already visible in DevTools before this server connected, ' +
            'plus new output produced afterwards. ' +
            'Exceptions are reported with their full stack trace (source-mapped when available).',
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
            clear: z.boolean().default(false).describe('Clear the buffer after returning entries'),
        }),
        outputSchema: z.object({
            logs: z.array(z.object({
                timestamp: z.string(),
                type: z.string(),
                text: z.string(),
                stackTrace: z
                    .array(z.object({
                    functionName: z.string(),
                    url: z.string(),
                    lineNumber: z.number(),
                    columnNumber: z.number(),
                }))
                    .optional(),
            })),
        }),
        annotations: {
            title: 'Get console logs',
            readOnlyHint: true,
        },
    }, async ({ limit, level, clear }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        await session.attach(client);
        const logs = session.readConsoleLogs({ limit, level });
        if (clear)
            session.clearConsoleLogs();
        return {
            content: logs.length === 0
                ? [{ type: 'text', text: 'No console entries captured yet.' }]
                : [{ type: 'text', text: JSON.stringify(logs, null, 2) }],
            structuredContent: { logs },
        };
    });
}

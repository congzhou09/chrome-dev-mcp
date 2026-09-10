import { z } from 'zod';
// ── Capture buffer tool ───────────────────────────────────────────────────────
// The only tool that writes rather than reads, and the only one that touches state
// owned by this server instead of by Chrome. Kept out of the console/network tool
// groups so those stay honestly readOnlyHint: true — clients use that hint to skip
// confirmation, and a rare clear must not tax every read.
export function registerCaptureTools(server, session, capture) {
    server.registerTool('clear_captures', {
        description: 'Discard the buffers this server holds, so a following get_console_logs / get_network_requests shows only what happens next. ' +
            'Affects this server only: nothing is cleared in Chrome or in the DevTools UI, and capture keeps running — no reconnect or reload is needed. ' +
            'Cannot be undone. Console entries are gone for good, because Console.enable() replays history only at attach time. ' +
            'Cleared network requestIds still resolve in get_network_response_body for as long as Chrome itself holds the body; once Chrome drops it the error says the data was discarded rather than that the id is unknown. ' +
            'Works without a connected tab.',
        inputSchema: z.object({
            targets: z
                .array(z.enum(['console', 'network']))
                .min(1)
                .default(['console', 'network'])
                .describe('Which buffers to clear. Defaults to both.'),
        }),
        outputSchema: z.object({
            cleared: z
                .object({
                console: z.number().optional(),
                network: z.number().optional(),
            })
                .describe('Entries dropped per target; a target absent from `targets` is absent here'),
        }),
        annotations: {
            title: 'Clear captures',
            readOnlyHint: false,
            destructiveHint: true,
            // Clearing twice leaves the same state as clearing once.
            idempotentHint: true,
        },
    }, async ({ targets }) => {
        const cleared = {};
        if (targets.includes('console'))
            cleared.console = session.clearConsoleLogs();
        if (targets.includes('network'))
            cleared.network = capture.clearBuffer();
        const summary = [
            cleared.console == null ? null : `${cleared.console} console entries`,
            cleared.network == null ? null : `${cleared.network} network records`,
        ]
            .filter(Boolean)
            .join(', ');
        return {
            content: [{ type: 'text', text: `Cleared ${summary}.` }],
            structuredContent: { cleared },
        };
    });
}

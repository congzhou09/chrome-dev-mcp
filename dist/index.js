#!/usr/bin/env node
import CDP from 'chrome-remote-interface';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
let cdpClient = null;
let currentTargetId = null;
// Serialises every connection transition, and is also the shared promise that stops two
// callers from starting duplicate attempts.
//
// Serialising matters because a transition tears down `cdpClient` and builds a new one:
// two of them interleaving can leave a client that nobody holds a reference to but that is
// still open, with its Network listeners still feeding the one shared capture buffer —
// every request then lands in the buffer twice, and the duplicate that responseReceived
// does NOT update stays without status or headers forever.
let pending = null;
// Runs `work` after whatever transition is already in flight, never concurrently with it.
const queueTransition = (work) => {
    // A failed predecessor must not poison the queue; each transition reports its own errors.
    const run = (pending ?? Promise.resolve(null)).catch(() => null).then(work);
    pending = run;
    // Only clear if nothing else has queued behind us in the meantime.
    const settle = () => {
        if (pending === run)
            pending = null;
    };
    run.then(settle, settle);
    return run;
};
// Created up here (not next to server.connect below) because connectToTarget needs
// attachNetwork, and connectToTarget can run before the transport is wired up.
const { server, attachNetwork } = createServer(getClient, switchToTarget, () => currentTargetId);
async function findActivePageTargetId() {
    const targets = (await CDP.List({ host: '127.0.0.1', port: 9222 }));
    const pageTargets = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    for (const target of pageTargets) {
        const tempClient = await CDP({ host: '127.0.0.1', port: 9222, target: target.id }).catch(() => null);
        if (!tempClient)
            continue;
        try {
            const { result } = await tempClient.Runtime.evaluate({ expression: 'document.visibilityState === "visible"' });
            if (result.value === true)
                return target.id;
        }
        finally {
            await tempClient.close().catch(() => { });
        }
    }
    return pageTargets[0]?.id;
}
async function connectToTarget(targetId) {
    const client = await CDP({ host: '127.0.0.1', port: 9222, target: targetId });
    await client.Runtime.enable();
    await client.Page.enable();
    // Eager attach: Network.enable() does not replay history, so capture has to start at
    // connect time rather than on the first tool call. Cheap and side-effect-free, unlike
    // Debugger.enable() — which is why that one stays lazy. Never rejects.
    await attachNetwork(client);
    cdpClient = client;
    currentTargetId = targetId;
    console.error('[chrome-dev-mcp] Connected to Chrome');
    // Cleanup only: clear the reference so the next tool call triggers reconnect.
    // Debugger and network state reset happens in server.ts when it detects a new client.
    client.on('disconnect', () => {
        cdpClient = null;
        currentTargetId = null;
        console.error('[chrome-dev-mcp] Chrome disconnected — will reconnect on next tool call');
    });
    return client;
}
async function getClient() {
    if (cdpClient)
        return cdpClient;
    // Share whatever transition is in flight instead of racing it. If that is a switch_tab,
    // this call correctly ends up on the tab being switched to.
    if (pending)
        return pending;
    return queueTransition(async () => {
        try {
            const targetId = await findActivePageTargetId();
            if (targetId === undefined) {
                console.error('[chrome-dev-mcp] No page target found in Chrome');
                return null;
            }
            return await connectToTarget(targetId);
        }
        catch (e) {
            console.error('[chrome-dev-mcp] Chrome unavailable:', e.message);
            return null;
        }
    });
}
async function switchToTarget(targetId) {
    // Queued rather than run immediately: the eager connect from startup can still be in
    // flight with `cdpClient` not yet assigned, and closing before it lands would close
    // nothing and leave that client open on the old target.
    return queueTransition(async () => {
        // Already on this target: hand back the live client instead of rebuilding. A rebuild
        // would reset the network capture buffer and the debugger state for nothing, and it
        // would pull the client out from under a concurrent caller still using it. A client
        // that actually died is already null here — the 'disconnect' handler clears it.
        if (cdpClient && currentTargetId === targetId)
            return cdpClient;
        if (cdpClient) {
            await cdpClient.close().catch(() => { });
            cdpClient = null;
            // Cleared together with the client: a failed switch below must not leave a targetId
            // that list_tabs would still report as the active tab.
            currentTargetId = null;
        }
        try {
            return await connectToTarget(targetId);
        }
        catch (e) {
            console.error('[chrome-dev-mcp] Failed to switch to target:', e.message);
            return null;
        }
    });
}
// Start MCP transport before attempting Chrome connection so Claude Code
// can always reach the server even when Chrome is not yet running.
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[chrome-dev-mcp] MCP server ready');
// Eagerly attempt first connection; failure is non-fatal.
await getClient();

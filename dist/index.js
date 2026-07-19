#!/usr/bin/env node
import CDP from 'chrome-remote-interface';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
let cdpClient = null;
// Shared promise while a connection attempt is in flight — prevents duplicate attempts.
let connectingPromise = null;
async function findActivePageTargetId() {
    const targets = (await CDP.List({ host: '127.0.0.1', port: 9222 }));
    const pageTargets = targets.filter((t) => t.type === 'page');
    for (const target of pageTargets) {
        const tempClient = await CDP({ host: '127.0.0.1', port: 9222, target: target.id }).catch(() => null);
        if (!tempClient)
            continue;
        try {
            const { result } = await tempClient.Runtime.evaluate({ expression: 'document.hasFocus()' });
            if (result.value === true)
                return target.id;
        }
        finally {
            await tempClient.close().catch(() => { });
        }
    }
    return pageTargets[0]?.id;
}
async function getClient() {
    if (cdpClient)
        return cdpClient;
    if (connectingPromise)
        return connectingPromise;
    connectingPromise = (async () => {
        try {
            const targetId = await findActivePageTargetId();
            if (targetId === undefined) {
                console.error('[chrome-dev-mcp] No page target found in Chrome');
                return null;
            }
            const client = await CDP({ host: '127.0.0.1', port: 9222, target: targetId });
            await client.Runtime.enable();
            await client.Page.enable();
            cdpClient = client;
            console.error('[chrome-dev-mcp] Connected to Chrome');
            // Cleanup only: clear the reference so the next tool call triggers reconnect.
            // Debugger state reset happens in server.ts when it detects a new client.
            client.on('disconnect', () => {
                cdpClient = null;
                console.error('[chrome-dev-mcp] Chrome disconnected — will reconnect on next tool call');
            });
            return client;
        }
        catch (e) {
            console.error('[chrome-dev-mcp] Chrome unavailable:', e.message);
            return null;
        }
        finally {
            connectingPromise = null;
        }
    })();
    return connectingPromise;
}
// Start MCP transport before attempting Chrome connection so Claude Code
// can always reach the server even when Chrome is not yet running.
const server = createServer(getClient);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[chrome-dev-mcp] MCP server ready');
// Eagerly attempt first connection; failure is non-fatal.
await getClient();

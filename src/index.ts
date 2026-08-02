#!/usr/bin/env node
import CDP from 'chrome-remote-interface';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

let cdpClient: CDP.Client | null = null;
let currentTargetId: string | null = null;
// Shared promise while a connection attempt is in flight — prevents duplicate attempts.
let connectingPromise: Promise<CDP.Client | null> | null = null;

async function findActivePageTargetId(): Promise<string | undefined> {
  const targets = (await CDP.List({ host: '127.0.0.1', port: 9222 })) as Array<{ id: string; type: string; url: string }>;
  const pageTargets = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));

  for (const target of pageTargets) {
    const tempClient = await CDP({ host: '127.0.0.1', port: 9222, target: target.id }).catch(() => null);
    if (!tempClient) continue;
    try {
      const { result } = await tempClient.Runtime.evaluate({ expression: 'document.visibilityState === "visible"' });
      if (result.value === true) return target.id;
    } finally {
      await tempClient.close().catch(() => {});
    }
  }

  return pageTargets[0]?.id;
}

async function connectToTarget(targetId: string): Promise<CDP.Client> {
  const client = await CDP({ host: '127.0.0.1', port: 9222, target: targetId });
  await client.Runtime.enable();
  await client.Page.enable();
  cdpClient = client;
  currentTargetId = targetId;
  console.error('[chrome-dev-mcp] Connected to Chrome');

  // Cleanup only: clear the reference so the next tool call triggers reconnect.
  // Debugger state reset happens in server.ts when it detects a new client.
  client.on('disconnect', () => {
    cdpClient = null;
    currentTargetId = null;
    console.error('[chrome-dev-mcp] Chrome disconnected — will reconnect on next tool call');
  });

  return client;
}

async function getClient(): Promise<CDP.Client | null> {
  if (cdpClient) return cdpClient;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    try {
      const targetId = await findActivePageTargetId();
      if (targetId === undefined) {
        console.error('[chrome-dev-mcp] No page target found in Chrome');
        return null;
      }
      return await connectToTarget(targetId);
    } catch (e) {
      console.error('[chrome-dev-mcp] Chrome unavailable:', (e as Error).message);
      return null;
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
}

async function switchToTarget(targetId: string): Promise<CDP.Client | null> {
  if (cdpClient) {
    await cdpClient.close().catch(() => {});
    cdpClient = null;
  }
  connectingPromise = null;
  try {
    return await connectToTarget(targetId);
  } catch (e) {
    console.error('[chrome-dev-mcp] Failed to switch to target:', (e as Error).message);
    return null;
  }
}

// Start MCP transport before attempting Chrome connection so Claude Code
// can always reach the server even when Chrome is not yet running.
const server = createServer(getClient, switchToTarget, () => currentTargetId);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[chrome-dev-mcp] MCP server ready');

// Eagerly attempt first connection; failure is non-fatal.
await getClient();

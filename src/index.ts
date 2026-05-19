import CDP from 'chrome-remote-interface';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

let cdpClient: CDP.Client | null = null;
// Shared promise while a connection attempt is in flight — prevents duplicate attempts.
let connectingPromise: Promise<CDP.Client | null> | null = null;

async function getClient(): Promise<CDP.Client | null> {
  if (cdpClient) return cdpClient;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    try {
      const client = await CDP({
        host: '127.0.0.1',
        port: 9222,
        target: (targets) => {
          return targets.find((t) => t.type === 'page' && t.url.includes('localhost')) as CDP.Target;
        },
      });
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
    } catch (e) {
      console.error('[chrome-dev-mcp] Chrome unavailable:', (e as Error).message);
      return null;
    } finally {
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

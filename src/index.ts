import CDP from 'chrome-remote-interface';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const client = await CDP({
  host: '127.0.0.1',
  port: 9222,
  target: (targets) => {
    return targets.find((t) => {
      return t.type === 'page' && t.url.includes('localhost');
    }) as CDP.Target;
  },
});

await client.Runtime.enable();
await client.Page.enable();

const server = createServer(client);
const transport = new StdioServerTransport();
await server.connect(transport);

console.log('chrome-dev-mcp started');

import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pkgInfo from '../package.json' with { type: 'json' };

export function createServer(client: CDP.Client) {
  const { Runtime, Page } = client;

  const server = new McpServer({
    name: pkgInfo.name,
    version: pkgInfo.version,
  });

  server.registerTool(
    'get_title',
    {
      description: 'Get current page title',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await Runtime.evaluate({
        expression: 'document.title',
        returnByValue: true,
      });
      return {
        content: [{ type: 'text', text: String(result.result.value) }],
      };
    },
  );

  server.registerTool(
    'get_url',
    {
      description: 'Get current page url',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await Runtime.evaluate({
        expression: 'location.href',
        returnByValue: true,
      });
      return {
        content: [{ type: 'text', text: String(result.result.value) }],
      };
    },
  );

  server.registerTool(
    'get_html',
    {
      description: 'Get current page html',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await Runtime.evaluate({
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      });
      return {
        content: [{ type: 'text', text: String(result.result.value).slice(0, 20000) }],
      };
    },
  );

  server.registerTool(
    'evaluate_js',
    {
      description: 'Evaluate javascript in page',
      inputSchema: z.object({ expression: z.string() }),
    },
    async ({ expression }) => {
      const result = await Runtime.evaluate({ expression, returnByValue: true });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.result.value, null, 2) }],
      };
    },
  );

  server.registerTool(
    'get_computed_style',
    {
      description: 'Get computed style of element',
      inputSchema: z.object({ selector: z.string() }),
    },
    async ({ selector }) => {
      const expression = `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const s = getComputedStyle(el);
          return {
            display: s.display,
            position: s.position,
            overflow: s.overflow,
            zIndex: s.zIndex,
            pointerEvents: s.pointerEvents,
            opacity: s.opacity,
            visibility: s.visibility,
          };
        })()
      `;
      const result = await Runtime.evaluate({ expression, returnByValue: true });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.result.value, null, 2) }],
      };
    },
  );

  server.registerTool(
    'element_from_point',
    {
      description: 'Get actual top element at target position',
      inputSchema: z.object({ selector: z.string() }),
    },
    async ({ selector }) => {
      const expression = `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          const topEl = document.elementFromPoint(rect.left + 5, rect.top + 5);
          return {
            target: el.outerHTML,
            actualTopElement: topEl?.outerHTML,
          };
        })()
      `;
      const result = await Runtime.evaluate({ expression, returnByValue: true });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.result.value, null, 2) }],
      };
    },
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Capture screenshot',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await Page.captureScreenshot({ format: 'png' });
      return {
        content: [{ type: 'image', data: result.data, mimeType: 'image/png' }],
      };
    },
  );

  return server;
}

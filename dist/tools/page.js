import { z } from 'zod';
import { MAX_HTML_LENGTH, NOT_CONNECTED } from '../constants.js';
// ── Page inspection tools ─────────────────────────────────────────────────────
//
// Every tool here is a bare Runtime.evaluate / Page.captureScreenshot, so this group
// needs nothing but getClient — no session state at all.
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
        const result = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
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
        const result = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
        return { content: [{ type: 'text', text: String(result.result.value) }] };
    });
    server.registerTool('get_html', {
        description: 'Get the full HTML source of the currently connected tab (`document.documentElement.outerHTML`). ' +
            `Truncated to ${MAX_HTML_LENGTH} characters for large pages.`,
        inputSchema: z.object({}),
        annotations: {
            title: 'Get page HTML',
            readOnlyHint: true,
        },
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await client.Runtime.evaluate({
            expression: 'document.documentElement.outerHTML',
            returnByValue: true,
        });
        return { content: [{ type: 'text', text: String(result.result.value).slice(0, MAX_HTML_LENGTH) }] };
    });
    server.registerTool('evaluate_js', {
        description: 'Evaluate javascript in page. To access the currently selected element in the Elements panel ($0), use get_inspected_element instead.',
        inputSchema: z.object({ expression: z.string() }),
        annotations: {
            title: 'Evaluate JS',
        },
    }, async ({ expression }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await client.Runtime.evaluate({
            expression,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
            return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
        }
        const { value, type, description } = result.result;
        const text = value !== undefined ? JSON.stringify(value, null, 2) : (description ?? type ?? 'undefined');
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
        const result = await client.Runtime.evaluate({ expression, returnByValue: true });
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
    server.registerTool('screenshot', {
        description: 'Capture a PNG screenshot of the current viewport (the visible page area only — not the full scrollable page, not the browser chrome, not DevTools).',
        inputSchema: z.object({}),
        annotations: {
            title: 'Screenshot',
            readOnlyHint: true,
        },
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await client.Page.captureScreenshot({ format: 'png' });
        return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
    });
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
        const result = await client.Runtime.evaluate({
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
        });
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

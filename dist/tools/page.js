import { z } from 'zod';
import { MAX_HTML_LENGTH, NOT_CONNECTED } from '../constants.js';
import { releaseRemoteObject, renderValueFirst } from '../remote-object.js';
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
        description: 'Evaluate a JavaScript expression in the page, in global scope. Returns the real value when it serialises; ' +
            'objects that cannot (DOM nodes, Errors, Maps, class instances) come back as a preview instead: class name plus a ' +
            'first level of properties, marked `…` where Chrome truncated it — readable, not parseable as the value. ' +
            'At a breakpoint this still evaluates globally and cannot see local or closure variables — use evaluate_at_frame for those. ' +
            'For the element selected in the Elements panel ($0), use get_inspected_element.',
        inputSchema: z.object({ expression: z.string() }),
        annotations: {
            title: 'Evaluate JS',
        },
    }, async ({ expression }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        // Evaluated exactly once, in preview mode. Asking for the value here instead would
        // silently flatten DOM nodes, Errors, Maps and class instances, and retrying after
        // its -32000 would re-run the expression — see remote-object.ts.
        const result = await client.Runtime.evaluate({
            expression,
            returnByValue: false,
            generatePreview: true,
        });
        if (result.exceptionDetails) {
            const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
            return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
        }
        const text = await renderValueFirst(client, result.result);
        await releaseRemoteObject(client, result.result);
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
    // Reads `window.$0` — a real page global the user has to create — rather than `$0` itself,
    // because `$0` is out of this server's reach entirely.
    //
    // `$0` is not a page variable. It resolves from the inspector's selected-node state, which is
    // held PER CDP SESSION, and nothing here ever sets it. Measured against a live Chrome with an
    // h2 selected in DevTools, from a separate session:
    //
    //   typeof window.$0                            -> "undefined"   (never a page global)
    //   typeof $0   with includeCommandLineAPI      -> "undefined"   (selection not shared)
    //   typeof $$   with includeCommandLineAPI      -> "function"    (the API itself IS live)
    //   ...then this session calls DOM.setInspectedNode itself:
    //   typeof $0   with includeCommandLineAPI      -> "object"
    //   $0.tagName                                  -> "H2"
    //
    // So turning on includeCommandLineAPI would not help: it hands over `$$` and not `$0`.
    // Neither would calling DOM.setInspectedNode — that WRITES the state, so we would have to
    // already know which node the user means, and CDP offers no way to read which node DevTools
    // has selected. Hence the manual `window.$0 = $0` step, which runs where the binding lives.
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

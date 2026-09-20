import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BRING_TO_FRONT_TIMEOUT_MS,
  EVAL_EXECUTION_TIMEOUT_MS,
  EVAL_SETTLE_TIMEOUT_MS,
  MAX_HTML_LENGTH,
  NOT_CONNECTED,
  PAGE_COMMAND_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  rendererTimedOut,
} from '../constants.js';
import { releaseRemoteObject, renderValueFirst } from '../remote-object.js';
import { TIMED_OUT, withTimeout } from '../timeout.js';

// Chrome reports a `timeout` kill as a REJECTED command rather than through
// `exceptionDetails`, so it bypasses the normal error path entirely. The code it rejects
// with also degrades once replMode is on — measured, Chrome 141, reproducible over repeats:
//
//   replMode: false  ->  -32000  "Execution was terminated"
//   replMode: true   ->  -32603  "Internal error"
//
// Neither message is worth putting in front of a caller, and the second one says nothing at
// all, so both are recognised here and answered with our own text.
//
// -32603 is JSON-RPC's generic "Internal error" though, not a fingerprint for termination:
// every other internal failure in the protocol can carry it too. Claiming a timeout kill on
// the code alone would answer an unrelated fault with a confident, fully wrong sentence and
// swallow the real error, so it is only trusted once the kill we asked for is actually due.
// `elapsedMs` is measured from before the command is sent, while Chrome starts its own
// `timeout` clock only after receiving it, so a genuine kill always lands on the far side.
const isExecutionTerminated = (err: unknown, elapsedMs: number): boolean => {
  const response = (err as { response?: { code?: number; message?: string } })?.response;
  if (response?.message === 'Execution was terminated') return true;
  return response?.code === -32603 && elapsedMs >= EVAL_EXECUTION_TIMEOUT_MS;
};

const timedOut = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

// ── Page inspection tools ─────────────────────────────────────────────────────
//
// Every tool here is a bare Runtime.evaluate / Page.captureScreenshot, so this group
// needs nothing but getClient — no session state at all.
//
// Every one of them is also bounded. A CDP command sent to a renderer that is paused,
// looping, or sitting on a modal neither returns nor rejects (see timeout.ts), so "read the
// title" is just as capable of hanging forever as evaluating an arbitrary expression is —
// the difference is only in how surprising it looks when it happens.

export function registerPageTools(server: McpServer, getClient: () => Promise<CDP.Client | null>): void {
  server.registerTool(
    'get_title',
    {
      description: 'Get the title of the currently connected tab (`document.title`).',
      inputSchema: z.object({}),
      annotations: {
        title: 'Get page title',
        readOnlyHint: true,
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      const result = await withTimeout(
        client.Runtime.evaluate({ expression: 'document.title', returnByValue: true }),
        PAGE_COMMAND_TIMEOUT_MS,
      );
      if (result === TIMED_OUT) return rendererTimedOut('get_title');
      return { content: [{ type: 'text', text: String(result.result.value) }] };
    },
  );

  server.registerTool(
    'get_url',
    {
      description: 'Get the URL of the currently connected tab (`location.href`).',
      inputSchema: z.object({}),
      annotations: {
        title: 'Get page URL',
        readOnlyHint: true,
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      const result = await withTimeout(
        client.Runtime.evaluate({ expression: 'location.href', returnByValue: true }),
        PAGE_COMMAND_TIMEOUT_MS,
      );
      if (result === TIMED_OUT) return rendererTimedOut('get_url');
      return { content: [{ type: 'text', text: String(result.result.value) }] };
    },
  );

  server.registerTool(
    'get_html',
    {
      description:
        'Get the full HTML source of the currently connected tab (`document.documentElement.outerHTML`). ' +
        `Truncated to ${MAX_HTML_LENGTH} characters for large pages; a truncated result ends with a ` +
        '`…` marker giving how much was cut and the real length of the document, so a short result is never ' +
        'ambiguous between "small page" and "cut off here".',
      inputSchema: z.object({}),
      annotations: {
        title: 'Get page HTML',
        readOnlyHint: true,
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      const result = await withTimeout(
        client.Runtime.evaluate({
          // Truncated in the page, not on arrival. Slicing here would mean serialising the
          // whole document AND putting all of it on the wire, only to keep the first 20k.
          // Measured, Chrome 141, a 500,000-node document — 25.5MB of outerHTML: 482ms to
          // serialise, 1127ms to transfer. Slicing at the source drops that second number
          // entirely, ~70% of the call, for a byte-identical result.
          //
          // The serialisation itself is not avoidable: `outerHTML` has to build the whole
          // string before anything can take a slice of it. `length` is read off that same
          // string, so reporting the real size costs one number rather than a second pass.
          expression: `
            (() => {
              const html = document.documentElement.outerHTML;
              return { html: html.slice(0, ${MAX_HTML_LENGTH}), totalLength: html.length };
            })()
          `,
          returnByValue: true,
        }),
        PAGE_COMMAND_TIMEOUT_MS,
      );
      if (result === TIMED_OUT) return rendererTimedOut('get_html');
      const { html, totalLength } = result.result.value as { html: string; totalLength: number };
      // Marked rather than silently cut, and marked in the same `… (+N chars)` idiom formatUrl
      // uses. Without it a 20,000-character result is indistinguishable from a page that
      // happens to be exactly that size, and reading truncated markup as the whole document is
      // how "the element isn't in the DOM" gets concluded about an element that is.
      const text =
        totalLength > MAX_HTML_LENGTH
          ? `${html}
… (+${totalLength - MAX_HTML_LENGTH} chars truncated — document is ${totalLength} characters)`
          : html;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'evaluate_js',
    {
      description:
        'Evaluate a JavaScript expression in the page, in global scope, with the same semantics as the DevTools console. ' +
        'Returns the real value when it serialises; objects that cannot (DOM nodes, Errors, Maps, class instances) come back ' +
        'as a preview instead: class name plus a first level of properties, marked `…` where Chrome truncated it — readable, ' +
        'not parseable as the value. ' +
        'Top-level `await` works, but an expression that merely RETURNS a promise is NOT awaited — it comes back as a ' +
        'pending Promise, exactly as in the console. ' +
        'The call returns as soon as your expression finishes its synchronous work, before queued microtasks run, so the state ' +
        'triggered by a click is not visible in the same call: put `await Promise.resolve()` between the click and ' +
        'the read, or read in a second call. ' +
        'At a breakpoint this still evaluates globally and cannot see local or closure variables — use evaluate_at_frame for those. ' +
        'For the element selected in the Elements panel ($0), use get_inspected_element.',
      inputSchema: z.object({ expression: z.string() }),
      annotations: {
        title: 'Evaluate JS',
      },
    },
    async ({ expression }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      // Evaluated exactly once, in preview mode. Asking for the value here instead would
      // silently flatten DOM nodes, Errors, Maps and class instances, and retrying after
      // its -32000 would re-run the expression — see remote-object.ts.
      //
      // `replMode` is what the DevTools console itself passes, and it is the switch that
      // enables top-level `await`; `awaitPromise` is deliberately NOT set alongside it.
      // The two are not freely combinable — measured, Chrome 141:
      //
      //   replMode  awaitPromise   `(async () => { await sleep(800); return 'R' })()`
      //   false     false          Promise            (3ms)
      //   false     true           'R'                (1217ms — really waited)
      //   true      false          Promise            (2ms)
      //   true      true           Promise            (2ms — awaitPromise is INERT)
      //
      // replMode wraps the expression in an async function and resolves that wrapper itself,
      // which is both how top-level `await` works under `awaitPromise: false` and why
      // `awaitPromise` has nothing left to act on. So "console semantics plus auto-await" is
      // not a reachable combination, and passing awaitPromise here would only be dead weight
      // that reads as if it did something.
      const startedAt = Date.now();
      const evaluation = client.Runtime.evaluate({
        expression,
        returnByValue: false,
        generatePreview: true,
        replMode: true,
        timeout: EVAL_EXECUTION_TIMEOUT_MS,
      });
      // The settle race below abandons this promise on timeout. Without a handler of its own,
      // a later rejection would surface as an unhandledRejection with nobody listening.
      evaluation.catch(() => {});

      let result;
      try {
        const settled = await withTimeout(evaluation, EVAL_SETTLE_TIMEOUT_MS);
        if (settled === TIMED_OUT) {
          return timedOut(
            `Error: expression did not settle within ${EVAL_SETTLE_TIMEOUT_MS}ms. It is suspended on something ` +
              'that has not resolved — a pending promise, a request that never returns. The page is still running it.',
          );
        }
        result = settled;
      } catch (err) {
        if (!isExecutionTerminated(err, Date.now() - startedAt)) throw err;
        return timedOut(
          `Error: expression was terminated after ${EVAL_EXECUTION_TIMEOUT_MS}ms of execution — it was still ` +
            'running (an infinite loop, or a blocking computation). The tab was not left spinning.',
        );
      }

      if (result.exceptionDetails) {
        const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
      const text = await renderValueFirst(client, result.result);
      releaseRemoteObject(client, result.result);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'get_computed_style',
    {
      description: 'Get computed CSS values for the given properties on the element matched by selector.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector for the target element'),
        properties: z.array(z.string()).min(1).describe('CSS property names to return (kebab-case or camelCase)'),
      }),
      outputSchema: z.object({
        styles: z
          .record(z.string(), z.string())
          .describe(
            'Map of property name → computed value. Keys match the input `properties` verbatim (case preserved). Values are `getComputedStyle` output; unknown properties yield empty string.',
          ),
      }),
      annotations: {
        title: 'Get computed style',
        readOnlyHint: true,
      },
    },
    async ({ selector, properties }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
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
      const result = await withTimeout(
        client.Runtime.evaluate({ expression, returnByValue: true }),
        PAGE_COMMAND_TIMEOUT_MS,
      );
      if (result === TIMED_OUT) return rendererTimedOut('get_computed_style');
      if (result.result.value === null) {
        return {
          content: [{ type: 'text', text: `No element matches selector: ${selector}` }],
          isError: true,
        };
      }
      const styles = result.result.value as Record<string, string>;
      return {
        content: [{ type: 'text', text: JSON.stringify(styles, null, 2) }],
        structuredContent: { styles },
      };
    },
  );

  // `Page.captureScreenshot` is the one command here that is not a query: it waits for the
  // compositor to hand over a frame. A tab whose frames are not being produced — backgrounded
  // within its window, its window minimised or fully occluded — answers it with neither a
  // value nor an error, and the renderer itself is perfectly healthy throughout. So this tool
  // gets a recovery step rather than only a bound.
  //
  // Bringing the tab forward is what actually ends that wait, and it is the RETRY rather than
  // a precondition because it steals whatever tab the user is looking at — too rude to pay on
  // every call for a fault that is occasional. Measured, Chrome 141, against a page target
  // reporting `document.visibilityState === "hidden"` whose window was still on screen:
  // capture returned in 137ms. So `hidden` is not the trigger and a pre-emptive activate would
  // be spent for nothing nearly every time; frames were still being produced. What the hang
  // needs is the surface to be gone, which is why it reads as "worked all session, then one
  // call didn't".
  //
  // The abandoned first capture is left pending deliberately. Once the tab comes forward both
  // captures resolve off the same frame; nothing is listening to the first one.
  server.registerTool(
    'screenshot',
    {
      description:
        'Capture a PNG screenshot of the current viewport (the visible page area only — not the full scrollable page, not the browser chrome, not DevTools). If the tab is not on screen it is brought to the front first, which changes what the user is looking at.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Screenshot',
        readOnlyHint: true,
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;

      const capture = () => {
        const shot = client.Page.captureScreenshot({ format: 'png' });
        // Abandoned by the race on timeout; without a handler of its own a later rejection
        // would surface as an unhandledRejection with nobody listening.
        shot.catch(() => {});
        return withTimeout(shot, SCREENSHOT_TIMEOUT_MS);
      };

      let result = await capture();

      if (result === TIMED_OUT) {
        const front = client.Page.bringToFront();
        front.catch(() => {});
        if ((await withTimeout(front, BRING_TO_FRONT_TIMEOUT_MS)) === TIMED_OUT) {
          return timedOut(
            `Error: screenshot timed out after ${SCREENSHOT_TIMEOUT_MS}ms, and the tab could not be brought ` +
              'to the front either. Chrome is not answering for this target at all — check the window still exists.',
          );
        }
        result = await capture();
      }

      if (result === TIMED_OUT) {
        return timedOut(
          `Error: screenshot timed out after ${SCREENSHOT_TIMEOUT_MS}ms, twice — once before bringing the tab ` +
            'to the front and once after. The tab is not producing frames (minimised or fully occluded window), ' +
            'or its renderer is blocked. Nothing was captured.',
        );
      }

      return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
    },
  );

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
  server.registerTool(
    'get_inspected_element',
    {
      description:
        'Get the element marked for MCP inspection. To mark an element: select it in the Elements panel, then run `window.$0 = $0` in the DevTools console.',
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
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      const result = await withTimeout(
        client.Runtime.evaluate({
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
        }),
        PAGE_COMMAND_TIMEOUT_MS,
      );
      if (result === TIMED_OUT) return rendererTimedOut('get_inspected_element');
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
      const el = result.result.value as {
        tagName: string;
        id?: string;
        className?: string;
        attributes: Record<string, string>;
        outerHTML: string;
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(el, null, 2) }],
        structuredContent: el,
      };
    },
  );
}

import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { z } from 'zod';
import pkgInfo from '../package.json' with { type: 'json' };

interface DebuggerState {
  paused: boolean;
  callFrames: any[];
  pauseReason: string;
  hitBreakpoints: string[];
}

interface ConsoleEntry {
  timestamp: string;
  type: string;
  text: string;
  stackTrace?: Array<{
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  }>;
}

const NOT_CONNECTED = {
  content: [
    {
      type: 'text' as const,
      text: 'Chrome is not connected. Launch Chrome with:\n  --remote-debugging-port=9222 --user-data-dir=<path>\nThen try again.',
    },
  ],
};

const MAX_CONSOLE_LOGS = 500;

export function createServer(
  getClient: () => Promise<CDP.Client | null>,
  switchToTarget: (targetId: string) => Promise<CDP.Client | null>,
  getCurrentTargetId: () => string | null,
) {
  const debuggerState: DebuggerState = {
    paused: false,
    callFrames: [],
    pauseReason: '',
    hitBreakpoints: [],
  };

  // breakpointId -> human-readable label ("url:line")
  const activeBreakpoints = new Map<string, string>();

  // scriptId -> { url, sourceMapURL }; populated by Debugger.scriptParsed
  const scriptRegistry = new Map<string, { url: string; sourceMapURL?: string }>();
  // script url -> parsed TraceMap (null = no source map or fetch failed)
  const sourceMapCache = new Map<string, TraceMap | null>();

  // Circular buffer for console messages and uncaught exceptions.
  const consoleLogs: ConsoleEntry[] = [];

  // Track which client the event listeners are registered on.
  // When getClient() returns a different instance (reconnect), we re-register
  // and reset stale debugger state — this is the "reconnect cleanup" point.
  let registeredOnClient: CDP.Client | null = null;

  const ensureDebuggerEvents = async (client: CDP.Client): Promise<void> => {
    if (registeredOnClient === client) return;
    registeredOnClient = client;

    // Reset stale state from the previous Chrome session.
    debuggerState.paused = false;
    debuggerState.callFrames = [];
    debuggerState.pauseReason = '';
    debuggerState.hitBreakpoints = [];
    activeBreakpoints.clear();
    scriptRegistry.clear();
    sourceMapCache.clear();
    consoleLogs.length = 0;

    // ── Console / exception event listeners ──────────────────────────────────

    // Format a Runtime.StackTrace into resolved (source-mapped) frames.
    const formatStackTrace = async (stackTrace: any): Promise<ConsoleEntry['stackTrace']> => {
      if (!stackTrace?.callFrames?.length) return undefined;
      return Promise.all(
        stackTrace.callFrames.map(async (frame: any) => {
          const line0: number = frame.lineNumber ?? 0;
          const col: number = frame.columnNumber ?? 0;
          const orig = frame.scriptId
            ? await resolveOriginalPosition(frame.scriptId, line0, col)
            : null;
          return {
            functionName: frame.functionName || '(anonymous)',
            url: orig?.source ?? frame.url ?? '',
            lineNumber: orig?.line ?? line0 + 1,
            columnNumber: orig?.column ?? col,
          };
        }),
      );
    };

    // Console.messageAdded covers both historical and new messages.
    // Chrome replays all existing Console entries when Console.enable() is called,
    // then continues delivering new ones — so we capture what is already visible
    // in DevTools before this server connected.
    //
    // source === 'javascript' + level === 'error' → uncaught exception (not a console.error call).
    client.Console.on('messageAdded', async (event: any) => {
      const msg = event.message;
      const type: string =
        msg.source === 'javascript' && msg.level === 'error' ? 'exception' : (msg.level as string);
      const stackTrace = msg.stackTrace
        ? await formatStackTrace(msg.stackTrace)
        : undefined;
      consoleLogs.push({
        timestamp: new Date().toISOString(),
        type,
        text: msg.text as string,
        ...(stackTrace?.length ? { stackTrace } : {}),
      });
      if (consoleLogs.length > MAX_CONSOLE_LOGS) consoleLogs.shift();
    });

    // Console domain is marked @deprecated in CDP in favour of Runtime.consoleAPICalled +
    // Log.entryAdded, but those alternatives do NOT replay history. Console.enable() is the
    // only mechanism that replays all messages already visible in DevTools before this server
    // connected — which is the core requirement here.  The @deprecated hint is intentional.
    await client.Console.enable();

    client.Debugger.on('scriptParsed', (event: any) => {
      if (event.url) {
        scriptRegistry.set(event.scriptId, {
          url: event.url,
          sourceMapURL: event.sourceMapURL || undefined,
        });
      }
    });

    client.Debugger.on('paused', (event: any) => {
      debuggerState.paused = true;
      debuggerState.callFrames = event.callFrames;
      debuggerState.pauseReason = event.reason;
      debuggerState.hitBreakpoints = event.hitBreakpoints ?? [];
    });

    client.Debugger.on('resumed', () => {
      debuggerState.paused = false;
      debuggerState.callFrames = [];
      debuggerState.pauseReason = '';
      debuggerState.hitBreakpoints = [];
    });

    // Set up a one-time listener BEFORE enable so Chrome's initial 'paused' event
    // (if execution is already stopped) is caught and updates debuggerState.
    const initialPauseSettled = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 200);
      (client as any).once('Debugger.paused', () => { clearTimeout(timer); resolve(); });
    });

    // First-ever enable for this client — Chrome fires 'paused' here if already stopped.
    await client.Debugger.enable({});
    await initialPauseSettled;
  };

  const fetchTraceMap = async (scriptUrl: string, sourceMapURL: string): Promise<TraceMap | null> => {
    try {
      let raw: string;
      if (sourceMapURL.startsWith('data:')) {
        const b64 = sourceMapURL.slice(sourceMapURL.indexOf(',') + 1);
        raw = Buffer.from(b64, 'base64').toString('utf-8');
      } else {
        const mapUrl = new URL(sourceMapURL, scriptUrl).href;
        const res = await fetch(mapUrl);
        if (!res.ok) return null;
        raw = await res.text();
      }
      return new TraceMap(raw);
    } catch {
      return null;
    }
  };

  const resolveOriginalPosition = async (scriptId: string, line0: number, col: number) => {
    const script = scriptRegistry.get(scriptId);
    if (!script?.sourceMapURL) return null;

    if (!sourceMapCache.has(script.url)) {
      sourceMapCache.set(script.url, await fetchTraceMap(script.url, script.sourceMapURL));
    }
    const tracer = sourceMapCache.get(script.url);
    if (!tracer) return null;

    // trace-mapping uses 0-based line and column
    const pos = originalPositionFor(tracer, { line: line0 + 1, column: col });
    if (pos.source == null) return null;
    return { source: pos.source, line: pos.line, column: pos.column, name: pos.name ?? undefined };
  };

  // Resolves true when the next paused event arrives, false on timeout.
  // Call BEFORE issuing the step command to avoid missing the event.
  const waitForNextPause = (client: CDP.Client, timeoutMs = 5000): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      (client as any).once('Debugger.paused', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  const formatCallStack = async () =>
    Promise.all(
      debuggerState.callFrames.map(async (frame: any, index: number) => {
        const line0 = frame.location.lineNumber;
        const col = frame.location.columnNumber ?? 0;
        const orig = await resolveOriginalPosition(frame.location.scriptId, line0, col);
        return {
          index,
          functionName: frame.functionName || '(anonymous)',
          url: orig?.source ?? frame.url,
          lineNumber: orig?.line ?? line0 + 1,
          columnNumber: orig?.column ?? col,
          ...(orig && { compiledUrl: frame.url, compiledLine: line0 + 1 }),
          scopeTypes: (frame.scopeChain ?? []).map((s: any) => s.type),
        };
      }),
    );

  const server = new McpServer({
    name: pkgInfo.name,
    version: pkgInfo.version,
  });

  // ── Tab management tools ────────────────────────────────────────────────────

  server.registerTool(
    'list_tabs',
    {
      description: 'List all open Chrome page tabs with their targetIds, titles, and URLs. When you are unsure which tab to inspect, call this proactively to discover available tabs, then present the list to the user and ask which one to switch to — do NOT tell the user to switch tabs manually in Chrome.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const targets = (await CDP.List({ host: '127.0.0.1', port: 9222 })) as Array<{
          id: string;
          type: string;
          title: string;
          url: string;
        }>;
        const activeId = getCurrentTargetId();
        const result: Record<string, { title: string; url: string; active?: true }> = {};
        for (const t of targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))) {
          result[t.id] = t.id === activeId
            ? { title: t.title, url: t.url, active: true }
            : { title: t.title, url: t.url };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch {
        return NOT_CONNECTED;
      }
    },
  );

  server.registerTool(
    'switch_tab',
    {
      description: 'Switch the MCP connection to a specific Chrome tab. Use list_tabs first to get available targetIds.',
      inputSchema: z.object({
        targetId: z.string().describe('Target ID from list_tabs'),
      }),
    },
    async ({ targetId }) => {
      const client = await switchToTarget(targetId);
      if (!client) {
        return { content: [{ type: 'text', text: `Failed to connect to tab ${targetId}. Use list_tabs to check available targets.` }] };
      }
      await ensureDebuggerEvents(client);
      const result = await client.Runtime.evaluate({ expression: 'document.title + " — " + location.href', returnByValue: true });
      return { content: [{ type: 'text', text: `Switched to: ${String(result.result.value)}` }] };
    },
  );

  // ── Page inspection tools ───────────────────────────────────────────────────

  server.registerTool(
    'get_title',
    {
      description: 'Get current page title',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      const result = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
      return { content: [{ type: 'text', text: String(result.result.value) }] };
    },
  );

  server.registerTool(
    'get_url',
    {
      description: 'Get current page url',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      const result = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
      return { content: [{ type: 'text', text: String(result.result.value) }] };
    },
  );

  server.registerTool(
    'get_html',
    {
      description: 'Get current page html',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      const result = await client.Runtime.evaluate({
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      });
      return { content: [{ type: 'text', text: String(result.result.value).slice(0, 20000) }] };
    },
  );

  server.registerTool(
    'evaluate_js',
    {
      description: 'Evaluate javascript in page. To access the currently selected element in the Elements panel ($0), use get_inspected_element instead.',
      inputSchema: z.object({ expression: z.string() }),
    },
    async ({ expression }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      const result = await client.Runtime.evaluate({
        expression,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        return { content: [{ type: 'text', text: `Error: ${msg}` }] };
      }
      const { value, type, description } = result.result;
      const text =
        value !== undefined
          ? JSON.stringify(value, null, 2)
          : description ?? type ?? 'undefined';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'get_computed_style',
    {
      description:
        'Get computed CSS values for the given properties on the element matched by selector.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector for the target element'),
        properties: z
          .array(z.string())
          .min(1)
          .describe('CSS property names to return (kebab-case or camelCase)'),
      }),
      outputSchema: z.object({
        styles: z.record(z.string(), z.string()),
      }),
      annotations: {
        title: 'Get computed style',
        readOnlyHint: true,
      },
    },
    async ({ selector, properties }) => {
      const client = await getClient();
      if (!client) return { ...NOT_CONNECTED, isError: true };
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
      const styles = result.result.value as Record<string, string>;
      return {
        content: [{ type: 'text', text: JSON.stringify(styles, null, 2) }],
        structuredContent: { styles },
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
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      const result = await client.Page.captureScreenshot({ format: 'png' });
      return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
    },
  );

  server.registerTool(
    'get_inspected_element',
    {
      description:
        'Get the element marked for MCP inspection. To mark an element: select it in the Elements panel, then run `window.$0 = $0` in the DevTools console. Returns tag, id, classes, attributes, and outerHTML.',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
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
          content: [{ type: 'text', text: 'No element marked. Select an element in the Elements panel, then run `window.$0 = $0` in the DevTools console.' }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.result.value, null, 2) }] };
    },
  );

  // ── Debugger tools ──────────────────────────────────────────────────────────

  server.registerTool(
    'get_debugger_state',
    {
      description:
        'Get current debugger state: whether execution is paused, the pause reason, hit breakpoints, and the full call stack with file/line info.',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);

      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: JSON.stringify({ paused: false }, null, 2) }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                paused: true,
                reason: debuggerState.pauseReason,
                hitBreakpoints: debuggerState.hitBreakpoints,
                callStack: await formatCallStack(),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_scope_variables',
    {
      description:
        'Inspect variable values in a call frame scope. Only works when execution is paused. Use get_debugger_state first to find available frame indices.',
      inputSchema: z.object({
        frameIndex: z.number().default(0).describe('Call frame index (0 = top frame)'),
        scopeType: z
          .enum(['local', 'closure', 'block', 'global', 'script', 'module'])
          .default('local')
          .describe('Scope type to inspect'),
      }),
    },
    async ({ frameIndex, scopeType }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);

      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Debugger is not paused.' }] };
      }
      const frame = debuggerState.callFrames[frameIndex];
      if (!frame) {
        return { content: [{ type: 'text', text: `No call frame at index ${frameIndex}.` }] };
      }
      const scope = (frame.scopeChain ?? []).find((s: any) => s.type === scopeType);
      if (!scope) {
        const available = (frame.scopeChain ?? []).map((s: any) => s.type).join(', ');
        return {
          content: [
            {
              type: 'text',
              text: `No "${scopeType}" scope in frame ${frameIndex}. Available: ${available}`,
            },
          ],
        };
      }
      const props = await client.Runtime.getProperties({
        objectId: scope.object.objectId,
        ownProperties: true,
        generatePreview: true,
      });
      const variables = (props.result ?? [])
        .filter((p: any) => !p.name.startsWith('__'))
        .map((p: any) => ({
          name: p.name,
          type: p.value?.type,
          value: p.value?.value ?? p.value?.description,
          preview: p.value?.preview?.description,
        }));
      return { content: [{ type: 'text', text: JSON.stringify(variables, null, 2) }] };
    },
  );

  server.registerTool(
    'set_breakpoint',
    {
      description:
        'Set a breakpoint by URL (exact or regex) + line number. Returns `{ breakpointId, resolvedLocations }`. `resolvedLocations` may be empty if the script is not loaded yet — the breakpoint will resolve later when Chrome parses it.',
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe('Exact script URL. Provide this or urlRegex; if both, urlRegex takes precedence.'),
        lineNumber: z.number().int().min(1).describe('Line number (1-indexed)'),
        columnNumber: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Column number, 1-indexed (optional)'),
        condition: z
          .string()
          .optional()
          .describe('JS expression; breakpoint triggers only when truthy'),
        urlRegex: z
          .string()
          .optional()
          .describe('URL regex pattern. Provide this or url; if both, urlRegex takes precedence.'),
      }),
      annotations: {
        title: 'Set breakpoint',
        idempotentHint: true,
      },
    },
    async ({ url, lineNumber, columnNumber, condition, urlRegex }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      if (!url && !urlRegex) {
        return {
          content: [{ type: 'text', text: 'Must provide either url or urlRegex.' }],
        };
      }
      await ensureDebuggerEvents(client);

      const params: {
        lineNumber: number;
        columnNumber?: number;
        condition?: string;
        url?: string;
        urlRegex?: string;
      } = {
        lineNumber: lineNumber - 1,
        ...(columnNumber !== undefined && { columnNumber: columnNumber - 1 }),
        ...(condition && { condition }),
        ...(urlRegex ? { urlRegex } : { url }),
      };
      const result = await client.Debugger.setBreakpointByUrl(params);
      const label = `${urlRegex ?? url}:${lineNumber}`;
      activeBreakpoints.set(result.breakpointId, label);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { breakpointId: result.breakpointId, resolvedLocations: result.locations },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'remove_breakpoint',
    {
      description:
        'Remove a breakpoint by ID. The ID is invalidated; use set_breakpoint to restore (returns a new ID).',
      inputSchema: z.object({ breakpointId: z.string() }),
      annotations: {
        title: 'Remove breakpoint',
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ breakpointId }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);
      try {
        await client.Debugger.removeBreakpoint({ breakpointId });
      } finally {
        activeBreakpoints.delete(breakpointId);
      }
      return { content: [{ type: 'text', text: `Removed breakpoint ${breakpointId}.` }] };
    },
  );

  server.registerTool(
    'list_breakpoints',
    {
      description:
        'List breakpoints tracked by this server (set via `set_breakpoint`). Returns `[{ breakpointId, location }]`. Breakpoints set outside this server (DevTools UI, other CDP clients, prior sessions) are not visible — CDP has no API to enumerate them.',
      inputSchema: z.object({}),
      annotations: {
        title: 'List breakpoints',
        readOnlyHint: true,
      },
    },
    async () => {
      const list = Array.from(activeBreakpoints.entries()).map(([id, label]) => ({
        breakpointId: id,
        location: label,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    },
  );

  server.registerTool(
    'pause_execution',
    {
      description:
        'Pause JavaScript execution immediately. After pausing, use get_debugger_state to inspect the call stack.',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);
      await client.Debugger.pause();
      return {
        content: [
          { type: 'text', text: 'Pause command sent. Call get_debugger_state to inspect the current position.' },
        ],
      };
    },
  );

  server.registerTool(
    'resume_execution',
    {
      description: 'Resume JavaScript execution after a breakpoint or pause.',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);
      await client.Debugger.resume({});
      return { content: [{ type: 'text', text: 'Execution resumed.' }] };
    },
  );

  server.registerTool(
    'step_over',
    {
      description:
        'Execute the current line and pause at the next line (does not enter function calls). Returns the new call stack position.',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);
      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Not paused. Cannot step.' }] };
      }
      const pausePromise = waitForNextPause(client);
      await client.Debugger.stepOver({});
      const paused = await pausePromise;
      if (!paused) {
        return {
          content: [{ type: 'text', text: 'Stepped over — execution did not pause again (no more breakpoints).' }],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { paused: true, reason: debuggerState.pauseReason, callStack: await formatCallStack() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'step_into',
    {
      description:
        'Step into the function call on the current line. Returns the new call stack position.',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);
      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Not paused. Cannot step.' }] };
      }
      const pausePromise = waitForNextPause(client);
      await client.Debugger.stepInto({});
      const paused = await pausePromise;
      if (!paused) {
        return { content: [{ type: 'text', text: 'Stepped into — execution did not pause again.' }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { paused: true, reason: debuggerState.pauseReason, callStack: await formatCallStack() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'evaluate_at_frame',
    {
      description:
        'Evaluate a JavaScript expression in the scope of a paused call frame. Unlike evaluate_js, this has access to local variables, closure variables, and the current `this`. Only works when execution is paused.',
      inputSchema: z.object({
        expression: z.string().describe('JS expression to evaluate'),
        frameIndex: z.number().default(0).describe('Call frame index (0 = top frame); use get_debugger_state to find available frames'),
      }),
    },
    async ({ expression, frameIndex }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);

      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Debugger is not paused. Use evaluate_js for global-scope evaluation.' }] };
      }
      const frame = debuggerState.callFrames[frameIndex];
      if (!frame) {
        return { content: [{ type: 'text', text: `No call frame at index ${frameIndex}.` }] };
      }

      const result = await client.Debugger.evaluateOnCallFrame({
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: false,
        generatePreview: true,
      });

      if (result.exceptionDetails) {
        const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        return { content: [{ type: 'text', text: `Error: ${msg}` }] };
      }

      const r = result.result;
      let text: string;
      if (r.value !== undefined) {
        text = JSON.stringify(r.value, null, 2);
      } else if (r.preview) {
        const props = (r.preview.properties ?? [])
          .map((p: any) => `  ${p.name}: ${p.value}`)
          .join(',\n');
        text = `${r.preview.description ?? r.type} {\n${props}\n}`;
      } else {
        text = r.description ?? r.type ?? 'undefined';
      }
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'step_out',
    {
      description:
        'Step out of the current function and pause at the caller. Returns the new call stack position.',
      inputSchema: z.object({}),
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);
      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Not paused. Cannot step.' }] };
      }
      const pausePromise = waitForNextPause(client);
      await client.Debugger.stepOut();
      const paused = await pausePromise;
      if (!paused) {
        return { content: [{ type: 'text', text: 'Stepped out — execution did not pause again.' }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { paused: true, reason: debuggerState.pauseReason, callStack: await formatCallStack() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── Console log tool ───────────────────────────────────────────────────────

  server.registerTool(
    'get_console_logs',
    {
      description:
        'Return browser console messages and uncaught exceptions. ' +
        'Includes messages already visible in DevTools before this server connected, ' +
        'plus new output produced afterwards. ' +
        'Exceptions are reported with their full stack trace (source-mapped when available).',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONSOLE_LOGS)
          .default(100)
          .describe('Maximum number of most-recent entries to return'),
        level: z
          .enum(['log', 'info', 'debug', 'warning', 'error', 'exception'])
          .optional()
          .describe('Filter by log level / type. Omit to return all levels.'),
        clear: z
          .boolean()
          .default(false)
          .describe('Clear the buffer after returning entries'),
      }),
    },
    async ({ limit, level, clear }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);

      const filtered = level
        ? consoleLogs.filter((e) => e.type === level)
        : consoleLogs;
      const entries = filtered.slice(-limit);

      if (clear) consoleLogs.length = 0;

      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No console entries captured yet.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
    },
  );

  return server;
}

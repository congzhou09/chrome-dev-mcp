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
  isError: true,
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
      outputSchema: z.object({
        tabs: z.array(
          z.object({
            targetId: z.string(),
            title: z.string(),
            url: z.string(),
            active: z.boolean().describe('True if this tab is the current MCP target'),
          }),
        ),
      }),
      annotations: {
        title: 'List tabs',
        readOnlyHint: true,
      },
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
        const tabs = targets
          .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
          .map((t) => ({
            targetId: t.id,
            title: t.title,
            url: t.url,
            active: t.id === activeId,
          }));
        return {
          content: [{ type: 'text', text: JSON.stringify(tabs, null, 2) }],
          structuredContent: { tabs },
        };
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
      outputSchema: z.object({
        targetId: z.string(),
        title: z.string(),
        url: z.string(),
      }),
      annotations: {
        title: 'Switch tab',
      },
    },
    async ({ targetId }) => {
      const client = await switchToTarget(targetId);
      if (!client) {
        return {
          content: [{ type: 'text', text: `Failed to connect to tab ${targetId}. Use list_tabs to check available targets.` }],
          isError: true,
        };
      }
      await ensureDebuggerEvents(client);
      const result = await client.Runtime.evaluate({
        expression: '({ title: document.title, url: location.href })',
        returnByValue: true,
      });
      const { title, url } = result.result.value as { title: string; url: string };
      return {
        content: [{ type: 'text', text: `Switched to: ${title} — ${url}` }],
        structuredContent: { targetId, title, url },
      };
    },
  );

  // ── Page inspection tools ───────────────────────────────────────────────────

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
      const result = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
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
      const result = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
      return { content: [{ type: 'text', text: String(result.result.value) }] };
    },
  );

  server.registerTool(
    'get_html',
    {
      description:
        'Get the full HTML source of the currently connected tab (`document.documentElement.outerHTML`). Truncated to 20 000 characters for large pages.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Get page HTML',
        readOnlyHint: true,
      },
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
      annotations: {
        title: 'Evaluate JS',
      },
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
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
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
      description:
        'Capture a PNG screenshot of the current viewport (the visible page area only — not the full scrollable page, not the browser chrome, not DevTools).',
      inputSchema: z.object({}),
      annotations: {
        title: 'Screenshot',
        readOnlyHint: true,
      },
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

  // ── Debugger tools ──────────────────────────────────────────────────────────

  server.registerTool(
    'get_debugger_state',
    {
      description:
        'Get current debugger state: whether execution is paused, the pause reason, hit breakpoints, and the full call stack with file/line info.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        paused: z.boolean(),
        reason: z.string().optional().describe('Pause reason (e.g. "breakpoint", "exception"). Present only when paused.'),
        hitBreakpoints: z.array(z.string()).optional().describe('IDs of breakpoints hit. Present only when paused.'),
        callStack: z
          .array(
            z.object({
              index: z.number(),
              functionName: z.string(),
              url: z.string(),
              lineNumber: z.number(),
              columnNumber: z.number(),
              compiledUrl: z.string().optional(),
              compiledLine: z.number().optional(),
              scopeTypes: z.array(z.string()),
            }),
          )
          .optional()
          .describe('Source-mapped positions when available. Present only when paused.'),
      }),
      annotations: {
        title: 'Get debugger state',
        readOnlyHint: true,
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);

      if (!debuggerState.paused) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ paused: false }, null, 2) }],
          structuredContent: { paused: false },
        };
      }
      const callStack = await formatCallStack();
      const state = {
        paused: true,
        reason: debuggerState.pauseReason,
        hitBreakpoints: debuggerState.hitBreakpoints,
        callStack,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(state, null, 2) }],
        structuredContent: state,
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
      outputSchema: z.object({
        variables: z.array(
          z.object({
            name: z.string(),
            type: z.string().optional(),
            value: z.unknown().optional(),
            preview: z.string().optional(),
          }),
        ),
      }),
      annotations: {
        title: 'Get scope variables',
        readOnlyHint: true,
      },
    },
    async ({ frameIndex, scopeType }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);

      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Debugger is not paused.' }], isError: true };
      }
      const frame = debuggerState.callFrames[frameIndex];
      if (!frame) {
        return { content: [{ type: 'text', text: `No call frame at index ${frameIndex}.` }], isError: true };
      }
      const scope = (frame.scopeChain ?? []).find((s: any) => s.type === scopeType);
      if (!scope) {
        const available = (frame.scopeChain ?? []).map((s: any) => s.type).join(', ');
        return {
          content: [{ type: 'text', text: `No "${scopeType}" scope in frame ${frameIndex}. Available: ${available}` }],
          isError: true,
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
      return {
        content: [{ type: 'text', text: JSON.stringify(variables, null, 2) }],
        structuredContent: { variables },
      };
    },
  );

  server.registerTool(
    'set_breakpoint',
    {
      description: 'Set a breakpoint by URL (exact or regex) + line number.',
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
      outputSchema: z.object({
        breakpointId: z.string(),
        resolvedLocations: z
          .array(
            z.object({
              scriptId: z.string(),
              lineNumber: z.number(),
              columnNumber: z.number().optional(),
            }),
          )
          .describe('May be empty if the script is not loaded yet; the breakpoint will bind automatically when Chrome parses the script'),
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
          isError: true,
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
      const data = { breakpointId: result.breakpointId, resolvedLocations: result.locations };
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
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
        'List breakpoints tracked by this server (set via `set_breakpoint`). Breakpoints set outside this server (DevTools UI, other CDP clients, prior sessions) are not visible — CDP has no API to enumerate them.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        breakpoints: z.array(
          z.object({
            breakpointId: z.string(),
            location: z.string().describe('Human-readable "url:line" label'),
          }),
        ),
      }),
      annotations: {
        title: 'List breakpoints',
        readOnlyHint: true,
      },
    },
    async () => {
      const breakpoints = Array.from(activeBreakpoints.entries()).map(([id, label]) => ({
        breakpointId: id,
        location: label,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(breakpoints, null, 2) }],
        structuredContent: { breakpoints },
      };
    },
  );

  server.registerTool(
    'pause_execution',
    {
      description:
        'Pause JavaScript execution immediately. After pausing, use get_debugger_state to inspect the call stack.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Pause execution',
      },
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
      annotations: {
        title: 'Resume execution',
      },
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
      annotations: {
        title: 'Step over',
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);
      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Not paused. Cannot step.' }], isError: true };
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
      annotations: {
        title: 'Step into',
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);
      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Not paused. Cannot step.' }], isError: true };
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
      annotations: {
        title: 'Evaluate at frame',
      },
    },
    async ({ expression, frameIndex }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);

      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Debugger is not paused. Use evaluate_js for global-scope evaluation.' }], isError: true };
      }
      const frame = debuggerState.callFrames[frameIndex];
      if (!frame) {
        return { content: [{ type: 'text', text: `No call frame at index ${frameIndex}.` }], isError: true };
      }

      const result = await client.Debugger.evaluateOnCallFrame({
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: false,
        generatePreview: true,
      });

      if (result.exceptionDetails) {
        const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
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
      annotations: {
        title: 'Step out',
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);
      if (!debuggerState.paused) {
        return { content: [{ type: 'text', text: 'Not paused. Cannot step.' }], isError: true };
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
      outputSchema: z.object({
        logs: z.array(
          z.object({
            timestamp: z.string(),
            type: z.string(),
            text: z.string(),
            stackTrace: z
              .array(
                z.object({
                  functionName: z.string(),
                  url: z.string(),
                  lineNumber: z.number(),
                  columnNumber: z.number(),
                }),
              )
              .optional(),
          }),
        ),
      }),
      annotations: {
        title: 'Get console logs',
        readOnlyHint: true,
      },
    },
    async ({ limit, level, clear }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await ensureDebuggerEvents(client);

      const filtered = level ? consoleLogs.filter((e) => e.type === level) : consoleLogs;
      const logs = filtered.slice(-limit);

      if (clear) consoleLogs.length = 0;

      return {
        content: logs.length === 0
          ? [{ type: 'text' as const, text: 'No console entries captured yet.' }]
          : [{ type: 'text' as const, text: JSON.stringify(logs, null, 2) }],
        structuredContent: { logs },
      };
    },
  );

  return server;
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { z } from 'zod';
import pkgInfo from '../package.json' with { type: 'json' };
const NOT_CONNECTED = {
    content: [
        {
            type: 'text',
            text: 'Chrome is not connected. Launch Chrome with:\n  --remote-debugging-port=9222 --user-data-dir=<path>\nThen try again.',
        },
    ],
};
export function createServer(getClient) {
    const debuggerState = {
        paused: false,
        callFrames: [],
        pauseReason: '',
        hitBreakpoints: [],
    };
    // breakpointId -> human-readable label ("url:line")
    const activeBreakpoints = new Map();
    // scriptId -> { url, sourceMapURL }; populated by Debugger.scriptParsed
    const scriptRegistry = new Map();
    // script url -> parsed TraceMap (null = no source map or fetch failed)
    const sourceMapCache = new Map();
    // Track which client the event listeners are registered on.
    // When getClient() returns a different instance (reconnect), we re-register
    // and reset stale debugger state — this is the "reconnect cleanup" point.
    let registeredOnClient = null;
    const ensureDebuggerEvents = async (client) => {
        if (registeredOnClient === client)
            return;
        registeredOnClient = client;
        // Reset stale state from the previous Chrome session.
        debuggerState.paused = false;
        debuggerState.callFrames = [];
        debuggerState.pauseReason = '';
        debuggerState.hitBreakpoints = [];
        activeBreakpoints.clear();
        scriptRegistry.clear();
        sourceMapCache.clear();
        client.Debugger.on('scriptParsed', (event) => {
            if (event.url) {
                scriptRegistry.set(event.scriptId, {
                    url: event.url,
                    sourceMapURL: event.sourceMapURL || undefined,
                });
            }
        });
        client.Debugger.on('paused', (event) => {
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
        const initialPauseSettled = new Promise((resolve) => {
            const timer = setTimeout(resolve, 200);
            client.once('Debugger.paused', () => { clearTimeout(timer); resolve(); });
        });
        // First-ever enable for this client — Chrome fires 'paused' here if already stopped.
        await client.Debugger.enable({});
        await initialPauseSettled;
    };
    const fetchTraceMap = async (scriptUrl, sourceMapURL) => {
        try {
            let raw;
            if (sourceMapURL.startsWith('data:')) {
                const b64 = sourceMapURL.slice(sourceMapURL.indexOf(',') + 1);
                raw = Buffer.from(b64, 'base64').toString('utf-8');
            }
            else {
                const mapUrl = new URL(sourceMapURL, scriptUrl).href;
                const res = await fetch(mapUrl);
                if (!res.ok)
                    return null;
                raw = await res.text();
            }
            return new TraceMap(raw);
        }
        catch {
            return null;
        }
    };
    const resolveOriginalPosition = async (scriptId, line0, col) => {
        const script = scriptRegistry.get(scriptId);
        if (!script?.sourceMapURL)
            return null;
        if (!sourceMapCache.has(script.url)) {
            sourceMapCache.set(script.url, await fetchTraceMap(script.url, script.sourceMapURL));
        }
        const tracer = sourceMapCache.get(script.url);
        if (!tracer)
            return null;
        // trace-mapping uses 0-based line and column
        const pos = originalPositionFor(tracer, { line: line0 + 1, column: col });
        if (pos.source == null)
            return null;
        return { source: pos.source, line: pos.line, column: pos.column, name: pos.name ?? undefined };
    };
    // Resolves true when the next paused event arrives, false on timeout.
    // Call BEFORE issuing the step command to avoid missing the event.
    const waitForNextPause = (client, timeoutMs = 5000) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        client.once('Debugger.paused', () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
    const formatCallStack = async () => Promise.all(debuggerState.callFrames.map(async (frame, index) => {
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
            scopeTypes: (frame.scopeChain ?? []).map((s) => s.type),
        };
    }));
    const server = new McpServer({
        name: pkgInfo.name,
        version: pkgInfo.version,
    });
    // ── Page inspection tools ───────────────────────────────────────────────────
    server.registerTool('get_title', {
        description: 'Get current page title',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
        return { content: [{ type: 'text', text: String(result.result.value) }] };
    });
    server.registerTool('get_url', {
        description: 'Get current page url',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
        return { content: [{ type: 'text', text: String(result.result.value) }] };
    });
    server.registerTool('get_html', {
        description: 'Get current page html',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await client.Runtime.evaluate({
            expression: 'document.documentElement.outerHTML',
            returnByValue: true,
        });
        return { content: [{ type: 'text', text: String(result.result.value).slice(0, 20000) }] };
    });
    server.registerTool('evaluate_js', {
        description: 'Evaluate javascript in page',
        inputSchema: z.object({ expression: z.string() }),
    }, async ({ expression }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await client.Runtime.evaluate({ expression, returnByValue: true });
        return { content: [{ type: 'text', text: JSON.stringify(result.result.value, null, 2) }] };
    });
    server.registerTool('get_computed_style', {
        description: 'Get computed style of element',
        inputSchema: z.object({ selector: z.string() }),
    }, async ({ selector }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
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
        const result = await client.Runtime.evaluate({ expression, returnByValue: true });
        return { content: [{ type: 'text', text: JSON.stringify(result.result.value, null, 2) }] };
    });
    server.registerTool('element_from_point', {
        description: 'Get actual top element at target position',
        inputSchema: z.object({ selector: z.string() }),
    }, async ({ selector }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
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
        const result = await client.Runtime.evaluate({ expression, returnByValue: true });
        return { content: [{ type: 'text', text: JSON.stringify(result.result.value, null, 2) }] };
    });
    server.registerTool('screenshot', {
        description: 'Capture screenshot',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        const result = await client.Page.captureScreenshot({ format: 'png' });
        return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
    });
    // ── Debugger tools ──────────────────────────────────────────────────────────
    server.registerTool('get_debugger_state', {
        description: 'Get current debugger state: whether execution is paused, the pause reason, hit breakpoints, and the full call stack with file/line info.',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        await ensureDebuggerEvents(client);
        if (!debuggerState.paused) {
            return { content: [{ type: 'text', text: JSON.stringify({ paused: false }, null, 2) }] };
        }
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        paused: true,
                        reason: debuggerState.pauseReason,
                        hitBreakpoints: debuggerState.hitBreakpoints,
                        callStack: await formatCallStack(),
                    }, null, 2),
                },
            ],
        };
    });
    server.registerTool('get_scope_variables', {
        description: 'Inspect variable values in a call frame scope. Only works when execution is paused. Use get_debugger_state first to find available frame indices.',
        inputSchema: z.object({
            frameIndex: z.number().default(0).describe('Call frame index (0 = top frame)'),
            scopeType: z
                .enum(['local', 'closure', 'block', 'global', 'script', 'module'])
                .default('local')
                .describe('Scope type to inspect'),
        }),
    }, async ({ frameIndex, scopeType }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        await ensureDebuggerEvents(client);
        if (!debuggerState.paused) {
            return { content: [{ type: 'text', text: 'Debugger is not paused.' }] };
        }
        const frame = debuggerState.callFrames[frameIndex];
        if (!frame) {
            return { content: [{ type: 'text', text: `No call frame at index ${frameIndex}.` }] };
        }
        const scope = (frame.scopeChain ?? []).find((s) => s.type === scopeType);
        if (!scope) {
            const available = (frame.scopeChain ?? []).map((s) => s.type).join(', ');
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
            .filter((p) => !p.name.startsWith('__'))
            .map((p) => ({
            name: p.name,
            type: p.value?.type,
            value: p.value?.value ?? p.value?.description,
            preview: p.value?.preview?.description,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(variables, null, 2) }] };
    });
    server.registerTool('set_breakpoint', {
        description: 'Set a breakpoint at a URL + line number. Supports exact URL match or regex. Returns a breakpointId to use with remove_breakpoint.',
        inputSchema: z.object({
            url: z.string().describe('Exact script URL, or omit to use urlRegex'),
            lineNumber: z.number().describe('Line number (1-indexed)'),
            columnNumber: z.number().optional().describe('Column number (optional)'),
            condition: z.string().optional().describe('JS expression; breakpoint triggers only when truthy'),
            urlRegex: z.string().optional().describe('URL regex pattern (alternative to exact url)'),
        }),
    }, async ({ url, lineNumber, columnNumber, condition, urlRegex }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        await ensureDebuggerEvents(client);
        const params = {
            lineNumber: lineNumber - 1,
            ...(columnNumber !== undefined && { columnNumber }),
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
                    text: JSON.stringify({ breakpointId: result.breakpointId, resolvedLocations: result.locations }, null, 2),
                },
            ],
        };
    });
    server.registerTool('remove_breakpoint', {
        description: 'Remove a breakpoint by its ID (obtained from set_breakpoint or list_breakpoints).',
        inputSchema: z.object({ breakpointId: z.string() }),
    }, async ({ breakpointId }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        await ensureDebuggerEvents(client);
        await client.Debugger.removeBreakpoint({ breakpointId });
        activeBreakpoints.delete(breakpointId);
        return { content: [{ type: 'text', text: `Removed breakpoint ${breakpointId}.` }] };
    });
    server.registerTool('list_breakpoints', {
        description: 'List all breakpoints set in this session.',
        inputSchema: z.object({}),
    }, async () => {
        const list = Array.from(activeBreakpoints.entries()).map(([id, label]) => ({
            breakpointId: id,
            location: label,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    });
    server.registerTool('pause_execution', {
        description: 'Pause JavaScript execution immediately. After pausing, use get_debugger_state to inspect the call stack.',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        await ensureDebuggerEvents(client);
        await client.Debugger.pause();
        return {
            content: [
                { type: 'text', text: 'Pause command sent. Call get_debugger_state to inspect the current position.' },
            ],
        };
    });
    server.registerTool('resume_execution', {
        description: 'Resume JavaScript execution after a breakpoint or pause.',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        await ensureDebuggerEvents(client);
        await client.Debugger.resume({});
        return { content: [{ type: 'text', text: 'Execution resumed.' }] };
    });
    server.registerTool('step_over', {
        description: 'Execute the current line and pause at the next line (does not enter function calls). Returns the new call stack position.',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
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
                    text: JSON.stringify({ paused: true, reason: debuggerState.pauseReason, callStack: await formatCallStack() }, null, 2),
                },
            ],
        };
    });
    server.registerTool('step_into', {
        description: 'Step into the function call on the current line. Returns the new call stack position.',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
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
                    text: JSON.stringify({ paused: true, reason: debuggerState.pauseReason, callStack: await formatCallStack() }, null, 2),
                },
            ],
        };
    });
    server.registerTool('step_out', {
        description: 'Step out of the current function and pause at the caller. Returns the new call stack position.',
        inputSchema: z.object({}),
    }, async () => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
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
                    text: JSON.stringify({ paused: true, reason: debuggerState.pauseReason, callStack: await formatCallStack() }, null, 2),
                },
            ],
        };
    });
    return server;
}

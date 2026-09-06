import { MAX_CONSOLE_LOGS } from './constants.js';
import { createSourceMapResolver } from './sourcemap.js';
export function createInspectorSession() {
    const debuggerState = {
        paused: false,
        callFrames: [],
        pauseReason: '',
        hitBreakpoints: [],
    };
    // breakpointId -> human-readable label ("url:line")
    const activeBreakpoints = new Map();
    const sourceMaps = createSourceMapResolver();
    // Circular buffer for console messages and uncaught exceptions.
    const consoleLogs = [];
    // Track which client the event listeners are registered on.
    // When getClient() returns a different instance (reconnect), we re-register
    // and reset stale debugger state — this is the "reconnect cleanup" point.
    let registeredOnClient = null;
    const attach = async (client) => {
        if (registeredOnClient === client)
            return;
        registeredOnClient = client;
        // Reset stale state from the previous Chrome session.
        //
        // Do NOT add the network buffer here. This function runs lazily on the first
        // debugger/console tool call, which can be minutes after connect — clearing the
        // network buffer at that point would discard everything captured since connect.
        // Network capture has its own reset in NetworkCapture.reset().
        debuggerState.paused = false;
        debuggerState.callFrames = [];
        debuggerState.pauseReason = '';
        debuggerState.hitBreakpoints = [];
        activeBreakpoints.clear();
        sourceMaps.reset();
        consoleLogs.length = 0;
        // ── Console / exception event listeners ──────────────────────────────────
        // Format a Runtime.StackTrace into resolved (source-mapped) frames.
        const formatStackTrace = async (stackTrace) => {
            if (!stackTrace?.callFrames?.length)
                return undefined;
            return Promise.all(stackTrace.callFrames.map(async (frame) => {
                const line0 = frame.lineNumber ?? 0;
                const col = frame.columnNumber ?? 0;
                const orig = frame.scriptId ? await sourceMaps.resolve(frame.scriptId, line0, col) : null;
                return {
                    functionName: frame.functionName || '(anonymous)',
                    url: orig?.source ?? frame.url ?? '',
                    lineNumber: orig?.line ?? line0 + 1,
                    columnNumber: orig?.column ?? col,
                };
            }));
        };
        // Console.messageAdded covers both historical and new messages.
        // Chrome replays all existing Console entries when Console.enable() is called,
        // then continues delivering new ones — so we capture what is already visible
        // in DevTools before this server connected.
        //
        // source === 'javascript' + level === 'error' → uncaught exception (not a console.error call).
        client.Console.on('messageAdded', async (event) => {
            const msg = event.message;
            const type = msg.source === 'javascript' && msg.level === 'error' ? 'exception' : msg.level;
            const stackTrace = msg.stackTrace ? await formatStackTrace(msg.stackTrace) : undefined;
            consoleLogs.push({
                timestamp: new Date().toISOString(),
                type,
                text: msg.text,
                ...(stackTrace?.length ? { stackTrace } : {}),
            });
            if (consoleLogs.length > MAX_CONSOLE_LOGS)
                consoleLogs.shift();
        });
        // Console domain is marked @deprecated in CDP in favour of Runtime.consoleAPICalled +
        // Log.entryAdded, but those alternatives do NOT replay history. Console.enable() is the
        // only mechanism that replays all messages already visible in DevTools before this server
        // connected — which is the core requirement here.  The @deprecated hint is intentional.
        await client.Console.enable();
        client.Debugger.on('scriptParsed', (event) => {
            if (event.url) {
                sourceMaps.registerScript(event.scriptId, event.url, event.sourceMapURL);
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
            client.once('Debugger.paused', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        // First-ever enable for this client — Chrome fires 'paused' here if already stopped.
        await client.Debugger.enable({});
        await initialPauseSettled;
    };
    return {
        attach,
        get state() {
            return debuggerState;
        },
        get breakpoints() {
            return activeBreakpoints;
        },
        addBreakpoint(id, label) {
            activeBreakpoints.set(id, label);
        },
        removeBreakpoint(id) {
            return activeBreakpoints.delete(id);
        },
        formatCallStack: () => Promise.all(debuggerState.callFrames.map(async (frame, index) => {
            const line0 = frame.location.lineNumber;
            const col = frame.location.columnNumber ?? 0;
            const orig = await sourceMaps.resolve(frame.location.scriptId, line0, col);
            return {
                index,
                functionName: frame.functionName || '(anonymous)',
                url: orig?.source ?? frame.url,
                lineNumber: orig?.line ?? line0 + 1,
                columnNumber: orig?.column ?? col,
                ...(orig && { compiledUrl: frame.url, compiledLine: line0 + 1 }),
                scopeTypes: (frame.scopeChain ?? []).map((s) => s.type),
            };
        })),
        // Resolves true when the next paused event arrives, false on timeout.
        // Call BEFORE issuing the step command to avoid missing the event.
        waitForNextPause: (client, timeoutMs = 5000) => new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), timeoutMs);
            client.once('Debugger.paused', () => {
                clearTimeout(timer);
                resolve(true);
            });
        }),
        readConsoleLogs({ limit, level }) {
            const filtered = level ? consoleLogs.filter((e) => e.type === level) : consoleLogs;
            return filtered.slice(-limit);
        },
        clearConsoleLogs() {
            consoleLogs.length = 0;
        },
    };
}

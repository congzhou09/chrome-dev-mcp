import CDP from 'chrome-remote-interface';
import { MAX_CONSOLE_LOGS } from './constants.js';
import { createSourceMapResolver } from './sourcemap.js';
import type { ConsoleEntry, DebuggerState } from './types.js';

export interface CallStackFrame {
  index: number;
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  compiledUrl?: string;
  compiledLine?: number;
  scopeTypes: string[];
}

// One lazily-attached session covering BOTH the Debugger and Console domains.
//
// They share this object rather than getting one each because they share a single attach
// point: the same client-identity check and the same reset block register the Console and
// Debugger listeners together, for the same "only pay for it on demand" reason. Splitting
// them into two sessions would mean duplicating both.
export interface InspectorSession {
  /** Idempotent per client instance; a different instance re-registers and resets. */
  attach(client: CDP.Client): Promise<void>;

  /** Read-only snapshot; tools never write it. */
  readonly state: Readonly<DebuggerState>;

  /** breakpointId -> "url:line" */
  readonly breakpoints: ReadonlyMap<string, string>;
  addBreakpoint(id: string, label: string): void;
  removeBreakpoint(id: string): boolean;

  /** Call stack with source-mapped positions where available. */
  formatCallStack(): Promise<CallStackFrame[]>;

  /** MUST be called BEFORE issuing the step command, or the event is missed. */
  waitForNextPause(client: CDP.Client, timeoutMs?: number): Promise<boolean>;

  readConsoleLogs(opts: {
    limit: number;
    level?: string;
    /** How far back to read: the three are ordered, and each one includes the newer. */
    since?: 'before-connect' | 'earlier-page-load' | 'current-page-load';
  }): ConsoleEntry[];

  /** Drops every buffered entry. Returns how many were dropped. */
  clearConsoleLogs(): number;
}

export function createInspectorSession(): InspectorSession {
  const debuggerState: DebuggerState = {
    paused: false,
    callFrames: [],
    pauseReason: '',
    hitBreakpoints: [],
  };

  // breakpointId -> human-readable label ("url:line")
  const activeBreakpoints = new Map<string, string>();

  const sourceMaps = createSourceMapResolver();

  // Circular buffer for console messages and uncaught exceptions, each stamped with the
  // page load it belongs to.
  //
  // The stamp exists because nothing else separates one page's output from the next: a
  // reload does not clear this buffer (measured — Chrome replays history only at
  // Console.enable(), so after a reload the old entries simply stay and the new ones are
  // appended), and the timestamps are this server's arrival times, which a caller would
  // have to eyeball against a navigation it cannot see. Deleting on navigation, the way
  // the network buffer prunes, was the alternative and is worse here: an error thrown
  // during unload is exactly what a caller is looking for, the buffer is capped at 500
  // small entries anyway, and the pre-connect replay is the only history there is.
  const consoleLogs: Array<ConsoleEntry & { load: number }> = [];

  // 0 is the backlog Console.enable() replays at attach — it predates this session, so it
  // belongs to no load this server watched happen. Live capture starts at 1, and every
  // main-frame navigation after that adds one.
  let loadGeneration = 0;

  // Track which client the event listeners are registered on.
  // When getClient() returns a different instance (reconnect), we re-register
  // and reset stale debugger state — this is the "reconnect cleanup" point.
  let registeredOnClient: CDP.Client | null = null;

  const clearPause = () => {
    debuggerState.paused = false;
    debuggerState.callFrames = [];
    debuggerState.pauseReason = '';
    debuggerState.hitBreakpoints = [];
  };

  const attach = async (client: CDP.Client): Promise<void> => {
    if (registeredOnClient === client) return;
    registeredOnClient = client;

    // Reset stale state from the previous Chrome session.
    //
    // Do NOT add the network buffer here. This function runs lazily on the first
    // debugger/console tool call, which can be minutes after connect — clearing the
    // network buffer at that point would discard everything captured since connect.
    // Network capture has its own reset in NetworkCapture.reset().
    clearPause();
    activeBreakpoints.clear();
    sourceMaps.reset();
    consoleLogs.length = 0;
    loadGeneration = 0;

    // ── Console / exception event listeners ──────────────────────────────────

    // Format a Runtime.StackTrace into resolved (source-mapped) frames.
    const formatStackTrace = async (stackTrace: any): Promise<ConsoleEntry['stackTrace']> => {
      if (!stackTrace?.callFrames?.length) return undefined;
      return Promise.all(
        stackTrace.callFrames.map(async (frame: any) => {
          const line0: number = frame.lineNumber ?? 0;
          const col: number = frame.columnNumber ?? 0;
          const orig = frame.scriptId ? await sourceMaps.resolve(frame.scriptId, line0, col) : null;
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
      // Read synchronously, before the first await. Resolving a stack trace takes a turn or
      // two, and the replay burst that Console.enable() answers with arrives during exactly
      // that window — stamping after the await would hand those entries the live generation.
      const load = loadGeneration;
      const msg = event.message;
      const type: string = msg.source === 'javascript' && msg.level === 'error' ? 'exception' : (msg.level as string);

      // Take the slot and the clock reading now, and fill the stack trace in afterwards.
      // Resolving one can await a source map fetch (cold cache, first exception from a
      // bundle), and everything that arrives during that fetch would otherwise be pushed
      // ahead of it — reversing an error and the log line that follows it, which is the one
      // ordering a caller reads for cause and effect.
      const entry: ConsoleEntry & { load: number } = {
        // Generation 0 is the replay: see ConsoleEntry.timestamp for why it gets none.
        ...(load === 0 ? {} : { timestamp: new Date().toISOString() }),
        load,
        type,
        text: msg.text as string,
      };
      consoleLogs.push(entry);
      if (consoleLogs.length > MAX_CONSOLE_LOGS) consoleLogs.shift();

      if (msg.stackTrace) {
        const stackTrace = await formatStackTrace(msg.stackTrace);
        // A read that lands during the fetch sees the entry without its stack, which is a
        // better answer than not seeing the exception at all.
        if (stackTrace?.length) entry.stackTrace = stackTrace;
      }
    });

    // Console domain is marked @deprecated in CDP in favour of Runtime.consoleAPICalled +
    // Log.entryAdded, but those alternatives do NOT replay history. Console.enable() is the
    // only mechanism that replays all messages already visible in DevTools before this server
    // connected — which is the core requirement here.  The @deprecated hint is intentional.
    await client.Console.enable();

    // Everything replayed above belongs to generation 0; everything from here is live.
    loadGeneration = 1;

    // One generation per main-frame navigation — a reload included, which is the case this
    // whole stamp exists for. Subframes are ignored: an iframe swapping does not make the
    // page's own output stale. (Page.enable is issued at connect time, in index.ts.)
    //
    // A main-frame navigation also ends any pause, and this is the only signal that it did.
    // Navigating away from a paused document — the toolbar reload button, F5 in DevTools, or
    // Page.reload / Page.navigate from any CDP session — discards the pause WITHOUT a
    // Debugger.resumed (measured, Chrome 154: only executionContextsCleared, frameNavigated
    // and loadEventFired follow). Only a navigation the page's own script starts, such as
    // location.reload() via evaluate, resumes first. Without this the state would keep
    // reporting call frames of a document that no longer exists. A breakpoint the new
    // document hits arrives as a fresh Debugger.paused after this event, so it is not lost.
    client.Page.on('frameNavigated', (event: any) => {
      if (!event?.frame || event.frame.parentId) return;
      loadGeneration++;
      clearPause();
    });

    client.Debugger.on('scriptParsed', (event: any) => {
      if (event.url) {
        sourceMaps.registerScript(event.scriptId, event.url, event.sourceMapURL);
      }
    });

    client.Debugger.on('paused', (event: any) => {
      debuggerState.paused = true;
      debuggerState.callFrames = event.callFrames;
      debuggerState.pauseReason = event.reason;
      debuggerState.hitBreakpoints = event.hitBreakpoints ?? [];
    });

    client.Debugger.on('resumed', clearPause);

    // Set up a one-time listener BEFORE enable so Chrome's initial 'paused' event
    // (if execution is already stopped) is caught and updates debuggerState.
    const initialPauseSettled = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 200);
      (client as any).once('Debugger.paused', () => {
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

    formatCallStack: () =>
      Promise.all(
        debuggerState.callFrames.map(async (frame: any, index: number) => {
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
            scopeTypes: (frame.scopeChain ?? []).map((s: any) => s.type),
          };
        }),
      ),

    // Resolves true when the next paused event arrives, false on timeout.
    // Call BEFORE issuing the step command to avoid missing the event.
    waitForNextPause: (client, timeoutMs = 5000) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        (client as any).once('Debugger.paused', () => {
          clearTimeout(timer);
          resolve(true);
        });
      }),

    readConsoleLogs({ limit, level, since = 'before-connect' }) {
      // The three buckets are ordered, so the filter and the label are the same question
      // asked twice: which of them an entry falls in. Naming that once keeps them from
      // drifting apart.
      const BUCKETS = ['before-connect', 'earlier-page-load', 'current-page-load'] as const;
      const bucketOf = (load: number) => (load === 0 ? 0 : load < loadGeneration ? 1 : 2);
      const floor = BUCKETS.indexOf(since);

      // Filtering before the slice is the point of `since`: `limit` would otherwise be
      // spent on a replaced page, and "no entries" is a far more useful answer than a list
      // the caller has to scan for the absence of a marker.
      const inScope = consoleLogs.filter((e) => bucketOf(e.load) >= floor && (level ? e.type === level : true));

      // Stored as a number, handed out as a label: the number only means something next to
      // the current generation, and by the time a caller reads it the page may have
      // navigated again. Only what is NOT from the page as it stands now gets marked, so an
      // unmarked entry is current — the same way an unmarked screenshot is exactly the
      // rectangle that was asked for.
      return inScope.slice(-limit).map(({ load, ...entry }) => {
        const bucket = bucketOf(load);
        return bucket === 2 ? entry : { ...entry, from: BUCKETS[bucket] };
      });
    },

    clearConsoleLogs() {
      const dropped = consoleLogs.length;
      consoleLogs.length = 0;
      return dropped;
    },
  };
}

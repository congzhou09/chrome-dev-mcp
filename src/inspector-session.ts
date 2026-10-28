import { randomBytes } from 'crypto';
import CDP from 'chrome-remote-interface';
import { MAX_CONSOLE_LOGS, PAGE_COMMAND_TIMEOUT_MS } from './constants.js';
import { createSourceMapResolver, withoutQuery, type ParsedScript, type SourceLookup } from './sourcemap.js';
import { TIMED_OUT, withTimeout } from './timeout.js';
import type { ConsoleEntry, DebuggerState } from './types.js';

export interface CallStackFrame {
  index: number;
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  compiledUrl?: string;
  compiledLine?: number;
  compiledColumn?: number;
  scopeTypes: string[];
}

/** A location in a loaded script, 1-based, with the source-mapped position beside it when there is one. */
export interface DescribedLocation {
  url: string;
  lineNumber: number;
  columnNumber: number;
  source?: string;
  sourceLine?: number;
  sourceColumn?: number;
}

/** A breakpoint dropped because the file it was set in changed. */
export interface DroppedBreakpoint {
  breakpointId: string;
  location: string;
  reason: string;
}

/** One script a `source` breakpoint was placed in, and where. */
export interface SourcePlacement {
  chromeId: string;
  scriptId: string;
  url: string;
  /** 0-based line in the loaded script, as Chrome takes it. */
  lineNumber: number;
  /** 0-based, as Chrome takes it. */
  columnNumber?: number;
  /** 1-based line of the file the placement came from. */
  sourceLine: number;
}

// One lazily-attached session covering BOTH the Debugger and Console domains.
//
// They share this object rather than getting one each because they share a single attach
// point: the same client-identity check and the same reset block register the Console and
// Debugger listeners together, for the same "only pay for it on demand" reason. Splitting
// them into two sessions would mean duplicating both.
export interface InspectorSession {
  /**
   * Idempotent per client instance; a different instance takes over: the previous one's listeners
   * come off, and it re-registers and resets. A call that arrives while another is attaching waits
   * for that one. False when it did not finish within
   * PAGE_COMMAND_TIMEOUT_MS: the attach carries on, and a later call picks it up.
   * Rejects when Chrome refuses an enable; that attempt is undone, so the next call starts over.
   */
  attach(client: CDP.Client): Promise<boolean>;

  /** Read-only snapshot; tools never write it. */
  readonly state: Readonly<DebuggerState>;

  /** breakpointId -> "url:line" */
  readonly breakpoints: ReadonlyMap<string, string>;
  /**
   * Records a breakpoint and returns a new id for it, never one of `chromeIds`.
   * `chromeIds` holds more than one when one file is loaded in several scripts and the breakpoint
   * needed a Chrome breakpoint in each; a hit on any of them is reported as the returned id
   * (see breakpointIdFor).
   */
  addBreakpoint(label: string, chromeIds: string[]): string;
  /**
   * The ids of the Chrome breakpoints `id` stands for right now: those addBreakpoint recorded,
   * replaced by new ones once followed into a new copy of their script, and none once dropped.
   */
  chromeBreakpointIds(id: string): string[];
  /** Forgets a breakpoint, a dropped one included. False if `id` is not one this session has. */
  removeBreakpoint(id: string): boolean;
  /** The id set_breakpoint returned for a Chrome breakpoint id. */
  breakpointIdFor(chromeId: string): string;

  /**
   * Watches a breakpoint set by `source`. Each later copy of a script it was placed in is checked:
   * an unchanged file carries the breakpoint into the new copy; a changed one drops it.
   */
  watchSourceBreakpoint(
    id: string,
    spec: { key: string; display: string; column?: number; condition?: string; placements: SourcePlacement[] },
  ): Promise<void>;
  /** Resolves when every pending check of a newly loaded copy is done. Await it before reporting a pause. */
  settleSourceChecks(): Promise<void>;
  /** Breakpoints dropped since the last call — each one is reported once. */
  takeDroppedBreakpoints(): DroppedBreakpoint[];
  /** Says so when the current pause is on a breakpoint that has since been dropped. */
  droppedHitNote(): string | undefined;

  /** Call stack with source-mapped positions where available. */
  formatCallStack(): Promise<CallStackFrame[]>;

  /** A file the caller names → where that code sits in the scripts Chrome loaded. */
  locateSource(path: string, line: number, column?: number): Promise<SourceLookup>;
  /** A 0-based Chrome location → the same in 1-based terms, source-mapped where possible. */
  describeLocation(scriptId: string, line0: number, col0: number): Promise<DescribedLocation>;

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
  // breakpointId -> every Chrome breakpoint behind it, and back.
  const breakpointGroups = new Map<string, string[]>();
  const groupOf = new Map<string, string>();

  // The ids callers get are this session's own, never Chrome's. Chrome names a breakpoint by its
  // place — url, lineNumber 2 and columnNumber 0 are "br:1:2:0:<url>" every time (measured, Chrome
  // 156) — so one set where an earlier one was gets that one's id back, while the earlier one may
  // still answer to it: a dropped one is still reported and named under its id, and a followed one
  // keeps its id while its Chrome breakpoint moves to a new copy.
  //
  // Never reset, attach() included: an id a caller still holds from before a tab switch must not
  // name a breakpoint set after it. The tag does the same across restarts of this server.
  const idTag = randomBytes(2).toString('hex');
  let idCount = 0;

  // Breakpoints set by `source`, followed from copy to copy of the scripts they sit in.
  //
  // Following is only ever safe while the file is unchanged. Once it changes, where the
  // breakpoint "should" be has no answer this server can give: a line inserted above makes the
  // same line number a different statement, and following the code instead is a guess Chrome's
  // own breakpoint hints already make, and get wrong in a React module (measured, Vite 7, Chrome
  // 155: the hint left it one statement early, then inside another function). Only the caller
  // made the edit, so only the caller knows — the breakpoint is dropped, and told.
  //
  // `fingerprint` is the file's own text, from the map's sourcesContent. Not the script's hash:
  // in Vite, editing util.ts rewrites App.tsx's import to "util.ts?t=…", so App.tsx's script
  // changes while App.tsx does not. The hash is only the fallback for a map without
  // sourcesContent, and for a script without a map, which is the file itself.
  type Watched = {
    id: string;
    key: string;
    display: string;
    column?: number;
    condition?: string;
    placements: Array<SourcePlacement & { base: string; fingerprint: string }>;
  };
  const watched = new Map<string, Watched>();
  // A dropped breakpoint's label, kept so a pause already on it can still be named.
  const droppedLabels = new Map<string, string>();
  let pendingDrops: DroppedBreakpoint[] = [];
  // One check at a time, in arrival order: a hot update followed by a reload is two copies, and
  // the second has to be judged against what the first left behind.
  let sourceChecks: Promise<void> = Promise.resolve();

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
  // The attach under way on registeredOnClient, or finished. Every caller waits on this one.
  let attaching: Promise<void> = Promise.resolve();

  // A listener an attach registered, by the name the client files it under: chrome-remote-interface
  // documents client.<Domain>.on(event, handler) as the same as client.on('<Domain>.<event>', handler).
  type Registered = [event: string, handler: (params: any) => void];
  // What that attach registered on registeredOnClient. Being this list is also what makes an
  // attach the current one (see attach).
  let listening: Registered[] = [];

  const labelOf = (bp: Watched) => {
    const first = bp.placements[0];
    return `${bp.display}:${first.sourceLine} → ${first.url}:${first.lineNumber + 1}`;
  };

  const fingerprintOf = (scriptId: string, file: { content: string | null }) =>
    file.content ?? `hash:${sourceMaps.scriptHash(scriptId) ?? ''}`;

  const drop = async (client: CDP.Client, bp: Watched, reason: string) => {
    const location = activeBreakpoints.get(bp.id) ?? labelOf(bp);
    watched.delete(bp.id);
    activeBreakpoints.delete(bp.id);
    // groupOf keeps its entries: a pause that already landed on one of these still has to be named.
    breakpointGroups.delete(bp.id);
    droppedLabels.set(bp.id, location);
    pendingDrops.push({ breakpointId: bp.id, location, reason });
    for (const { chromeId } of bp.placements) {
      await client.Debugger.removeBreakpoint({ breakpointId: chromeId }).catch(() => {});
    }
  };

  // A new copy of a script that watched breakpoints were placed in: Vite's "App.tsx?t=…" after a
  // hot update, or the same URL after a reload.
  //
  // This runs right as Chrome parses the copy, but the copy runs at the same time, so code it
  // executes on the spot can reach a stale breakpoint before it is removed. That pause is not
  // prevented — it is named: scriptParsed always arrives ahead of it, so by the time a tool
  // reports the pause, the drop is known (see droppedHitNote).
  const recheck = async (client: CDP.Client, script: ParsedScript, base: string, ids: string[]) => {
    for (const id of ids) {
      const bp = watched.get(id);
      const placement = bp?.placements.find((p) => p.base === base);
      if (!bp || !placement || registeredOnClient !== client) continue;

      const file = await sourceMaps.fileIn(script.scriptId, bp.key);
      if (!file) {
        await drop(client, bp, `${bp.display} is no longer part of ${script.url}`);
        continue;
      }
      if (fingerprintOf(script.scriptId, file) !== placement.fingerprint) {
        await drop(client, bp, `${bp.display} changed since this breakpoint was set`);
        continue;
      }
      const at = await sourceMaps.positionIn(script.scriptId, file.source, placement.sourceLine, bp.column);
      if (!at) {
        await drop(client, bp, `${bp.display} has no code at line ${placement.sourceLine} in ${script.url}`);
        continue;
      }
      if (
        script.url === placement.url &&
        at.lineNumber === placement.lineNumber &&
        at.columnNumber === placement.columnNumber
      ) {
        // Chrome's own URL breakpoint already bound to this copy, at the same spot.
        placement.scriptId = script.scriptId;
        continue;
      }
      // The same file, unchanged, at a new URL or laid out differently: follow it there.
      try {
        const placed = await client.Debugger.setBreakpointByUrl({
          url: script.url,
          lineNumber: at.lineNumber,
          ...(at.columnNumber !== undefined && { columnNumber: at.columnNumber }),
          ...(bp.condition && { condition: bp.condition }),
        });
        await client.Debugger.removeBreakpoint({ breakpointId: placement.chromeId }).catch(() => {});
        Object.assign(placement, {
          chromeId: placed.breakpointId,
          scriptId: script.scriptId,
          url: script.url,
          lineNumber: at.lineNumber,
          columnNumber: at.columnNumber,
        });
        groupOf.set(placed.breakpointId, id);
        breakpointGroups.set(
          id,
          bp.placements.map((p) => p.chromeId),
        );
        activeBreakpoints.set(id, labelOf(bp));
      } catch (e) {
        await drop(
          client,
          bp,
          `${bp.display} could not be placed in its new copy at ${script.url}: ${(e as Error).message}`,
        );
      }
    }
  };

  const followSourceBreakpoints = (client: CDP.Client, script: ParsedScript) => {
    const base = withoutQuery(script.url);
    const ids = [...watched.values()]
      .filter((bp) => bp.placements.some((p) => p.base === base && p.scriptId !== script.scriptId))
      .map((bp) => bp.id);
    if (!ids.length) return;
    sourceChecks = sourceChecks
      .then(() => recheck(client, script, base, ids))
      .catch((e) => console.error('[chrome-dev-mcp] Following a source breakpoint failed:', (e as Error).message));
  };

  const clearPauseRecord = () => {
    debuggerState.paused = false;
    debuggerState.callFrames = [];
    debuggerState.pauseReason = '';
    debuggerState.hitBreakpoints = [];
  };

  // The attach itself. Every listener it registers is recorded in `registered`, so that it can be
  // taken off again: when Chrome refuses the attach, or when the session moves to another client
  // (see attach below).
  const attachTo = async (client: CDP.Client, registered: Registered[]): Promise<void> => {
    const listen = (
      domain: 'Console' | 'Debugger' | 'Page' | 'Runtime',
      event: string,
      handler: (params: any) => void,
    ) => {
      (client[domain] as { on(event: string, handler: (params: any) => void): void }).on(event, handler);
      registered.push([`${domain}.${event}`, handler]);
    };

    // Reset stale state from the previous Chrome session.
    //
    // Do NOT add the network buffer here. This function runs lazily on the first
    // debugger/console tool call, which can be minutes after connect — clearing the
    // network buffer at that point would discard everything captured since connect.
    // Network capture has its own reset in NetworkCapture.reset().
    clearPauseRecord();
    activeBreakpoints.clear();
    breakpointGroups.clear();
    groupOf.clear();
    watched.clear();
    droppedLabels.clear();
    pendingDrops = [];
    sourceChecks = Promise.resolve();
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
            columnNumber: (orig?.column ?? col) + 1,
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
    listen('Console', 'messageAdded', async (event: any) => {
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
    // Taken over by another attach while it waited (see attach): what it registered so far has
    // been taken off, and it registers nothing more, nor touches state that attach now owns. This
    // await is the first point where that can have happened: attach sets `listening` and calls
    // attachTo in one synchronous run, which lasts until here, so a check any earlier always passes.
    if (listening !== registered) return;

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
    listen('Page', 'frameNavigated', (event: any) => {
      if (!event?.frame || event.frame.parentId) return;
      loadGeneration++;
      clearPauseRecord();
    });

    listen('Debugger', 'scriptParsed', (event: ParsedScript) => {
      if (!event.url) return;
      sourceMaps.registerScript(event);
      followSourceBreakpoints(client, event);
    });

    // A destroyed context's scripts are gone, and keeping them would let set_breakpoint place a
    // source position in a page that is no longer there. A navigation clears every context
    // before the new document parses anything — measured, Chrome 155: executionContextsCleared,
    // frameNavigated, executionContextCreated, then the first scriptParsed — so dropping
    // everything here never takes a script of the new page with it.
    listen('Runtime', 'executionContextsCleared', () => sourceMaps.dropContext());
    listen('Runtime', 'executionContextDestroyed', (event: any) => {
      if (event?.executionContextId != null) sourceMaps.dropContext(event.executionContextId);
    });

    listen('Debugger', 'paused', (event: any) => {
      debuggerState.paused = true;
      debuggerState.callFrames = event.callFrames;
      debuggerState.pauseReason = event.reason;
      debuggerState.hitBreakpoints = event.hitBreakpoints ?? [];
    });

    listen('Debugger', 'resumed', clearPauseRecord);

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

  // Takes off what an attach registered. By name, not through what `.on` returned: that is typed
  // void, and is a function that unsubscribes only by the current implementation, which could
  // change it without breaking anything it promises.
  const unlisten = (client: CDP.Client, registered: Registered[]) => {
    const emitter = client as unknown as NodeJS.EventEmitter;
    for (const [event, handler] of registered) emitter.removeListener(event, handler);
  };

  // Shared, and bounded.
  //
  // Shared because a call that arrives while another is attaching has to wait for it. Returning
  // early, it would send Debugger commands ahead of Debugger.enable, which Chrome refuses ("Debugger
  // agent is not enabled"), and read a pause record and a console buffer that cannot have filled
  // yet — a pause already in place would read as `paused: false`. Two tool calls issued together
  // are enough to hit it.
  //
  // Bounded because a renderer held in a synchronous loop or by a modal dialog answers neither
  // enable until it is let go, and a shared attach without a bound would park every caller at
  // once. A paused renderer is not among them: it answers straight away. Measured, Chrome 156, a
  // fresh session each time:
  //
  //   page                                          Console.enable   Debugger.enable
  //   Vite + React dev page                               13ms             64ms
  //   1000 console entries, 2000 scripts                  37ms            194ms
  //   the same, paused at a `debugger` statement          36ms            145ms   paused event with it
  //   the same, in a 3000ms synchronous loop            2819ms            119ms
  //   an alert() open                                 no answer in 3000ms; 12ms once dismissed
  //
  // So a caller that gives up cancels nothing: the attach finishes by itself once the renderer is
  // let go, and the next call finds it done. PAGE_COMMAND_TIMEOUT_MS is ~20x the slowest healthy
  // attach, the 200ms look for a pause already in place included.
  const attach = async (client: CDP.Client): Promise<boolean> => {
    // Synchronous up to the await, so that a concurrent caller always finds this attach started.
    if (registeredOnClient !== client) {
      // The client left behind comes off first. Today that changes nothing — index.ts closes a
      // client before it connects another, and a closed one emits nothing — but it keeps the
      // session from depending on that: a client still alive would go on writing into state the
      // new one owns, and one attached again later would have every listener twice.
      if (registeredOnClient) unlisten(registeredOnClient, listening);
      registeredOnClient = client;
      const registered: Registered[] = [];
      listening = registered;
      attaching = attachTo(client, registered);
      // A refused attach is undone rather than kept, so the next call starts over instead of
      // finding a session that looks attached with no debugger behind it. Chrome refuses
      // Debugger.enable while script execution is disabled ("Script execution is prohibited",
      // measured, Chrome 156), and the same session takes it once execution is back on.
      attaching.catch(() => {
        // Taken over before it failed, and taken off then.
        if (listening !== registered) return;
        registeredOnClient = null;
        unlisten(client, registered);
      });
    }
    return (await withTimeout(attaching, PAGE_COMMAND_TIMEOUT_MS)) !== TIMED_OUT;
  };

  return {
    attach,

    get state() {
      return debuggerState;
    },

    get breakpoints() {
      return activeBreakpoints;
    },

    addBreakpoint(label, chromeIds) {
      const id = `${idTag}-${++idCount}`;
      activeBreakpoints.set(id, label);
      breakpointGroups.set(id, chromeIds);
      // Replaces whatever an earlier breakpoint at the same place left here.
      for (const chromeId of chromeIds) groupOf.set(chromeId, id);
      return id;
    },

    chromeBreakpointIds: (id) => breakpointGroups.get(id) ?? [],

    removeBreakpoint(id) {
      // Every entry pointing at `id`, not just its current group: those of the copies it was
      // followed out of, and all of them once it was dropped, are still here.
      for (const [chromeId, owner] of groupOf) if (owner === id) groupOf.delete(chromeId);
      breakpointGroups.delete(id);
      watched.delete(id);
      const wasDropped = droppedLabels.delete(id);
      return activeBreakpoints.delete(id) || wasDropped;
    },

    breakpointIdFor: (chromeId) => groupOf.get(chromeId) ?? chromeId,

    async watchSourceBreakpoint(id, { key, display, column, condition, placements }) {
      const followed = await Promise.all(
        placements.map(async (placement) => {
          const file = await sourceMaps.fileIn(placement.scriptId, key);
          return {
            ...placement,
            base: withoutQuery(placement.url),
            fingerprint: file
              ? fingerprintOf(placement.scriptId, file)
              : `hash:${sourceMaps.scriptHash(placement.scriptId) ?? ''}`,
          };
        }),
      );
      watched.set(id, { id, key, display, column, condition, placements: followed });
    },

    settleSourceChecks: () => sourceChecks,

    takeDroppedBreakpoints() {
      const dropped = pendingDrops;
      pendingDrops = [];
      return dropped;
    },

    droppedHitNote() {
      const hits = [
        ...new Set(debuggerState.hitBreakpoints.map((chromeId) => groupOf.get(chromeId) ?? chromeId)),
      ].filter((id) => droppedLabels.has(id));
      if (!hits.length) return undefined;
      const named = hits.map((id) => `${id} (${droppedLabels.get(id)})`).join(', ');
      return (
        `Stopped on ${named}, dropped because its file changed after it was set: this may not be the ` +
        'statement it was set on. Set it again on the line you mean.'
      );
    },

    formatCallStack: () =>
      Promise.all(
        debuggerState.callFrames.map(async (frame: any, index: number) => {
          const line0 = frame.location.lineNumber;
          const col = frame.location.columnNumber ?? 0;
          const orig = await sourceMaps.resolve(frame.location.scriptId, line0, col);
          // Looked up by scriptId, not read off the frame: CallFrame.url is deprecated, and
          // Chrome 155 sends it empty (measured), which left every frame of a script without a
          // source map with no url at all.
          const scriptUrl = sourceMaps.scriptUrl(frame.location.scriptId) ?? frame.url;
          return {
            index,
            functionName: frame.functionName || '(anonymous)',
            url: orig?.source ?? scriptUrl,
            lineNumber: orig?.line ?? line0 + 1,
            columnNumber: (orig?.column ?? col) + 1,
            ...(orig && { compiledUrl: scriptUrl, compiledLine: line0 + 1, compiledColumn: col + 1 }),
            scopeTypes: (frame.scopeChain ?? []).map((s: any) => s.type),
          };
        }),
      ),

    locateSource: (path, line, column) => sourceMaps.locate(path, line, column),

    async describeLocation(scriptId, line0, col0) {
      const orig = await sourceMaps.resolve(scriptId, line0, col0);
      return {
        url: sourceMaps.scriptUrl(scriptId) ?? '',
        lineNumber: line0 + 1,
        columnNumber: col0 + 1,
        ...(orig && { source: orig.source, sourceLine: orig.line, sourceColumn: orig.column + 1 }),
      };
    },

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

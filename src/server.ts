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

// One record per redirect hop. Chrome reuses a single requestId across a redirect
// chain, so `requestId` is NOT unique in the buffer — `hop` disambiguates.
interface NetworkRecord {
  requestId: string;
  // Which document load this request belongs to. Used to prune the previous
  // page's requests on navigation while keeping the new document's own request,
  // which Chrome reports BEFORE it reports the navigation.
  loaderId: string;
  hop: number;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  initiator: string;
  startedAt: string;
  // Monotonic CDP timestamp (seconds); only used to compute durationMs.
  startMono: number;
  state: 'pending' | 'complete' | 'failed' | 'redirect';
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  fromCache?: boolean;
  redirectedTo?: string;
  size?: number;
  durationMs?: number;
  errorText?: string;
  canceled?: boolean;
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
const MAX_HTML_LENGTH = 20_000;

// Network traffic is far denser than console output — a single page load is routinely
// 100-500 requests. Unlike MAX_CONSOLE_LOGS, the buffer depth is deliberately NOT reused
// as the zod `.max()` on `limit`: 1000 records would be ~60-100k tokens in one response.
const MAX_NETWORK_REQUESTS = 1000; // circular buffer depth
const MAX_NETWORK_REQUESTS_PER_CALL = 200; // per-response cap — context budget, not buffer depth

// Chrome returns the same "No resource with given identifier found" error for an unknown
// requestId and for a body it has already discarded, so the error alone cannot tell them
// apart. These ids are the tombstone that makes the distinction possible: an id in here was
// really captured, so a failed body fetch means "discarded", not "never existed".
const MAX_DISCARDED_REQUEST_IDS = 2000;

const MAX_URL_LENGTH = 512;
const MAX_RESPONSE_BODY_LENGTH = 50_000;

// Chrome retains response bodies in the renderer subject to these limits, and
// Network.getResponseBody can only read what is still retained. Generous values buy a
// wider window for on-demand body fetches; the memory cost lands in Chrome, not here.
const NETWORK_MAX_TOTAL_BUFFER_SIZE = 100 * 1024 * 1024;
const NETWORK_MAX_RESOURCE_BUFFER_SIZE = 10 * 1024 * 1024;

// Accepts any casing while keeping the exact enum in the advertised JSON Schema.
// A bare z.enum() rejects "xhr" during input validation — before any handler runs — and
// `XHR` being the only all-caps member of the CDP enum makes that a likely stumble.
const caseInsensitiveEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (values.find((x) => x.toLowerCase() === v.toLowerCase()) ?? v) : v),
    z.enum(values),
  );

// CDP Network.ResourceType, verbatim.
const RESOURCE_TYPES = [
  'Document',
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'TextTrack',
  'XHR',
  'Fetch',
  'Prefetch',
  'EventSource',
  'WebSocket',
  'Manifest',
  'SignedExchange',
  'Ping',
  'CSPViolationReport',
  'Preflight',
  'Other',
] as const;

// Long URLs are collapsed rather than silently cut: a truncated URL buried in a JSON
// record would otherwise be reported or re-fetched as if it were complete.
//
// `collapseLong` is off for single-request drill-downs (a `requestId` query,
// get_network_response_body), where the output is bounded to a handful of records and the
// tail of a long URL — a signed token, a GraphQL query in the querystring — is often the
// very thing under investigation. Nothing else can recover it: the record stores the full
// URL, but no tool returns it.
//
// data: URIs collapse in BOTH modes. Their length is unbounded (megabytes of inline
// base64) and their tail carries no diagnostic value, so the reason to collapse them has
// nothing to do with how many records are being returned.
const formatUrl = (url: string, collapseLong = true): string => {
  if (url.startsWith('data:')) {
    return `${url.slice(0, 64)}… (data URI, ${url.length} chars)`;
  }
  if (collapseLong && url.length > MAX_URL_LENGTH) {
    return `${url.slice(0, MAX_URL_LENGTH)}… (+${url.length - MAX_URL_LENGTH} chars)`;
  }
  return url;
};

// The CDP initiator is a nested stack trace (callFrames plus a parent chain); only the
// topmost frame survives, as one string — the full tree on every record would dominate a
// 200-request response.
//
// The position is COMPILED, not source-mapped: resolving needs an await, and this runs in a
// capture handler that must stay synchronous. Deferring to return time would not help —
// scriptRegistry is filled only by Debugger.scriptParsed, so it would take Debugger.enable().
const formatInitiator = (initiator: any): string => {
  if (!initiator) return 'unknown';
  const type = initiator.type ?? 'unknown';
  const frame = initiator.stack?.callFrames?.[0];
  if (frame?.url) {
    return `${type} ${frame.url}:${(frame.lineNumber ?? 0) + 1}`.slice(0, 200);
  }
  if (initiator.url) {
    const line = initiator.lineNumber != null ? `:${initiator.lineNumber + 1}` : '';
    return `${type} ${initiator.url}${line}`.slice(0, 200);
  }
  return type;
};

const headersToObject = (headers: any): Record<string, string> => {
  if (!headers || typeof headers !== 'object') return {};
  return { ...headers } as Record<string, string>;
};

const HEADER_WILDCARD = '*';

// Callers name the headers they want, the way get_computed_style takes `properties` —
// returning every header on every record is what makes a 200-record response unusable.
//
// Lookups normalise case because the casing Chrome reports depends on the protocol:
// HTTP/2 lowercases every name, HTTP/1.1 preserves whatever the origin sent. Output keys
// echo the caller's spelling so the response lines up with the request.
//
// Unlike get_computed_style, a header that is not present is OMITTED rather than returned
// as an empty string: an absent header and a header with an empty value are different
// things in HTTP, and conflating them would misreport the absent case.
const projectHeaders = (headers: Record<string, string> | undefined, keys: string[]): Record<string, string> => {
  if (!headers) return {};
  if (keys.includes(HEADER_WILDCARD)) return { ...headers };
  const byLowerName = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) byLowerName.set(name.toLowerCase(), value);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = byLowerName.get(key.toLowerCase());
    if (value !== undefined) out[key] = value;
  }
  return out;
};

// Projection for tool output. Every conditional field is omitted (not null) when absent,
// which is why the matching zod outputSchema marks them `.optional()`.
const toOutputRecord = (r: NetworkRecord, headerKeys?: string[], collapseLongUrls = true) => ({
  requestId: r.requestId,
  method: r.method,
  url: formatUrl(r.url, collapseLongUrls),
  resourceType: r.resourceType,
  state: r.state,
  initiator: r.initiator,
  startedAt: r.startedAt,
  ...(r.hop > 0 ? { hop: r.hop } : {}),
  ...(r.status != null ? { status: r.status } : {}),
  ...(r.statusText ? { statusText: r.statusText } : {}),
  ...(r.mimeType ? { mimeType: r.mimeType } : {}),
  ...(r.size != null ? { size: r.size } : {}),
  ...(r.durationMs != null ? { durationMs: r.durationMs } : {}),
  ...(r.fromCache ? { fromCache: true } : {}),
  ...(r.redirectedTo ? { redirectedTo: formatUrl(r.redirectedTo, collapseLongUrls) } : {}),
  ...(r.errorText ? { errorText: r.errorText } : {}),
  ...(r.canceled ? { canceled: true } : {}),
  ...(headerKeys?.length
    ? {
        requestHeaders: projectHeaders(r.requestHeaders, headerKeys),
        responseHeaders: projectHeaders(r.responseHeaders, headerKeys),
      }
    : {}),
});

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

  // ── Network capture state ───────────────────────────────────────────────────
  // Owned exclusively by ensureNetworkEvents / resetNetworkCapture below.
  // Reset through resetNetworkCapture() only — never from ensureDebuggerEvents.
  const networkRequests: NetworkRecord[] = []; // chronological, circular
  const networkByRequestId = new Map<string, NetworkRecord>(); // requestId → current hop
  const discardedRequestIds = new Set<string>();

  // Track which client the event listeners are registered on.
  // When getClient() returns a different instance (reconnect), we re-register
  // and reset stale debugger state — this is the "reconnect cleanup" point.
  let registeredOnClient: CDP.Client | null = null;

  // Network has its OWN identity flag because it attaches eagerly at connect time
  // (see ensureNetworkEvents), while the Debugger/Console listeners stay lazy.
  let networkRegisteredOnClient: CDP.Client | null = null;
  let networkAttachInFlight: Promise<void> = Promise.resolve();

  const ensureDebuggerEvents = async (client: CDP.Client): Promise<void> => {
    if (registeredOnClient === client) return;
    registeredOnClient = client;

    // Reset stale state from the previous Chrome session.
    //
    // Do NOT add the network buffer here. This function runs lazily on the first
    // debugger/console tool call, which can be minutes after connect — clearing the
    // network buffer at that point would discard everything captured since connect.
    // Network capture has its own reset in resetNetworkCapture().
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
          const orig = frame.scriptId ? await resolveOriginalPosition(frame.scriptId, line0, col) : null;
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
      const type: string = msg.source === 'javascript' && msg.level === 'error' ? 'exception' : (msg.level as string);
      const stackTrace = msg.stackTrace ? await formatStackTrace(msg.stackTrace) : undefined;
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
      (client as any).once('Debugger.paused', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // First-ever enable for this client — Chrome fires 'paused' here if already stopped.
    await client.Debugger.enable({});
    await initialPauseSettled;
  };

  // ── Network capture ─────────────────────────────────────────────────────────

  const resetNetworkCapture = (): void => {
    networkRequests.length = 0;
    networkByRequestId.clear();
    discardedRequestIds.clear();
  };

  // Remember that this id was captured but its data is gone, so a later body fetch can
  // say "discarded" instead of "unknown id" — Chrome's error is identical for both.
  const noteDiscarded = (requestId: string): void => {
    discardedRequestIds.add(requestId);
    if (discardedRequestIds.size > MAX_DISCARDED_REQUEST_IDS) {
      // Set iterates in insertion order, so this drops the oldest.
      discardedRequestIds.delete(discardedRequestIds.values().next().value as string);
    }
  };

  const pushNetworkRecord = (record: NetworkRecord): void => {
    networkRequests.push(record);
    networkByRequestId.set(record.requestId, record);
    if (networkRequests.length > MAX_NETWORK_REQUESTS) {
      const dropped = networkRequests.shift()!;
      // Only orphan the map entry if this record was still the current hop.
      if (networkByRequestId.get(dropped.requestId) === dropped) {
        networkByRequestId.delete(dropped.requestId);
      }
      noteDiscarded(dropped.requestId);
    }
  };

  // All handlers here are intentionally synchronous — no source-map resolution, no body
  // fetches. Anything async would race with the events that follow it.
  const attachNetworkTo = async (client: CDP.Client): Promise<void> => {
    resetNetworkCapture();

    client.Network.on('requestWillBeSent', (event: any) => {
      const prev = networkByRequestId.get(event.requestId);

      // A redirect re-fires requestWillBeSent with the SAME requestId, carrying the
      // response of the PREVIOUS hop. Close that hop out and start a new record.
      if (event.redirectResponse && prev) {
        prev.state = 'redirect';
        prev.status = event.redirectResponse.status;
        prev.statusText = event.redirectResponse.statusText || undefined;
        prev.mimeType = event.redirectResponse.mimeType || undefined;
        prev.responseHeaders = headersToObject(event.redirectResponse.headers);
        prev.redirectedTo =
          event.redirectResponse.headers?.location ?? event.redirectResponse.headers?.Location ?? event.documentURL;
        prev.durationMs = Number(((event.timestamp - prev.startMono) * 1000).toFixed(1));
      }

      pushNetworkRecord({
        requestId: event.requestId,
        loaderId: event.loaderId,
        hop: event.redirectResponse && prev ? prev.hop + 1 : 0,
        method: event.request?.method ?? 'GET',
        url: event.request?.url ?? '',
        resourceType: event.type ?? 'Other',
        requestHeaders: headersToObject(event.request?.headers),
        initiator: formatInitiator(event.initiator),
        startedAt: new Date((event.wallTime ?? Date.now() / 1000) * 1000).toISOString(),
        startMono: event.timestamp,
        state: 'pending',
      });
    });

    client.Network.on('responseReceived', (event: any) => {
      const record = networkByRequestId.get(event.requestId);
      if (!record) return;
      record.status = event.response?.status;
      record.statusText = event.response?.statusText || undefined;
      record.mimeType = event.response?.mimeType || undefined;
      record.responseHeaders = headersToObject(event.response?.headers);
      if (event.response?.fromDiskCache || event.response?.fromPrefetchCache) {
        record.fromCache = true;
      }
      // The type on responseReceived is more reliable than the one on requestWillBeSent.
      if (event.type) record.resourceType = event.type;
    });

    client.Network.on('requestServedFromCache', (event: any) => {
      const record = networkByRequestId.get(event.requestId);
      if (record) record.fromCache = true;
    });

    client.Network.on('loadingFinished', (event: any) => {
      const record = networkByRequestId.get(event.requestId);
      if (!record) return;
      record.state = 'complete';
      // encodedDataLength here is the full transferred size; the one on the response
      // object counts headers only.
      record.size = event.encodedDataLength;
      record.durationMs = Number(((event.timestamp - record.startMono) * 1000).toFixed(1));
    });

    client.Network.on('loadingFailed', (event: any) => {
      const record = networkByRequestId.get(event.requestId);
      if (!record) return;
      record.state = 'failed';
      record.errorText = event.errorText || event.blockedReason || 'unknown error';
      if (event.canceled) record.canceled = true;
      record.durationMs = Number(((event.timestamp - record.startMono) * 1000).toFixed(1));
    });

    // Prune the previous page on navigation, mirroring the DevTools Network panel default.
    //
    // A blanket clear would be wrong: Chrome reports requestWillBeSent for the new
    // document BEFORE it reports frameNavigated, so the document request the user most
    // wants after a reload would be the first thing deleted. Keeping the committed
    // loaderId's records preserves it.
    client.Page.on('frameNavigated', (event: any) => {
      const frame = event.frame;
      if (!frame || frame.parentId) return; // subframe — leave the buffer alone
      const keepLoaderId: string = frame.loaderId;
      for (let i = networkRequests.length - 1; i >= 0; i--) {
        if (networkRequests[i].loaderId === keepLoaderId) continue;
        const [dropped] = networkRequests.splice(i, 1);
        if (networkByRequestId.get(dropped.requestId) === dropped) {
          networkByRequestId.delete(dropped.requestId);
        }
        noteDiscarded(dropped.requestId);
      }
    });

    await client.Network.enable({
      maxTotalBufferSize: NETWORK_MAX_TOTAL_BUFFER_SIZE,
      maxResourceBufferSize: NETWORK_MAX_RESOURCE_BUFFER_SIZE,
    });
  };

  // Attached eagerly from index.ts at connect time, because Network.enable() does NOT
  // replay history the way Console.enable() does — anything before enable is lost
  // forever. Unlike Debugger.enable() it has no page-observable side effect (no JIT
  // deoptimisation) and no handshake to wait on, so paying for it on every connection
  // is cheap. Never rejects: a network failure must not fail the whole connection.
  //
  // Resolves true when THIS call performed the attach, which also means attachNetworkTo
  // just reset the capture buffer and the tombstone set. Callers turn that into a
  // "capture (re)started" explanation instead of reporting an empty buffer or an unknown
  // requestId. Returning it from here keeps the client-identity check in one place.
  const ensureNetworkEvents = async (client: CDP.Client): Promise<boolean> => {
    // Everything up to the await must stay synchronous: it is what makes a concurrent
    // caller see networkRegisteredOnClient already set and await the same attach instead
    // of starting a second one. Do not move the check or the assignment below the await.
    const alreadyAttached = networkRegisteredOnClient === client;
    if (!alreadyAttached) {
      networkRegisteredOnClient = client;
      networkAttachInFlight = attachNetworkTo(client).catch((e) => {
        console.error('[chrome-dev-mcp] Network capture unavailable:', (e as Error).message);
        // Allow a later call to retry rather than leaving the client marked as attached
        // with no listeners.
        if (networkRegisteredOnClient === client) networkRegisteredOnClient = null;
      });
    }
    await networkAttachInFlight;
    return !alreadyAttached;
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
      description:
        'List all open Chrome page tabs with their targetIds, titles, and URLs. When you are unsure which tab to inspect, call this proactively to discover available tabs, then present the list to the user and ask which one to switch to — do NOT tell the user to switch tabs manually in Chrome.',
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
      description:
        'Switch the MCP connection to a specific Chrome tab. Use list_tabs first to get available targetIds.',
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
          content: [
            { type: 'text', text: `Failed to connect to tab ${targetId}. Use list_tabs to check available targets.` },
          ],
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
        'Get the full HTML source of the currently connected tab (`document.documentElement.outerHTML`). ' +
        `Truncated to ${MAX_HTML_LENGTH} characters for large pages.`,
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
      return { content: [{ type: 'text', text: String(result.result.value).slice(0, MAX_HTML_LENGTH) }] };
    },
  );

  server.registerTool(
    'evaluate_js',
    {
      description:
        'Evaluate javascript in page. To access the currently selected element in the Elements panel ($0), use get_inspected_element instead.',
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
      const text = value !== undefined ? JSON.stringify(value, null, 2) : (description ?? type ?? 'undefined');
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

  // ── Debugger tools ──────────────────────────────────────────────────────────

  server.registerTool(
    'get_debugger_state',
    {
      description:
        'Get current debugger state: whether execution is paused, the pause reason, hit breakpoints, and the full call stack with file/line info.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        paused: z.boolean(),
        reason: z
          .string()
          .optional()
          .describe('Pause reason (e.g. "breakpoint", "exception"). Present only when paused.'),
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
        columnNumber: z.number().int().min(1).optional().describe('Column number, 1-indexed (optional)'),
        condition: z.string().optional().describe('JS expression; breakpoint triggers only when truthy'),
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
          .describe(
            'May be empty if the script is not loaded yet; the breakpoint will bind automatically when Chrome parses the script',
          ),
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
      description: 'Step into the function call on the current line. Returns the new call stack position.',
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
        frameIndex: z
          .number()
          .default(0)
          .describe('Call frame index (0 = top frame); use get_debugger_state to find available frames'),
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
        return {
          content: [{ type: 'text', text: 'Debugger is not paused. Use evaluate_js for global-scope evaluation.' }],
          isError: true,
        };
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
        const props = (r.preview.properties ?? []).map((p: any) => `  ${p.name}: ${p.value}`).join(',\n');
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
      description: 'Step out of the current function and pause at the caller. Returns the new call stack position.',
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
        clear: z.boolean().default(false).describe('Clear the buffer after returning entries'),
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
        content:
          logs.length === 0
            ? [{ type: 'text' as const, text: 'No console entries captured yet.' }]
            : [{ type: 'text' as const, text: JSON.stringify(logs, null, 2) }],
        structuredContent: { logs },
      };
    },
  );

  // ── Network tools ───────────────────────────────────────────────────────────

  server.registerTool(
    'get_network_requests',
    {
      description:
        'Return HTTP requests captured from the connected tab — method, URL, resource type, status, transferred size, duration, initiator, and failure reason. ' +
        'Capture starts when this server connects to the tab: requests issued before that are NOT visible (unlike get_console_logs, which replays pre-connect history). ' +
        'Requests belonging to a previous page are pruned on navigation, mirroring the DevTools Network panel default; the new document request itself is kept. ' +
        'A redirect chain appears as one record per hop, sharing a requestId and distinguished by `hop`. ' +
        'WebSocket frames are not captured.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_NETWORK_REQUESTS_PER_CALL)
          .default(50)
          .describe('Maximum number of most-recent requests to return'),
        requestId: z
          .string()
          .optional()
          .describe(
            'Return only this request, including every hop of its redirect chain. Pair with headerKeys to inspect one request in full.',
          ),
        urlFilter: z
          .string()
          .optional()
          .describe('Case-insensitive substring match on the full (untruncated) request URL'),
        resourceType: caseInsensitiveEnum(RESOURCE_TYPES)
          .optional()
          .describe('Filter by CDP resource type. Any casing is accepted.'),
        status: caseInsensitiveEnum(['2xx', '3xx', '4xx', '5xx', 'failed', 'pending'])
          .optional()
          .describe(
            'Filter by response status class, or by outcome: `failed` = network error/blocked, `pending` = still in flight.',
          ),
        headerKeys: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            'Return only these headers, matched case-insensitively, on both requestHeaders and responseHeaders. Omit to return no headers. Pass ["*"] for every header — that is bounded only by `limit`, so use it with `requestId` or a small limit.',
          ),
        clear: z.boolean().default(false).describe('Clear the capture buffer after returning entries'),
      }),
      outputSchema: z.object({
        requests: z.array(
          z.object({
            requestId: z.string(),
            method: z.string(),
            url: z
              .string()
              .describe(
                'data: URIs are always collapsed; in a bulk listing long URLs are truncated too. Both are marked with `…`, and a marked value is NOT a usable URL — query a single `requestId` to get long URLs in full. `urlFilter` always matches the full URL.',
              ),
            resourceType: z
              .string()
              .describe('CDP resource type (Document, Script, XHR, …); same vocabulary as the `resourceType` filter'),
            state: z
              .enum(['pending', 'complete', 'failed', 'redirect'])
              .describe(
                'Lifecycle of this hop: `pending` = no terminal event yet (stays pending forever if the page navigated away mid-flight), `complete` = loaded, `failed` = network error or blocked, `redirect` = returned 3xx and continued on the next hop.',
              ),
            initiator: z
              .string()
              .describe(
                'Flattened to "<type> <url>:<line>", or just the type when no location is known. Compiled position, not source-mapped; capped at 200 chars.',
              ),
            startedAt: z.string().describe('ISO-8601 wall-clock time the request was sent'),
            hop: z.number().optional().describe('Redirect hop index; omitted for the first hop'),
            status: z
              .number()
              .optional()
              .describe(
                'HTTP status of this hop — the 3xx itself when state is `redirect`. Absent until a response arrives.',
              ),
            statusText: z.string().optional().describe('Reason phrase; usually absent over HTTP/2+, which has none'),
            mimeType: z.string().optional(),
            size: z
              .number()
              .optional()
              .describe('Transferred on-the-wire bytes (encodedDataLength) — compressed, not the decoded body size'),
            durationMs: z
              .number()
              .optional()
              .describe(
                'Milliseconds from request start until this hop was closed out — by loadingFinished, loadingFailed, or the next hop taking over on a redirect',
              ),
            fromCache: z
              .boolean()
              .optional()
              .describe('Served from Chrome cache rather than the network; `size` is then typically 0'),
            redirectedTo: z
              .string()
              .optional()
              .describe('Redirect target from the `Location` header; same truncation rules as `url`'),
            errorText: z
              .string()
              .optional()
              .describe('CDP failure or block reason (e.g. `net::ERR_ABORTED`); present only when state is `failed`'),
            canceled: z
              .boolean()
              .optional()
              .describe(
                'The failure was a cancellation (navigating away, an aborted fetch), not a genuine network error — usually not worth reporting as a problem',
              ),
            requestHeaders: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                'The headers named by `headerKeys`, keyed by your own spelling; absent when `headerKeys` is omitted. A requested header missing from this map was not sent; one present with an empty string WAS sent, with an empty value.',
              ),
            responseHeaders: z
              .record(z.string(), z.string())
              .optional()
              .describe('Same projection as `requestHeaders`; `{}` when no response arrived'),
          }),
        ),
      }),
      annotations: {
        title: 'Get network requests',
        readOnlyHint: true,
      },
    },
    async ({ limit, requestId, urlFilter, resourceType, status, headerKeys, clear }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      // True when this call performed the attach, so an empty buffer can be explained
      // rather than looking like "no traffic".
      const reattached = await ensureNetworkEvents(client);

      const needle = urlFilter?.toLowerCase();
      const wantedType = resourceType?.toLowerCase();
      const filtered = networkRequests.filter((r) => {
        if (requestId && r.requestId !== requestId) return false;
        if (needle && !r.url.toLowerCase().includes(needle)) return false;
        if (wantedType && r.resourceType.toLowerCase() !== wantedType) return false;
        if (status) {
          if (status === 'failed') return r.state === 'failed';
          if (status === 'pending') return r.state === 'pending';
          if (r.status == null) return false;
          if (Math.floor(r.status / 100) !== Number(status[0])) return false;
        }
        return true;
      });

      // A requestId query is a drill-down: bounded output, so long URLs stay intact.
      const requests = filtered.slice(-limit).map((r) => toOutputRecord(r, headerKeys, requestId == null));

      // Mirrors get_console_logs: `clear` empties the whole buffer, not the filtered slice.
      if (clear) resetNetworkCapture();

      const emptyMessage = reattached
        ? 'Network capture (re)started for a new Chrome session — the previous buffer was discarded. Reload the page or re-trigger the requests, then call this tool again.'
        : networkRequests.length === 0
          ? 'No network requests captured yet. Capture began when this server connected to the tab — reload the page to collect its requests.'
          : 'No network requests match the given filters.';

      return {
        content:
          requests.length === 0
            ? [{ type: 'text' as const, text: emptyMessage }]
            : [{ type: 'text' as const, text: JSON.stringify(requests, null, 2) }],
        structuredContent: { requests },
      };
    },
  );

  server.registerTool(
    'get_network_response_body',
    {
      description:
        'Fetch the response body for one requestId from get_network_requests. ' +
        'Bodies are never buffered by this server — they are read from Chrome on demand, and Chrome discards them on navigation or when its own buffer limits are exceeded, so fetch promptly and before navigating away. ' +
        'Chrome stores at most one body per requestId, so for a redirect chain only the final hop has a body. ' +
        'Returns a JSON metadata block, then the body as a separate text block — kept separate so a large body is not JSON-escaped. ' +
        'Metadata carries requestId, base64Encoded, byteLength and method/url/status/mimeType, the last four replaced by a `note` when the capture buffer no longer holds the request, plus `truncated: true` when the body was cut at ' +
        `${MAX_RESPONSE_BODY_LENGTH} characters. ` +
        'A binary body is never returned: metadata carries `omitted` and there is no second content block.',
      inputSchema: z.object({
        requestId: z.string(),
      }),
      annotations: {
        title: 'Get network response body',
        readOnlyHint: true,
      },
    },
    async ({ requestId }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      // True when this call performed the attach, which resets the capture buffer AND the
      // tombstone set — otherwise a perfectly valid id from the previous session would be
      // reported as invented.
      const reattached = await ensureNetworkEvents(client);

      const record = networkByRequestId.get(requestId);

      // Answer from our own record where it already settles the question, so we don't
      // report a confusing CDP error for a request that simply has no body yet.
      if (record?.state === 'pending') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Request ${requestId} has not finished loading yet (no loadingFinished event). Retry in a moment.`,
            },
          ],
          isError: true,
        };
      }
      if (record?.state === 'failed') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Request ${requestId} failed (${record.errorText ?? 'unknown error'}); no response body is available.`,
            },
          ],
          isError: true,
        };
      }

      let body: string;
      let base64Encoded: boolean;
      try {
        const result = await client.Network.getResponseBody({ requestId });
        body = result.body;
        base64Encoded = result.base64Encoded;
      } catch (e) {
        const message = (e as Error).message ?? '';

        // Chrome's message is identical for "unknown id" and "already discarded", so the
        // tombstone set is what lets us tell the user which one actually happened.
        if (!record) {
          const text = reattached
            ? `Network capture (re)started for a new Chrome session, discarding every request captured before it — ${requestId} belonged to the previous session and is not invalid. Re-trigger the request, then fetch the body under its new requestId.`
            : discardedRequestIds.has(requestId)
              ? `Request ${requestId} was captured but its data has been discarded (page navigation, or the capture buffer overflowed). Re-trigger the request and fetch its body before navigating.`
              : `Unknown requestId ${requestId}. It is not in the capture buffer (last ${MAX_NETWORK_REQUESTS} requests, pruned on navigation) and Chrome has no data for it. Call get_network_requests for current requestIds.`;
          return { content: [{ type: 'text' as const, text }], isError: true };
        }

        const text = /evicted/i.test(message)
          ? `Response body for ${requestId} was discarded by Chrome (exceeded its network buffer limits — ${Math.round(NETWORK_MAX_TOTAL_BUFFER_SIZE / 1024 / 1024)} MB total / ${Math.round(NETWORK_MAX_RESOURCE_BUFFER_SIZE / 1024 / 1024)} MB per resource). Fetch bodies promptly after a request completes.`
          : `Chrome has no body for ${requestId} (status ${record.status ?? 'unknown'}${
              record.state === 'redirect' ? ', redirect hop' : ''
            }). The response may have had no body, or be a resource Chrome does not buffer. CDP said: ${message}`;
        return { content: [{ type: 'text' as const, text }], isError: true };
      }

      const meta: Record<string, unknown> = {
        requestId,
        ...(record
          ? {
              method: record.method,
              url: formatUrl(record.url, false),
              status: record.status,
              mimeType: record.mimeType,
            }
          : { note: 'Metadata for this request was evicted from the capture buffer; body came from Chrome.' }),
        base64Encoded,
        byteLength: body.length,
      };

      // Dumping base64 image/font data into an agent's context is pure waste.
      if (base64Encoded && !/^text\/|json|xml|javascript|ecmascript/i.test(record?.mimeType ?? '')) {
        meta.omitted = 'binary body not returned';
        return { content: [{ type: 'text' as const, text: JSON.stringify(meta, null, 2) }] };
      }

      const truncated = body.length > MAX_RESPONSE_BODY_LENGTH;
      if (truncated) meta.truncated = true;

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
          { type: 'text' as const, text: truncated ? body.slice(0, MAX_RESPONSE_BODY_LENGTH) : body },
        ],
      };
    },
  );

  return { server, attachNetwork: ensureNetworkEvents };
}

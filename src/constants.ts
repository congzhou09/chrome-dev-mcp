import { z } from 'zod';

export const NOT_CONNECTED = {
  content: [
    {
      type: 'text' as const,
      text: 'Chrome is not connected. Launch Chrome with:\n  --remote-debugging-port=9222 --user-data-dir=<path>\nThen try again.',
    },
  ],
  isError: true,
};

export const MAX_CONSOLE_LOGS = 500;
export const MAX_HTML_LENGTH = 20_000;

// ── Connection timeouts ───────────────────────────────────────────────────────
//
// Chrome is never assumed to be in a clean debugging state. A renderer that is paused at a
// breakpoint, stuck in a synchronous loop, or blocked on a modal answers NO CDP command —
// not even Runtime.enable — and never rejects either. Every command issued while building
// a connection is therefore bounded; without that, one wedged tab parks the shared
// connection promise forever and every tool that needs a client times out at the MCP layer
// while browser-level tools like list_tabs keep working.

// Per-target visibility probe. Only has to survive one round-trip to a healthy renderer.
export const TARGET_PROBE_TIMEOUT_MS = 2000;

// Runtime.enable + Page.enable + Network.enable against the chosen target, as a group.
export const CONNECT_TIMEOUT_MS = 10_000;

// Backstop on the transition queue itself: how long a queued transition waits for its
// predecessor before giving up on serialisation and running anyway. Serialisation is worth
// having, but not at the price of a permanent deadlock.
export const TRANSITION_WAIT_TIMEOUT_MS = 15_000;

// ── evaluate_js timeouts ──────────────────────────────────────────────────────
//
// An arbitrary expression can hang in two ways that need two different bounds. They cover
// disjoint cases and neither substitutes for the other. Measured against Chrome 141:
//
//   expression                      renderer      Runtime.evaluate `timeout`   client-side race
//   while (Date.now()-t < 5000) {}  WEDGED        fires, 1008ms for 1000       useless
//   await new Promise(() => {})     idle          never fires (>6000ms)        the only bound
//
// Row 2 is the case that matters, and it holds for a structural reason: `timeout` bounds
// EXECUTION, and time suspended at an `await` is not execution. An `await sleep(800)` under
// `timeout: 200` was not terminated — it returned its value ~1000ms later, five times over
// its own bound. Suspended time is simply not counted, so an expression that never resumes
// never accumulates any, and `timeout` has nothing to fire on however long we wait. The
// client-side race is the only thing that ends that call.
//
// The reverse is just as one-sided. A synchronous loop wedges the renderer, which then
// answers no CDP command at all — the client-side race hands control back to the caller but
// leaves the tab spinning, and every later tool call inherits a dead target. Only `timeout`
// actually stops it.

// Server-side: how long the expression may hold the renderer in ONE uninterrupted stretch.
//
// Not a budget for the whole expression — the clock is per-slice, and every `await` resets
// it. Measured: ten 700ms busy loops separated by awaits, 7177ms of real execution, ran to
// completion under `timeout: 5000`. So what this actually catches is five continuous seconds
// of a blocked main thread, which no legitimate debugging expression reaches and which is
// already a broken page. Total runtime is bounded by EVAL_SETTLE_TIMEOUT_MS instead.
export const EVAL_EXECUTION_TIMEOUT_MS = 5000;

// Client-side: the wall-clock bound on the whole call, covering an expression suspended on a
// promise that never settles — and a context destroyed mid-evaluate by a navigation, which
// drops the command without ever answering it.
//
// Sized for what top-level `await` invites people to write: awaiting a slow fetch, an
// animation, a poll for an element. 30s matches the de-facto convention for browser
// automation (Playwright's default action timeout, Puppeteer's default navigation timeout).
//
// The ceiling is the MCP client's own request timeout, DEFAULT_REQUEST_TIMEOUT_MSEC = 60s.
// Staying well under it is the point: whichever timer fires first writes the error message,
// and ours names the cause while the client's only says the call took too long.
export const EVAL_SETTLE_TIMEOUT_MS = 30_000;

// Bound on the optional deep-value upgrade in remote-object.ts, which runs AFTER the two
// above have already been satisfied — so it has to be small enough that the two cannot add
// up past the MCP client's 60s. 30 + 5 leaves real headroom.
//
// Generous against measured cost: an array of 500,000 small objects deep-serialises in
// 1631ms (10,000 -> 35ms, 100,000 -> 355ms), so 5s covers anything a person would sit and
// wait for, and falling back to the preview is a correct answer rather than an error.
//
// It is a stop-loss, not a cure. `Runtime.callFunctionOn` takes no `timeout` of its own, so
// nothing can terminate the renderer once serialisation is spinning. Two measurements, and
// they answer different questions — the second one alone would prove nothing:
//
//   get slow() { busy(3000); return 'GETTER_RAN' }   3001ms, and 'GETTER_RAN' came back
//   get boom() { while (true) {} }                   never returned
//
// The first is the evidence that serialisation INVOKES getters, and it had to TERMINATE to
// be evidence at all: a hang on its own is equally consistent with the call failing for some
// unrelated reason, whereas a getter that costs exactly its own 3000ms and hands back the
// value it computed can only have been called. The second is then the consequence — and
// afterwards the renderer answered no command at all, not even a `1+1` carrying its own
// timeout. The race saves this call; the tab stays wedged either way. Without it the call
// simply never returns.
export const EVAL_DEEP_VALUE_TIMEOUT_MS = 5000;

// Network traffic is far denser than console output — a single page load is routinely
// 100-500 requests. Unlike MAX_CONSOLE_LOGS, the buffer depth is deliberately NOT reused
// as the zod `.max()` on `limit`: 1000 records would be ~60-100k tokens in one response.
export const MAX_NETWORK_REQUESTS = 1000; // circular buffer depth
export const MAX_NETWORK_REQUESTS_PER_CALL = 200; // per-response cap — context budget, not buffer depth

// Chrome returns the same "No resource with given identifier found" error for an unknown
// requestId and for a body it has already discarded, so the error alone cannot tell them
// apart. These ids are the tombstone that makes the distinction possible: an id in here was
// really captured, so a failed body fetch means "discarded", not "never existed".
export const MAX_DISCARDED_REQUEST_IDS = 2000;

export const MAX_URL_LENGTH = 512;
export const MAX_RESPONSE_BODY_LENGTH = 50_000;

// Chrome retains response bodies in the renderer subject to these limits, and
// Network.getResponseBody can only read what is still retained. Generous values buy a
// wider window for on-demand body fetches; the memory cost lands in Chrome, not here.
export const NETWORK_MAX_TOTAL_BUFFER_SIZE = 100 * 1024 * 1024;
export const NETWORK_MAX_RESOURCE_BUFFER_SIZE = 10 * 1024 * 1024;

// Accepts any casing while keeping the exact enum in the advertised JSON Schema.
// A bare z.enum() rejects "xhr" during input validation — before any handler runs — and
// `XHR` being the only all-caps member of the CDP enum makes that a likely stumble.
export const caseInsensitiveEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (values.find((x) => x.toLowerCase() === v.toLowerCase()) ?? v) : v),
    z.enum(values),
  );

// CDP Network.ResourceType, verbatim.
export const RESOURCE_TYPES = [
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

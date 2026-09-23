import { z } from 'zod';
export const NOT_CONNECTED = {
    content: [
        {
            type: 'text',
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
// ── Page / tab command timeouts ───────────────────────────────────────────────
// One CDP round-trip that has no reason to be slow: read document.title, read location.href,
// serialise outerHTML, read a computed style, list a scope's properties. A renderer blocked in
// a synchronous loop or sitting on a modal dialog answers none of them and rejects none of
// them either, so without a bound the tool call hangs until the MCP client's own 60s timeout
// writes a message that names nothing.
//
// Two of them are not constant-time: get_html scales with the size of the document, and
// get_scope_variables with the number of properties in the scope. get_html is the one measured
// here — the other's numbers live at its call site in debugger.ts, since they are about an
// object's width and not about a page at all. Chrome 141, build cost subtracted so these are
// what the call itself pays:
//
//   document                     outerHTML   serialise   transport
//   real app page, 196 nodes       171 KB        —           —       (21ms all in)
//   synthetic, 100,000 nodes       4.9 MB      103ms       251ms
//   synthetic, 500,000 nodes      25.5 MB      482ms      1127ms
//
// It truncates inside the page, so it pays the serialise column and not the transport one —
// 482ms at 500,000 nodes, which is itself two orders of magnitude past the DOM size Lighthouse
// already calls excessive. The bound sits ~20x above that absurd page and ~475x above a real one.
//
// get_scope_variables is the tighter of the two, and so the one that really sets this value: a
// pathologically wide object outruns 10s where no document can. A real scope does not come close.
//
// The margin is deliberate and close to free: a bound too large only lengthens the wait
// before an error that was coming anyway, while a bound too small kills work that was going to
// succeed. The ceiling that matters is the MCP client's 60s, and 10s stays well inside it.
export const PAGE_COMMAND_TIMEOUT_MS = 10_000;
// `Page.captureScreenshot` waits for the compositor to hand over a frame, which is a wait no
// other command in this server makes. Measured, Chrome 141: a normal capture of a 1-tab page
// took 189ms and 137ms. A tab that is not producing frames never answers at all — hence a
// bound well above the real cost but far below anything a caller would sit through.
export const SCREENSHOT_TIMEOUT_MS = 10_000;
// Bound on `Page.getLayoutMetrics` and the `devicePixelRatio` read beside it, which is what
// turning a requested long edge into a clip needs. Measured, Chrome 153: 1ms, then 1ms on
// each of three repeats. Both report state that already exists rather than waiting on the
// compositor, so they do not share the frame-production stall `Page.captureScreenshot` has
// to defend against.
//
// Short, and non-fatal on expiry: sizing is best-effort, capturing is the job. A timeout
// here falls through to a native capture rather than failing the tool, so the whole cost of
// this bound being too tight is a screenshot larger than the caller asked for.
export const LAYOUT_METRICS_TIMEOUT_MS = 2000;
// Bound on `Page.bringToFront`. It is a tab activation handled by the browser rather than work
// queued onto the page's main thread, so it stays answerable on a target that has stopped
// answering everything else. Measured, Chrome 141, one throwaway tab over one CDP session,
// the wedged column taken with the renderer held in a synchronous loop:
//
//   command                  healthy   wedged renderer
//   Runtime.evaluate `1+1`       2ms   no answer in 3000ms
//   Page.captureScreenshot     122ms   no answer in 5000ms
//   Page.bringToFront            2ms   answered in 1ms
//
// A timeout here therefore has only one reading left: with the page's main thread ruled out as
// the cause, an activation that goes unanswered means the target itself is gone.
//
// 3s rather than tighter because 1-2ms is a happy-path sample of a command that still crosses a
// process boundary; rather than looser because nothing arrives late — it answers or it is gone.
export const BRING_TO_FRONT_TIMEOUT_MS = 3000;
// Bound on waiting for the page to paint a frame after it has been raised, which is the
// difference between a capture that shows the page and one that shows a stale surface.
// Measured, Chrome 153, a minimised window: the tab reported `hidden`, and after
// `Page.bringToFront` a double-rAF resolved in 29ms and the capture that followed matched
// the page exactly. 1s is that with room for a busy first frame; on expiry the capture goes
// ahead anyway, because the timeout-and-raise path behind it is still there to catch a tab
// that never paints.
export const FRAME_WAIT_TIMEOUT_MS = 1000;
// The answer to a CDP round-trip that outlived its bound. Deliberately a normal tool error
// rather than a thrown one: "this renderer never answered" is a state the caller can act on
// (resume the debugger, dismiss the dialog, reload the tab), not a fault in this server.
export const rendererTimedOut = (what, causes = 'paused at a breakpoint, blocked in a synchronous loop, or blocked on a modal dialog') => ({
    content: [
        {
            type: 'text',
            text: `Error: ${what} did not answer within ${PAGE_COMMAND_TIMEOUT_MS}ms. ` +
                `The tab's renderer is not responding — it may be ${causes}.`,
        },
    ],
    isError: true,
});
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
export const caseInsensitiveEnum = (values) => z.preprocess((v) => (typeof v === 'string' ? (values.find((x) => x.toLowerCase() === v.toLowerCase()) ?? v) : v), z.enum(values));
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
];

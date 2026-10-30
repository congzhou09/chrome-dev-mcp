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
// Chrome is never assumed to be in a clean debugging state. A renderer stuck in a synchronous
// loop or blocked on a modal answers NO CDP command — not even Runtime.enable — and never
// rejects either. One paused at a breakpoint is not among them: measured, Chrome 156, it
// answered Runtime.evaluate, Runtime.enable and Page.enable from a fresh connection within
// 2ms. Every command issued while building a connection is therefore bounded; without that,
// one wedged tab parks the shared connection promise forever and every tool that needs a
// client times out at the MCP layer while browser-level tools like list_tabs keep working.

// Per-target visibility probe. Only has to survive one round-trip to a healthy renderer.
export const TARGET_PROBE_TIMEOUT_MS = 2000;

// Runtime.enable + Page.enable + Network.enable against the chosen target, as a group.
export const CONNECT_TIMEOUT_MS = 10_000;

// Backstop on the transition queue itself: how long a queued transition waits for its
// predecessor before giving up on serialisation and running anyway. Serialisation is worth
// having, but not at the price of a permanent deadlock.
export const TRANSITION_WAIT_TIMEOUT_MS = 15_000;

// ── evaluate_js bounds ────────────────────────────────────────────────────────
//
// An arbitrary expression can hang in two ways that need two different bounds. They cover
// disjoint cases and neither substitutes for the other:
//
//   expression                      renderer   answers a probe   what ends it
//   while (Date.now()-t < 5000) {}  busy       no                Runtime.terminateExecution
//   await new Promise(() => {})     idle       yes               the client-side race
//
// A synchronous loop holds the renderer, which then answers no CDP command at all. The
// client-side race in evaluate_js would hand control back to the caller without stopping the loop, 
// and every later tool call would inherit a dead target; only terminating the loop stops it. An
// expression suspended at an `await` holds nothing, and the client-side race in evaluate_js is
// the only thing that ends that call.
//
// Runtime.evaluate's own `timeout` used to stop the loop. But that `timeout` is a wall clock, and it
// keeps running while execution is paused in the debugger. Measured, Chrome 156, `timeout: 1000`
// and a `debugger;` statement held for 2.5s: after Debugger.resume not one more statement of the
// expression ran, and Debugger.stepOver ended the expression the same way. The first
// evaluateOnCallFrame during that pause failed with "Execution was terminated". An agent's calls
// are seconds apart, so every breakpoint an evaluate_js expression ran into — one in the click
// handler that `btn.click()` calls, say — was held past the `timeout`.
//
// So instead of the previous approach, evaluate_js now watches the renderer itself, by sending it
// a probe (Runtime.evaluate of `0`). Measured, Chrome 156:
//
//   renderer                            probe answered after
//   paused at a breakpoint              4ms
//   in a 2s loop, probe sent at 200ms   1791ms, once the loop ended
//
// An idle renderer answers at once, as a paused one does. Runtime.terminateExecution is not held
// back by a loop: it was answered in 14–30ms, and the evaluation ended within ~40ms, with or
// without the debugger enabled. Sent to a page with nothing running, Runtime.terminateExecution is
// dropped: the next evaluation and an already-queued timer both ran.

// How long the renderer may go without answering a probe before evaluate_js terminates the code
// that holds it. Five seconds of a blocked main thread is more than any legitimate debugging
// expression needs, and a page blocked that long is already broken. Neither a pause nor time
// suspended at an `await` counts, since in both the renderer answers.
//
// Runtime.terminateExecution stops whatever is running, and that need not be the expression. Other
// code holds the renderer just the same in three cases: a loop in the page's own code that was
// already running when the call began; one that started while the expression waited at an
// `await`; or a loop in an expression that an earlier call left running, for example one that
// paused and was then resumed. Measured, Chrome 156, each case: the call terminated the loop and
// returned its own result, 6–7s after the call began.
export const EVAL_EXECUTION_TIMEOUT_MS = 5000;

// Gap between probes while an expression runs. The first probe goes out only this long after the
// expression, so an expression that finishes sooner — nearly all of them — costs no probe at all.
export const EVAL_PROBE_INTERVAL_MS = 1000;

// How long to wait for a terminated expression to end; measured above at ~40ms. A page showing a
// modal dialog answers neither the probe nor Runtime.terminateExecution. Measured, Chrome 156: an
// expression that called alert() went on to finish normally once the dialog was closed, with the
// Runtime.terminateExecution sent during the dialog having no effect. So an expression that has
// not ended by this bound is reported as held by a dialog, not as terminated.
export const EVAL_TERMINATE_WAIT_MS = 2000;

// Client-side: the wall-clock bound on the whole call. It covers three cases: an expression
// suspended on a promise that never settles; a context destroyed mid-evaluate by a navigation,
// which drops the command without ever answering it; and a pause the call cannot hear about,
// because this server's Debugger is not enabled (a breakpoint set in DevTools, say).
//
// Sized for what top-level `await` invites people to write: awaiting a slow fetch, an
// animation, a poll for an element. 30s matches the de-facto convention for browser
// automation (Playwright's default action timeout, Puppeteer's default navigation timeout).
//
// The ceiling is the MCP client's own request timeout, DEFAULT_REQUEST_TIMEOUT_MSEC = 60s.
// Staying well under it is the point: whichever timer fires first writes the error message,
// and ours names the cause while the client's only says the call took too long.
export const EVAL_SETTLE_TIMEOUT_MS = 30_000;

// Bound on the optional deep-value upgrade in remote-object.ts, which runs AFTER the evaluation
// has settled within EVAL_SETTLE_TIMEOUT_MS — so it has to be small enough that the two cannot
// add up past the MCP client's 60s. 30 + 5 leaves real headroom.
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
// The debugger/console attach that the first such tool call makes is bounded by it too, as a
// whole: two enables and a 200ms look for a pause already in place, under half a second on a
// heavy page. Its numbers are at InspectorSession.attach.
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

// Bound on a navigate or reload, from issuing the command to the new page's load event.
// Unlike every bound above, this one waits on the network rather than on the renderer, so it
// is sized like EVAL_SETTLE_TIMEOUT_MS and for the same reasons: 30s is Puppeteer's default
// navigation timeout, and it leaves room under the MCP client's 60s for the PAGE_COMMAND_TIMEOUT_MS
// read of the new page's title that follows it.
export const NAVIGATION_TIMEOUT_MS = 30_000;

// How long pause_execution waits for its pause to land. Debugger.pause stops at the next
// statement that runs, so the wait is set by what the page is doing. Measured, Chrome 156, a
// background tab — hidden, as is any tab in a window that is minimised or fully covered:
//
//   page                       pause landed after
//   in a synchronous loop            6ms
//   a 100ms setInterval        17–997ms, median 468ms (30 runs)
//   a 1000ms setInterval     1000–1883ms (12 runs)
//   idle                       never: nothing runs
//
// A hidden tab runs its timers once a second at most, which is what spreads the middle rows over
// a whole second and more; a visible one runs them on time. 2s takes in any page with a timer due
// once a second or more often, hidden or not. The last row sets the cost: an idle page holds the
// call for all of it, only to hear that the pause is still pending — the answer it gets however
// long the wait. That is why the bound is not stretched to catch every slow timer.
export const PAUSE_WAIT_TIMEOUT_MS = 2000;

// How long a step tool waits for the pause its step causes. Measured, Chrome 156, a background tab:
//
//   step                                                    paused after
//   to the next statement, into a call, or out of one       0–6ms
//   over an `await` of a 2500ms timer                       2926ms, on the statement after it
//   past the end of a timer callback, a 100ms interval set  610ms, in the interval's callback
//   past the end of a timer callback, no other timer set    never: nothing runs
//   over a call into an endless loop                        never
//
// So a step pauses within milliseconds wherever code runs on. The wait matters only for a step that
// waits for code to run: at an `await`, or past the end of the code that was running. 5s covers an
// `await` on a slow request. As with PAUSE_WAIT_TIMEOUT_MS, an idle page holds the call for the whole
// wait: a step past the end of an event handler waits 5s, only to report that it has not paused.
export const STEP_WAIT_TIMEOUT_MS = 5000;

// Spread into every Runtime.evaluate of an expression this server wrote itself — all but
// evaluate_js's, which runs the caller's code and so stops wherever the caller's breakpoints say.
//
// A read of the page is script like any other, so without this it is where a pending pause lands:
// one that pause_execution left on an idle page, or that DevTools' pause button did. Measured,
// Chrome 156, a pause requested on an idle tab: the next Runtime.evaluate stopped on its own first
// statement, whether it came over the session that asked for the pause or over a fresh connection
// like probeVisible's — so the read never answered, and the page sat paused in code nobody wrote.
// With `disableBreaks` the read answered in 21ms, and the pause stayed pending for the page's own
// code. It covers the evaluation itself only: a callback the expression leaves behind, such as
// the one an awaited setTimeout runs, still stops — so an expression that waits must not leave
// one behind (see the screenshot's frame wait).
export const OWN_EXPRESSION = { disableBreaks: true } as const;

// The answer to a CDP round-trip that outlived its bound. Deliberately a normal tool error
// rather than a thrown one: "this renderer never answered" is a state the caller can act on
// (resume the debugger, dismiss the dialog, reload the tab), not a fault in this server.
export const rendererTimedOut = (
  what: string,
  causes = 'paused at a breakpoint, blocked in a synchronous loop, or blocked on a modal dialog',
) => ({
  content: [
    {
      type: 'text' as const,
      text:
        `Error: ${what} did not answer within ${PAGE_COMMAND_TIMEOUT_MS}ms. ` +
        `The tab's renderer is not responding — it may be ${causes}.`,
    },
  ],
  isError: true,
});

// rendererTimedOut for the debugger/console attach. A breakpoint is not among the causes there:
// a paused renderer answers both enables straight away (measured at InspectorSession.attach).
//
// The retry advice holds for every caller: most never ran their operation, and switch_tab, which
// already switched, finds itself on that tab and does nothing more.
export const attachTimedOut = (what: string) => {
  const result = rendererTimedOut(what, 'blocked in a synchronous loop, or blocked on a modal dialog');
  result.content[0].text +=
    ' Retry once the page responds again (the loop ends or the dialog is closed): the attach was not cancelled, and will have finished by then.';
  return result;
};

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

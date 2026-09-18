# Tool boundaries

●Why this server draws its tools where it does, why several pairs that look mergeable are not merged, and how the descriptions either side of a boundary point at each other. Written for anyone — human or agent — arriving at "these two could be one tool with an extra parameter".

## The count is not the metric

◆What a caller actually pays is the serialised tool definitions carried in its context.
◆Measured on the current set: **21,348 characters (~5.9k tokens) across 24 tools**, of which `get_network_requests` alone is 25%. The four stepping tools together are 5%.
◆So merging tools to lower the count trades a real cost (a caller choosing the wrong tool) for a negligible one. It also does not remove the decision — it relocates it from a tool name into an enum value, and drops the per-tool description that helps a caller get it right.
◆Where the schemas are large, they are large on purpose: `get_network_requests` spends its budget documenting navigation pruning, URL truncation markers and redirect-hop semantics — things a caller silently misreads without them.

## evaluate_js / evaluate_at_frame

**Not merged — and not for the reason it first appears.**

●It is _not_ because one returns values and the other returns previews. Both `Runtime.evaluate` and `Debugger.evaluateOnCallFrame` accept `returnByValue` and `generatePreview`, so rendering is a free parameter on either method. A difference that either tool could adopt tomorrow cannot justify a split.
●The reason is that `evaluate_at_frame`'s precondition is **invisible session state**. A merged `evaluate_js({ expression, frameIndex? })` would have to pick one of two behaviours when called while paused with no `frameIndex`:

- **Evaluate globally.** An agent reading a local variable at a breakpoint then gets a same-named global, or a ReferenceError, with nothing indicating it read the wrong scope.
- **Switch to frame 0.** As the DevTools Console does. The same call now means different things depending on a pause state the caller cannot see without a separate `get_debugger_state` round-trip.

●Both are silent-error sources, and an agent gets no feedback loop that would let it notice.
●Two names make the state explicit: each tool has exactly one meaning, always. Choosing between two well-named tools is also the operation a model performs most reliably — more so than remembering an optional parameter that is conditional on state it must query separately.
●The rendering difference survives as a _consequence_ of the two purposes, not as their justification: `evaluate_js` is value-first (a Console in DevTools — you want the value), `evaluate_at_frame` is preview-first (a Watch pane in DevTools— you want to see what the object is).
●`preview` is CDP's own term: a `Runtime.ObjectPreview`, flagged `overflow` when truncated. See `src/remote-object.ts`, which holds both renderers and the measured CDP behaviour behind them.

## step_over / step_into / step_out / resume_execution

**Not merged.** 

■These are the standard debugger primitives, not overlapping conveniences: `next` / `step` / `finish` / `continue` in gdb, `next` / `stepIn` / `stepOut` / `continue` in DAP, four distinct `Debugger.*` methods in CDP. ■They are mutually exclusive and none can be expressed through another. ■`resume_execution` is not a stepping mode at all.
■Collapsing them into `step({ direction })` would remove three names and no decisions.

## get_title / get_url vs list_tabs

**Deliberate overlap.**

❤`list_tabs` already reports every tab's title and URL, so these two are redundant in the strict sense.
❤They are kept because reading the current page's title or URL is frequent and their whole schemas are among the smallest in the set (~260 characters each), while `list_tabs` returns every tab and exists to choose between them.

## evaluate_js vs get_inspected_element

▲Not a narrower `evaluate_js`, and not a matter of naming which element you mean — the selection is simply out of reach. `$0` is not a page variable; it resolves from the inspector's selected-node state, which is per CDP session, and this server's session never holds it. No expression can get there.
▲`window.$0 = $0`, run in the DevTools console, is what bridges that: it copies the element into a real `window` property, which `get_inspected_element` reads and returns as a structured record. The manual step is the boundary itself, not friction a better expression could remove.
▲The measurements behind this, and why `DOM.setInspectedNode` is not a way around the step, are in the comment above the tool in `src/tools/page.ts`.

## get_scope_variables vs evaluate_at_frame

◆`get_scope_variables` lists every variable in ONE scope of ONE paused frame: you pick the frame index and the scope type (`local`, `closure`, `block`, `global`, `script`, `module`), and get back every name in that scope with its value.
◆`evaluate_at_frame` evaluates one expression that you write. Producing the same listing through it would mean naming every variable up front — and not knowing the names is the usual reason to open a scope at all.

## set_breakpoint / remove_breakpoint / list_breakpoints

■Ordinary CRUD, left as three verbs. One tool with an `op` parameter would carry three different required-parameter sets and three different return shapes under a single schema, which JSON Schema expresses poorly and a caller reads worse.

## Cross-references are for disambiguation, not discovery

□Every tool name is already in the caller's context — the tool list is the table of contents, and a description that re-lists its neighbours only spends budget. 
□A cross-reference earns its place only where a caller could plausibly pick the wrong tool and get a wrong answer.
□That makes the right direction depend on the relationship:

- **Confusable alternatives** — `evaluate_js` / `evaluate_at_frame`. Either one can be the wrong landing point, and landing wrong yields a silently wrong answer, so the reference is **bidirectional**. A one-way reference here is worse than none: whoever arrives at the unmarked side believes they have seen the whole picture.
- **Prerequisites** — `evaluate_at_frame` → `get_debugger_state` (frame indices), `switch_tab` → `list_tabs` (targetId), `get_network_response_body` → `get_network_requests` (requestId), `remove_breakpoint` → `set_breakpoint` (breakpointId). **One-way, pointing at the input source.** The dependent tool cannot be called without the id; the producer loses nothing, because a caller who stops after it has merely stopped — there is no wrong answer to prevent. Reciprocating these would turn hub tools into directories: `get_debugger_state` is named by three tools, `set_breakpoint` and `get_network_requests` by two each.
- **Contrast warnings** — `get_network_requests` → `get_console_logs`, noting that network capture does not replay pre-connect history while console capture does. **One-way, placed where the surprise is.** A caller reading `get_console_logs` is not about to be surprised, so the note does not belong there.

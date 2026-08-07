# Todo — MCP modern paradigm migration

Coordinated pass to move every tool's return contract from
`content: [{ type: 'text', text: JSON.stringify(...) }]` to the modern MCP
pattern: `outputSchema` + `structuredContent` + `isError`.

**Do this AFTER the per-tool description/behavior review is complete** —
migration and review changes overlap (both touch description text and return
shape), so batching migration once tools are behaviorally sound avoids
churn.

Pilot: `get_computed_style` — pattern established at
[src/server.ts:354-405](src/server.ts#L354-L405). Reference this when
migrating others.

## What the migration does per tool

- Add `outputSchema` (Zod object).
- Return `structuredContent: {...}` for machine use; keep
  `content: [{ type: 'text', text: JSON.stringify(...) }]` for older clients
  and human display.
- Drop `Returns \`{...}\`` prose from the description — outputSchema is now
  the doc.
- Add `.describe()` on output fields when the name alone is ambiguous
  (e.g. `resolvedLocations` — the "may be empty until script loads" nuance
  belongs on the schema field, not the tool description).
- Error paths return `isError: true`. `NOT_CONNECTED` already carries it,
  so infra errors are covered.

## Tools to migrate

Tools with structured returns (need outputSchema):
- [ ] `set_breakpoint` → `{ breakpointId, resolvedLocations }`
- [ ] `list_breakpoints` → wrap array: `{ breakpoints: [...] }`
- [ ] `get_debugger_state` → complex object; biggest schema
- [ ] `get_console_logs` → wrap array: `{ logs: [...] }`
- [ ] `list_tabs` → wrap array: `{ tabs: [...] }`
- [ ] `switch_tab` → object with tab metadata
- [ ] `get_scope_variables` → wrap array
- [ ] `get_inspected_element` → object

Tools that stay unchanged:
- `screenshot` — image content, not structured
- `get_url` / `get_title` — plain text is the natural return
- `get_html` — text
- `evaluate_js` / `evaluate_at_frame` — return is arbitrary JS values;
  `outputSchema` too restrictive. Leave as text, or use `z.unknown()` if
  worth trying.

## Gotchas (learned during pilot)

- **outputSchema top-level must be `type: "object"`** — MCP spec
  restriction. Wrap arrays/scalars: `{ items: [...] }`, not raw
  `z.array(...)`.
- **Zod v4 syntax**: `z.record(z.string(), z.string())` — the v3 shorthand
  `z.record(z.string())` fails to compile in v4.
- **`isError` covers both domain and infra errors** — set it for "selector
  not found" (domain) as well as "Chrome not connected" (infra). Signals to
  the agent that `content` is a diagnostic message, not data to parse.
- **Description tightens automatically** — after adding outputSchema,
  sentences like "Returns `{ breakpointId, resolvedLocations }`" become
  redundant with the schema. Delete them so the description keeps only
  semantic info ("what does it do"), not mechanical ("what shape").
- **Dual return (`content` + `structuredContent`) is the safe default** —
  the spec allows one or both; providing both gives forward-compat (modern
  clients read structuredContent) and backward-compat (old clients / human
  display use content).
- **Update tests to assert `structuredContent` and `isError`** — otherwise
  the migration is under-verified. Existing text-only assertions still
  pass (structuredContent is additive), so it's easy to miss.
- **Don't touch `dist/`** — user rebuilds separately.

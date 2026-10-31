# Dev Hint

- Do not assume Chrome starts in a clean debugging state.
- Chrome may already have active targets, sessions, breakpoints, or enabled domains before this MCP server starts.
- All tools should handle and synchronize these existing states during server initialization.

# Client-Agnostic

- This MCP server is generic: do not design tools or write docs around any one client, Claude Code included.
- Only a tool's name, description and inputSchema are certain to reach the model. Whether `outputSchema` and `annotations` do is up to the client (Claude Code drops them), so anything a caller needs to read a result correctly must not live only there.
- A tool description says only what the caller cannot learn elsewhere: not what its inputSchema says, nor what another tool's description already says, unless a caller would otherwise misread a result or pick the wrong tool. Many clients send every description with every request.

# Temporary Docs

- Disposable working notes and design docs are named `*.tmp.md` or `*.local.md`.
- Never reference a `*.tmp.md` or `*.local.md` file from anything that outlives it: source comments, README, `docs/`, tool descriptions, or commit messages.
- If the reasoning in one is worth keeping, inline it where it belongs instead of linking to it.

# Writing Style

Applies to source comments, tool descriptions and error messages alike. A reader should never have to decode a sentence.

- When a `which`/`it`/`that` would reach back across a long clause, name its antecedent again instead. Next to its antecedent, a pronoun is fine.
- Do not refer back to an event with a noun made from its verb ("it refuses … the refusal"). Name the thing again: "Debugger.resume fails … the failed resume".
- No metaphors or idioms standing in for a plain statement: not "survives the refusal" but "is not cancelled by it"; not "finds itself on that tab" but "is already on that tab"; not "once the page is let go" but "once the loop ends or the dialog is closed".
- Split a sentence that carries more than one claim. Several cases go in a list ("in two cases: A, or B"), not in a `both when … and when …, which …` chain.
- Say what the reader can do, not just the internal state: "Retry once the page responds", not "the next call finds it done".

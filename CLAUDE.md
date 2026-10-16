# Dev Hint

- Do not assume Chrome starts in a clean debugging state.
- Chrome may already have active targets, sessions, breakpoints, or enabled domains before this MCP server starts.
- All tools should handle and synchronize these existing states during server initialization.

# Client-Agnostic

- This MCP server is generic: do not design tools or write docs around any one client, Claude Code included.
- Only a tool's name, description and inputSchema are certain to reach the model. Whether `outputSchema` and `annotations` do is up to the client (Claude Code drops them), so anything a caller needs to read a result correctly must not live only there.

# Temporary Docs

- Disposable working notes and design docs are named `*.tmp.md` or `*.local.md`.
- Never reference a `*.tmp.md` or `*.local.md` file from anything that outlives it: source comments, README, `docs/`, tool descriptions, or commit messages.
- If the reasoning in one is worth keeping, inline it where it belongs instead of linking to it.

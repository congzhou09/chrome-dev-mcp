# Dev Hint

- Do not assume Chrome starts in a clean debugging state.
- Chrome may already have active targets, sessions, breakpoints, or enabled domains before this MCP server starts.
- All tools should handle and synchronize these existing states during server initialization.

# Temporary Docs

- Disposable working notes and design docs are named `*.tmp.md` or `*.local.md`.
- Never reference a `*.tmp.md` or `*.local.md` file from anything that outlives it: source comments, README, `docs/`, tool descriptions, or commit messages.
- If the reasoning in one is worth keeping, inline it where it belongs instead of linking to it.

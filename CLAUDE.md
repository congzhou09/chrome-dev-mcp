# Dev Hint

- Do not assume Chrome starts in a clean debugging state.
- Chrome may already have active targets, sessions, breakpoints, or enabled domains before this MCP server starts.
- All tools should handle and synchronize these existing states during server initialization.

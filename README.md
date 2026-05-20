# chrome-dev-mcp

●An MCP server that connects AI agents to a running Chrome tab via the Chrome DevTools Protocol (CDP).

●This project focuses on Chrome runtime debugging.

## Why This Exists

●Currently, [chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp) is still focused more on browser automation and inspection than full runtime debugging, though it is clearly moving toward exposing more DevTools capabilities, as described in this [Let your Coding Agent debug your browser session with Chrome DevTools MCP](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session?utm_source=chatgpt.com).

●Meanwhile, the underlying debugging capabilities are already available through tools such as chrome-remote-interface and @jridgewell/trace-mapping.

●This project exists as a faster, independent implementation focused specifically on making Chrome runtime debugging usable for AI agents before similar functionality is officially available in chrome-devtools-mcp.

## Limitations

■ Connects to the first `page` target whose URL contains `localhost`. Other pages, iframes, workers, and service workers are not supported at present.
■ Not designed to run alongside chrome-devtools-mcp. Both register overlapping tool names and maintain independent debugger state against the same Chrome target, which causes confusion for the AI and potential state conflicts.

## Prerequisites

- Node.js 22+
- Google Chrome

## Usage

### Chrome

●Launch Chrome with remote debugging enabled.

```
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\chrome-debug-profile
# --user-data-dir can be any empty directory; it keeps the debug session isolated from your normal Chrome profile.
# Verify remote debugging is active by opening http://localhost:9222/json in a browser — it should return a JSON list of debuggable targets.

```

●Open the page you want to debug.

●This MCP server will connect to the first `page` target whose URL contains `localhost`.

### Claude Code configuration

#### through local project

●Clone this project to local.

●Add the server to Claude Code's MCP.

```
claude mcp add --transport stdio chrome-dev -- node "path/to/chrome-dev-mcp/dist/index.js"
```

●Claude Code's config(`~/.claude.json`) may like this:

```json
"mcpServers": {
  "chrome-dev": {
    "type": "stdio",
    "command": "node",
    "args": ["path/to/chrome-dev-mcp/dist/index.js"],
    "env": {}
  }
}
```

#### through npm package

●Install npm package globally.

```
npm install -g chrome-dev-mcp
```

●Add the server to Claude Code's MCP.

```
claude mcp add --transport stdio chrome-dev -- chrome-dev-mcp
```

●Claude Code's config(`~/.claude.json`) may like this:

```json
"mcpServers": {
  "chrome-dev": {
    "type": "stdio",
    "command": "chrome-dev-mcp",
    "args": [],
    "env": {}
  }
},
```

### Validation

●run `claude mcp list`, and it will print `chrome-dev: xxxxx - ✓ Connected`.

## Tools

### Page inspection

| Tool                 | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `get_title`          | Current page title                                    |
| `get_url`            | Current page URL                                      |
| `get_html`           | Full page HTML (capped at 20,000 chars)               |
| `evaluate_js`        | Run arbitrary JavaScript and return the result        |
| `get_computed_style` | Computed CSS properties for a CSS selector            |
| `element_from_point` | Topmost element at a selector's bounding-box position |
| `screenshot`         | PNG screenshot of the current viewport                |

### Debugger

| Tool                  | Description                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `get_debugger_state`  | Paused status, pause reason, hit breakpoints, and full call stack with file + line (map to source code if possible) |
| `get_scope_variables` | Variable values inside a call frame scope (`local`, `closure`, `block`, `global`, …)                                |
| `set_breakpoint`      | Set a breakpoint by URL + line number; supports conditions and URL regex                                            |
| `remove_breakpoint`   | Remove a breakpoint by its ID                                                                                       |
| `list_breakpoints`    | All breakpoints active in this session                                                                              |
| `pause_execution`     | Pause JS execution immediately                                                                                      |
| `resume_execution`    | Resume after a pause or breakpoint                                                                                  |
| `step_over`           | Execute current line, pause at next (skips into calls); returns updated call stack                                  |
| `step_into`           | Step into the function call on the current line; returns updated call stack                                         |
| `step_out`            | Step out of the current function back to the caller; returns updated call stack                                     |

## Typical debugging workflow

1. Bring Chrome to the desired state manually — navigate to a specific route, trigger a flow, or pause at a breakpoint.
2. Ask the AI what you want to investigate; it will call `get_debugger_state`, `get_scope_variables`, etc. when needed.

```
# Example sequence Claude might use
get_debugger_state          → { paused: true, callStack: [{ functionName: "handleClick", url: "...", lineNumber: 42 }] }
get_scope_variables         → [{ name: "event", type: "object", value: "MouseEvent" }, ...]
```

## Development

●Install dependencies by `pnpm install`, and then:

```
pnpm dev          # development (tsx watch)
pnpm build        # tsc type-check + compile to dist/
pnpm start        # run compiled build
pnpm test         # run vitest
```

# chrome-dev-mcp

●An MCP server that connects Claude Code to a running Chrome tab via the Chrome DevTools Protocol (CDP).

●Let Claude inspect page content, capture screenshots, and control the JavaScript debugger.

## Usage

### Prerequisites

●Chrome launched with remote debugging enabled

```
chrome.exe --remote-debugging-port=9222 --user-data-dir=${"D:\chrome-debug", for example}
```

●This MCP server will connect to the first `page` target whose URL contains `localhost`.

### Claude Code configuration

●Add the server to Claude Code's MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "chrome-dev": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/chrome-dev-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

### Validation
●run `claude mcp list`, and it will print `chrome-dev: node path/to/chrome-dev-mcp/dist/index.js - ✓ Connected`.

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

| Tool                  | Description                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `get_debugger_state`  | Paused status, pause reason, hit breakpoints, and full call stack with file + line   |
| `get_scope_variables` | Variable values inside a call frame scope (`local`, `closure`, `block`, `global`, …) |
| `set_breakpoint`      | Set a breakpoint by URL + line number; supports conditions and URL regex             |
| `remove_breakpoint`   | Remove a breakpoint by its ID                                                        |
| `list_breakpoints`    | All breakpoints active in this session                                               |
| `pause_execution`     | Pause JS execution immediately                                                       |
| `resume_execution`    | Resume after a pause or breakpoint                                                   |
| `step_over`           | Execute current line, pause at next (skips into calls); returns updated call stack   |
| `step_into`           | Step into the function call on the current line; returns updated call stack          |
| `step_out`            | Step out of the current function back to the caller; returns updated call stack      |

## Typical debugging workflow

1. Set a breakpoint or add `debugger;` in your source code.
2. Trigger the code path in Chrome (click a button, reload the page, etc.).
3. Chrome pauses — call `get_debugger_state` to see the call stack and current file/line.
4. Call `get_scope_variables` to inspect local variables at any frame.
5. Use `step_over` / `step_into` / `step_out` to walk through execution; each call returns the new position automatically.
6. Call `resume_execution` when done.

```
# Example sequence Claude might use
get_debugger_state          → { paused: true, callStack: [{ functionName: "handleClick", url: "...", lineNumber: 42 }] }
get_scope_variables         → [{ name: "event", type: "object", value: "MouseEvent" }, ...]
step_over                   → { paused: true, callStack: [{ lineNumber: 43 }] }
resume_execution            → "Execution resumed."
```

## Development

●Install dependencies by `pnpm install`, and then:
```
pnpm dev          # development (tsx watch)
pnpm build        # tsc type-check + compile to dist/
pnpm start        # run compiled build
pnpm test         # run vitest
```

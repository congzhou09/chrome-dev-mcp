# chrome-dev-mcp

[![npm chrome-dev-mcp package](https://img.shields.io/npm/v/chrome-dev-mcp.svg)](https://npmjs.org/package/chrome-dev-mcp)

●An MCP server that attaches to an already-running Chrome tab for real runtime debugging: breakpoints, stepping, and scope variables — plus JS/CSS inspection, console logs, and network capture. Built for web frontend development.

●It talks plain CDP through chrome-remote-interface — no DevTools SDK, no bundled browser — so it debugs the tab you already have open, in your own Chrome, instead of launching an isolated instance.

## Demo video

### Debugging js

[![Debugging js](https://github.com/user-attachments/assets/9f1a8066-4e0c-42cb-a95a-1bb58d5bbade)](https://github.com/user-attachments/assets/9d4de615-9b96-4780-ac72-c4097083bf8c)

### Inspecting html and css

[![Inspecting html and css](https://github.com/user-attachments/assets/d0a53c59-d3c8-4671-9387-9330cab952aa)](https://github.com/user-attachments/assets/2b15035b-c144-474a-91e3-71bbb607bf37)

## Why This Exists

●Currently, [chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp) is still focused more on browser automation and inspection than full runtime debugging, though it is clearly moving toward exposing more DevTools capabilities, as described in this [Let your Coding Agent debug your browser session with Chrome DevTools MCP](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session?utm_source=chatgpt.com).

●Meanwhile, the underlying debugging capabilities are already available through tools such as chrome-remote-interface and @jridgewell/trace-mapping.

●This project exists as a faster, independent implementation focused specifically on making Chrome runtime debugging usable for AI agents before similar functionality is officially available in chrome-devtools-mcp.

### Architectural difference from chrome-devtools-mcp

●chrome-devtools-mcp runs DevTools SDK models (`TargetManager`, `DebuggerModel`, `NetworkManager`, etc.) directly in Node.js via `chrome-devtools-frontend`'s `/mcp/mcp.js` entrypoint, backed by a Puppeteer CDP connection — capabilities that go beyond what the raw Chrome DevTools Protocol exposes directly.

●That approach comes with trade-offs: `chrome-devtools-frontend` is a very large package (it mirrors the entire Chrome DevTools frontend codebase), and the approach relies on the internal structure of the DevTools page remaining stable across Chrome versions.

●This project takes the opposite approach: plain CDP via `chrome-remote-interface`, no DevTools SDK, minimal dependencies. The result is a lightweight server that is easy to install, audit, and extend.

## Limitations

■ **Does not track Chrome's active tab automatically.** CDP does not expose a tab-switch event, so switching tabs in Chrome does not change the MCP connection — use `switch_tab` to explicitly reconnect to the tab you want.

■ **Iframes, workers, and service workers are not supported at present.**

■ **WebSocket frames are not captured.**

■ **Not designed to run alongside chrome-devtools-mcp**. Both register overlapping tool names and maintain independent debugger state against the same Chrome target, which causes confusion for the AI and potential state conflicts.

## Prerequisites

- Node.js 22+
- Google Chrome

## Usage

### Chrome

▲Launch Chrome with remote debugging enabled.

```
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\chrome-debug-profile
# --user-data-dir can be any empty directory; it keeps the debug session isolated from your normal Chrome profile.
```

▲Verify remote debugging is active by opening http://localhost:9222/json in a browser — it should return a JSON list of debuggable targets.

▲Open the page you want to debug. The MCP server connects to the active tab at startup. To switch to a different tab later, ask the AI to switch — it will use `list_tabs` and `switch_tab` as needed.

### Claude Code configuration

#### Through npm package

##### With a fixed version

▲Install npm package globally.

```
npm install -g chrome-dev-mcp
```

▲Add the server to Claude Code's MCP.

```
claude mcp add --transport stdio chrome-dev -- chrome-dev-mcp
```

▲Claude Code's config(`~/.claude.json`) will look like this:

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

##### Always use the latest version

▲Add the server to Claude Code's MCP.

```
claude mcp add --transport stdio chrome-dev -- npx -y chrome-dev-mcp@latest
# '-y' is not supportted at 20260522. We may change the config below directory.
```

▲Claude Code's config(`~/.claude.json`) will look like this:

```json
"mcpServers": {
  "chrome-dev": {
    "type": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "chrome-dev-mcp@latest"
    ],
    "env": {}
  }
},
```

#### Through local project

▲Clone this project to local.

▲Add the server to Claude Code's MCP.

```
claude mcp add --transport stdio chrome-dev -- node "path/to/chrome-dev-mcp/dist/index.js"
```

▲Claude Code's config(`~/.claude.json`) will look like this:

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

### Validation

●run `claude mcp list`, and it will print `chrome-dev: xxxxx - ✓ Connected`.

## MCP Tools

24 tools in six groups — five domains plus one cross-cutting tool:

| Group | Tools | Covers |
| --- | --- | --- |
| Tab management | 2 | Discovering tabs, and choosing which one this server is attached to |
| Page inspection | 7 | The live page: title, URL, HTML, computed CSS, screenshots, the DevTools-selected element, and arbitrary evaluation |
| Console | 1 | Console messages and uncaught exceptions, including output from before this server connected |
| Debugger | 11 | Breakpoints, stepping, call stack, scopes, frame-scoped evaluation |
| Network | 2 | Requests captured from connect time onward, plus response bodies fetched on demand |
| Capture buffers | 1 | `clear_captures` — cross-cutting: resets the console and network buffers above |

All 24 serve the same workflow: get the page into the state where it misbehaves, then read whatever explains it — a console error, a network response, the DOM and its computed CSS, or a paused call stack and its scopes. Several pairs below look mergeable and are deliberately not — [docs/tool-boundaries.md](docs/tool-boundaries.md) records which, and why.

### Tab management

| Tool         | Description                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tabs`  | List all open Chrome page tabs as `{ targetId: { title, url, active?: true } }` — the currently connected tab is marked with `active: true` |
| `switch_tab` | Switch the MCP connection to a specific tab by `targetId` (obtained from `list_tabs`)                                                       |

### Page inspection

| Tool                    | Description                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `get_title`             | Current page title                                                                                             |
| `get_url`               | Current page URL                                                                                               |
| `get_html`              | Full page HTML (capped at 20,000 chars)                                                                        |
| `evaluate_js`           | Run arbitrary JavaScript in global scope, with DevTools console semantics: top-level `await` works, and an expression that merely returns a promise stays pending rather than being awaited for you. Returns the real value when it serialises; DOM nodes, Errors, Maps and class instances come back as a preview instead — class name plus a first level of properties, readable but not parseable as the value |
| `get_computed_style`    | Computed CSS values for the given properties on a CSS selector                                                 |
| `screenshot`            | PNG screenshot of the current viewport                                                                         |
| `get_inspected_element` | Tag, id, classes, attributes, and outerHTML of the element marked via `window.$0 = $0` in the DevTools console |

### Console

| Tool               | Description                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_console_logs` | All messages visible in the DevTools Console — including output that existed before this server connected. Exceptions are reported with their full stack trace (source-mapped when available). Supports filtering by level (`log` / `info` / `debug` / `warning` / `error` / `exception`). Not pruned on navigation — use `clear_captures` to start fresh. |

### Debugger

| Tool                  | Description                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `get_debugger_state`  | Paused status, pause reason, hit breakpoints, and full call stack with file + line (map to source code if possible) |
| `get_scope_variables` | Variable values inside a call frame scope (`local`, `closure`, `block`, `global`, …)                                |
| `evaluate_at_frame`   | Evaluate a JS expression in a paused call frame's scope — reads local variables, closures, and `this`. Errors out when not paused rather than falling back to global scope       |
| `set_breakpoint`      | Set a breakpoint by URL + line number; supports conditions and URL regex                                            |
| `remove_breakpoint`   | Remove a breakpoint by its ID                                                                                       |
| `list_breakpoints`    | All breakpoints active in this session                                                                              |
| `pause_execution`     | Pause JS execution immediately                                                                                      |
| `resume_execution`    | Resume after a pause or breakpoint                                                                                  |
| `step_over`           | Execute current line, pause at next (skips into calls); returns updated call stack                                  |
| `step_into`           | Step into the function call on the current line; returns updated call stack                                         |
| `step_out`            | Step out of the current function back to the caller; returns updated call stack                                     |

### Network

| Tool                        | Description                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_network_requests`      | HTTP requests captured from the connected tab — method, URL, resource type, status, transferred size, duration, initiator, and failure reason. Redirects appear as one record per hop. Filter by URL substring, resource type, or status class (`2xx` / `3xx` / `4xx` / `5xx` / `failed` / `pending`). `headerKeys` returns the named request/response headers (omit for none, `["*"]` for all). |
| `get_network_response_body` | Response body for one `requestId` from `get_network_requests`. Fetched from Chrome on demand — never buffered by this server, and Chrome discards it on navigation, so fetch while the page is still up. Binary bodies are reported as metadata only.                                                                                                                                                                                                             |

▲Unlike `get_console_logs`, network capture is **not** retroactive: `Network.enable()` has no history replay, so capture begins when this server connects to the tab and nothing before that is visible. Requests belonging to a previous page are then pruned on navigation, mirroring the DevTools Network panel default — the new document's own request is kept.

### Capture buffers

| Tool             | Description                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clear_captures` | Discard the console and/or network buffers this server holds, so the next read shows only what happens afterwards. Pick with `targets`; defaults to both. |

▲Affects this server only — nothing is cleared in Chrome or in the DevTools UI, and capture keeps running. Clearing cannot be undone: console entries are gone for good, since `Console.enable()` replays history only at attach time, while cleared network `requestId`s still resolve in `get_network_response_body` for as long as Chrome itself holds the body.

## Typical debugging workflow

◆Bring Chrome to the desired state manually — navigate to a specific route, trigger a flow, or pause at a breakpoint.

◆Ask the AI what you want to investigate, and it will call `get_debugger_state`, `get_scope_variables`, etc. automatically when needed.

◆To share a specific DOM element with the AI during debugging, select it in the Elements panel, then run this in the DevTools console:

```js
window.$0 = $0;
```

The AI can then call `get_inspected_element` to read its tag, attributes, and HTML.

```
# Example sequence Claude might use
get_debugger_state          → { paused: true, callStack: [{ functionName: "handleClick", url: "...", lineNumber: 42 }] }
get_scope_variables         → [{ name: "event", type: "object", value: "MouseEvent" }, ...]
evaluate_at_frame           → expression: "dropTargets.map(t => t.id)"  →  ["list-1", "list-2"]
```

> `evaluate_at_frame` runs in the paused frame's scope and can read local variables, whereas `evaluate_js` runs in the global scope and cannot.
> They stay separate tools so that the pause state — which the caller cannot see — is carried by the tool name instead of an optional
> parameter: `evaluate_js` never silently answers from the wrong scope, and `evaluate_at_frame` never silently answers from the global one.

## Development

●Install dependencies by `pnpm install`, and then:

```
pnpm dev          # development (tsx watch)
pnpm build        # tsc type-check + compile to dist/
pnpm start        # run compiled build
pnpm test         # run vitest
```

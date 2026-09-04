# server.ts 拆分方案

> 状态：**待实施**（下个迭代）。本文档只记录方案，代码未改动。
> 起点：`src/server.ts` 1596 行，21 + 2 = 23 个工具，56 个测试全绿。

## 为什么拆

`src/server.ts` 已到 1596 行。工具组之间本身零耦合（已被 `// ── xxx tools ──` banner 分好），
真正的约束只有一处：所有东西都在 `createServer` 的闭包里，工具处理函数直接读闭包变量。

拆分的成败取决于**这些闭包成员怎么对外暴露**。传得糙就退化成一个 god-object，比现在的闭包更差。

## 非目标

- **不改任何行为**。这是纯结构重构。
- **不改对外契约**。`createServer(getClient, switchToTarget, getCurrentTargetId)` 的签名、
  以及返回的 `{ server, attachNetwork }` 形状原样保留 —— `src/index.ts` 一行不用改。
- 不动 Network 的 eager attach / Debugger 的 lazy attach 这个既有设计（理由见 `discuss.md`）。

## 依赖审计（已实测，不是推测）

按 banner 切出 5 个区段，统计每段实际引用的闭包成员及次数：

| 工具组 | 行范围 | 行数 | 实际依赖的闭包成员 |
| --- | --- | --- | --- |
| tabs | 534–623 | 90 | `switchToTarget` ×1, `getCurrentTargetId` ×1, `ensureDebuggerEvents` ×1 |
| page | 624–843 | 220 | **仅 `getClient` ×7** |
| debugger | 844–1310 | 467 | `debuggerState` ×13, `getClient` ×10, `ensureDebuggerEvents` ×10, `formatCallStack` ×4, `waitForNextPause` ×3, `activeBreakpoints` ×3 |
| console | 1311–1378 | 68 | `consoleLogs` ×3, `getClient` ×1, `ensureDebuggerEvents` ×1 |
| network | 1379–1594 | 216 | `networkRequests` ×2, `getClient` ×2, `ensureNetworkEvents` ×2, `resetNetworkCapture` ×1, `networkRegisteredOnClient` ×1, `networkByRequestId` ×1, `discardedRequestIds` ×1 |

两个关键结论：

1. **`page` 组零会话依赖** —— 7 个工具全是纯 `Runtime.evaluate` / `Page.captureScreenshot`，
   只要 `getClient`。可以最先、最安全地搬走。
2. **`scriptRegistry` / `sourceMapCache` / `resolveOriginalPosition` 没有任何工具直接引用** ——
   它们只是 `formatCallStack` 和 `ensureDebuggerEvents` 内部的 source-map 机制。
   可以完全封装进去，不进任何对外接口。这是拆分能做干净的主要原因。

## 目标结构

```
src/
  types.ts              ~50   DebuggerState / ConsoleEntry / NetworkRecord
  constants.ts          ~70   NOT_CONNECTED, MAX_*, NETWORK_MAX_*,
                              RESOURCE_TYPES, caseInsensitiveEnum
  format.ts             ~60   formatUrl / formatInitiator /
                              headersToObject / toOutputRecord
  sourcemap.ts          ~70   createSourceMapResolver()
  debugger-session.ts   ~300  createDebuggerSession()
  network-capture.ts    ~170  createNetworkCapture()
  tools/
    tabs.ts             ~95   registerTabTools()
    page.ts             ~225  registerPageTools()
    debugger.ts         ~475  registerDebuggerTools()
    console.ts          ~70   registerConsoleTools()
    network.ts          ~220  registerNetworkTools()
  server.ts             ~60   只做装配
  index.ts              不改
```

`tsconfig.json` 是 `rootDir: "src"` + `include: ["src"]`，子目录无需配置改动，
`dist/` 会自动镜像结构。`tsconfig.build.json` 已用 `src/**/*.test.ts` 排除测试，也无需改。

## 两个会话对象的接口

拆分的核心。工具组拿到的是**有行为的会话对象**，不是一包裸 state。

### `src/sourcemap.ts`

完全吃掉 `scriptRegistry` + `sourceMapCache` + `fetchTraceMap` + `resolveOriginalPosition`。
只被 `debugger-session.ts` 使用，不进任何工具组。

```ts
export interface SourceMapResolver {
  /** 从 Debugger.scriptParsed 调用 */
  registerScript(scriptId: string, url: string, sourceMapURL?: string): void;
  /** 编译位置 → 原始位置；无 source map 或抓取失败时返回 null */
  resolve(scriptId: string, line0: number, col: number)
    : Promise<{ source: string; line: number; column: number; name?: string } | null>;
  reset(): void;
}

export function createSourceMapResolver(): SourceMapResolver;
```

### `src/debugger-session.ts`

拥有 `debuggerState` + `activeBreakpoints` + `consoleLogs`，以及现有的
`ensureDebuggerEvents` / `waitForNextPause` / `formatCallStack`。

**注意**：它同时拥有 console 缓冲区。这不是设计失误 —— 现有
`ensureDebuggerEvents` 用同一个身份判断、同一个复位块同时注册 Console 和 Debugger 监听，
因为两者共享「按需才付代价」的懒注册理由。拆成两个会话就得复制身份判断和复位逻辑。
命名见下方待定项。

```ts
export interface DebuggerSession {
  /** 现 ensureDebuggerEvents：按实例幂等，换实例则重新注册 + 复位 */
  attach(client: CDP.Client): Promise<void>;

  /** 只读快照；工具只读不写 */
  readonly state: Readonly<DebuggerState>;

  /** breakpointId → "url:line" */
  readonly breakpoints: ReadonlyMap<string, string>;
  addBreakpoint(id: string, label: string): void;
  removeBreakpoint(id: string): boolean;

  /** 已解析（source-map 后）的调用栈 */
  formatCallStack(): Promise<Array<{
    index: number; functionName: string; url: string;
    lineNumber: number; columnNumber: number;
    compiledUrl?: string; compiledLine?: number; scopeTypes: string[];
  }>>;

  /** 必须在发出 step 命令【之前】调用，否则会漏掉事件 */
  waitForNextPause(client: CDP.Client, timeoutMs?: number): Promise<boolean>;

  /** console 缓冲区读取；clear 对应 get_console_logs 的 clear 参数 */
  readConsoleLogs(opts: { limit: number; level?: string }): ConsoleEntry[];
  clearConsoleLogs(): void;
}

export function createDebuggerSession(): DebuggerSession;
```

### `src/network-capture.ts`

拥有 `networkRequests` + `networkByRequestId` + `discardedRequestIds` +
`networkRegisteredOnClient` + `networkAttachInFlight`。

两个方法专门把「直接读裸 state」换成行为，是这个接口的关键：
`isAttachedTo()` 替掉 network 工具里对 `networkRegisteredOnClient` 的直接比较，
`wasDiscarded()` 替掉对 `discardedRequestIds` 的直接查询。

```ts
export interface NetworkCapture {
  /** 现 ensureNetworkEvents：eager，由 index.ts 在 connect 时调用；永不 reject */
  attach(client: CDP.Client): Promise<void>;

  /** 供 get_network_requests 判断「是否刚换了新会话」以解释空 buffer */
  isAttachedTo(client: CDP.Client): boolean;

  /** 时间序，含每个 redirect hop 各一条 */
  readonly requests: readonly NetworkRecord[];

  /** requestId → 当前（最新）hop */
  get(requestId: string): NetworkRecord | undefined;

  /** 墓碑查询：true = 确实抓到过但数据已丢弃，用于区分「已丢弃」和「未知 id」 */
  wasDiscarded(requestId: string): boolean;

  reset(): void;
}

export function createNetworkCapture(): NetworkCapture;
```

### 工具组的注册签名

不引入统一的 `ToolContext` god-object —— 每组只声明自己真正需要的：

```ts
// tools/page.ts —— 依赖最少
export function registerPageTools(
  server: McpServer,
  getClient: () => Promise<CDP.Client | null>,
): void;

// tools/tabs.ts
export function registerTabTools(
  server: McpServer,
  deps: {
    switchToTarget: (targetId: string) => Promise<CDP.Client | null>;
    getCurrentTargetId: () => string | null;
    debuggerSession: DebuggerSession;
  },
): void;

// tools/debugger.ts
export function registerDebuggerTools(
  server: McpServer,
  getClient: () => Promise<CDP.Client | null>,
  debuggerSession: DebuggerSession,
): void;

// tools/console.ts
export function registerConsoleTools(
  server: McpServer,
  getClient: () => Promise<CDP.Client | null>,
  debuggerSession: DebuggerSession,
): void;

// tools/network.ts
export function registerNetworkTools(
  server: McpServer,
  getClient: () => Promise<CDP.Client | null>,
  networkCapture: NetworkCapture,
): void;
```

### 装配后的 server.ts

```ts
export function createServer(
  getClient: () => Promise<CDP.Client | null>,
  switchToTarget: (targetId: string) => Promise<CDP.Client | null>,
  getCurrentTargetId: () => string | null,
) {
  const debuggerSession = createDebuggerSession();
  const networkCapture = createNetworkCapture();

  const server = new McpServer({ name: pkgInfo.name, version: pkgInfo.version });

  registerTabTools(server, { switchToTarget, getCurrentTargetId, debuggerSession });
  registerPageTools(server, getClient);
  registerDebuggerTools(server, getClient, debuggerSession);
  registerConsoleTools(server, getClient, debuggerSession);
  registerNetworkTools(server, getClient, networkCapture);

  // 对外契约不变：index.ts 在 connectToTarget 里 eager 调用 attachNetwork
  return { server, attachNetwork: (c: CDP.Client) => networkCapture.attach(c) };
}
```

## 实施顺序

每步结束都跑 `pnpm build && pnpm test --run`，全绿再进下一步。
按「依赖最少的先走」排序，让风险单调递增：

1. `types.ts` + `constants.ts` + `format.ts` —— 纯搬迁，无逻辑。server.ts 降到 ~1430。
2. `tools/page.ts` —— 只依赖 `getClient`，最安全的一组，用来验证注册函数这个模式可行。
3. `sourcemap.ts` —— 独立单元，只有 `debugger-session` 会用。
4. `debugger-session.ts` —— 最大的一步。注意保留 `attach` 末尾那个 200ms 初始
   `paused` 握手，以及「复位块里绝不能加 network buffer」的注释（见 `server.ts` 现有注释）。
5. `network-capture.ts` —— 把 `networkRegisteredOnClient` 的直接比较换成 `isAttachedTo()`，
   `discardedRequestIds` 的直接查询换成 `wasDiscarded()`。
6. `tools/tabs.ts` / `tools/debugger.ts` / `tools/console.ts` / `tools/network.ts`。
7. `server.ts` 收敛成装配器。

## 验证

- **56 个现有测试全部走 MCP `callTool` 边界**，不碰任何内部实现 —— 所以它们是这次重构的
  现成安全网，重构前后必须逐一对齐，一个都不能改断言。
  唯一的例外是测试 harness 里的 `createServer` 解构和 `attachNetwork`，
  而对外契约保持不变，所以连 harness 也不用动。
- 每步跑 `pnpm build`（`tsc` 严格模式）+ `pnpm test --run`。
- 全部完成后，用 `listTools()` 核对仍是 23 个工具、`inputSchema` 全部合法、
  `resourceType` 枚举仍有 18 个成员（防止 `caseInsensitiveEnum` 搬迁时被写坏）。
- 最后跑一次真实 Chrome 端到端（在临时标签页里 `CDP.New` / `CDP.Close`，
  不要碰用户正在用的 tab）：确认 eager attach 抓到文档请求、reload 后
  loaderId 剪枝仍是「旧请求 0 残留 + 新 Document 保留」、body 能取回。

## 待定项

动手前需要定的三件事：

1. **`DebuggerSession` 的命名。** 它同时拥有 console 缓冲区（因为 `Console.enable()` 和
   `Debugger.enable()` 共享同一个懒注册入口）。叫 `DebuggerSession` 名不副实，
   `InspectorSession` 更准确但和 CDP 术语有歧义。也可以拆成两个会话共享一个 attach，
   但要复制身份判断和复位逻辑。
2. **`get_computed_style` 和 `get_inspected_element` 归哪组。** 现在按 banner 划进 page 组，
   但它们语义上更偏 DOM 检查。如果以后要加 DOM 类工具，可能值得单开 `tools/dom.ts`。
3. **`tools/debugger.ts` 拆完仍有 ~475 行**，是 5 个文件里最大的。要不要再切
   （断点 / 步进 / 作用域求值 三块），还是先接受这个尺寸。

## 已知不在本次范围

- `src/server.test.ts` 1040 行、56 个测试是否跟着拆（镜像成 `tools/*.test.ts` +
  抽出 `test-helpers.ts`），本次未决。源码拆完后测试仍能从 MCP 边界正常工作，
  不拆也不阻塞 —— 而且不动它正是它能当安全网的前提。
- WebSocket / EventSource 帧捕获（Network 那次迭代明确排除的范围）。

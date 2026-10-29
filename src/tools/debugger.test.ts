import { describe, it, expect, vi } from 'vitest';
import CDP from 'chrome-remote-interface';
import { PAGE_COMMAND_TIMEOUT_MS, PAUSE_WAIT_TIMEOUT_MS } from '../constants.js';
import { makeMockClient, setupMcpClient, setupServer, fireCdp, inlineSourceMap } from '../test-helpers.js';

describe('get_debugger_state', () => {
  it('returns not-paused state when not paused', async () => {
    const client = await setupMcpClient(makeMockClient());
    const result = await client.callTool({ name: 'get_debugger_state', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ paused: false }, null, 2) }]);
  });

  it('returns call stack when paused via CDP event', async () => {
    const cdpClient = makeMockClient();
    const mcpClient = await setupMcpClient(cdpClient);

    // First call triggers ensureDebuggerEvents, which registers handlers on the mock.
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });

    // Simulate Chrome firing a paused event by calling the registered handler directly.
    const pausedHandler = (cdpClient as any).Debugger.on.mock.calls.find(
      ([event]: [string]) => event === 'paused',
    )?.[1];
    pausedHandler?.({
      reason: 'breakpoint',
      hitBreakpoints: ['b:1:0'],
      callFrames: [
        {
          functionName: 'handleClick',
          url: 'http://localhost:3000/app.js',
          location: { scriptId: '1', lineNumber: 9, columnNumber: 2 },
          scopeChain: [{ type: 'local', object: { objectId: 'obj-1' } }],
        },
      ],
    });

    const result = await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.paused).toBe(true);
    expect(parsed.reason).toBe('breakpoint');
    expect(parsed.callStack[0].functionName).toBe('handleClick');
    expect(parsed.callStack[0].lineNumber).toBe(10); // converted from 0-indexed
    expect(parsed.callStack[0].columnNumber).toBe(3); // and so is the column, as set_breakpoint takes it
  });

  // Chrome drops a pause on navigation without sending Debugger.resumed, so the state has to
  // be cleared by the navigation itself — for the main frame only.
  const pauseThenNavigate = async (parentId?: string) => {
    const cdpClient = makeMockClient();
    const mcpClient = await setupMcpClient(cdpClient);
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    fireCdp(cdpClient, 'Debugger', 'paused', {
      reason: 'other',
      callFrames: [{ functionName: 'tick', url: 'http://localhost/a.js', location: { scriptId: '1', lineNumber: 0 } }],
    });
    fireCdp(cdpClient, 'Page', 'frameNavigated', {
      frame: { url: 'http://localhost/', loaderId: 'l2', ...(parentId ? { parentId } : {}) },
    });
    const result = await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    return JSON.parse((result.content as any)[0].text);
  };

  it('reports not paused after a main-frame navigation discards the pause', async () => {
    expect(await pauseThenNavigate()).toEqual({ paused: false });
  });

  it('stays paused when only a subframe navigates', async () => {
    expect((await pauseThenNavigate('main-frame')).paused).toBe(true);
  });
});

// The first debugger or console tool call attaches the session: Console.enable, then
// Debugger.enable. Chrome answers Console.enable only once it has replayed the console history,
// and not at all while the renderer is held in a loop or by a dialog — holding the mock's open
// reproduces both.
describe('attaching the debugger', () => {
  const holdConsoleEnable = (debuggerMethods: Record<string, ReturnType<typeof vi.fn>> = {}) => {
    let answer = () => {};
    const cdpClient: any = makeMockClient(undefined, undefined, debuggerMethods);
    cdpClient.Console.enable = vi.fn(() => new Promise<void>((resolve) => (answer = () => resolve())));
    return { cdpClient, answer: () => answer() };
  };

  // Keeps listeners the way chrome-remote-interface does — `<Domain>.on(event, handler)` puts the
  // handler on the client itself, under '<Domain>.<event>' — and returns how many of those each
  // event has on the client right now, for the events that have any.
  const trackListeners = (cdpClient: any) => {
    const viaOn = new Set<unknown>();
    for (const domain of ['Console', 'Debugger', 'Page', 'Runtime']) {
      cdpClient[domain].on = vi.fn((event: string, handler: (params: any) => void) => {
        viaOn.add(handler);
        cdpClient.on(`${domain}.${event}`, handler);
      });
    }
    return (): number[] =>
      cdpClient
        .eventNames()
        .map((name: string) => cdpClient.listeners(name).filter((handler: unknown) => viaOn.has(handler)).length)
        .filter((count: number) => count > 0);
  };

  it('makes a call that arrives mid-attach wait for it, rather than run ahead of Debugger.enable', async () => {
    const sent: string[] = [];
    const { cdpClient, answer } = holdConsoleEnable({
      enable: vi.fn(async () => {
        sent.push('Debugger.enable');
        return {};
      }),
      setBreakpointByUrl: vi.fn(async () => {
        sent.push('Debugger.setBreakpointByUrl');
        return { breakpointId: 'br:1:0:0:http://localhost/app.js', locations: [] };
      }),
    });
    const mcpClient = await setupMcpClient(cdpClient);

    const logs = mcpClient.callTool({ name: 'get_console_logs', arguments: {} });
    const breakpoint = mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { url: 'http://localhost/app.js', lineNumber: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);

    answer();
    await Promise.all([logs, breakpoint]);
    expect(sent).toEqual(['Debugger.enable', 'Debugger.setBreakpointByUrl']);
    expect(cdpClient.Console.enable).toHaveBeenCalledTimes(1);
  });

  it('answers with an error when the tab does not finish attaching, and finds the attach done later', async () => {
    const { cdpClient, answer } = holdConsoleEnable();
    const mcpClient = await setupMcpClient(cdpClient);

    vi.useFakeTimers();
    try {
      const pending = mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
      await vi.advanceTimersByTimeAsync(PAGE_COMMAND_TIMEOUT_MS + 1);
      const result = await pending;
      expect(result.isError).toBe(true);
      const text = (result.content as any)[0].text;
      expect(text).toContain(`did not answer within ${PAGE_COMMAND_TIMEOUT_MS}ms`);
      // A paused renderer answers both enables, so a pause is not offered as the cause.
      expect(text).not.toContain('breakpoint');

      // The renderer is let go: the attach already under way finishes, and no second one starts.
      answer();
      const next = mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
      await vi.advanceTimersByTimeAsync(250);
      expect((await next).isError).toBeFalsy();
      expect(cdpClient.Console.enable).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts over after Chrome refuses Debugger.enable, without registering its listeners twice', async () => {
    const cdpClient: any = makeMockClient(undefined, undefined, {
      enable: vi.fn().mockRejectedValueOnce(new Error('Script execution is prohibited')).mockResolvedValue({}),
    });
    const live = trackListeners(cdpClient);
    const mcpClient = await setupMcpClient(cdpClient);

    const refused = await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    expect(refused.isError).toBe(true);
    expect((refused.content as any)[0].text).toContain('Script execution is prohibited');

    const retried = await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    expect(retried.isError).toBeFalsy();
    expect(cdpClient.Debugger.enable).toHaveBeenCalledTimes(2);
    // The refused attempt took back every listener it added, so each event has only the retry's.
    const perEvent = live();
    expect(perEvent.length).toBeGreaterThan(0);
    expect(perEvent).toEqual(Array(perEvent.length).fill(1));
  });

  it('takes its listeners off a client it moves away from, so going back does not register them twice', async () => {
    const a: any = makeMockClient();
    const b: any = makeMockClient();
    const onA = trackListeners(a);
    const onB = trackListeners(b);
    let current = a;
    const { mcpClient } = await setupServer(() => current);
    const callOn = async (client: any) => {
      current = client;
      await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    };

    await callOn(a);
    const oneSet = onA();
    expect(oneSet.length).toBeGreaterThan(0);
    expect(oneSet).toEqual(Array(oneSet.length).fill(1));

    await callOn(b);
    expect(onA()).toEqual([]);
    expect(onB()).toEqual(oneSet);

    await callOn(a);
    expect(onA()).toEqual(oneSet);
    expect(onB()).toEqual([]);
  });

  it('lets an attach that another client took over midway register nothing more', async () => {
    const { cdpClient: a, answer } = holdConsoleEnable();
    const b: any = makeMockClient();
    const onA = trackListeners(a);
    let current = a;
    const { mcpClient } = await setupServer(() => current);

    const first = mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    await vi.waitFor(() => expect(a.Console.enable).toHaveBeenCalled());
    current = b;
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });

    // a's Console.enable answers only now, after b has taken over.
    answer();
    await first;
    expect(onA()).toEqual([]);
    expect(a.Debugger.enable).not.toHaveBeenCalled();
  });
});

describe('evaluate_at_frame', () => {
  async function pauseAt(cdpClient: CDP.Client, mcpClient: Awaited<ReturnType<typeof setupMcpClient>>) {
    // First call triggers ensureDebuggerEvents, which registers handlers on the mock.
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    const pausedHandler = (cdpClient as any).Debugger.on.mock.calls.find(
      ([event]: [string]) => event === 'paused',
    )?.[1];
    pausedHandler?.({
      reason: 'breakpoint',
      hitBreakpoints: ['b:1:0'],
      callFrames: [
        {
          callFrameId: 'cf-1',
          functionName: 'handleClick',
          url: 'http://localhost:3000/app.js',
          location: { scriptId: '1', lineNumber: 9, columnNumber: 2 },
          scopeChain: [{ type: 'local', object: { objectId: 'obj-1' } }],
        },
      ],
    });
  }

  it('renders a preview of an object rather than serialising it by value', async () => {
    const evaluateOnCallFrame = vi.fn().mockResolvedValue({
      result: {
        type: 'object',
        className: 'Foo',
        description: 'Foo',
        objectId: 'frame-obj-1',
        preview: {
          description: 'Foo',
          overflow: false,
          properties: [{ name: 'a', type: 'number', value: '1' }],
        },
      },
    });
    const cdpClient = makeMockClient(vi.fn(), undefined, { evaluateOnCallFrame });
    const mcpClient = await setupMcpClient(cdpClient);
    await pauseAt(cdpClient, mcpClient);

    const result = await mcpClient.callTool({ name: 'evaluate_at_frame', arguments: { expression: 'obj' } });

    // Shape, not value: a by-value round-trip would flatten this to {"a":1} and lose `Foo`.
    expect((result.content as any)[0].text).toBe('Foo {\n  a: 1\n}');
    expect(evaluateOnCallFrame).toHaveBeenCalledWith({
      callFrameId: 'cf-1',
      expression: 'obj',
      returnByValue: false,
      generatePreview: true,
    });
  });

  it('refuses to evaluate when the debugger is not paused', async () => {
    const evaluateOnCallFrame = vi.fn();
    const cdpClient = makeMockClient(vi.fn(), undefined, { evaluateOnCallFrame });
    const mcpClient = await setupMcpClient(cdpClient);

    const result = await mcpClient.callTool({ name: 'evaluate_at_frame', arguments: { expression: 'obj' } });

    // The precondition is the reason this is a separate tool from evaluate_js: it is
    // session state the caller cannot see, so it is reported rather than silently
    // falling back to global scope.
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('not paused');
    expect(evaluateOnCallFrame).not.toHaveBeenCalled();
  });
});

describe('set_breakpoint', () => {
  const chromeId = 'br:1:9:0:http://localhost:3000/app.js';

  it("calls setBreakpointByUrl and returns an id of its own, not Chrome's", async () => {
    const setBreakpointByUrl = vi.fn().mockResolvedValue({ breakpointId: chromeId, locations: [] });
    const cdpClient = makeMockClient(undefined, undefined, { setBreakpointByUrl });
    const mcpClient = await setupMcpClient(cdpClient);

    const result = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { url: 'http://localhost:3000/app.js', lineNumber: 10 },
    });

    expect(setBreakpointByUrl).toHaveBeenCalledWith({
      url: 'http://localhost:3000/app.js',
      lineNumber: 9,
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.breakpointId).toEqual(expect.any(String));
    expect(parsed.breakpointId).not.toBe(chromeId);
  });

  // Chrome answers in 0-based positions and scriptIds; the caller asked in 1-based ones and has
  // no tool that takes a scriptId.
  it('reports where it bound in the 1-based terms it was asked in, with the script URL', async () => {
    const setBreakpointByUrl = vi.fn().mockResolvedValue({
      breakpointId: chromeId,
      locations: [{ scriptId: 's1', lineNumber: 11, columnNumber: 4 }],
    });
    const cdpClient = makeMockClient(undefined, undefined, { setBreakpointByUrl });
    const mcpClient = await setupMcpClient(cdpClient);
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', { scriptId: 's1', url: 'http://localhost:3000/app.js' });

    const result = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { url: 'http://localhost:3000/app.js', lineNumber: 10 },
    });

    expect(result.structuredContent).toEqual({
      breakpointId: expect.any(String),
      resolvedLocations: [{ url: 'http://localhost:3000/app.js', lineNumber: 12, columnNumber: 5 }],
      note: 'Line 10 has no code that can take a breakpoint; it is on line 12 of http://localhost:3000/app.js, the next one that does.',
    });
  });
});

describe('set_breakpoint by source', () => {
  // Source line 14 compiles to generated line 10; 7 is a type alias and maps to nothing.
  const appMap = inlineSourceMap(
    ['App.tsx'],
    [[], [], [[0, 0, 1, 0]], [], [[0, 0, 9, 0]], [], [], [], [], [[4, 0, 14, 4]]],
  );
  const appUrl = 'http://localhost:5173/src/App.tsx';

  const setUp = async (
    setBreakpointByUrl: ReturnType<typeof vi.fn>,
    removeBreakpoint = vi.fn().mockResolvedValue({}),
  ) => {
    const cdpClient = makeMockClient(undefined, undefined, { setBreakpointByUrl, removeBreakpoint });
    const mcpClient = await setupMcpClient(cdpClient);
    // Attaches the session, which is what registers the scriptParsed listener.
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    return { cdpClient, mcpClient };
  };

  it('places the source line where it was compiled to, and reports both positions', async () => {
    const setBreakpointByUrl = vi.fn().mockResolvedValue({
      breakpointId: `br:1:9:4:${appUrl}`,
      locations: [{ scriptId: 's1', lineNumber: 9, columnNumber: 4 }],
    });
    const { cdpClient, mcpClient } = await setUp(setBreakpointByUrl);
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's1',
      url: appUrl,
      sourceMapURL: appMap,
      executionContextId: 1,
    });

    const result = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { source: 'src/App.tsx', lineNumber: 14, condition: 'n > 2' },
    });

    expect(setBreakpointByUrl).toHaveBeenCalledWith({
      url: appUrl,
      lineNumber: 9,
      columnNumber: 4,
      condition: 'n > 2',
    });
    const { breakpointId } = result.structuredContent as any;
    expect(result.structuredContent).toEqual({
      breakpointId,
      resolvedLocations: [
        { url: appUrl, lineNumber: 10, columnNumber: 5, source: appUrl, sourceLine: 14, sourceColumn: 5 },
      ],
    });
    const listed = await mcpClient.callTool({ name: 'list_breakpoints', arguments: {} });
    expect((listed.structuredContent as any).breakpoints).toEqual([
      { breakpointId, location: `${appUrl}:14 → ${appUrl}:10` },
    ]);
  });

  it('says so when the line has no code and the breakpoint went to the next line that does', async () => {
    const setBreakpointByUrl = vi.fn().mockResolvedValue({
      breakpointId: `br:1:4:0:${appUrl}`,
      locations: [{ scriptId: 's1', lineNumber: 4, columnNumber: 0 }],
    });
    const { cdpClient, mcpClient } = await setUp(setBreakpointByUrl);
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's1',
      url: appUrl,
      sourceMapURL: appMap,
      executionContextId: 1,
    });

    const result = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { source: 'src/App.tsx', lineNumber: 7 },
    });

    expect(setBreakpointByUrl).toHaveBeenCalledWith({ url: appUrl, lineNumber: 4, columnNumber: 0 });
    expect((result.structuredContent as any).note).toBe(
      `Line 7 has no code that can take a breakpoint; it is on line 9 of ${appUrl}, the next one that does.`,
    );
  });

  it('refuses source together with url, since they number different files', async () => {
    const setBreakpointByUrl = vi.fn();
    const { mcpClient } = await setUp(setBreakpointByUrl);

    const result = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { source: 'src/App.tsx', url: appUrl, lineNumber: 14 },
    });

    expect(result.isError).toBe(true);
    expect(setBreakpointByUrl).not.toHaveBeenCalled();
  });

  it('errors, rather than leaving an unbound breakpoint, for a file no loaded script has', async () => {
    const setBreakpointByUrl = vi.fn();
    const { mcpClient } = await setUp(setBreakpointByUrl);

    const result = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { source: 'src/Lazy.tsx', lineNumber: 3 },
    });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toMatch(/has not loaded yet/);
    expect(setBreakpointByUrl).not.toHaveBeenCalled();
  });

  // One module bundled into two chunks needs a Chrome breakpoint in each, but the caller set one.
  it('sets a file loaded in two scripts as one breakpoint, reported, listed and removed as one', async () => {
    const shared = (gen: number) => inlineSourceMap(['webpack://app/src/shared.ts'], [[], [], [[0, 0, gen, 0]]]);
    const [inA, inB] = ['br:1:2:0:http://x/a.js', 'br:1:2:0:http://x/b.js'];
    const setBreakpointByUrl = vi
      .fn()
      .mockResolvedValueOnce({ breakpointId: inA, locations: [{ scriptId: 'a', lineNumber: 2, columnNumber: 0 }] })
      .mockResolvedValueOnce({ breakpointId: inB, locations: [{ scriptId: 'b', lineNumber: 2, columnNumber: 0 }] });
    const removeBreakpoint = vi.fn().mockResolvedValue({});
    const { cdpClient, mcpClient } = await setUp(setBreakpointByUrl, removeBreakpoint);
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', { scriptId: 'a', url: 'http://x/a.js', sourceMapURL: shared(5) });
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', { scriptId: 'b', url: 'http://x/b.js', sourceMapURL: shared(5) });

    const result = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { source: 'src/shared.ts', lineNumber: 5 },
    });

    expect(setBreakpointByUrl).toHaveBeenCalledTimes(2);
    const { breakpointId } = result.structuredContent as any;
    expect((result.structuredContent as any).resolvedLocations.map((l: any) => l.url)).toEqual([
      'http://x/a.js',
      'http://x/b.js',
    ]);
    const listed = await mcpClient.callTool({ name: 'list_breakpoints', arguments: {} });
    expect((listed.structuredContent as any).breakpoints.map((b: any) => b.breakpointId)).toEqual([breakpointId]);

    // A hit in the second script reports the id the caller was given.
    fireCdp(cdpClient, 'Debugger', 'paused', {
      reason: 'other',
      hitBreakpoints: [inB],
      callFrames: [{ functionName: 'f', url: 'http://x/b.js', location: { scriptId: 'b', lineNumber: 2 } }],
    });
    const state = await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    expect((state.structuredContent as any).hitBreakpoints).toEqual([breakpointId]);

    await mcpClient.callTool({ name: 'remove_breakpoint', arguments: { breakpointId } });
    expect(removeBreakpoint.mock.calls.map(([arg]) => arg.breakpointId)).toEqual([inA, inB]);
  });
});

describe('set_breakpoint by source, when its file loads again', () => {
  const appUrl = 'http://localhost:5173/src/App.tsx';
  // Chrome's ids for the breakpoint in the first copy, and in the "?t=1" copy it is followed into.
  const [inFirst, inCopy] = [`br:1:9:4:${appUrl}`, `br:1:10:4:${appUrl}?t=1`];
  const text = (edit = '') => Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + edit;
  // Source line 14 at generated line `gen` (1-based), column 4.
  const mapAt = (gen: number, content = text()) =>
    inlineSourceMap(
      ['App.tsx'],
      Array.from({ length: gen }, (_, i) => (i === gen - 1 ? [[4, 0, 14, 4] as [number, number, number, number]] : [])),
      [content],
    );

  const setUp = async () => {
    const setBreakpointByUrl = vi
      .fn()
      .mockResolvedValueOnce({ breakpointId: inFirst, locations: [{ scriptId: 's1', lineNumber: 9, columnNumber: 4 }] })
      .mockResolvedValue({ breakpointId: inCopy, locations: [] });
    const removeBreakpoint = vi.fn().mockResolvedValue({});
    const cdpClient = makeMockClient(undefined, undefined, { setBreakpointByUrl, removeBreakpoint });
    const mcpClient = await setupMcpClient(cdpClient);
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's1',
      url: appUrl,
      sourceMapURL: mapAt(10),
      hash: 'h1',
    });
    const set = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { source: 'src/App.tsx', lineNumber: 14 },
    });
    const id = (set.structuredContent as any).breakpointId;
    setBreakpointByUrl.mockClear();
    // The state read settles the checks a new copy starts, so it is what the assertions wait on.
    const state = async () =>
      (await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} })).structuredContent as any;
    const listed = async () =>
      ((await mcpClient.callTool({ name: 'list_breakpoints', arguments: {} })).structuredContent as any).breakpoints;
    return { cdpClient, mcpClient, setBreakpointByUrl, removeBreakpoint, state, listed, id };
  };

  it('leaves it alone when a reload brings the file back unchanged', async () => {
    const { cdpClient, setBreakpointByUrl, removeBreakpoint, state, listed, id } = await setUp();

    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: appUrl,
      sourceMapURL: mapAt(10),
      hash: 'h1',
    });

    expect(await state()).toEqual({ paused: false });
    expect(setBreakpointByUrl).not.toHaveBeenCalled();
    expect(removeBreakpoint).not.toHaveBeenCalled();
    expect((await listed()).map((b: any) => b.breakpointId)).toEqual([id]);
  });

  // Vite re-imports a module as "App.tsx?t=…" when a file it imports changes, even if it did not.
  it('follows an unchanged file into a copy at a new URL, under the same id', async () => {
    const { cdpClient, setBreakpointByUrl, removeBreakpoint, state, listed, id } = await setUp();

    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: `${appUrl}?t=1`,
      sourceMapURL: mapAt(11),
      hash: 'h2',
    });

    expect(await state()).toEqual({ paused: false });
    expect(setBreakpointByUrl).toHaveBeenCalledWith({ url: `${appUrl}?t=1`, lineNumber: 10, columnNumber: 4 });
    expect(removeBreakpoint).toHaveBeenCalledWith({ breakpointId: inFirst });
    expect(await listed()).toEqual([{ breakpointId: id, location: `${appUrl}:14 → ${appUrl}?t=1:11` }]);

    // A hit on the copy is reported under the id the caller was given.
    fireCdp(cdpClient, 'Debugger', 'paused', {
      reason: 'other',
      hitBreakpoints: [inCopy],
      callFrames: [{ functionName: 'f', location: { scriptId: 's2', lineNumber: 10, columnNumber: 4 } }],
    });
    expect((await state()).hitBreakpoints).toEqual([id]);
  });

  it('drops it when the file changed, and says so once', async () => {
    const { cdpClient, setBreakpointByUrl, removeBreakpoint, state, listed, id } = await setUp();

    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: `${appUrl}?t=1`,
      sourceMapURL: mapAt(11, text('\nline 21')),
      hash: 'h2',
    });

    expect(await state()).toEqual({
      paused: false,
      droppedBreakpoints: [
        {
          breakpointId: id,
          location: `${appUrl}:14 → ${appUrl}:10`,
          reason: `${appUrl} changed since this breakpoint was set`,
        },
      ],
    });
    expect(removeBreakpoint).toHaveBeenCalledWith({ breakpointId: inFirst });
    expect(setBreakpointByUrl).not.toHaveBeenCalled();
    expect(await listed()).toEqual([]);
    expect(await state()).toEqual({ paused: false });
  });

  // A reload of a changed file: its old URL breakpoint can bind and fire during startup before
  // it is removed. The stop is real, but not necessarily where the breakpoint was set.
  it('names a pause on a breakpoint that was dropped under it', async () => {
    const { cdpClient, state, id } = await setUp();

    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: appUrl,
      sourceMapURL: mapAt(10, text('\nline 21')),
      hash: 'h2',
    });
    fireCdp(cdpClient, 'Debugger', 'paused', {
      reason: 'other',
      hitBreakpoints: [inFirst],
      callFrames: [{ functionName: 'f', location: { scriptId: 's2', lineNumber: 9, columnNumber: 4 } }],
    });

    const paused = await state();
    expect(paused.hitBreakpoints).toEqual([id]);
    expect(paused.note).toMatch(new RegExp(`^Stopped on ${id} \\(.*\\), dropped because its file changed`));
    expect(paused.droppedBreakpoints.map((b: any) => b.breakpointId)).toEqual([id]);
  });

  it('has nothing left to remove from Chrome for a dropped breakpoint', async () => {
    const { cdpClient, mcpClient, removeBreakpoint, state, id } = await setUp();
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: appUrl,
      sourceMapURL: mapAt(10, text('\nline 21')),
      hash: 'h2',
    });
    await state();
    removeBreakpoint.mockClear();

    const result = await mcpClient.callTool({ name: 'remove_breakpoint', arguments: { breakpointId: id } });

    expect(result.isError).toBeFalsy();
    expect(removeBreakpoint).not.toHaveBeenCalled();
  });

  // Chrome names a breakpoint by its place, so setting one again on the same line, after an edit
  // that did not move that line, gets the dropped one's Chrome id back.
  it('gives a breakpoint set where a dropped one was a new id, though Chrome reuses its own', async () => {
    const { cdpClient, mcpClient, setBreakpointByUrl, removeBreakpoint, state, id } = await setUp();
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: appUrl,
      sourceMapURL: mapAt(10, text('\nline 21')),
      hash: 'h2',
    });
    // Dropped, but not yet reported.
    await vi.waitFor(() => expect(removeBreakpoint).toHaveBeenCalledWith({ breakpointId: inFirst }));
    setBreakpointByUrl.mockResolvedValueOnce({
      breakpointId: inFirst,
      locations: [{ scriptId: 's2', lineNumber: 9, columnNumber: 4 }],
    });

    const again = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { source: 'src/App.tsx', lineNumber: 14 },
    });
    const newId = (again.structuredContent as any).breakpointId;
    expect(newId).not.toBe(id);

    fireCdp(cdpClient, 'Debugger', 'paused', {
      reason: 'other',
      hitBreakpoints: [inFirst],
      callFrames: [{ functionName: 'f', location: { scriptId: 's2', lineNumber: 9, columnNumber: 4 } }],
    });
    const paused = await state();
    expect(paused.hitBreakpoints).toEqual([newId]);
    expect(paused.note).toBeUndefined();
    // The earlier one's drop is still reported, under the id it had.
    expect(paused.droppedBreakpoints.map((b: any) => b.breakpointId)).toEqual([id]);

    removeBreakpoint.mockClear();
    await mcpClient.callTool({ name: 'remove_breakpoint', arguments: { breakpointId: newId } });
    expect(removeBreakpoint).toHaveBeenCalledWith({ breakpointId: inFirst });
  });
});

describe('remove_breakpoint', () => {
  // A reconnect is a new session: every breakpoint went with the old one, and Chrome hands out
  // the same ids again. One from before must not name a breakpoint set since.
  it('rejects an id from before a reconnect, though a breakpoint was set at the same place since', async () => {
    const setBreakpointByUrl = vi
      .fn()
      .mockResolvedValue({ breakpointId: 'br:1:9:0:http://localhost:3000/app.js', locations: [] });
    const removeBreakpoint = vi.fn().mockResolvedValue({});
    let cdpClient = makeMockClient(undefined, undefined, { setBreakpointByUrl, removeBreakpoint });
    const { mcpClient } = await setupServer(() => cdpClient);
    const set = async () => {
      const result = await mcpClient.callTool({
        name: 'set_breakpoint',
        arguments: { url: 'http://localhost:3000/app.js', lineNumber: 10 },
      });
      return (result.structuredContent as any).breakpointId;
    };

    const before = await set();
    cdpClient = makeMockClient(undefined, undefined, { setBreakpointByUrl, removeBreakpoint });
    const after = await set();
    expect(after).not.toBe(before);

    const result = await mcpClient.callTool({ name: 'remove_breakpoint', arguments: { breakpointId: before } });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toMatch(/^No breakpoint /);
    expect(removeBreakpoint).not.toHaveBeenCalled();
    const listed = await mcpClient.callTool({ name: 'list_breakpoints', arguments: {} });
    expect((listed.structuredContent as any).breakpoints.map((b: any) => b.breakpointId)).toEqual([after]);
  });
});

describe('list_breakpoints', () => {
  it('returns empty array initially', async () => {
    const mcpClient = await setupMcpClient(makeMockClient());
    const result = await mcpClient.callTool({ name: 'list_breakpoints', arguments: {} });
    expect(JSON.parse((result.content as any)[0].text)).toEqual([]);
  });
});

// A pause as Chrome delivers it: the session's listener records it, and whoever is waiting for the
// next one on the client hears it.
const landPause = (cdpClient: CDP.Client, event: any) => {
  fireCdp(cdpClient, 'Debugger', 'paused', event);
  (cdpClient as any).emit('Debugger.paused', event);
};
const tick = { functionName: 'tick', url: 'http://localhost/app.js', location: { scriptId: '1', lineNumber: 4 } };

describe('pause_execution', () => {
  const attached = async (debuggerMethods: Record<string, ReturnType<typeof vi.fn>> = {}) => {
    const cdpClient: any = makeMockClient(undefined, undefined, debuggerMethods);
    const mcpClient = await setupMcpClient(cdpClient);
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    return { cdpClient, mcpClient };
  };

  it('returns the call stack once the pause lands', async () => {
    // Chrome answers the command first, and the pause follows.
    const pause = vi.fn(async () => {
      setTimeout(() => landPause(cdpClient, { reason: 'other', callFrames: [tick] }));
      return {};
    });
    const { cdpClient, mcpClient } = await attached({ pause });

    const result = await mcpClient.callTool({ name: 'pause_execution', arguments: {} });

    expect(pause).toHaveBeenCalledTimes(1);
    expect(JSON.parse((result.content as any)[0].text)).toEqual({
      paused: true,
      reason: 'other',
      callStack: [expect.objectContaining({ functionName: 'tick', lineNumber: 5 })],
    });
  });

  it('returns where execution already is, without pausing again', async () => {
    const { cdpClient, mcpClient } = await attached();
    fireCdp(cdpClient, 'Debugger', 'paused', { reason: 'breakpoint', callFrames: [tick] });

    const result = await mcpClient.callTool({ name: 'pause_execution', arguments: {} });

    expect(cdpClient.Debugger.pause).not.toHaveBeenCalled();
    expect(JSON.parse((result.content as any)[0].text)).toMatchObject({
      paused: true,
      reason: 'breakpoint',
      callStack: [{ functionName: 'tick' }],
    });
  });

  // An idle page runs nothing, so the pause has nowhere to land yet.
  it('says the pause is pending when nothing runs in time, and leaves no listener behind', async () => {
    const { cdpClient, mcpClient } = await attached();
    const listeners = cdpClient.listenerCount('Debugger.paused');

    vi.useFakeTimers();
    try {
      const pending = mcpClient.callTool({ name: 'pause_execution', arguments: {} });
      await vi.advanceTimersByTimeAsync(PAUSE_WAIT_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result.isError).toBeFalsy();
      expect((result.content as any)[0].text).toMatch(/^No script ran within .*The pause stays pending/);
      expect(cdpClient.Debugger.pause).toHaveBeenCalledTimes(1);
      expect(cdpClient.listenerCount('Debugger.paused')).toBe(listeners);
    } finally {
      vi.useRealTimers();
    }
  });

  // A page showing alert() answers no command until the dialog is closed.
  it('stops waiting on a page that does not take the pause', async () => {
    const { cdpClient, mcpClient } = await attached({ pause: vi.fn(() => new Promise(() => {})) });
    const listeners = cdpClient.listenerCount('Debugger.paused');

    vi.useFakeTimers();
    try {
      const pending = mcpClient.callTool({ name: 'pause_execution', arguments: {} });
      await vi.advanceTimersByTimeAsync(PAUSE_WAIT_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('modal dialog');
      expect(cdpClient.listenerCount('Debugger.paused')).toBe(listeners);
    } finally {
      vi.useRealTimers();
    }
  });

  // Debugger.enable is not answered during a synchronous loop, and Debugger.pause is refused without it.
  it('says why a page that will not let the debugger attach cannot be paused', async () => {
    const cdpClient: any = makeMockClient();
    cdpClient.Console.enable = vi.fn(() => new Promise(() => {}));
    const mcpClient = await setupMcpClient(cdpClient);

    vi.useFakeTimers();
    try {
      const pending = mcpClient.callTool({ name: 'pause_execution', arguments: {} });
      await vi.advanceTimersByTimeAsync(PAGE_COMMAND_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result.isError).toBe(true);
      const text = (result.content as any)[0].text;
      expect(text).toContain('paused only by a debugger attached before it started');
      expect(text).toContain('call any debugger tool, such as get_debugger_state, before reproducing the hang');
      expect(cdpClient.Debugger.pause).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('step_over', () => {
  it('returns the call stack where the step paused', async () => {
    let cdpClient: any;
    const stepOver = vi.fn(async () => {
      setTimeout(() =>
        landPause(cdpClient, {
          reason: 'other',
          callFrames: [{ ...tick, location: { scriptId: '1', lineNumber: 5 } }],
        }),
      );
      return {};
    });
    cdpClient = makeMockClient(undefined, undefined, { stepOver });
    const mcpClient = await setupMcpClient(cdpClient);
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    fireCdp(cdpClient, 'Debugger', 'paused', { reason: 'breakpoint', callFrames: [tick] });

    const result = await mcpClient.callTool({ name: 'step_over', arguments: {} });

    expect(JSON.parse((result.content as any)[0].text)).toEqual({
      paused: true,
      reason: 'other',
      callStack: [expect.objectContaining({ functionName: 'tick', lineNumber: 6 })],
    });
  });
});

describe('resume_execution', () => {
  it('calls Debugger.resume', async () => {
    const resume = vi.fn().mockResolvedValue({});
    const cdpClient = makeMockClient(undefined, undefined, { resume });
    const mcpClient = await setupMcpClient(cdpClient);

    await mcpClient.callTool({ name: 'resume_execution', arguments: {} });

    expect(resume).toHaveBeenCalled();
  });

  it('says there is nothing to resume when Chrome refuses for lack of a pause', async () => {
    const resume = vi.fn().mockRejectedValue(new Error('Can only perform operation while paused.'));
    const cdpClient = makeMockClient(undefined, undefined, { resume });
    const mcpClient = await setupMcpClient(cdpClient);

    const result = await mcpClient.callTool({ name: 'resume_execution', arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('not paused — nothing to resume');
  });
});

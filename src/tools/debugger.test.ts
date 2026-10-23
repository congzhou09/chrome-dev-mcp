import { describe, it, expect, vi } from 'vitest';
import CDP from 'chrome-remote-interface';
import { makeMockClient, setupMcpClient, fireCdp, inlineSourceMap } from '../test-helpers.js';

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
  it('calls setBreakpointByUrl and returns the breakpointId', async () => {
    const setBreakpointByUrl = vi.fn().mockResolvedValue({ breakpointId: 'bp-42', locations: [] });
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
    expect(parsed.breakpointId).toBe('bp-42');
  });

  // Chrome answers in 0-based positions and scriptIds; the caller asked in 1-based ones and has
  // no tool that takes a scriptId.
  it('reports where it bound in the 1-based terms it was asked in, with the script URL', async () => {
    const setBreakpointByUrl = vi.fn().mockResolvedValue({
      breakpointId: 'bp-42',
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
      breakpointId: 'bp-42',
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
      breakpointId: 'bp-7',
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
    expect(result.structuredContent).toEqual({
      breakpointId: 'bp-7',
      resolvedLocations: [
        { url: appUrl, lineNumber: 10, columnNumber: 5, source: appUrl, sourceLine: 14, sourceColumn: 5 },
      ],
    });
    const listed = await mcpClient.callTool({ name: 'list_breakpoints', arguments: {} });
    expect((listed.structuredContent as any).breakpoints).toEqual([
      { breakpointId: 'bp-7', location: `${appUrl}:14 → ${appUrl}:10` },
    ]);
  });

  it('says so when the line has no code and the breakpoint went to the next line that does', async () => {
    const setBreakpointByUrl = vi.fn().mockResolvedValue({
      breakpointId: 'bp-7',
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
    const setBreakpointByUrl = vi
      .fn()
      .mockResolvedValueOnce({ breakpointId: 'bp-a', locations: [{ scriptId: 'a', lineNumber: 2, columnNumber: 0 }] })
      .mockResolvedValueOnce({ breakpointId: 'bp-b', locations: [{ scriptId: 'b', lineNumber: 2, columnNumber: 0 }] });
    const removeBreakpoint = vi.fn().mockResolvedValue({});
    const { cdpClient, mcpClient } = await setUp(setBreakpointByUrl, removeBreakpoint);
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', { scriptId: 'a', url: 'http://x/a.js', sourceMapURL: shared(5) });
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', { scriptId: 'b', url: 'http://x/b.js', sourceMapURL: shared(5) });

    const result = await mcpClient.callTool({
      name: 'set_breakpoint',
      arguments: { source: 'src/shared.ts', lineNumber: 5 },
    });

    expect(setBreakpointByUrl).toHaveBeenCalledTimes(2);
    expect((result.structuredContent as any).breakpointId).toBe('bp-a');
    expect((result.structuredContent as any).resolvedLocations.map((l: any) => l.url)).toEqual([
      'http://x/a.js',
      'http://x/b.js',
    ]);
    const listed = await mcpClient.callTool({ name: 'list_breakpoints', arguments: {} });
    expect((listed.structuredContent as any).breakpoints.map((b: any) => b.breakpointId)).toEqual(['bp-a']);

    // A hit in the second script reports the id the caller was given.
    fireCdp(cdpClient, 'Debugger', 'paused', {
      reason: 'other',
      hitBreakpoints: ['bp-b'],
      callFrames: [{ functionName: 'f', url: 'http://x/b.js', location: { scriptId: 'b', lineNumber: 2 } }],
    });
    const state = await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });
    expect((state.structuredContent as any).hitBreakpoints).toEqual(['bp-a']);

    await mcpClient.callTool({ name: 'remove_breakpoint', arguments: { breakpointId: 'bp-a' } });
    expect(removeBreakpoint.mock.calls.map(([arg]) => arg.breakpointId)).toEqual(['bp-a', 'bp-b']);
  });
});

describe('set_breakpoint by source, when its file loads again', () => {
  const appUrl = 'http://localhost:5173/src/App.tsx';
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
      .mockResolvedValueOnce({ breakpointId: 'bp-7', locations: [{ scriptId: 's1', lineNumber: 9, columnNumber: 4 }] })
      .mockResolvedValue({ breakpointId: 'bp-8', locations: [] });
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
    await mcpClient.callTool({ name: 'set_breakpoint', arguments: { source: 'src/App.tsx', lineNumber: 14 } });
    setBreakpointByUrl.mockClear();
    // The state read settles the checks a new copy starts, so it is what the assertions wait on.
    const state = async () =>
      (await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} })).structuredContent as any;
    const listed = async () =>
      ((await mcpClient.callTool({ name: 'list_breakpoints', arguments: {} })).structuredContent as any).breakpoints;
    return { cdpClient, mcpClient, setBreakpointByUrl, removeBreakpoint, state, listed };
  };

  it('leaves it alone when a reload brings the file back unchanged', async () => {
    const { cdpClient, setBreakpointByUrl, removeBreakpoint, state, listed } = await setUp();

    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: appUrl,
      sourceMapURL: mapAt(10),
      hash: 'h1',
    });

    expect(await state()).toEqual({ paused: false });
    expect(setBreakpointByUrl).not.toHaveBeenCalled();
    expect(removeBreakpoint).not.toHaveBeenCalled();
    expect((await listed()).map((b: any) => b.breakpointId)).toEqual(['bp-7']);
  });

  // Vite re-imports a module as "App.tsx?t=…" when a file it imports changes, even if it did not.
  it('follows an unchanged file into a copy at a new URL, under the same id', async () => {
    const { cdpClient, setBreakpointByUrl, removeBreakpoint, state, listed } = await setUp();

    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: `${appUrl}?t=1`,
      sourceMapURL: mapAt(11),
      hash: 'h2',
    });

    expect(await state()).toEqual({ paused: false });
    expect(setBreakpointByUrl).toHaveBeenCalledWith({ url: `${appUrl}?t=1`, lineNumber: 10, columnNumber: 4 });
    expect(removeBreakpoint).toHaveBeenCalledWith({ breakpointId: 'bp-7' });
    expect(await listed()).toEqual([{ breakpointId: 'bp-7', location: `${appUrl}:14 → ${appUrl}?t=1:11` }]);

    // A hit on the copy is reported under the id the caller was given.
    fireCdp(cdpClient, 'Debugger', 'paused', {
      reason: 'other',
      hitBreakpoints: ['bp-8'],
      callFrames: [{ functionName: 'f', location: { scriptId: 's2', lineNumber: 10, columnNumber: 4 } }],
    });
    expect((await state()).hitBreakpoints).toEqual(['bp-7']);
  });

  it('drops it when the file changed, and says so once', async () => {
    const { cdpClient, setBreakpointByUrl, removeBreakpoint, state, listed } = await setUp();

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
          breakpointId: 'bp-7',
          location: `${appUrl}:14 → ${appUrl}:10`,
          reason: `${appUrl} changed since this breakpoint was set`,
        },
      ],
    });
    expect(removeBreakpoint).toHaveBeenCalledWith({ breakpointId: 'bp-7' });
    expect(setBreakpointByUrl).not.toHaveBeenCalled();
    expect(await listed()).toEqual([]);
    expect(await state()).toEqual({ paused: false });
  });

  // A reload of a changed file: its old URL breakpoint can bind and fire during startup before
  // it is removed. The stop is real, but not necessarily where the breakpoint was set.
  it('names a pause on a breakpoint that was dropped under it', async () => {
    const { cdpClient, state } = await setUp();

    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: appUrl,
      sourceMapURL: mapAt(10, text('\nline 21')),
      hash: 'h2',
    });
    fireCdp(cdpClient, 'Debugger', 'paused', {
      reason: 'other',
      hitBreakpoints: ['bp-7'],
      callFrames: [{ functionName: 'f', location: { scriptId: 's2', lineNumber: 9, columnNumber: 4 } }],
    });

    const paused = await state();
    expect(paused.hitBreakpoints).toEqual(['bp-7']);
    expect(paused.note).toMatch(/^Stopped on bp-7 \(.*\), dropped because its file changed/);
    expect(paused.droppedBreakpoints.map((b: any) => b.breakpointId)).toEqual(['bp-7']);
  });

  it('has nothing left to remove from Chrome for a dropped breakpoint', async () => {
    const { cdpClient, mcpClient, removeBreakpoint, state } = await setUp();
    fireCdp(cdpClient, 'Debugger', 'scriptParsed', {
      scriptId: 's2',
      url: appUrl,
      sourceMapURL: mapAt(10, text('\nline 21')),
      hash: 'h2',
    });
    await state();
    removeBreakpoint.mockClear();

    const result = await mcpClient.callTool({ name: 'remove_breakpoint', arguments: { breakpointId: 'bp-7' } });

    expect(result.isError).toBeFalsy();
    expect(removeBreakpoint).not.toHaveBeenCalled();
  });
});

describe('list_breakpoints', () => {
  it('returns empty array initially', async () => {
    const mcpClient = await setupMcpClient(makeMockClient());
    const result = await mcpClient.callTool({ name: 'list_breakpoints', arguments: {} });
    expect(JSON.parse((result.content as any)[0].text)).toEqual([]);
  });
});

describe('pause_execution', () => {
  it('calls Debugger.pause', async () => {
    const pause = vi.fn().mockResolvedValue({});
    const cdpClient = makeMockClient(undefined, undefined, { pause });
    const mcpClient = await setupMcpClient(cdpClient);

    await mcpClient.callTool({ name: 'pause_execution', arguments: {} });

    expect(pause).toHaveBeenCalled();
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
});

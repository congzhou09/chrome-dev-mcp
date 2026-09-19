import { describe, it, expect, vi } from 'vitest';
import CDP from 'chrome-remote-interface';
import { makeMockClient, setupMcpClient } from '../test-helpers.js';

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

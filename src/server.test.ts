import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type CDP from 'chrome-remote-interface';
import { createServer } from './server.js';

function makeMockClient(
  evaluate = vi.fn(),
  captureScreenshot = vi.fn(),
  debuggerMethods: Record<string, ReturnType<typeof vi.fn>> = {},
): CDP.Client {
  const debugger_ = {
    on: vi.fn(),
    enable: vi.fn().mockResolvedValue({}),
    setBreakpointByUrl: vi.fn().mockResolvedValue({ breakpointId: 'bp-1', locations: [] }),
    removeBreakpoint: vi.fn().mockResolvedValue({}),
    pause: vi.fn().mockResolvedValue({}),
    resume: vi.fn().mockResolvedValue({}),
    stepOver: vi.fn().mockResolvedValue({}),
    stepInto: vi.fn().mockResolvedValue({}),
    stepOut: vi.fn().mockResolvedValue({}),
    ...debuggerMethods,
  };

  return Object.assign(new EventEmitter(), {
    Runtime: { enable: vi.fn(), evaluate, getProperties: vi.fn() },
    Page: { enable: vi.fn(), captureScreenshot },
    Debugger: debugger_,
  }) as unknown as CDP.Client;
}

async function setupMcpClient(cdpClient: CDP.Client | null) {
  const server = createServer(async () => cdpClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

describe('get_title', () => {
  it('returns the page title as text content', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { value: 'My Page Title' } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'get_title', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'My Page Title' }]);
    expect(evaluate).toHaveBeenCalledWith({ expression: 'document.title', returnByValue: true });
  });

  it('returns not-connected message when Chrome is unavailable', async () => {
    const client = await setupMcpClient(null);
    const result = await client.callTool({ name: 'get_title', arguments: {} });
    expect((result.content as any)[0].text).toMatch(/Chrome is not connected/);
  });
});

describe('get_url', () => {
  it('returns the page url as text content', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { value: 'http://localhost:3000/' } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'get_url', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'http://localhost:3000/' }]);
  });
});

describe('get_html', () => {
  it('returns html truncated to 20000 chars', async () => {
    const longHtml = 'a'.repeat(25000);
    const evaluate = vi.fn().mockResolvedValue({ result: { value: longHtml } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'get_html', arguments: {} });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toHaveLength(20000);
  });
});

describe('evaluate_js', () => {
  it('passes expression to Runtime.evaluate and JSON-stringifies the result', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { value: { count: 42 } } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({
      name: 'evaluate_js',
      arguments: { expression: 'window.__myData' },
    });

    expect(evaluate).toHaveBeenCalledWith({ expression: 'window.__myData', returnByValue: true });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ count: 42 }, null, 2) }]);
  });
});

describe('get_computed_style', () => {
  it('returns computed style as JSON text', async () => {
    const style = {
      display: 'flex',
      position: 'relative',
      overflow: 'hidden',
      zIndex: '1',
      pointerEvents: 'auto',
      opacity: '1',
      visibility: 'visible',
    };
    const evaluate = vi.fn().mockResolvedValue({ result: { value: style } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'get_computed_style', arguments: { selector: '#app' } });

    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(style, null, 2) }]);
  });

  it('returns null when element not found', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { value: null } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({
      name: 'get_computed_style',
      arguments: { selector: '.nonexistent' },
    });

    expect(result.content).toEqual([{ type: 'text', text: 'null' }]);
  });
});

describe('element_from_point', () => {
  it('returns target and actualTopElement', async () => {
    const value = { target: "<div id='app'>", actualTopElement: '<span>' };
    const evaluate = vi.fn().mockResolvedValue({ result: { value } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'element_from_point', arguments: { selector: '#app' } });

    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value, null, 2) }]);
  });
});

describe('screenshot', () => {
  it('returns base64 image content', async () => {
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const captureScreenshot = vi.fn().mockResolvedValue({ data: pngBase64 });
    const client = await setupMcpClient(makeMockClient(vi.fn(), captureScreenshot));

    const result = await client.callTool({ name: 'screenshot', arguments: {} });

    expect(captureScreenshot).toHaveBeenCalledWith({ format: 'png' });
    expect(result.content).toEqual([{ type: 'image', data: pngBase64, mimeType: 'image/png' }]);
  });
});

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

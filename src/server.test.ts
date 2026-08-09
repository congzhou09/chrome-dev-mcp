import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import CDP from 'chrome-remote-interface';
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
    Console: { on: vi.fn(), enable: vi.fn().mockResolvedValue({}) },
    Debugger: debugger_,
  }) as unknown as CDP.Client;
}

async function setupMcpClient(
  cdpClient: CDP.Client | null,
  switchToTarget: (targetId: string) => Promise<CDP.Client | null> = vi.fn(),
  getCurrentTargetId: () => string | null = () => null,
) {
  const server = createServer(async () => cdpClient, switchToTarget, getCurrentTargetId);
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

  it('returns not-connected message with isError when Chrome is unavailable', async () => {
    const client = await setupMcpClient(null);
    const result = await client.callTool({ name: 'get_title', arguments: {} });
    expect((result.content as any)[0].text).toMatch(/Chrome is not connected/);
    expect(result.isError).toBe(true);
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

  it('returns error message when expression throws', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {},
      exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x is not defined' } },
    });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'x' } });

    expect((result.content as any)[0].text).toBe('Error: ReferenceError: x is not defined');
  });

  it('returns description when value is undefined (e.g. non-serializable object)', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'object', description: 'HTMLDivElement' } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'document.body' } });

    expect((result.content as any)[0].text).toBe('HTMLDivElement');
  });

  it('returns "undefined" string when expression result is undefined', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'undefined' } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'void 0' } });

    expect((result.content as any)[0].text).toBe('undefined');
  });
});

describe('get_computed_style', () => {
  it('returns styles in both content text and structuredContent', async () => {
    const style = {
      display: 'flex',
      position: 'relative',
      overflow: 'hidden',
    };
    const evaluate = vi.fn().mockResolvedValue({ result: { value: style } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({
      name: 'get_computed_style',
      arguments: { selector: '#app', properties: ['display', 'position', 'overflow'] },
    });

    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(style, null, 2) }]);
    expect(result.structuredContent).toEqual({ styles: style });
    expect(result.isError).toBeFalsy();
  });

  it('sets isError with a not-found message when element does not match', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { value: null } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({
      name: 'get_computed_style',
      arguments: { selector: '.nonexistent', properties: ['display'] },
    });

    expect(result.content).toEqual([
      { type: 'text', text: 'No element matches selector: .nonexistent' },
    ]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
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

describe('list_tabs', () => {
  it('returns available tabs filtered by type and excluding devtools://', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce([
      { id: 'tab-1', type: 'page', title: 'My App', url: 'http://localhost:3000/' },
      { id: 'tab-2', type: 'page', title: 'About', url: 'http://localhost:3000/about' },
      { id: 'tab-3', type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/devtools_app.html' },
      { id: 'tab-4', type: 'service_worker', title: '', url: 'http://localhost:3000/sw.js' },
    ]);
    const mcpClient = await setupMcpClient(null);

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    const { tabs } = (result.structuredContent as any);
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t: any) => t.targetId === 'tab-1')).toEqual({ targetId: 'tab-1', title: 'My App', url: 'http://localhost:3000/', active: false });
    expect(tabs.find((t: any) => t.targetId === 'tab-2')).toEqual({ targetId: 'tab-2', title: 'About', url: 'http://localhost:3000/about', active: false });

    vi.restoreAllMocks();
  });

  it('marks the currently connected tab with active: true', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce([
      { id: 'tab-1', type: 'page', title: 'My App', url: 'http://localhost:3000/' },
      { id: 'tab-2', type: 'page', title: 'About', url: 'http://localhost:3000/about' },
    ]);
    const mcpClient = await setupMcpClient(null, vi.fn(), () => 'tab-1');

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    const { tabs } = (result.structuredContent as any);
    expect(tabs.find((t: any) => t.targetId === 'tab-1')).toMatchObject({ active: true });
    expect(tabs.find((t: any) => t.targetId === 'tab-2')).toMatchObject({ active: false });

    vi.restoreAllMocks();
  });

  it('returns not-connected with isError when Chrome is unavailable', async () => {
    vi.spyOn(CDP, 'List' as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const mcpClient = await setupMcpClient(null);

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    expect((result.content as any)[0].text).toMatch(/Chrome is not connected/);
    expect(result.isError).toBe(true);

    vi.restoreAllMocks();
  });
});

describe('switch_tab', () => {
  it('calls switchToTarget and returns new tab info', async () => {
    const newClient = makeMockClient(
      vi.fn().mockResolvedValue({ result: { value: { title: 'My App', url: 'http://localhost:3000/' } } }),
    );
    const switchToTarget = vi.fn().mockResolvedValue(newClient);
    const mcpClient = await setupMcpClient(null, switchToTarget);

    const result = await mcpClient.callTool({ name: 'switch_tab', arguments: { targetId: 'tab-1' } });

    expect(switchToTarget).toHaveBeenCalledWith('tab-1');
    expect((result.content as any)[0].text).toBe('Switched to: My App — http://localhost:3000/');
    expect(result.structuredContent).toEqual({ targetId: 'tab-1', title: 'My App', url: 'http://localhost:3000/' });
  });

  it('returns error message when target is not found', async () => {
    const switchToTarget = vi.fn().mockResolvedValue(null);
    const mcpClient = await setupMcpClient(null, switchToTarget);

    const result = await mcpClient.callTool({ name: 'switch_tab', arguments: { targetId: 'nonexistent' } });

    expect((result.content as any)[0].text).toMatch(/Failed to connect/);
  });
});

describe('get_inspected_element', () => {
  it('returns element info when window.$0 is set', async () => {
    const elementData = {
      tagName: 'div',
      id: 'app',
      className: 'container',
      attributes: { id: 'app', class: 'container' },
      outerHTML: '<div id="app" class="container"></div>',
    };
    const evaluate = vi.fn().mockResolvedValue({ result: { value: elementData } });
    const mcpClient = await setupMcpClient(makeMockClient(evaluate));

    const result = await mcpClient.callTool({ name: 'get_inspected_element', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(elementData, null, 2) }]);
  });

  it('returns guidance message when window.$0 is not set', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { value: null } });
    const mcpClient = await setupMcpClient(makeMockClient(evaluate));

    const result = await mcpClient.callTool({ name: 'get_inspected_element', arguments: {} });

    expect((result.content as any)[0].text).toMatch(/window\.\$0 = \$0/);
  });

  it('returns not-connected message with isError when Chrome is unavailable', async () => {
    const mcpClient = await setupMcpClient(null);

    const result = await mcpClient.callTool({ name: 'get_inspected_element', arguments: {} });

    expect((result.content as any)[0].text).toMatch(/Chrome is not connected/);
    expect(result.isError).toBe(true);
  });
});

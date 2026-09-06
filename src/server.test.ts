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
  networkMethods: Record<string, ReturnType<typeof vi.fn>> = {},
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

  const network = {
    on: vi.fn(),
    enable: vi.fn().mockResolvedValue({}),
    getResponseBody: vi.fn().mockResolvedValue({ body: '', base64Encoded: false }),
    ...networkMethods,
  };

  return Object.assign(new EventEmitter(), {
    Runtime: { enable: vi.fn(), evaluate, getProperties: vi.fn() },
    Page: { enable: vi.fn(), captureScreenshot, on: vi.fn() },
    Console: { on: vi.fn(), enable: vi.fn().mockResolvedValue({}) },
    Debugger: debugger_,
    Network: network,
  }) as unknown as CDP.Client;
}

// Exposes attachNetwork alongside the MCP client. In production index.ts calls it at
// connect time; tests have to call it explicitly to start network capture.
async function setupServer(
  cdpClient: CDP.Client | null | (() => CDP.Client | null),
  switchToTarget: (targetId: string) => Promise<CDP.Client | null> = vi.fn(),
  getCurrentTargetId: () => string | null = () => null,
) {
  const getClient = typeof cdpClient === 'function' ? cdpClient : () => cdpClient;
  const { server, attachNetwork } = createServer(async () => getClient(), switchToTarget, getCurrentTargetId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await mcpClient.connect(clientTransport);
  return { mcpClient, attachNetwork };
}

async function setupMcpClient(
  cdpClient: CDP.Client | null,
  switchToTarget: (targetId: string) => Promise<CDP.Client | null> = vi.fn(),
  getCurrentTargetId: () => string | null = () => null,
) {
  const { mcpClient } = await setupServer(cdpClient, switchToTarget, getCurrentTargetId);
  return mcpClient;
}

// Invokes a registered CDP handler directly, the same way the get_debugger_state test
// simulates a paused event. Handlers are synchronous, so this is not awaited.
function fireCdp(cdpClient: CDP.Client, domain: 'Network' | 'Page', event: string, payload: any): void {
  const handler = (cdpClient as any)[domain].on.mock.calls.find(([e]: [string]) => e === event)?.[1];
  handler?.(payload);
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

    expect(result.content).toEqual([{ type: 'text', text: 'No element matches selector: .nonexistent' }]);
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

    const { tabs } = result.structuredContent as any;
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t: any) => t.targetId === 'tab-1')).toEqual({
      targetId: 'tab-1',
      title: 'My App',
      url: 'http://localhost:3000/',
      active: false,
    });
    expect(tabs.find((t: any) => t.targetId === 'tab-2')).toEqual({
      targetId: 'tab-2',
      title: 'About',
      url: 'http://localhost:3000/about',
      active: false,
    });

    vi.restoreAllMocks();
  });

  it('marks the currently connected tab with active: true', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce([
      { id: 'tab-1', type: 'page', title: 'My App', url: 'http://localhost:3000/' },
      { id: 'tab-2', type: 'page', title: 'About', url: 'http://localhost:3000/about' },
    ]);
    const mcpClient = await setupMcpClient(null, vi.fn(), () => 'tab-1');

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    const { tabs } = result.structuredContent as any;
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

// Minimal event payloads. `timestamp` is CDP's monotonic clock in seconds.
function sentEvent(over: any = {}) {
  return {
    requestId: 'req-1',
    loaderId: 'loader-1',
    timestamp: 100,
    wallTime: 1700000000,
    type: 'XHR',
    initiator: {
      type: 'script',
      stack: { callFrames: [{ url: 'https://app/main.js', lineNumber: 41 }] },
    },
    request: {
      method: 'GET',
      url: 'https://api.example.com/users',
      headers: { accept: 'application/json' },
    },
    ...over,
  };
}

async function captureOne(cdpClient: CDP.Client, attachNetwork: (c: CDP.Client) => Promise<boolean>, over: any = {}) {
  await attachNetwork(cdpClient);
  fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent(over));
  fireCdp(cdpClient, 'Network', 'responseReceived', {
    requestId: over.requestId ?? 'req-1',
    type: 'XHR',
    response: {
      status: 200,
      statusText: 'OK',
      mimeType: 'application/json',
      headers: { 'content-type': 'application/json' },
    },
  });
  fireCdp(cdpClient, 'Network', 'loadingFinished', {
    requestId: over.requestId ?? 'req-1',
    timestamp: 100.25,
    encodedDataLength: 1234,
  });
}

describe('get_network_requests', () => {
  it('returns an empty-state message before any requests are captured', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    expect((result.content as any)[0].text).toMatch(/No network requests captured yet/);
    expect(result.structuredContent).toEqual({ requests: [] });
  });

  it('passes large buffer sizes to Network.enable', async () => {
    const cdpClient = makeMockClient();
    const { attachNetwork } = await setupServer(cdpClient);

    await attachNetwork(cdpClient);

    expect((cdpClient as any).Network.enable).toHaveBeenCalledWith({
      maxTotalBufferSize: 104857600,
      maxResourceBufferSize: 10485760,
    });
  });

  it('registers listeners only once per client', async () => {
    const cdpClient = makeMockClient();
    const { attachNetwork } = await setupServer(cdpClient);

    await attachNetwork(cdpClient);
    await attachNetwork(cdpClient);

    expect((cdpClient as any).Network.enable).toHaveBeenCalledTimes(1);
  });

  it('captures a completed request with method, status, size, and duration', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: 'req-1',
      method: 'GET',
      url: 'https://api.example.com/users',
      resourceType: 'XHR',
      state: 'complete',
      status: 200,
      mimeType: 'application/json',
      size: 1234,
      durationMs: 250,
      initiator: 'script https://app/main.js:42',
    });
  });

  it('marks in-flight requests as pending', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests[0].state).toBe('pending');
    expect(requests[0].status).toBeUndefined();
  });

  it('records failure details from loadingFailed', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());
    fireCdp(cdpClient, 'Network', 'loadingFailed', {
      requestId: 'req-1',
      timestamp: 100.1,
      errorText: 'net::ERR_CONNECTION_REFUSED',
      canceled: false,
    });

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests[0]).toMatchObject({
      state: 'failed',
      errorText: 'net::ERR_CONNECTION_REFUSED',
    });
  });

  it('keeps each redirect hop as a separate record', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ request: { method: 'GET', url: 'https://example.com/old', headers: {} } }),
    );
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({
        timestamp: 100.05,
        request: { method: 'GET', url: 'https://example.com/new', headers: {} },
        redirectResponse: {
          status: 301,
          statusText: 'Moved Permanently',
          mimeType: 'text/html',
          headers: { location: 'https://example.com/new' },
        },
      }),
    );

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      state: 'redirect',
      status: 301,
      redirectedTo: 'https://example.com/new',
    });
    expect(requests[0].hop).toBeUndefined();
    expect(requests[1]).toMatchObject({ hop: 1, state: 'pending', url: 'https://example.com/new' });
  });

  it('prunes requests from the previous loader on main-frame navigation', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'old-1', loaderId: 'loader-1' }));
    // Chrome reports the new document's request BEFORE it reports the navigation.
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ requestId: 'new-1', loaderId: 'loader-2', type: 'Document' }),
    );
    fireCdp(cdpClient, 'Page', 'frameNavigated', {
      frame: { id: 'f1', loaderId: 'loader-2', url: 'https://example.com/' },
    });

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(1);
    expect(requests[0].requestId).toBe('new-1');
  });

  it('ignores navigation of a subframe', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());
    fireCdp(cdpClient, 'Page', 'frameNavigated', {
      frame: { id: 'f2', parentId: 'f1', loaderId: 'loader-9', url: 'https://ads/' },
    });

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    expect((result.structuredContent as any).requests).toHaveLength(1);
  });

  it('filters by resourceType case-insensitively', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'x-1', type: 'XHR' }));
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'i-1', type: 'Image' }));

    const exact = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { resourceType: 'XHR' },
    });
    // A bare z.enum would reject this during input validation, before the handler runs.
    const lower = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { resourceType: 'xhr' },
    });

    for (const result of [exact, lower]) {
      const { requests } = result.structuredContent as any;
      expect(requests).toHaveLength(1);
      expect(requests[0].requestId).toBe('x-1');
    }
  });

  it('accepts any casing for the status filter', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());
    fireCdp(cdpClient, 'Network', 'loadingFailed', {
      requestId: 'req-1',
      timestamp: 100.1,
      errorText: 'net::ERR_FAILED',
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { status: 'FAILED' },
    });

    expect((result.structuredContent as any).requests).toHaveLength(1);
  });

  it('filters by status class', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'req-2' }));
    fireCdp(cdpClient, 'Network', 'responseReceived', {
      requestId: 'req-2',
      type: 'XHR',
      response: { status: 404, mimeType: 'text/html', headers: {} },
    });
    fireCdp(cdpClient, 'Network', 'loadingFinished', {
      requestId: 'req-2',
      timestamp: 100.1,
      encodedDataLength: 10,
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { status: '4xx' },
    });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe(404);
  });

  it('filters by url substring', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({
        requestId: 'a',
        request: { method: 'GET', url: 'https://api.example.com/users', headers: {} },
      }),
    );
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({
        requestId: 'b',
        request: { method: 'GET', url: 'https://cdn.example.com/logo.png', headers: {} },
      }),
    );

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { urlFilter: 'CDN' },
    });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(1);
    expect(requests[0].requestId).toBe('b');
  });

  it('omits headers unless headerKeys is given', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const record = (result.structuredContent as any).requests[0];
    expect(record.requestHeaders).toBeUndefined();
    expect(record.responseHeaders).toBeUndefined();
  });

  // The fixtures deliver lowercase header names, the way HTTP/2 does. Asking for canonical
  // casing proves the lookup normalises AND that output keys echo the caller's spelling.
  it('projects only the named headers, matched case-insensitively', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork, {
      request: {
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: { accept: 'application/json', authorization: 'Bearer tok' },
      },
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { headerKeys: ['Accept', 'Content-Type'] },
    });

    const record = (result.structuredContent as any).requests[0];
    // toEqual, not toMatchObject: the unnamed `authorization` must be absent, and a named
    // header the message never carried must be omitted rather than returned as an empty string.
    expect(record.requestHeaders).toEqual({ Accept: 'application/json' });
    expect(record.responseHeaders).toEqual({ 'Content-Type': 'application/json' });
  });

  // The schema promises that a missing key means "not sent" while an empty-string value means
  // "sent, but empty". Both halves are asserted together because the distinction is the point:
  // a truthy check inside projectHeaders would collapse them, and nothing else would notice.
  it('keeps a header sent with an empty value, distinct from an absent one', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork, {
      request: {
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: { 'x-empty': '' },
      },
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { headerKeys: ['X-Empty', 'X-Missing'] },
    });

    const record = (result.structuredContent as any).requests[0];
    expect(record.requestHeaders).toEqual({ 'X-Empty': '' });
    expect(record.responseHeaders).toEqual({});
  });

  it('returns every header for headerKeys ["*"]', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork, {
      request: {
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: { accept: 'application/json', authorization: 'Bearer tok' },
      },
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { headerKeys: ['*'] },
    });

    const record = (result.structuredContent as any).requests[0];
    expect(record.requestHeaders).toEqual({ accept: 'application/json', authorization: 'Bearer tok' });
    expect(record.responseHeaders).toEqual({ 'content-type': 'application/json' });
  });

  it('filters to one request by requestId, keeping every redirect hop', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'other-1' }));
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ request: { method: 'GET', url: 'https://example.com/old', headers: {} } }),
    );
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({
        timestamp: 100.05,
        request: { method: 'GET', url: 'https://example.com/new', headers: {} },
        redirectResponse: {
          status: 301,
          statusText: 'Moved Permanently',
          mimeType: 'text/html',
          headers: { location: 'https://example.com/new' },
        },
      }),
    );

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { requestId: 'req-1' },
    });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(2);
    expect(requests.every((r: any) => r.requestId === 'req-1')).toBe(true);
    expect(requests[0].hop).toBeUndefined();
    expect(requests[1].hop).toBe(1);
  });

  it('collapses long data URIs in the url field', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    const dataUri = 'data:image/png;base64,' + 'A'.repeat(5000);
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ type: 'Image', request: { method: 'GET', url: dataUri, headers: {} } }),
    );

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests[0].url).toMatch(/^data:image\/png;base64,A+… \(data URI, 5022 chars\)$/);
  });

  it('returns a long url in full when filtered to one requestId', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    const longUrl = 'https://example.com/' + 'q'.repeat(600) + '/tail';
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ request: { method: 'GET', url: longUrl, headers: {} } }),
    );

    const bulk = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });
    const single = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { requestId: 'req-1' },
    });

    const bulkUrl = (bulk.structuredContent as any).requests[0].url;
    expect(bulkUrl).toContain('… (+');
    expect(bulkUrl.length).toBeLessThan(longUrl.length);
    expect((single.structuredContent as any).requests[0].url).toBe(longUrl);
  });

  // The reason to collapse a data URI is its unbounded length and uninformative tail.
  // Neither changes when only one record comes back, so this stays collapsed either way.
  it('still collapses a data URI when filtered to one requestId', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    const dataUri = 'data:image/png;base64,' + 'A'.repeat(5000);
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ type: 'Image', request: { method: 'GET', url: dataUri, headers: {} } }),
    );

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { requestId: 'req-1' },
    });

    expect((result.structuredContent as any).requests[0].url).toContain('(data URI, 5022 chars)');
  });

  it('matches filters against the full url, not the truncated one', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    const longUrl = 'https://example.com/' + 'q'.repeat(600) + '/needle';
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ request: { method: 'GET', url: longUrl, headers: {} } }),
    );

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { urlFilter: 'needle' },
    });

    expect((result.structuredContent as any).requests).toHaveLength(1);
  });

  it('clears the buffer when clear is true', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const first = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { clear: true },
    });
    const second = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    expect((first.structuredContent as any).requests).toHaveLength(1);
    expect((second.structuredContent as any).requests).toHaveLength(0);
  });

  it('evicts the oldest record beyond the buffer cap', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    for (let i = 0; i < 1001; i++) {
      fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: `r-${i}` }));
    }

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { limit: 200 },
    });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(200);
    expect(requests[requests.length - 1].requestId).toBe('r-1000');
    expect(requests.some((r: any) => r.requestId === 'r-0')).toBe(false);
  });

  it('does not lose captured requests when the debugger attaches later', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    // ensureDebuggerEvents runs its own reset block here; it must not touch the
    // network buffer, which has been filling since connect.
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });
    expect((result.structuredContent as any).requests).toHaveLength(1);
  });

  it('returns not-connected message with isError when Chrome is unavailable', async () => {
    const client = await setupMcpClient(null);

    const result = await client.callTool({ name: 'get_network_requests', arguments: {} });

    expect((result.content as any)[0].text).toMatch(/Chrome is not connected/);
    expect(result.isError).toBe(true);
  });
});

describe('get_network_response_body', () => {
  // A reconnect resets the tombstone set too, so without the reattached check this valid
  // id would be reported as "Unknown requestId" — telling the model it invented the id.
  it('blames the reconnect, not the requestId, after the client is swapped', async () => {
    const first = makeMockClient();
    const second = makeMockClient(
      undefined,
      undefined,
      {},
      {
        getResponseBody: vi.fn().mockRejectedValue(new Error('No resource with given identifier found')),
      },
    );
    let current: CDP.Client = first;
    const { mcpClient, attachNetwork } = await setupServer(() => current);
    await captureOne(first, attachNetwork);

    current = second;

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    const text = (result.content as any)[0].text;
    expect(result.isError).toBe(true);
    expect(text).toContain('new Chrome session');
    expect(text).not.toContain('Unknown requestId');
  });

  it('returns the body with metadata for a completed request', async () => {
    const getResponseBody = vi.fn().mockResolvedValue({ body: '{"ok":true}', base64Encoded: false });
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect(getResponseBody).toHaveBeenCalledWith({ requestId: 'req-1' });
    const meta = JSON.parse((result.content as any)[0].text);
    expect(meta).toMatchObject({ requestId: 'req-1', status: 200, byteLength: 11 });
    // Single-request tool, so the metadata url is not length-truncated either.
    expect(meta.url).toBe('https://api.example.com/users');
    expect((result.content as any)[1].text).toBe('{"ok":true}');
  });

  it('truncates bodies over the limit', async () => {
    const getResponseBody = vi.fn().mockResolvedValue({ body: 'x'.repeat(60000), base64Encoded: false });
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect(JSON.parse((result.content as any)[0].text).truncated).toBe(true);
    expect((result.content as any)[1].text).toHaveLength(50000);
  });

  it('reports an evicted body specifically', async () => {
    const getResponseBody = vi.fn().mockRejectedValue(new Error('Request content was evicted from inspector cache'));
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/discarded by Chrome/);
    expect(result.isError).toBe(true);
  });

  it('reports that a captured request was discarded by navigation', async () => {
    const getResponseBody = vi.fn().mockRejectedValue(new Error('No resource with given identifier found'));
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);
    fireCdp(cdpClient, 'Page', 'frameNavigated', {
      frame: { id: 'f1', loaderId: 'loader-2', url: 'https://example.com/' },
    });

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/was captured but its data has been discarded/);
    expect(result.isError).toBe(true);
  });

  it('reports a buffer-evicted request as discarded, not unknown', async () => {
    const getResponseBody = vi.fn().mockRejectedValue(new Error('No resource with given identifier found'));
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    for (let i = 0; i < 1001; i++) {
      fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: `r-${i}` }));
    }

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'r-0' },
    });

    expect((result.content as any)[0].text).toMatch(/was captured but its data has been discarded/);
    expect(result.isError).toBe(true);
  });

  it('still returns a body Chrome kept after the record was evicted', async () => {
    const getResponseBody = vi.fn().mockResolvedValue({ body: 'late but present', base64Encoded: false });
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    for (let i = 0; i < 1001; i++) {
      fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: `r-${i}` }));
    }

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'r-0' },
    });

    expect(JSON.parse((result.content as any)[0].text).note).toMatch(/evicted from the capture buffer/);
    expect((result.content as any)[1].text).toBe('late but present');
    expect(result.isError).toBeFalsy();
  });

  it('returns an unknown-requestId error for an id never seen', async () => {
    const getResponseBody = vi.fn().mockRejectedValue(new Error('No resource with given identifier found'));
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'nope' },
    });

    expect((result.content as any)[0].text).toMatch(/Unknown requestId nope/);
    expect(result.isError).toBe(true);
  });

  it('reports that the request is still loading', async () => {
    const getResponseBody = vi.fn();
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/has not finished loading yet/);
    expect(getResponseBody).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('surfaces a failed request without calling getResponseBody', async () => {
    const getResponseBody = vi.fn();
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());
    fireCdp(cdpClient, 'Network', 'loadingFailed', {
      requestId: 'req-1',
      timestamp: 100.1,
      errorText: 'net::ERR_ABORTED',
    });

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/failed \(net::ERR_ABORTED\)/);
    expect(getResponseBody).not.toHaveBeenCalled();
  });

  it('does not return binary bodies', async () => {
    const getResponseBody = vi.fn().mockResolvedValue({ body: 'iVBORw0KGgo=', base64Encoded: true });
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ type: 'Image' }));
    fireCdp(cdpClient, 'Network', 'responseReceived', {
      requestId: 'req-1',
      type: 'Image',
      response: { status: 200, mimeType: 'image/png', headers: {} },
    });
    fireCdp(cdpClient, 'Network', 'loadingFinished', {
      requestId: 'req-1',
      timestamp: 100.2,
      encodedDataLength: 900,
    });

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect(result.content).toHaveLength(1);
    expect(JSON.parse((result.content as any)[0].text).omitted).toBe('binary body not returned');
  });

  it('returns not-connected message with isError when Chrome is unavailable', async () => {
    const client = await setupMcpClient(null);

    const result = await client.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/Chrome is not connected/);
    expect(result.isError).toBe(true);
  });
});

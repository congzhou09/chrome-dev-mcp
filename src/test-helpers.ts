import { EventEmitter } from 'events';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import CDP from 'chrome-remote-interface';
import { createServer } from './server.js';

export function makeMockClient(
  evaluate = vi.fn(),
  captureScreenshot = vi.fn(),
  debuggerMethods: Record<string, ReturnType<typeof vi.fn>> = {},
  networkMethods: Record<string, ReturnType<typeof vi.fn>> = {},
  runtimeMethods: Record<string, ReturnType<typeof vi.fn>> = {},
  pageMethods: Record<string, ReturnType<typeof vi.fn>> = {},
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
    Runtime: {
      enable: vi.fn(),
      evaluate,
      getProperties: vi.fn(),
      callFunctionOn: vi.fn().mockResolvedValue({ result: { type: 'object', value: {} } }),
      releaseObject: vi.fn().mockResolvedValue({}),
      ...runtimeMethods,
    },
    Page: {
      enable: vi.fn(),
      captureScreenshot,
      bringToFront: vi.fn().mockResolvedValue({}),
      on: vi.fn(),
      ...pageMethods,
    },
    Console: { on: vi.fn(), enable: vi.fn().mockResolvedValue({}) },
    Debugger: debugger_,
    Network: network,
  }) as unknown as CDP.Client;
}

// Exposes attachNetwork alongside the MCP client. In production index.ts calls it at
// connect time; tests have to call it explicitly to start network capture.
export async function setupServer(
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

export async function setupMcpClient(
  cdpClient: CDP.Client | null,
  switchToTarget: (targetId: string) => Promise<CDP.Client | null> = vi.fn(),
  getCurrentTargetId: () => string | null = () => null,
) {
  const { mcpClient } = await setupServer(cdpClient, switchToTarget, getCurrentTargetId);
  return mcpClient;
}

// Invokes a registered CDP handler directly, the same way the get_debugger_state test
// simulates a paused event. Handlers are synchronous, so this is not awaited.
export function fireCdp(cdpClient: CDP.Client, domain: 'Network' | 'Page', event: string, payload: any): void {
  const handler = (cdpClient as any)[domain].on.mock.calls.find(([e]: [string]) => e === event)?.[1];
  handler?.(payload);
}

// Minimal event payloads. `timestamp` is CDP's monotonic clock in seconds.
export function sentEvent(over: any = {}) {
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

export async function captureOne(
  cdpClient: CDP.Client,
  attachNetwork: (c: CDP.Client) => Promise<boolean>,
  over: any = {},
) {
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

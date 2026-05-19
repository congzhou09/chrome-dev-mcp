import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type CDP from 'chrome-remote-interface';
import { createServer } from './server.js';

function makeMockClient(evaluate = vi.fn(), captureScreenshot = vi.fn()): CDP.Client {
  return {
    Runtime: { enable: vi.fn(), evaluate },
    Page: { enable: vi.fn(), captureScreenshot },
  } as unknown as CDP.Client;
}

async function setupMcpClient(cdpClient: CDP.Client) {
  const server = createServer(cdpClient);
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
    expect(evaluate).toHaveBeenCalledWith({
      expression: 'document.title',
      returnByValue: true,
    });
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

    expect(evaluate).toHaveBeenCalledWith({
      expression: 'window.__myData',
      returnByValue: true,
    });
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

    const result = await client.callTool({
      name: 'get_computed_style',
      arguments: { selector: '#app' },
    });

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

    const result = await client.callTool({
      name: 'element_from_point',
      arguments: { selector: '#app' },
    });

    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value, null, 2) }]);
  });
});

describe('screenshot', () => {
  it('returns base64 image content', async () => {
    // 1x1 transparent PNG
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const captureScreenshot = vi.fn().mockResolvedValue({ data: pngBase64 });
    const client = await setupMcpClient(makeMockClient(vi.fn(), captureScreenshot));

    const result = await client.callTool({
      name: 'screenshot',
      arguments: {},
    });

    expect(captureScreenshot).toHaveBeenCalledWith({ format: 'png' });
    expect(result.content).toEqual([{ type: 'image', data: pngBase64, mimeType: 'image/png' }]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { makeMockClient, setupMcpClient } from '../test-helpers.js';

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

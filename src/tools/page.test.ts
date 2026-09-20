import { describe, it, expect, vi } from 'vitest';
import { BRING_TO_FRONT_TIMEOUT_MS, PAGE_COMMAND_TIMEOUT_MS, SCREENSHOT_TIMEOUT_MS } from '../constants.js';
import { makeMockClient, setupMcpClient } from '../test-helpers.js';

// A CDP command that never answers and never rejects — the shape every bound in this file
// exists for. A renderer blocked in a synchronous loop behaves exactly like this.
const neverAnswers = () => new Promise<any>(() => {});

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

  // Reading the title is the cheapest command in the server, and it hangs just as
  // permanently as anything else when the renderer stops answering.
  it('reports a renderer that never answers instead of hanging', async () => {
    const client = await setupMcpClient(makeMockClient(vi.fn(neverAnswers)));

    vi.useFakeTimers();
    try {
      const pending = client.callTool({ name: 'get_title', arguments: {} });
      await vi.advanceTimersByTimeAsync(PAGE_COMMAND_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain(`did not answer within ${PAGE_COMMAND_TIMEOUT_MS}ms`);
    } finally {
      vi.useRealTimers();
    }
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
  // The truncation happens in the page, so that is where it has to be asserted: a test that
  // only checked the returned length would still pass if the slice moved back to this side
  // and started transferring whole documents again.
  it('asks the page for the first 20000 chars rather than truncating on arrival', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { value: { html: 'a'.repeat(20000), totalLength: 20000 } } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    await client.callTool({ name: 'get_html', arguments: {} });

    const { expression } = evaluate.mock.calls[0][0];
    expect(expression).toContain('outerHTML');
    expect(expression).toContain('slice(0, 20000)');
    expect(expression).toContain('totalLength: html.length');
  });

  it('marks a truncated document with how much was cut and its real length', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValue({ result: { value: { html: 'a'.repeat(20000), totalLength: 1234567 } } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'get_html', arguments: {} });

    const text = (result.content as any)[0].text as string;
    expect(text.startsWith('a'.repeat(20000))).toBe(true);
    expect(text).toContain('+1214567 chars truncated');
    expect(text).toContain('document is 1234567 characters');
  });

  // A page that is exactly at the limit is not truncated, and must not claim to be.
  it('adds no marker when the whole document fits', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { value: { html: 'a'.repeat(20000), totalLength: 20000 } } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'get_html', arguments: {} });

    expect((result.content as any)[0].text).toBe('a'.repeat(20000));
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

  it('does not touch the foreground tab when the capture answers', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = makeMockClient(vi.fn(), captureScreenshot);
    const client = await setupMcpClient(cdp);

    await client.callTool({ name: 'screenshot', arguments: {} });

    expect((cdp as any).Page.bringToFront).not.toHaveBeenCalled();
  });

  // The recovery that matters: a tab producing no frames answers the capture with nothing at
  // all, and bringing it forward is what makes the compositor produce one.
  it('brings the tab to the front and retries when the first capture never answers', async () => {
    const captureScreenshot = vi.fn().mockImplementationOnce(neverAnswers).mockResolvedValueOnce({ data: 'aGk=' });
    const cdp = makeMockClient(vi.fn(), captureScreenshot);
    const client = await setupMcpClient(cdp);

    vi.useFakeTimers();
    try {
      const pending = client.callTool({ name: 'screenshot', arguments: {} });
      await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS + 1);
      const result = await pending;

      expect((cdp as any).Page.bringToFront).toHaveBeenCalledTimes(1);
      expect(captureScreenshot).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports both attempts timing out rather than waiting on the second', async () => {
    const captureScreenshot = vi.fn(neverAnswers);
    const client = await setupMcpClient(makeMockClient(vi.fn(), captureScreenshot));

    vi.useFakeTimers();
    try {
      const pending = client.callTool({ name: 'screenshot', arguments: {} });
      await vi.advanceTimersByTimeAsync((SCREENSHOT_TIMEOUT_MS + 1) * 2);
      const result = await pending;

      expect(captureScreenshot).toHaveBeenCalledTimes(2);
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('twice');
    } finally {
      vi.useRealTimers();
    }
  });

  // bringToFront is handled off the page's main thread, so it answering nothing means the
  // target itself is gone — a different message from "the tab is not producing frames".
  it('reports separately when the tab cannot even be brought to the front', async () => {
    const captureScreenshot = vi.fn(neverAnswers);
    const client = await setupMcpClient(
      makeMockClient(vi.fn(), captureScreenshot, {}, {}, {}, { bringToFront: vi.fn(neverAnswers) }),
    );

    vi.useFakeTimers();
    try {
      const pending = client.callTool({ name: 'screenshot', arguments: {} });
      await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS + BRING_TO_FRONT_TIMEOUT_MS + 2);
      const result = await pending;

      expect(captureScreenshot).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('could not be brought');
    } finally {
      vi.useRealTimers();
    }
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

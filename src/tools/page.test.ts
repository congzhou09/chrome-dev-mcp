import { describe, it, expect, vi } from 'vitest';
import {
  BRING_TO_FRONT_TIMEOUT_MS,
  LAYOUT_METRICS_TIMEOUT_MS,
  PAGE_COMMAND_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
} from '../constants.js';
import { makeMockClient, setupMcpClient } from '../test-helpers.js';

// A CDP command that never answers and never rejects — the shape every bound in this file
// exists for. A renderer blocked in a synchronous loop behaves exactly like this.
const neverAnswers = () => new Promise<any>(() => {});

// A PNG header and nothing after it. The screenshot tool reads delivered dimensions out of
// IHDR without decoding the image, so this is all a test needs to assert what the note says.
const pngHeader = (width: number, height: number): string => {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
};

// Both rectangles Page.getLayoutMetrics reports, the second being the first in device
// pixels — the pair is what the tool reads the device scale factor out of.
const layoutMetrics = (cssWidth: number, cssHeight: number, dpr = 1, pageX = 0, pageY = 0) => ({
  cssLayoutViewport: { pageX, pageY, clientWidth: cssWidth, clientHeight: cssHeight },
  layoutViewport: {
    pageX: pageX * dpr,
    pageY: pageY * dpr,
    clientWidth: cssWidth * dpr,
    clientHeight: cssHeight * dpr,
  },
});

// What the page answers when screenshot asks for `devicePixelRatio`. Kept separate from the
// layout metrics on purpose: under device emulation the two disagree, and which one the code
// believes is the difference between a correctly sized capture and a 3x-oversized one.
const reportsDpr = (value: unknown = 1) => vi.fn().mockResolvedValue({ result: { value } });

// Same shape as the other screenshot tests, with the Page overrides they need. `dpr` is what
// the page reports; pass the one the metrics imply unless the test is about them disagreeing.
const withMetrics = (captureScreenshot: any, getLayoutMetrics: any, dpr: unknown = 1) =>
  makeMockClient(reportsDpr(dpr), captureScreenshot, {}, {}, {}, { getLayoutMetrics });

// Asserts the contract against the pixels Chrome will actually produce (css * dpr * scale)
// rather than against the scale factor — a test that restated the arithmetic would pass just
// as happily on a wrong formula. The long edge of what comes back is what the caller asked
// for, to within the rounding of a pixel.
const expectLongEdge = (clip: any, dpr: number, requested: number) => {
  const width = clip.width * dpr * clip.scale;
  const height = clip.height * dpr * clip.scale;
  expect(Math.max(width, height)).toBeCloseTo(requested, 0);
};

const clipOf = (captureScreenshot: any, call = 0) => captureScreenshot.mock.calls[call][0].clip;

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
    const client = await setupMcpClient(makeMockClient(reportsDpr(1), captureScreenshot));

    const result = await client.callTool({ name: 'screenshot', arguments: {} });

    expect(captureScreenshot).toHaveBeenCalledWith({ format: 'png' });
    expect(result.content).toEqual([{ type: 'image', data: pngBase64, mimeType: 'image/png' }]);
  });

  it('does not touch the foreground tab when the capture answers', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = makeMockClient(reportsDpr(1), captureScreenshot);
    const client = await setupMcpClient(cdp);

    await client.callTool({ name: 'screenshot', arguments: {} });

    expect((cdp as any).Page.bringToFront).not.toHaveBeenCalled();
  });

  // The recovery that matters: a tab producing no frames answers the capture with nothing at
  // all, and bringing it forward is what makes the compositor produce one.
  it('brings the tab to the front and retries when the first capture never answers', async () => {
    const captureScreenshot = vi.fn().mockImplementationOnce(neverAnswers).mockResolvedValueOnce({ data: 'aGk=' });
    const cdp = makeMockClient(reportsDpr(1), captureScreenshot);
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
    const client = await setupMcpClient(makeMockClient(reportsDpr(1), captureScreenshot));

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
      makeMockClient(reportsDpr(1), captureScreenshot, {}, {}, {}, { bringToFront: vi.fn(neverAnswers) }),
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

  // The default is the tab's own pixels, and it has to cost nothing: no clip, no note, and
  // not even the round-trip that asking for a size would need.
  it('captures natively and asks nothing of the page when maxEdge is omitted', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const getLayoutMetrics = vi.fn().mockResolvedValue(layoutMetrics(1440, 900, 2));
    const cdp = withMetrics(captureScreenshot, getLayoutMetrics, 2);
    const client = await setupMcpClient(cdp);

    const result = await client.callTool({ name: 'screenshot', arguments: {} });

    expect(getLayoutMetrics).not.toHaveBeenCalled();
    expect(captureScreenshot).toHaveBeenCalledWith({ format: 'png' });
    expect(result.content).toEqual([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
  });

  // -1 is the documented default rather than a second code path, so it has to behave exactly
  // as omitting it does.
  it.each([
    ['the documented -1', -1],
    ['zero', 0],
  ])('captures natively for %s', async (_label, maxEdge) => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const getLayoutMetrics = vi.fn().mockResolvedValue(layoutMetrics(1440, 900, 2));
    const client = await setupMcpClient(withMetrics(captureScreenshot, getLayoutMetrics, 2));

    const result = await client.callTool({ name: 'screenshot', arguments: { maxEdge } });

    expect(getLayoutMetrics).not.toHaveBeenCalled();
    expect(captureScreenshot).toHaveBeenCalledWith({ format: 'png' });
    expect(result.content).toEqual([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
  });

  // The whole point of the parameter: the long edge of what comes back is the number asked
  // for, whatever the display's scale factor does to the native size in between.
  it('scales the long edge to the requested size on a HiDPI tab', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: pngHeader(1200, 750) });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1440, 900, 2)), 2);
    const client = await setupMcpClient(cdp);

    const result = await client.callTool({ name: 'screenshot', arguments: { maxEdge: 1200 } });

    const clip = clipOf(captureScreenshot);
    expect(clip).toMatchObject({ x: 0, y: 0, width: 1440, height: 900 });
    // Native long edge is 1440 * 2 = 2880, so the requested 1200 is 1200/2880 of it.
    expectLongEdge(clip, 2, 1200);
    const [image, note] = result.content as any[];
    expect(image).toEqual({ type: 'image', data: pngHeader(1200, 750), mimeType: 'image/png' });
    expect(note.text).toContain('1200x750');
    expect(note.text).toContain('maxEdge');
  });

  // Portrait viewports exist (phone emulation, a tall narrow window), and the cap is on the
  // long edge whichever axis that turns out to be.
  it('measures the long edge against height when height is the longer side', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(800, 2000)));
    const client = await setupMcpClient(cdp);

    await client.callTool({ name: 'screenshot', arguments: { maxEdge: 1000 } });

    const clip = clipOf(captureScreenshot);
    expect(clip).toMatchObject({ x: 0, y: 0, width: 800, height: 2000 });
    expectLongEdge(clip, 1, 1000);
    expect(clip.height * clip.scale).toBeCloseTo(1000, 0);
  });

  // A ceiling, never a target: a tab smaller than the request cannot be enlarged, and
  // asking for more must not produce an upscaled, blurrier image than the native one.
  it.each([
    ['above the native size', 4000],
    ['exactly at the native size', 1440],
  ])('returns native pixels untouched for a maxEdge %s', async (_label, maxEdge) => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1440, 900)));
    const client = await setupMcpClient(cdp);

    const result = await client.callTool({ name: 'screenshot', arguments: { maxEdge } });

    expect(captureScreenshot).toHaveBeenCalledWith({ format: 'png' });
    expect(result.content).toEqual([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
  });

  // The regression this guards is silent and total: clip coordinates are document-relative,
  // so a scrolled page clipped at the origin comes back showing the top of the document
  // instead of what is on screen — the wrong screenshot, with nothing about it looking wrong.
  it('clips at the scroll offset rather than the document origin', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1600, 900, 1.5, 0, 731)), 1.5);
    const client = await setupMcpClient(cdp);

    await client.callTool({ name: 'screenshot', arguments: { maxEdge: 1200 } });

    const clip = clipOf(captureScreenshot);
    expect(clip).toMatchObject({ x: 0, y: 731, width: 1600, height: 900 });
    expectLongEdge(clip, 1.5, 1200);
  });

  // Device emulation (DevTools' device toolbar, or another CDP client on the same tab) is a
  // state this server has to assume it may arrive into. Under it, layoutViewport keeps
  // reporting the host display's scale factor while the capture uses the emulated one —
  // measured 1.251 vs 1.0 on a 1.25x display. Believing the metrics there mis-sizes the clip.
  it('believes the page over the device-pixel rectangle when emulation makes them disagree', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    // The metrics imply 2x; the page — emulated — reports 1x, and 1x is what the capture uses.
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1600, 900, 2)), 1);
    const client = await setupMcpClient(cdp);

    await client.callTool({ name: 'screenshot', arguments: { maxEdge: 1000 } });

    expectLongEdge(clipOf(captureScreenshot), 1, 1000);
  });

  // When the page cannot answer, the deprecated rectangle is the only source left, and it is
  // the right one whenever nothing is emulating.
  it('falls back to the device-pixel rectangle when the page reports no usable ratio', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1440, 900, 2)), 'not-a-number');
    const client = await setupMcpClient(cdp);

    await client.callTool({ name: 'screenshot', arguments: { maxEdge: 1200 } });

    expectLongEdge(clipOf(captureScreenshot), 2, 1200);
  });

  // Neither source available: no device-pixel rectangle, and the page did not answer either.
  // The fallback has to be the one that returns a correct image at the wrong size rather
  // than a blurred one, so 1:1 — which under-states a HiDPI native size and therefore
  // overshoots the request rather than cutting into it.
  it('assumes 1:1 when neither the page nor the metrics report a ratio', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const getLayoutMetrics = vi.fn().mockResolvedValue({
      cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 2000, clientHeight: 1000 },
    });
    const client = await setupMcpClient(withMetrics(captureScreenshot, getLayoutMetrics, undefined));

    await client.callTool({ name: 'screenshot', arguments: { maxEdge: 1000 } });

    expectLongEdge(clipOf(captureScreenshot), 1, 1000);
  });

  // Sizing is best-effort and capturing is the job: metrics that never answer must cost one
  // short bound and then get out of the way, not fail a screenshot that was going to work.
  it('falls through to a native capture when the size probe never answers', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const client = await setupMcpClient(withMetrics(captureScreenshot, vi.fn(neverAnswers)));

    vi.useFakeTimers();
    try {
      const pending = client.callTool({ name: 'screenshot', arguments: { maxEdge: 800 } });
      await vi.advanceTimersByTimeAsync(LAYOUT_METRICS_TIMEOUT_MS + 1);
      const result = await pending;

      expect(captureScreenshot).toHaveBeenCalledWith({ format: 'png' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls through to a native capture when the size probe rejects', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const getLayoutMetrics = vi.fn().mockRejectedValue(new Error('Page domain not enabled'));
    const client = await setupMcpClient(withMetrics(captureScreenshot, getLayoutMetrics));

    const result = await client.callTool({ name: 'screenshot', arguments: { maxEdge: 800 } });

    expect(captureScreenshot).toHaveBeenCalledWith({ format: 'png' });
    expect(result.content).toEqual([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
  });

  // The recovery path has to carry the same clip as the attempt it replaces, or bringing the
  // tab forward would quietly hand back a full-size image.
  it('retries with the same clip after bringing the tab to the front', async () => {
    const captureScreenshot = vi
      .fn()
      .mockImplementationOnce(neverAnswers)
      .mockResolvedValueOnce({ data: pngHeader(1200, 750) });
    const client = await setupMcpClient(
      withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1440, 900, 2)), 2),
    );

    vi.useFakeTimers();
    try {
      const pending = client.callTool({ name: 'screenshot', arguments: { maxEdge: 1200 } });
      await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS + 1);
      const result = await pending;

      expect(clipOf(captureScreenshot, 0)).toBeDefined();
      expect(captureScreenshot.mock.calls[1][0]).toEqual(captureScreenshot.mock.calls[0][0]);
      expect((result.content as any)[1].text).toContain('1200x750');
    } finally {
      vi.useRealTimers();
    }
  });

  // The reason `region` exists: a question about exact pixels is almost always about one
  // element, and a small native-size crop of it costs a fraction of the whole viewport.
  it('captures just the requested rectangle at native size', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: pngHeader(96, 32) });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1440, 900)));
    const client = await setupMcpClient(cdp);

    const result = await client.callTool({
      name: 'screenshot',
      arguments: { region: { x: 412, y: 118, width: 96, height: 32 } },
    });

    expect(captureScreenshot).toHaveBeenCalledWith({
      format: 'png',
      clip: { x: 412, y: 118, width: 96, height: 32, scale: 1 },
    });
    // Nothing was scaled and nothing was cut, so the result carries no note.
    expect(result.content).toEqual([{ type: 'image', data: pngHeader(96, 32), mimeType: 'image/png' }]);
  });

  // The whole point of taking viewport coordinates: a getBoundingClientRect() box can be
  // handed over untouched, and this server adds the scroll offset CDP's clip needs. Getting
  // this backwards would photograph the top of the document on every scrolled page.
  it('adds the scroll offset to a viewport-relative region', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1440, 900, 1, 0, 731)));
    const client = await setupMcpClient(cdp);

    await client.callTool({
      name: 'screenshot',
      arguments: { region: { x: 40, y: 60, width: 200, height: 100 } },
    });

    expect(clipOf(captureScreenshot)).toMatchObject({ x: 40, y: 791, width: 200, height: 100 });
  });

  // getBoundingClientRect() returns fractional CSS pixels, so the common case is fractional
  // input; rounding it here would move the crop off the element by up to a pixel, which is
  // exactly the error a pixel-exact capture is being taken to investigate.
  it('passes a fractional rect through without rounding it', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1440, 900)));
    const client = await setupMcpClient(cdp);

    await client.callTool({
      name: 'screenshot',
      arguments: { region: { x: 412.5, y: 118.25, width: 96.5, height: 32.75 } },
    });

    expect(clipOf(captureScreenshot)).toMatchObject({ x: 412.5, y: 118.25, width: 96.5, height: 32.75 });
  });

  it('caps the region rather than the viewport when maxEdge is given too', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: pngHeader(200, 100) });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1440, 900, 2)), 2);
    const client = await setupMcpClient(cdp);

    const result = await client.callTool({
      name: 'screenshot',
      arguments: { region: { x: 0, y: 0, width: 400, height: 200 }, maxEdge: 200 },
    });

    const clip = clipOf(captureScreenshot);
    expect(clip).toMatchObject({ x: 0, y: 0, width: 400, height: 200 });
    // The region is 400 CSS px wide on a 2x tab, so 800 native px, and 200 is a quarter of it.
    expectLongEdge(clip, 2, 200);
    expect((result.content as any)[1].text).toContain('downscaled');
  });

  // An element flush against the edge, or half scrolled out, is ordinary — too ordinary to
  // fail over. The part that exists is returned, and the caller is told it was cut so the
  // image is never quietly narrower than what was asked for.
  it('cuts a region that runs past the viewport and says so', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1000, 800)));
    const client = await setupMcpClient(cdp);

    const result = await client.callTool({
      name: 'screenshot',
      arguments: { region: { x: 900, y: 700, width: 400, height: 400 } },
    });

    expect(clipOf(captureScreenshot)).toMatchObject({ x: 900, y: 700, width: 100, height: 100 });
    expect((result.content as any)[1].text).toContain('cut to the part on screen');
  });

  // Negative coordinates are what getBoundingClientRect() reports for something scrolled off
  // the top, so they are input, not nonsense — the visible remainder is the answer.
  it('cuts a region that starts above the viewport', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1000, 800, 1, 0, 500)));
    const client = await setupMcpClient(cdp);

    await client.callTool({
      name: 'screenshot',
      arguments: { region: { x: 0, y: -30, width: 200, height: 100 } },
    });

    // Document y is the scroll offset itself; the 30px above the fold are gone.
    expect(clipOf(captureScreenshot)).toMatchObject({ x: 0, y: 500, width: 200, height: 70 });
  });

  it('reports a region that is entirely off screen instead of capturing something else', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1000, 800)));
    const client = await setupMcpClient(cdp);

    const result = await client.callTool({
      name: 'screenshot',
      arguments: { region: { x: 1200, y: 100, width: 300, height: 200 } },
    });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('entirely outside');
    expect(captureScreenshot).not.toHaveBeenCalled();
  });

  // The asymmetry that matters: an unmeasurable viewport costs `maxEdge` only size, so it
  // degrades to native. A region placed without the viewport would be a picture of the wrong
  // part of the page, and nothing in the image would reveal it — so that one fails loudly.
  it('fails rather than guessing a region when the viewport cannot be measured', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const client = await setupMcpClient(withMetrics(captureScreenshot, vi.fn(neverAnswers)));

    vi.useFakeTimers();
    try {
      const pending = client.callTool({
        name: 'screenshot',
        arguments: { region: { x: 0, y: 0, width: 100, height: 100 } },
      });
      await vi.advanceTimersByTimeAsync(LAYOUT_METRICS_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain('region');
      expect(captureScreenshot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // A zero-area rect cannot be captured and is almost certainly a bug upstream (an element
  // with display:none reports one), so the schema rejects it before a CDP round-trip.
  it.each([
    ['zero width', { x: 0, y: 0, width: 0, height: 100 }],
    ['negative height', { x: 0, y: 0, width: 100, height: -5 }],
  ])('rejects a region with %s', async (_label, region) => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: 'aGk=' });
    const cdp = withMetrics(captureScreenshot, vi.fn().mockResolvedValue(layoutMetrics(1000, 800)));
    const client = await setupMcpClient(cdp);

    const result = await client.callTool({ name: 'screenshot', arguments: { region } });

    expect(result.isError).toBe(true);
    expect(captureScreenshot).not.toHaveBeenCalled();
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

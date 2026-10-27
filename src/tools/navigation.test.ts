import { describe, it, expect, vi } from 'vitest';
import { makeMockClient, setupMcpClient, fireCdp, inlineSourceMap } from '../test-helpers.js';

// The mock client is an EventEmitter, so the tool's own listeners hear `cdp.emit`. The
// session's handlers are mock registrations instead, reached through fireCdp.
const later = (fn: () => void) => setTimeout(fn, 0);

const commit = (cdp: any, url: string) => cdp.emit('Page.frameNavigated', { frame: { id: 'main', url } });

const pageRead = (url: string, title: string) =>
  vi.fn().mockResolvedValue({ result: { type: 'object', value: { url, title } } });

const call = async (client: any, name: string, args: Record<string, unknown> = {}) => {
  const result: any = await client.callTool({ name, arguments: args });
  return result;
};

describe('navigate_tab', () => {
  it('waits for the load event and reports the page it landed on', async () => {
    let cdp: any;
    const navigate = vi.fn(async () => {
      later(() => {
        commit(cdp, 'http://localhost/next');
        cdp.emit('Page.loadEventFired', { timestamp: 1 });
      });
      return { frameId: 'main', loaderId: 'l2' };
    });
    cdp = makeMockClient(pageRead('http://localhost/next', 'Next'), undefined, {}, {}, {}, { navigate });
    const client = await setupMcpClient(cdp);

    const result = await call(client, 'navigate_tab', { url: 'http://localhost/next' });

    expect(navigate).toHaveBeenCalledWith({ url: 'http://localhost/next' });
    expect(result.structuredContent).toEqual({ outcome: 'loaded', url: 'http://localhost/next', title: 'Next' });
  });

  it('reports a failed navigation instead of the error page that loads after it', async () => {
    let cdp: any;
    const navigate = vi.fn(async () => {
      // Chrome does go on to load its error page; that load must not read as success.
      later(() => cdp.emit('Page.loadEventFired', { timestamp: 1 }));
      return { frameId: 'main', loaderId: 'l2', errorText: 'net::ERR_CONNECTION_REFUSED' };
    });
    cdp = makeMockClient(undefined, undefined, {}, {}, {}, { navigate });
    const client = await setupMcpClient(cdp);

    const result = await call(client, 'navigate_tab', { url: 'http://localhost:1/' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('net::ERR_CONNECTION_REFUSED');
  });

  it('returns at once on a #hash change, which fires no load event', async () => {
    const navigate = vi.fn().mockResolvedValue({ frameId: 'main' });
    const cdp = makeMockClient(pageRead('http://localhost/#h', 'Same'), undefined, {}, {}, {}, { navigate });
    const client = await setupMcpClient(cdp);

    const result = await call(client, 'navigate_tab', { url: 'http://localhost/#h' });

    expect(result.structuredContent).toEqual({ outcome: 'same-document', url: 'http://localhost/#h', title: 'Same' });
  });

  it('reports a download without waiting for a load that never comes', async () => {
    // The answer Chrome gives for a download: it carries an errorText too.
    const navigate = vi
      .fn()
      .mockResolvedValue({ frameId: 'main', loaderId: 'l2', errorText: 'net::ERR_ABORTED', isDownload: true });
    const cdp = makeMockClient(undefined, undefined, {}, {}, {}, { navigate });
    const client = await setupMcpClient(cdp);

    const result = await call(client, 'navigate_tab', { url: 'http://localhost/file.zip' });

    expect(result.structuredContent).toEqual({ outcome: 'download' });
  });

  it('passes on a rejected command as a tool error', async () => {
    const navigate = vi.fn().mockRejectedValue(new Error('Cannot navigate to invalid URL'));
    const cdp = makeMockClient(undefined, undefined, {}, {}, {}, { navigate });
    const client = await setupMcpClient(cdp);

    const result = await call(client, 'navigate_tab', { url: 'example.invalid' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot navigate to invalid URL');
  });
});

describe('reload_tab', () => {
  it('returns the call stack when the new page pauses before it loads', async () => {
    let cdp: any;
    const paused = {
      reason: 'other',
      hitBreakpoints: ['bp-1'],
      callFrames: [
        { functionName: 'init', url: 'http://localhost/app.js', location: { scriptId: '1', lineNumber: 4 } },
      ],
    };
    const reload = vi.fn(async () => {
      later(() => {
        commit(cdp, 'http://localhost/');
        // The session's handler first, as in Chrome, where it was registered first.
        fireCdp(cdp, 'Debugger', 'paused', paused);
        cdp.emit('Debugger.paused', paused);
      });
      return {};
    });
    cdp = makeMockClient(undefined, undefined, {}, {}, {}, { reload });
    const client = await setupMcpClient(cdp);

    const result = await call(client, 'reload_tab', { ignoreCache: true });

    expect(reload).toHaveBeenCalledWith({ ignoreCache: true });
    expect(result.structuredContent.outcome).toBe('paused');
    expect(result.structuredContent.reason).toBe('other');
    expect(result.structuredContent.callStack[0]).toMatchObject({ functionName: 'init', lineNumber: 5 });
  });

  it('waits for the load event when nothing pauses', async () => {
    let cdp: any;
    const reload = vi.fn(async () => {
      later(() => {
        commit(cdp, 'http://localhost/');
        cdp.emit('Page.loadEventFired', { timestamp: 1 });
      });
      return {};
    });
    cdp = makeMockClient(pageRead('http://localhost/', 'Home'), undefined, {}, {}, {}, { reload });
    const client = await setupMcpClient(cdp);

    const result = await call(client, 'reload_tab');

    expect(reload).toHaveBeenCalledWith({ ignoreCache: false });
    expect(result.structuredContent).toEqual({ outcome: 'loaded', url: 'http://localhost/', title: 'Home' });
  });
  // The edit-then-reload loop: the edited file's old breakpoint can fire during startup before it
  // is removed. The result has to say the stop may not be where it was set, and that it is gone.
  it('reports a breakpoint the reload dropped because its file changed, and a stop on it', async () => {
    let cdp: any;
    const appUrl = 'http://localhost/src/app.ts';
    const text = (tail = '') => Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + tail;
    const map = (content: string) => inlineSourceMap(['app.ts'], [[], [[0, 0, 5, 0]]], [content]);
    const chromeId = `br:1:1:0:${appUrl}`;
    const paused = {
      reason: 'other',
      hitBreakpoints: [chromeId],
      callFrames: [{ functionName: 'init', location: { scriptId: 's2', lineNumber: 1, columnNumber: 0 } }],
    };
    const reload = vi.fn(async () => {
      later(() => {
        commit(cdp, 'http://localhost/');
        fireCdp(cdp, 'Debugger', 'scriptParsed', {
          scriptId: 's2',
          url: appUrl,
          sourceMapURL: map(text('\nline 11')),
          hash: 'h2',
        });
        fireCdp(cdp, 'Debugger', 'paused', paused);
        cdp.emit('Debugger.paused', paused);
      });
      return {};
    });
    const setBreakpointByUrl = vi
      .fn()
      .mockResolvedValue({ breakpointId: chromeId, locations: [{ scriptId: 's1', lineNumber: 1, columnNumber: 0 }] });
    cdp = makeMockClient(undefined, undefined, { setBreakpointByUrl }, {}, {}, { reload });
    const client = await setupMcpClient(cdp);
    await call(client, 'get_debugger_state');
    fireCdp(cdp, 'Debugger', 'scriptParsed', { scriptId: 's1', url: appUrl, sourceMapURL: map(text()), hash: 'h1' });
    const set = await call(client, 'set_breakpoint', { source: 'src/app.ts', lineNumber: 5 });
    const id = set.structuredContent.breakpointId;

    const result = await call(client, 'reload_tab');

    expect(result.structuredContent.outcome).toBe('paused');
    expect(result.structuredContent.note).toMatch(new RegExp(`^Stopped on ${id} .*dropped because its file changed`));
    expect(result.structuredContent.droppedBreakpoints).toEqual([
      {
        breakpointId: id,
        location: `${appUrl}:5 → ${appUrl}:2`,
        reason: `${appUrl} changed since this breakpoint was set`,
      },
    ]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { makeMockClient, setupMcpClient, fireCdp } from '../test-helpers.js';

// The handler the session registers for Chrome's console events. Reached the same way
// fireCdp reaches the Page and Network ones, from the mock's own call log.
const messageAdded = (cdp: any) => cdp.Console.on.mock.calls.find(([e]: [string]) => e === 'messageAdded')?.[1];

const say = async (cdp: any, text: string, level = 'log') => {
  await messageAdded(cdp)({ message: { source: 'console-api', level, text } });
  // The handler is async whenever a stack trace has to be resolved; let it settle either way.
  await Promise.resolve();
};

const navigate = (cdp: any, url = 'http://localhost/2', parentId?: string) =>
  fireCdp(cdp, 'Page', 'frameNavigated', { frame: { url, loaderId: url, ...(parentId ? { parentId } : {}) } });

const read = async (client: any, args: Record<string, unknown> = {}) => {
  const result: any = await client.callTool({ name: 'get_console_logs', arguments: args });
  return result;
};
const texts = (result: any) => (result.structuredContent?.logs ?? []).map((l: any) => l.text);
const marks = (result: any) =>
  (result.structuredContent?.logs ?? []).map((l: any) => `${l.text}:${l.from ?? 'current'}`);

// Chrome replays everything already in DevTools as a burst of messageAdded events answered
// by Console.enable(). Holding the enable open is how that window is reproduced here.
const withHeldEnable = () => {
  let release: () => void = () => {};
  const enable = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
  );
  const cdp: any = makeMockClient();
  cdp.Console = { on: vi.fn(), enable };
  return { cdp, release: () => release() };
};

describe('get_console_logs', () => {
  it('returns captured messages with their level', async () => {
    const cdp: any = makeMockClient();
    const client = await setupMcpClient(cdp);
    await read(client); // first call attaches the session and registers the listeners

    await say(cdp, 'hello');
    await say(cdp, 'boom', 'error');

    const result = await read(client);
    expect(texts(result)).toEqual(['hello', 'boom']);
    expect(await read(client, { level: 'error' }).then(texts)).toEqual(['boom']);
  });

  // The whole point of the stamp: a reload leaves the old output in place, so without a
  // marker the only way to tell the pages apart is to eyeball arrival times against a
  // navigation the caller cannot see.
  it('marks entries from before a navigation and leaves the current ones unmarked', async () => {
    const cdp: any = makeMockClient();
    const client = await setupMcpClient(cdp);
    await read(client);

    await say(cdp, 'from-first-page');
    navigate(cdp);
    await say(cdp, 'from-second-page');

    expect(marks(await read(client))).toEqual(['from-first-page:earlier-page-load', 'from-second-page:current']);
  });

  it('marks the history Chrome replays at attach as predating the connection', async () => {
    const { cdp, release } = withHeldEnable();
    const client = await setupMcpClient(cdp);

    const attaching = read(client);
    // Registration happens before the enable is awaited, so the replay lands in that window.
    await vi.waitFor(() => expect(messageAdded(cdp)).toBeTypeOf('function'));
    await say(cdp, 'was-already-in-devtools');
    release();
    await attaching;

    await say(cdp, 'captured-live');

    expect(marks(await read(client))).toEqual(['was-already-in-devtools:before-connect', 'captured-live:current']);
  });

  // Resolving an exception's stack trace can await a source map fetch, and a cold cache makes
  // that a real network round trip. Anything printed during it must not overtake the
  // exception: an error followed by the line that reacts to it is the ordering a caller reads
  // for cause and effect.
  it('keeps arrival order while a stack trace waits on a source map fetch', async () => {
    let answer: (body: string) => void = () => {};
    const fetching = new Promise<string>((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal('fetch', () => fetching.then((body) => ({ ok: true, text: async () => body })));

    const cdp: any = makeMockClient();
    const client = await setupMcpClient(cdp);
    await read(client);

    fireCdp(cdp, 'Debugger', 'scriptParsed', {
      scriptId: 's1',
      url: 'http://localhost/app.js',
      sourceMapURL: 'app.js.map',
    });

    // Not awaited: the handler is parked on the fetch, which is the window under test.
    void messageAdded(cdp)({
      message: {
        source: 'javascript',
        level: 'error',
        text: 'boom',
        stackTrace: {
          callFrames: [
            { functionName: 'f', scriptId: 's1', url: 'http://localhost/app.js', lineNumber: 4, columnNumber: 2 },
          ],
        },
      },
    });
    await say(cdp, 'retrying');

    const during = (await read(client)).structuredContent.logs;
    expect(during.map((l: any) => l.text)).toEqual(['boom', 'retrying']);
    expect(during[0].stackTrace).toBeUndefined();

    answer('{"version":3,"sources":[],"mappings":""}');
    await vi.waitFor(async () => {
      const after = (await read(client)).structuredContent.logs;
      expect(after.map((l: any) => l.text)).toEqual(['boom', 'retrying']);
      expect(after[0].stackTrace).toHaveLength(1);
    });

    vi.unstubAllGlobals();
  });

  // Chrome replays its console history with no time of its own (measured, Chrome 153: the
  // messageAdded payload is source/level/text/line/column), so the only reading available for
  // the backlog is the instant of the replay — identical for every entry, and unrelated to
  // when they happened. Reporting it would look exactly like an occurrence time.
  it('gives the replayed backlog no timestamp, and live entries one', async () => {
    const { cdp, release } = withHeldEnable();
    const client = await setupMcpClient(cdp);
    const attaching = read(client);
    await vi.waitFor(() => expect(messageAdded(cdp)).toBeTypeOf('function'));
    await say(cdp, 'replayed-at-attach');
    release();
    await attaching;

    await say(cdp, 'captured-live');

    const logs = (await read(client)).structuredContent.logs;
    expect(logs.map((l: any) => l.text)).toEqual(['replayed-at-attach', 'captured-live']);
    expect(logs[0]).not.toHaveProperty('timestamp');
    expect(logs[1].timestamp).toEqual(expect.any(String));
  });

  it('returns only the current document for since: current-page-load', async () => {
    const { cdp, release } = withHeldEnable();
    const client = await setupMcpClient(cdp);
    const attaching = read(client);
    await vi.waitFor(() => expect(messageAdded(cdp)).toBeTypeOf('function'));
    await say(cdp, 'backlog');
    release();
    await attaching;

    await say(cdp, 'first-page');
    navigate(cdp);
    await say(cdp, 'second-page');

    expect(texts(await read(client, { since: 'current-page-load' }))).toEqual(['second-page']);
    expect(texts(await read(client, { since: 'earlier-page-load' }))).toEqual(['first-page', 'second-page']);
    expect(texts(await read(client, { since: 'before-connect' }))).toEqual(['backlog', 'first-page', 'second-page']);
  });

  it('composes since with the level filter', async () => {
    const cdp: any = makeMockClient();
    const client = await setupMcpClient(cdp);
    await read(client);

    await say(cdp, 'old-error', 'error');
    navigate(cdp);
    await say(cdp, 'new-error', 'error');
    await say(cdp, 'new-log');

    expect(texts(await read(client, { since: 'current-page-load', level: 'error' }))).toEqual(['new-error']);
  });

  // An iframe swapping out does not make the page's own output stale, and a page that uses
  // them heavily would otherwise mark its entries `earlier-page-load` while it sits there unchanged.
  it('ignores subframe navigations', async () => {
    const cdp: any = makeMockClient();
    const client = await setupMcpClient(cdp);
    await read(client);

    await say(cdp, 'still-this-page');
    navigate(cdp, 'http://localhost/iframe', 'parent-frame-id');

    expect(marks(await read(client))).toEqual(['still-this-page:current']);
  });

  // "Nothing captured yet" and "this page has printed nothing" are different answers, and
  // the second one is the useful result of a check after a reload.
  it('says which emptiness it means', async () => {
    const cdp: any = makeMockClient();
    const client = await setupMcpClient(cdp);
    await read(client);

    await say(cdp, 'from-first-page');
    navigate(cdp);

    expect((await read(client, { since: 'current-page-load' })).content[0].text).toContain('currently loaded');
    expect((await read(client)).content[0].text).not.toContain('No console entries');
  });
});

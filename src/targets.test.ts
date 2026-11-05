import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CDP from 'chrome-remote-interface';
import { TARGET_PROBE_TIMEOUT_MS } from './constants.js';
import { chromeReportsNoRenderer, enableTarget, probeVisible, restoreDiscardedTab } from './targets.js';

vi.mock('chrome-remote-interface', () => ({ default: vi.fn() }));

const neverAnswers = () => new Promise<never>(() => {});

// A connection to one target. With `noRenderer`, Inspector.enable sends Inspector.targetCrashed before
// it answers, as Chrome does on a tab that has no renderer. With `noInspector`, Inspector.enable fails,
// as in a browser without the Inspector domain. `calls` records the commands in the order they were
// sent.
function targetClient({
  noRenderer = false,
  noInspector = false,
  evaluate = vi.fn().mockResolvedValue({ result: { value: false } }),
  runtimeEnable = vi.fn().mockResolvedValue({}),
  navigateToHistoryEntry = vi.fn().mockResolvedValue({}),
}: {
  noRenderer?: boolean;
  noInspector?: boolean;
  evaluate?: ReturnType<typeof vi.fn>;
  runtimeEnable?: ReturnType<typeof vi.fn>;
  navigateToHistoryEntry?: ReturnType<typeof vi.fn>;
} = {}) {
  const events = new EventEmitter();
  const calls: string[] = [];
  const record =
    (name: string, fn: any) =>
    (...args: any[]) => {
      calls.push(name);
      return fn(...args);
    };
  const client = {
    Inspector: {
      targetCrashed: (listener: () => void) => {
        events.on('targetCrashed', listener);
        return () => events.off('targetCrashed', listener);
      },
      enable: record('Inspector.enable', async () => {
        if (noInspector) throw new Error("'Inspector.enable' wasn't found");
        if (noRenderer) events.emit('targetCrashed', {});
        return {};
      }),
    },
    Runtime: { enable: record('Runtime.enable', runtimeEnable), evaluate: record('Runtime.evaluate', evaluate) },
    Page: {
      enable: record('Page.enable', async () => ({})),
      getNavigationHistory: record('Page.getNavigationHistory', async () => ({
        currentIndex: 1,
        entries: [{ id: 10 }, { id: 11 }, { id: 12 }],
      })),
      navigateToHistoryEntry: record('Page.navigateToHistoryEntry', navigateToHistoryEntry),
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { client: client as unknown as CDP.Client, raw: client, calls, events };
}

describe('chromeReportsNoRenderer', () => {
  it('is true when Inspector.enable is preceded by Inspector.targetCrashed', async () => {
    const { client, events } = targetClient({ noRenderer: true });

    expect(await chromeReportsNoRenderer(client)).toBe(true);
    expect(events.listenerCount('targetCrashed')).toBe(0);
  });

  it('is false for a tab whose renderer is there', async () => {
    const { client, events } = targetClient();

    expect(await chromeReportsNoRenderer(client)).toBe(false);
    expect(events.listenerCount('targetCrashed')).toBe(0);
  });

  it('is false, rather than an error, in a browser without the Inspector domain', async () => {
    const { client, events } = targetClient({ noInspector: true });

    expect(await chromeReportsNoRenderer(client)).toBe(false);
    expect(events.listenerCount('targetCrashed')).toBe(0);
  });
});

describe('restoreDiscardedTab', () => {
  it('navigates to the history entry the tab was showing', async () => {
    const navigateToHistoryEntry = vi.fn().mockResolvedValue({});
    const { client } = targetClient({ noRenderer: true, navigateToHistoryEntry });

    await restoreDiscardedTab(client);

    expect(navigateToHistoryEntry).toHaveBeenCalledWith({ entryId: 11 });
  });
});

describe('enableTarget', () => {
  const attachNetwork = (calls: string[]) =>
    vi.fn(async () => {
      calls.push('Network attach');
      return true;
    });

  it('enables, and does not navigate a tab that has a renderer', async () => {
    const { client, calls } = targetClient();

    await enableTarget(client, attachNetwork(calls), false);

    expect(calls).toEqual(['Runtime.enable', 'Page.enable', 'Network attach']);
  });

  it('sends the enables before the reload, and waits for the reloaded page to answer them', async () => {
    // As on a discarded tab: Runtime.enable is answered only once the reload has given the tab a
    // renderer. Awaiting the enables before starting the reload would wait forever.
    let reloaded!: () => void;
    const rendererBack = new Promise<void>((resolve) => (reloaded = resolve));
    const navigateToHistoryEntry = vi.fn(async () => {
      reloaded();
      return {};
    });
    const { client, calls } = targetClient({
      noRenderer: true,
      runtimeEnable: vi.fn(() => rendererBack.then(() => ({}))),
      navigateToHistoryEntry,
    });

    await enableTarget(client, attachNetwork(calls), true);

    expect(calls).toEqual([
      'Runtime.enable',
      'Page.enable',
      'Network attach',
      'Page.getNavigationHistory',
      'Page.navigateToHistoryEntry',
    ]);
  });

  it('fails with the reload error, and leaves no unhandled rejection once the connection closes', async () => {
    let closeConnection!: (e: Error) => void;
    const unanswered = new Promise((_, reject) => (closeConnection = reject));
    const { client } = targetClient({
      noRenderer: true,
      runtimeEnable: vi.fn(() => unanswered),
      navigateToHistoryEntry: vi.fn().mockRejectedValue(new Error('No entry with passed id')),
    });

    await expect(enableTarget(client, vi.fn().mockResolvedValue(true), true)).rejects.toThrow(
      'No entry with passed id',
    );

    // What closing the connection does to every command still unanswered. vitest fails the run on an
    // unhandled rejection.
    closeConnection(new Error('WebSocket connection closed'));
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('probeVisible', () => {
  beforeEach(() => {
    vi.mocked(CDP).mockReset();
  });

  it('reports a tab with no renderer at once, without asking its renderer', async () => {
    const { client, raw, calls } = targetClient({ noRenderer: true, evaluate: vi.fn(neverAnswers) });
    vi.mocked(CDP).mockResolvedValue(client as any);

    expect(await probeVisible('tab-1')).toBe('no-renderer');
    expect(calls).toEqual(['Inspector.enable']);
    expect(raw.close).toHaveBeenCalled();
  });

  it('reports whether a tab that answers is showing on screen', async () => {
    const visible = targetClient({ evaluate: vi.fn().mockResolvedValue({ result: { value: true } }) });
    const hidden = targetClient({ evaluate: vi.fn().mockResolvedValue({ result: { value: false } }) });
    vi.mocked(CDP)
      .mockResolvedValueOnce(visible.client as any)
      .mockResolvedValueOnce(hidden.client as any);

    expect(await probeVisible('tab-1')).toBe(true);
    expect(await probeVisible('tab-2')).toBe(false);
  });

  it('still reports whether a tab is on screen in a browser without the Inspector domain', async () => {
    const { client } = targetClient({
      noInspector: true,
      evaluate: vi.fn().mockResolvedValue({ result: { value: true } }),
    });
    vi.mocked(CDP).mockResolvedValue(client as any);

    expect(await probeVisible('tab-1')).toBe(true);
  });

  it('reports a renderer that does not answer as undefined once TARGET_PROBE_TIMEOUT_MS has passed', async () => {
    const { client, raw } = targetClient({ evaluate: vi.fn(neverAnswers) });
    vi.mocked(CDP).mockResolvedValue(client as any);

    vi.useFakeTimers();
    try {
      const pending = probeVisible('tab-1');
      await vi.advanceTimersByTimeAsync(TARGET_PROBE_TIMEOUT_MS + 1);

      expect(await pending).toBeUndefined();
      expect(raw.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a tab it cannot connect to as undefined', async () => {
    vi.mocked(CDP).mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await probeVisible('tab-1')).toBeUndefined();
  });
});

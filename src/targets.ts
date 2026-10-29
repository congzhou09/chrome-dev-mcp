import CDP from 'chrome-remote-interface';
import { OWN_EXPRESSION, TARGET_PROBE_TIMEOUT_MS } from './constants.js';
import { TIMED_OUT, withTimeout } from './timeout.js';

export type PageTarget = { id: string; title: string; url: string };

// Every tab Chrome lists as a page, less DevTools windows, which are pages too.
export async function listPageTargets(): Promise<PageTarget[]> {
  const targets = (await CDP.List({ host: '127.0.0.1', port: 9222 })) as Array<PageTarget & { type: string }>;
  return targets
    .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    .map(({ id, title, url }) => ({ id, title, url }));
}

// Whether the tab is showing on screen: the selected tab of a window that is neither minimised
// nor fully covered, as `document.visibilityState` has it. undefined when the tab does not
// answer, which is a normal thing to find — Chrome is never assumed to start in a clean state.
//
// Each probe is a connection of its own, closed straight after, so it leaves nothing enabled
// behind. Measured, Chrome 156: ~25ms a tab; a frozen tab answers and stays frozen, and a tab
// paused at a `debugger` statement answers too.
export async function probeVisible(targetId: string): Promise<boolean | undefined> {
  const client = await CDP({ host: '127.0.0.1', port: 9222, target: targetId }).catch(() => null);
  if (!client) return undefined;
  try {
    // The websocket connects even for a wedged renderer, so getting this far proves nothing.
    const probe = await withTimeout(
      client.Runtime.evaluate({ expression: 'document.visibilityState === "visible"', ...OWN_EXPRESSION }),
      TARGET_PROBE_TIMEOUT_MS,
    ).catch((): typeof TIMED_OUT => TIMED_OUT);
    if (probe === TIMED_OUT) return undefined;
    return probe.result.value === true;
  } finally {
    // Closing is handled by the browser process, so it works even on a wedged target.
    await client.close().catch(() => {});
  }
}

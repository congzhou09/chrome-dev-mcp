import CDP from 'chrome-remote-interface';
import { OWN_EXPRESSION, TARGET_PROBE_TIMEOUT_MS } from './constants.js';
import { TIMED_OUT, withTimeout } from './timeout.js';

export type PageTarget = { id: string; title: string; url: string };

// What switchToTarget (index.ts) did. `noRenderer`: when the switch began, Chrome reported that the tab
// had no renderer (see chromeReportsNoRenderer), so connecting started by having Chrome reload its page
// (see restoreDiscardedTab). With a client, that reload worked. Without one, the reloaded page did not
// answer.
export type SwitchResult = { client: CDP.Client | null; noRenderer: boolean };

// Every tab Chrome lists as a page, less DevTools windows, which are pages too.
export async function listPageTargets(): Promise<PageTarget[]> {
  const targets = (await CDP.List({ host: '127.0.0.1', port: 9222 })) as Array<PageTarget & { type: string }>;
  return targets
    .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    .map(({ id, title, url }) => ({ id, title, url }));
}

// Whether Chrome reports that the target has no renderer process. A tab has none in two cases:
// - Chrome discarded it to free memory. Chrome reloads such a tab only once it is selected.
// - Its renderer crashed.
//
// Such a tab answers no command that its renderer would handle, Runtime.enable and Runtime.evaluate
// included. Connecting to it therefore takes the whole CONNECT_TIMEOUT_MS and then fails.
// Inspector.enable is handled by the browser process instead. On a target with no renderer, the
// browser process sends Inspector.targetCrashed before it answers Inspector.enable. Measured,
// Chrome 156, background tabs:
//
//   tab                                    Inspector.targetCrashed   Runtime.evaluate
//   discarded (chrome://discards)          sent, 0–6ms               no answer
//   renderer process killed                sent, 0ms                 no answer
//   blocked in a synchronous loop          not sent                  no answer
//   frozen, by Chrome or by CDP            not sent                  2–6ms
//   alive                                  not sent                  20ms
//
// The protocol does not promise the Inspector.targetCrashed column above. Inspector is an experimental
// domain, and its documentation does not say that Inspector.enable sends Inspector.targetCrashed.
// Chromium's Inspector.enable handler has sent that event since at least Chrome 55. From Chrome 158,
// Chromium's browser tests check that Inspector.enable sends Inspector.targetCrashed on a discarded tab
// and on a crashed one (InspectorEnableAfterDiscardByReplacement and InspectorEnableAfterCrash, in
// content/browser/devtools/protocol/devtools_protocol_browsertest.cc). Chrome 158 also stops sending
// the event for a page that has not navigated yet. Measured, Chrome 156: a new background tab had a
// renderer 150ms after Target.createTarget was sent, while the web server was still holding back the
// tab's first response. So that change affects at most a tab's first 150ms.
//
// A browser without the Inspector domain fails Inspector.enable and sends no Inspector.targetCrashed.
// A tab with no renderer is then handled like one that does not answer: connecting to it fails after
// CONNECT_TIMEOUT_MS, and probeVisible reports it as not answering.
//
// Discarding also changes the tab's targetId: the old id is no longer listed, and the tab is listed
// under a new id within 5ms of the discard. Chrome does not discard a tab that a CDP client is
// connected to, so the tab this server is connected to stays loaded. chrome://discards gives
// "Tab is currently using DevTools" as the reason, and an urgent discard leaves that tab loaded too.
export async function chromeReportsNoRenderer(client: CDP.Client): Promise<boolean> {
  let reported = false;
  const unsubscribe = client.Inspector.targetCrashed(() => {
    reported = true;
  });
  await client.Inspector.enable().catch(() => {});
  unsubscribe();
  return reported;
}

// Has Chrome reload a tab it discarded, the way Chrome does when the tab is selected: a history
// navigation to the entry the tab was showing. Both commands are handled by the browser process,
// so neither waits for a renderer. Measured, Chrome 156, a discarded background tab:
// - The tab loaded without being brought to the front, and kept its targetId.
// - Commands already sent to it, Runtime.enable among them, were answered 250–400ms later.
// - A page that a form's POST had loaded was not posted again. Page.reload did post it again,
//   without asking.
// The history navigation does not reload a tab whose renderer crashed: commands sent to that tab
// stayed unanswered for 10s.
export async function restoreDiscardedTab(client: CDP.Client): Promise<void> {
  const { currentIndex, entries } = await client.Page.getNavigationHistory();
  await client.Page.navigateToHistoryEntry({ entryId: entries[currentIndex].id });
}

// Enables what a connection needs on a target just connected to. With `restore`, the target has no
// renderer, and the enables are sent before restoreDiscardedTab starts the reload. They are answered
// once the reloaded page has a renderer. Measured, Chrome 156, switch_tab to a discarded tab: it
// returned after 286ms, and the network capture had every request of the reload, the document's
// included.
export async function enableTarget(
  client: CDP.Client,
  attachNetwork: (client: CDP.Client) => Promise<boolean>,
  restore: boolean,
): Promise<void> {
  const enabled = Promise.all([client.Runtime.enable(), client.Page.enable(), attachNetwork(client)]);
  // `enabled` is awaited below, unless restoreDiscardedTab throws first. In that case the caller
  // closes the connection, which rejects every command still unanswered, and this handler keeps
  // that rejection from going unhandled.
  enabled.catch(() => {});
  if (restore) await restoreDiscardedTab(client);
  await enabled;
}

// What a probe of one tab found:
// - true or false: the tab answered, and is or is not showing on screen.
// - 'no-renderer': Chrome reports that the tab has no renderer (see chromeReportsNoRenderer).
// - undefined: the tab did not answer.
export type TabProbe = boolean | 'no-renderer' | undefined;

// Whether the tab is showing on screen: the selected tab of a window that is neither minimised
// nor fully covered, as `document.visibilityState` has it. A tab that does not answer is a normal
// thing to find, since Chrome is never assumed to start in a clean state.
//
// Each probe is a connection of its own, closed straight after, so it leaves nothing enabled
// behind. Measured, Chrome 156: ~25ms a tab; a frozen tab answers and stays frozen, and a tab
// paused at a `debugger` statement answers too. A tab with no renderer is known at once, without
// waiting for TARGET_PROBE_TIMEOUT_MS.
export async function probeVisible(targetId: string): Promise<TabProbe> {
  const client = await CDP({ host: '127.0.0.1', port: 9222, target: targetId }).catch(() => null);
  if (!client) return undefined;
  try {
    // The websocket connects even for a wedged renderer, so getting this far proves nothing.
    const probe = await withTimeout(
      (async () => {
        if (await chromeReportsNoRenderer(client)) return 'no-renderer' as const;
        const { result } = await client.Runtime.evaluate({
          expression: 'document.visibilityState === "visible"',
          ...OWN_EXPRESSION,
        });
        return result.value === true;
      })(),
      TARGET_PROBE_TIMEOUT_MS,
    ).catch((): typeof TIMED_OUT => TIMED_OUT);
    return probe === TIMED_OUT ? undefined : probe;
  } finally {
    // Closing is handled by the browser process, so it works even on a wedged target.
    await client.close().catch(() => {});
  }
}

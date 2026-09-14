#!/usr/bin/env node
import CDP from 'chrome-remote-interface';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CONNECT_TIMEOUT_MS, TARGET_PROBE_TIMEOUT_MS, TRANSITION_WAIT_TIMEOUT_MS } from './constants.js';
import { createServer } from './server.js';

let cdpClient: CDP.Client | null = null;
let currentTargetId: string | null = null;

// Returned in place of the value when `promise` outlives `ms`.
//
// A sentinel rather than a rejection because "this target never answered" is an expected
// state to branch on here, not an error: a renderer paused at a breakpoint or spinning in a
// synchronous loop replies to nothing and rejects nothing. The loser of the race is
// abandoned, never awaited — if it does eventually settle, nothing is listening.
const TIMED_OUT = Symbol('timed-out');

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // Never hold the process open just to fire a timeout.
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
};

// Serialises every connection transition, and is also the shared promise that stops two
// callers from starting duplicate attempts.
//
// Serialising matters because a transition tears down `cdpClient` and builds a new one:
// two of them interleaving can leave a client that nobody holds a reference to but that is
// still open, with its Network listeners still feeding the one shared capture buffer —
// every request then lands in the buffer twice, and the duplicate that responseReceived
// does NOT update stays without status or headers forever.
let pending: Promise<CDP.Client | null> | null = null;

// Runs `work` after whatever transition is already in flight, never concurrently with it.
const queueTransition = (work: () => Promise<CDP.Client | null>): Promise<CDP.Client | null> => {
  const predecessor = pending;
  const run = (async () => {
    // A failed predecessor must not poison the queue; each transition reports its own errors.
    // Neither must a WEDGED one. Every transition is internally time-bounded, so this is a
    // backstop rather than the main defence — but an unbounded wait here is what turns one
    // stuck tab into a dead server: `pending` never clears, getClient() hands that same
    // parked promise to every caller, and every tool needing a client times out, while
    // browser-level tools like list_tabs carry on working and hide the cause.
    if (predecessor) {
      const settled = await withTimeout(
        predecessor.catch(() => null),
        TRANSITION_WAIT_TIMEOUT_MS,
      );
      if (settled === TIMED_OUT) {
        console.error('[chrome-dev-mcp] Previous connection transition is stuck — proceeding without it');
      }
    }
    return work();
  })();
  pending = run;
  // Only clear if nothing else has queued behind us in the meantime.
  const settle = () => {
    if (pending === run) pending = null;
  };
  run.then(settle, settle);
  return run;
};

// Created up here (not next to server.connect below) because connectToTarget needs
// attachNetwork, and connectToTarget can run before the transport is wired up.
const { server, attachNetwork } = createServer(getClient, switchToTarget, () => currentTargetId);

// Picks the visible tab, skipping any target whose renderer does not answer.
//
// The probe is bounded because an unresponsive target is a normal thing to find: Chrome is
// never assumed to start in a clean debugging state, and a tab already paused at a
// breakpoint answers no CDP command at all. Falling back to `pageTargets[0]`
// unconditionally would hand back exactly such a tab and move the hang one layer down, so
// the fallback is the first target that actually answered.
async function findActivePageTargetId(): Promise<string | undefined> {
  const targets = (await CDP.List({ host: '127.0.0.1', port: 9222 })) as Array<{
    id: string;
    type: string;
    url: string;
  }>;
  const pageTargets = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));

  let firstResponsive: string | undefined;

  for (const target of pageTargets) {
    const tempClient = await CDP({ host: '127.0.0.1', port: 9222, target: target.id }).catch(() => null);
    if (!tempClient) continue;
    try {
      // The websocket connects even for a wedged renderer, so getting this far proves nothing.
      const probe = await withTimeout(
        tempClient.Runtime.evaluate({ expression: 'document.visibilityState === "visible"' }),
        TARGET_PROBE_TIMEOUT_MS,
      ).catch((): typeof TIMED_OUT => TIMED_OUT);
      if (probe === TIMED_OUT) {
        console.error(`[chrome-dev-mcp] Target not responding, skipped: ${target.url}`);
        continue;
      }
      firstResponsive ??= target.id;
      if (probe.result.value === true) return target.id;
    } finally {
      // Closing is handled by the browser process, so it works even on a wedged target.
      await tempClient.close().catch(() => {});
    }
  }

  return firstResponsive;
}

async function connectToTarget(targetId: string): Promise<CDP.Client> {
  const client = await CDP({ host: '127.0.0.1', port: 9222, target: targetId });

  // Every enable below is a round-trip the renderer has to answer, and a wedged one answers
  // none of them — including a target named explicitly through switch_tab, which never went
  // through findActivePageTargetId's probe. Bounded as a group so a bad target fails the
  // connection instead of parking it forever.
  const ready = await withTimeout(
    (async () => {
      await client.Runtime.enable();
      await client.Page.enable();

      // Eager attach: Network.enable() does not replay history, so capture has to start at
      // connect time rather than on the first tool call. Cheap and side-effect-free, unlike
      // Debugger.enable() — which is why that one stays lazy. Never rejects.
      await attachNetwork(client);
    })(),
    CONNECT_TIMEOUT_MS,
  ).catch(async (e) => {
    await client.close().catch(() => {});
    throw e;
  });

  if (ready === TIMED_OUT) {
    // Leaving it open would keep a half-enabled client feeding the shared capture buffer.
    await client.close().catch(() => {});
    throw new Error(`target ${targetId} did not respond within ${CONNECT_TIMEOUT_MS}ms (renderer paused or busy?)`);
  }

  cdpClient = client;
  currentTargetId = targetId;
  console.error('[chrome-dev-mcp] Connected to Chrome');

  // Cleanup only: clear the reference so the next tool call triggers reconnect.
  // Debugger and network state reset happens in server.ts when it detects a new client.
  client.on('disconnect', () => {
    cdpClient = null;
    currentTargetId = null;
    console.error('[chrome-dev-mcp] Chrome disconnected — will reconnect on next tool call');
  });

  return client;
}

async function getClient(): Promise<CDP.Client | null> {
  if (cdpClient) return cdpClient;
  // Share whatever transition is in flight instead of racing it. If that is a switch_tab,
  // this call correctly ends up on the tab being switched to.
  if (pending) return pending;

  return queueTransition(async () => {
    try {
      const targetId = await findActivePageTargetId();
      if (targetId === undefined) {
        console.error('[chrome-dev-mcp] No responsive page target found in Chrome');
        return null;
      }
      return await connectToTarget(targetId);
    } catch (e) {
      console.error('[chrome-dev-mcp] Chrome unavailable:', (e as Error).message);
      return null;
    }
  });
}

async function switchToTarget(targetId: string): Promise<CDP.Client | null> {
  // Queued rather than run immediately: the eager connect from startup can still be in
  // flight with `cdpClient` not yet assigned, and closing before it lands would close
  // nothing and leave that client open on the old target.
  return queueTransition(async () => {
    // Already on this target: hand back the live client instead of rebuilding. A rebuild
    // would reset the network capture buffer and the debugger state for nothing, and it
    // would pull the client out from under a concurrent caller still using it. A client
    // that actually died is already null here — the 'disconnect' handler clears it.
    if (cdpClient && currentTargetId === targetId) return cdpClient;

    if (cdpClient) {
      await cdpClient.close().catch(() => {});
      cdpClient = null;
      // Cleared together with the client: a failed switch below must not leave a targetId
      // that list_tabs would still report as the active tab.
      currentTargetId = null;
    }
    try {
      return await connectToTarget(targetId);
    } catch (e) {
      console.error('[chrome-dev-mcp] Failed to switch to target:', (e as Error).message);
      return null;
    }
  });
}

// Start MCP transport before attempting Chrome connection so Claude Code
// can always reach the server even when Chrome is not yet running.
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[chrome-dev-mcp] MCP server ready');

// Eagerly attempt first connection; failure is non-fatal.
await getClient();

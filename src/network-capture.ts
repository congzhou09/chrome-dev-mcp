import CDP from 'chrome-remote-interface';
import {
  MAX_DISCARDED_REQUEST_IDS,
  MAX_NETWORK_REQUESTS,
  NETWORK_MAX_RESOURCE_BUFFER_SIZE,
  NETWORK_MAX_TOTAL_BUFFER_SIZE,
} from './constants.js';
import { formatInitiator, headersToObject } from './format.js';
import type { NetworkRecord } from './types.js';

export interface NetworkCapture {
  /**
   * Eager attach, called by index.ts at connect time. Never rejects.
   *
   * Resolves true when THIS call performed the attach, which also means the capture
   * buffer and the tombstone set were just reset. Callers turn that into a
   * "capture (re)started" explanation instead of reporting an empty buffer or an
   * unknown requestId.
   */
  attach(client: CDP.Client): Promise<boolean>;

  /** Chronological, one entry per redirect hop. */
  readonly requests: readonly NetworkRecord[];

  /** requestId → current (latest) hop */
  get(requestId: string): NetworkRecord | undefined;

  /** Tombstone lookup: true = really captured but its data is gone. Distinguishes
   *  "discarded" from "unknown id", which Chrome reports identically. */
  wasDiscarded(requestId: string): boolean;

  reset(): void;
}

export function createNetworkCapture(): NetworkCapture {
  // ── Network capture state ───────────────────────────────────────────────────
  // Owned exclusively by this module. Reset through reset() only — never from
  // InspectorSession.attach().
  const networkRequests: NetworkRecord[] = []; // chronological, circular
  const networkByRequestId = new Map<string, NetworkRecord>(); // requestId → current hop
  const discardedRequestIds = new Set<string>();

  // Network has its OWN identity flag because it attaches eagerly at connect time,
  // while the Debugger/Console listeners stay lazy.
  let networkRegisteredOnClient: CDP.Client | null = null;
  let networkAttachInFlight: Promise<void> = Promise.resolve();

  const reset = (): void => {
    networkRequests.length = 0;
    networkByRequestId.clear();
    discardedRequestIds.clear();
  };

  // Remember that this id was captured but its data is gone, so a later body fetch can
  // say "discarded" instead of "unknown id" — Chrome's error is identical for both.
  const noteDiscarded = (requestId: string): void => {
    discardedRequestIds.add(requestId);
    if (discardedRequestIds.size > MAX_DISCARDED_REQUEST_IDS) {
      // Set iterates in insertion order, so this drops the oldest.
      discardedRequestIds.delete(discardedRequestIds.values().next().value as string);
    }
  };

  const pushNetworkRecord = (record: NetworkRecord): void => {
    networkRequests.push(record);
    networkByRequestId.set(record.requestId, record);
    if (networkRequests.length > MAX_NETWORK_REQUESTS) {
      const dropped = networkRequests.shift()!;
      // Only orphan the map entry if this record was still the current hop.
      if (networkByRequestId.get(dropped.requestId) === dropped) {
        networkByRequestId.delete(dropped.requestId);
      }
      noteDiscarded(dropped.requestId);
    }
  };

  // All handlers here are intentionally synchronous — no source-map resolution, no body
  // fetches. Anything async would race with the events that follow it.
  const attachTo = async (client: CDP.Client): Promise<void> => {
    reset();

    client.Network.on('requestWillBeSent', (event: any) => {
      const prev = networkByRequestId.get(event.requestId);

      // A redirect re-fires requestWillBeSent with the SAME requestId, carrying the
      // response of the PREVIOUS hop. Close that hop out and start a new record.
      if (event.redirectResponse && prev) {
        prev.state = 'redirect';
        prev.status = event.redirectResponse.status;
        prev.statusText = event.redirectResponse.statusText || undefined;
        prev.mimeType = event.redirectResponse.mimeType || undefined;
        prev.responseHeaders = headersToObject(event.redirectResponse.headers);
        prev.redirectedTo =
          event.redirectResponse.headers?.location ?? event.redirectResponse.headers?.Location ?? event.documentURL;
        prev.durationMs = Number(((event.timestamp - prev.startMono) * 1000).toFixed(1));
      }

      pushNetworkRecord({
        requestId: event.requestId,
        loaderId: event.loaderId,
        hop: event.redirectResponse && prev ? prev.hop + 1 : 0,
        method: event.request?.method ?? 'GET',
        url: event.request?.url ?? '',
        resourceType: event.type ?? 'Other',
        requestHeaders: headersToObject(event.request?.headers),
        initiator: formatInitiator(event.initiator),
        startedAt: new Date((event.wallTime ?? Date.now() / 1000) * 1000).toISOString(),
        startMono: event.timestamp,
        state: 'pending',
      });
    });

    client.Network.on('responseReceived', (event: any) => {
      const record = networkByRequestId.get(event.requestId);
      if (!record) return;
      record.status = event.response?.status;
      record.statusText = event.response?.statusText || undefined;
      record.mimeType = event.response?.mimeType || undefined;
      record.responseHeaders = headersToObject(event.response?.headers);
      if (event.response?.fromDiskCache || event.response?.fromPrefetchCache) {
        record.fromCache = true;
      }
      // The type on responseReceived is more reliable than the one on requestWillBeSent.
      if (event.type) record.resourceType = event.type;
    });

    client.Network.on('requestServedFromCache', (event: any) => {
      const record = networkByRequestId.get(event.requestId);
      if (record) record.fromCache = true;
    });

    client.Network.on('loadingFinished', (event: any) => {
      const record = networkByRequestId.get(event.requestId);
      if (!record) return;
      record.state = 'complete';
      // encodedDataLength here is the full transferred size; the one on the response
      // object counts headers only.
      record.size = event.encodedDataLength;
      record.durationMs = Number(((event.timestamp - record.startMono) * 1000).toFixed(1));
    });

    client.Network.on('loadingFailed', (event: any) => {
      const record = networkByRequestId.get(event.requestId);
      if (!record) return;
      record.state = 'failed';
      record.errorText = event.errorText || event.blockedReason || 'unknown error';
      if (event.canceled) record.canceled = true;
      record.durationMs = Number(((event.timestamp - record.startMono) * 1000).toFixed(1));
    });

    // Prune the previous page on navigation, mirroring the DevTools Network panel default.
    //
    // A blanket clear would be wrong: Chrome reports requestWillBeSent for the new
    // document BEFORE it reports frameNavigated, so the document request the user most
    // wants after a reload would be the first thing deleted. Keeping the committed
    // loaderId's records preserves it.
    client.Page.on('frameNavigated', (event: any) => {
      const frame = event.frame;
      if (!frame || frame.parentId) return; // subframe — leave the buffer alone
      const keepLoaderId: string = frame.loaderId;
      for (let i = networkRequests.length - 1; i >= 0; i--) {
        if (networkRequests[i].loaderId === keepLoaderId) continue;
        const [dropped] = networkRequests.splice(i, 1);
        if (networkByRequestId.get(dropped.requestId) === dropped) {
          networkByRequestId.delete(dropped.requestId);
        }
        noteDiscarded(dropped.requestId);
      }
    });

    await client.Network.enable({
      maxTotalBufferSize: NETWORK_MAX_TOTAL_BUFFER_SIZE,
      maxResourceBufferSize: NETWORK_MAX_RESOURCE_BUFFER_SIZE,
    });
  };

  // Attached eagerly from index.ts at connect time, because Network.enable() does NOT
  // replay history the way Console.enable() does — anything before enable is lost
  // forever. Unlike Debugger.enable() it has no page-observable side effect (no JIT
  // deoptimisation) and no handshake to wait on, so paying for it on every connection
  // is cheap. Never rejects: a network failure must not fail the whole connection.
  const attach = async (client: CDP.Client): Promise<boolean> => {
    // Everything up to the await must stay synchronous: it is what makes a concurrent
    // caller see networkRegisteredOnClient already set and await the same attach instead
    // of starting a second one. Do not move the check or the assignment below the await.
    const alreadyAttached = networkRegisteredOnClient === client;
    if (!alreadyAttached) {
      networkRegisteredOnClient = client;
      networkAttachInFlight = attachTo(client).catch((e) => {
        console.error('[chrome-dev-mcp] Network capture unavailable:', (e as Error).message);
        // Allow a later call to retry rather than leaving the client marked as attached
        // with no listeners.
        if (networkRegisteredOnClient === client) networkRegisteredOnClient = null;
      });
    }
    await networkAttachInFlight;
    return !alreadyAttached;
  };

  return {
    attach,

    get requests() {
      return networkRequests;
    },

    get(requestId) {
      return networkByRequestId.get(requestId);
    },

    wasDiscarded(requestId) {
      return discardedRequestIds.has(requestId);
    },

    reset,
  };
}

export interface DebuggerState {
  paused: boolean;
  callFrames: any[];
  pauseReason: string;
  hitBreakpoints: string[];
}

export interface ConsoleEntry {
  /**
   * When this server received the entry — within a millisecond or two of the page printing
   * it. Absent on `before-connect` entries: Console.messageAdded carries no time of its own
   * (measured, Chrome 153 — the payload is source/level/text/line/column), so the only clock
   * reading available for the backlog Chrome replays at attach is the moment of the replay,
   * which is the same instant for every one of them and says nothing about when they
   * happened. They arrive in the order DevTools shows them.
   */
  timestamp?: string;
  type: string;
  text: string;
  /**
   * Which page load this came from, and only when that is not the one showing now — an
   * unmarked entry belongs to the page as it currently stands. `before-connect` is the
   * backlog Console.enable() replays at attach, which happened before this server could
   * see any navigation; `earlier-page-load` is a document since replaced by a reload or a
   * navigation, and stays that way however many loads ago it was.
   */
  from?: 'before-connect' | 'earlier-page-load';
  stackTrace?: Array<{
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  }>;
}

// One record per redirect hop. Chrome reuses a single requestId across a redirect
// chain, so `requestId` is NOT unique in the buffer — `hop` disambiguates.
export interface NetworkRecord {
  requestId: string;
  // Which document load this request belongs to. Used to prune the previous
  // page's requests on navigation while keeping the new document's own request,
  // which Chrome reports BEFORE it reports the navigation.
  loaderId: string;
  hop: number;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  initiator: string;
  startedAt: string;
  // Monotonic CDP timestamp (seconds); only used to compute durationMs.
  startMono: number;
  state: 'pending' | 'complete' | 'failed' | 'redirect';
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  fromCache?: boolean;
  redirectedTo?: string;
  size?: number;
  durationMs?: number;
  errorText?: string;
  canceled?: boolean;
}

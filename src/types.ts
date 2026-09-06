export interface DebuggerState {
  paused: boolean;
  callFrames: any[];
  pauseReason: string;
  hitBreakpoints: string[];
}

export interface ConsoleEntry {
  timestamp: string;
  type: string;
  text: string;
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

import { MAX_URL_LENGTH } from './constants.js';
import type { NetworkRecord } from './types.js';

// Long URLs are collapsed rather than silently cut: a truncated URL buried in a JSON
// record would otherwise be reported or re-fetched as if it were complete.
//
// `collapseLong` is off for single-request drill-downs (a `requestId` query,
// get_network_response_body), where the output is bounded to a handful of records and the
// tail of a long URL — a signed token, a GraphQL query in the querystring — is often the
// very thing under investigation. Nothing else can recover it: the record stores the full
// URL, but no tool returns it.
//
// data: URIs collapse in BOTH modes. Their length is unbounded (megabytes of inline
// base64) and their tail carries no diagnostic value, so the reason to collapse them has
// nothing to do with how many records are being returned.
export const formatUrl = (url: string, collapseLong = true): string => {
  if (url.startsWith('data:')) {
    return `${url.slice(0, 64)}… (data URI, ${url.length} chars)`;
  }
  if (collapseLong && url.length > MAX_URL_LENGTH) {
    return `${url.slice(0, MAX_URL_LENGTH)}… (+${url.length - MAX_URL_LENGTH} chars)`;
  }
  return url;
};

// The CDP initiator is a nested stack trace (callFrames plus a parent chain); only the
// topmost frame survives, as one string — the full tree on every record would dominate a
// 200-request response.
//
// The position is COMPILED, not source-mapped: resolving needs an await, and this runs in a
// capture handler that must stay synchronous. Deferring to return time would not help —
// the script registry is filled only by Debugger.scriptParsed, so it would take
// Debugger.enable().
export const formatInitiator = (initiator: any): string => {
  if (!initiator) return 'unknown';
  const type = initiator.type ?? 'unknown';
  const frame = initiator.stack?.callFrames?.[0];
  if (frame?.url) {
    return `${type} ${frame.url}:${(frame.lineNumber ?? 0) + 1}`.slice(0, 200);
  }
  if (initiator.url) {
    const line = initiator.lineNumber != null ? `:${initiator.lineNumber + 1}` : '';
    return `${type} ${initiator.url}${line}`.slice(0, 200);
  }
  return type;
};

export const headersToObject = (headers: any): Record<string, string> => {
  if (!headers || typeof headers !== 'object') return {};
  return { ...headers } as Record<string, string>;
};

const HEADER_WILDCARD = '*';

// Callers name the headers they want, the way get_computed_style takes `properties` —
// returning every header on every record is what makes a 200-record response unusable.
//
// Lookups normalise case because the casing Chrome reports depends on the protocol:
// HTTP/2 lowercases every name, HTTP/1.1 preserves whatever the origin sent. Output keys
// echo the caller's spelling so the response lines up with the request.
//
// Unlike get_computed_style, a header that is not present is OMITTED rather than returned
// as an empty string: an absent header and a header with an empty value are different
// things in HTTP, and conflating them would misreport the absent case.
const projectHeaders = (headers: Record<string, string> | undefined, keys: string[]): Record<string, string> => {
  if (!headers) return {};
  if (keys.includes(HEADER_WILDCARD)) return { ...headers };
  const byLowerName = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) byLowerName.set(name.toLowerCase(), value);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = byLowerName.get(key.toLowerCase());
    if (value !== undefined) out[key] = value;
  }
  return out;
};

// Projection for tool output. Every conditional field is omitted (not null) when absent,
// which is why the matching zod outputSchema marks them `.optional()`.
export const toOutputRecord = (r: NetworkRecord, headerKeys?: string[], collapseLongUrls = true) => ({
  requestId: r.requestId,
  method: r.method,
  url: formatUrl(r.url, collapseLongUrls),
  resourceType: r.resourceType,
  state: r.state,
  initiator: r.initiator,
  startedAt: r.startedAt,
  ...(r.hop > 0 ? { hop: r.hop } : {}),
  ...(r.status != null ? { status: r.status } : {}),
  ...(r.statusText ? { statusText: r.statusText } : {}),
  ...(r.mimeType ? { mimeType: r.mimeType } : {}),
  ...(r.size != null ? { size: r.size } : {}),
  ...(r.durationMs != null ? { durationMs: r.durationMs } : {}),
  ...(r.fromCache ? { fromCache: true } : {}),
  ...(r.redirectedTo ? { redirectedTo: formatUrl(r.redirectedTo, collapseLongUrls) } : {}),
  ...(r.errorText ? { errorText: r.errorText } : {}),
  ...(r.canceled ? { canceled: true } : {}),
  ...(headerKeys?.length
    ? {
        requestHeaders: projectHeaders(r.requestHeaders, headerKeys),
        responseHeaders: projectHeaders(r.responseHeaders, headerKeys),
      }
    : {}),
});

import { z } from 'zod';

export const NOT_CONNECTED = {
  content: [
    {
      type: 'text' as const,
      text: 'Chrome is not connected. Launch Chrome with:\n  --remote-debugging-port=9222 --user-data-dir=<path>\nThen try again.',
    },
  ],
  isError: true,
};

export const MAX_CONSOLE_LOGS = 500;
export const MAX_HTML_LENGTH = 20_000;

// Network traffic is far denser than console output — a single page load is routinely
// 100-500 requests. Unlike MAX_CONSOLE_LOGS, the buffer depth is deliberately NOT reused
// as the zod `.max()` on `limit`: 1000 records would be ~60-100k tokens in one response.
export const MAX_NETWORK_REQUESTS = 1000; // circular buffer depth
export const MAX_NETWORK_REQUESTS_PER_CALL = 200; // per-response cap — context budget, not buffer depth

// Chrome returns the same "No resource with given identifier found" error for an unknown
// requestId and for a body it has already discarded, so the error alone cannot tell them
// apart. These ids are the tombstone that makes the distinction possible: an id in here was
// really captured, so a failed body fetch means "discarded", not "never existed".
export const MAX_DISCARDED_REQUEST_IDS = 2000;

export const MAX_URL_LENGTH = 512;
export const MAX_RESPONSE_BODY_LENGTH = 50_000;

// Chrome retains response bodies in the renderer subject to these limits, and
// Network.getResponseBody can only read what is still retained. Generous values buy a
// wider window for on-demand body fetches; the memory cost lands in Chrome, not here.
export const NETWORK_MAX_TOTAL_BUFFER_SIZE = 100 * 1024 * 1024;
export const NETWORK_MAX_RESOURCE_BUFFER_SIZE = 10 * 1024 * 1024;

// Accepts any casing while keeping the exact enum in the advertised JSON Schema.
// A bare z.enum() rejects "xhr" during input validation — before any handler runs — and
// `XHR` being the only all-caps member of the CDP enum makes that a likely stumble.
export const caseInsensitiveEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (values.find((x) => x.toLowerCase() === v.toLowerCase()) ?? v) : v),
    z.enum(values),
  );

// CDP Network.ResourceType, verbatim.
export const RESOURCE_TYPES = [
  'Document',
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'TextTrack',
  'XHR',
  'Fetch',
  'Prefetch',
  'EventSource',
  'WebSocket',
  'Manifest',
  'SignedExchange',
  'Ping',
  'CSPViolationReport',
  'Preflight',
  'Other',
] as const;

import { z } from 'zod';
import { caseInsensitiveEnum, MAX_NETWORK_REQUESTS, MAX_NETWORK_REQUESTS_PER_CALL, MAX_RESPONSE_BODY_LENGTH, NETWORK_MAX_RESOURCE_BUFFER_SIZE, NETWORK_MAX_TOTAL_BUFFER_SIZE, NOT_CONNECTED, RESOURCE_TYPES, } from '../constants.js';
import { formatUrl, toOutputRecord } from '../format.js';
// ── Network tools ─────────────────────────────────────────────────────────────
export function registerNetworkTools(server, getClient, capture) {
    server.registerTool('get_network_requests', {
        description: 'Return HTTP requests captured from the connected tab — method, URL, resource type, status, transferred size, duration, initiator, and failure reason. ' +
            'Capture starts when this server connects to the tab: requests issued before that are NOT visible (unlike get_console_logs, which replays pre-connect history). ' +
            'Requests belonging to a previous page are pruned on navigation, mirroring the DevTools Network panel default; the new document request itself is kept. ' +
            'A redirect chain appears as one record per hop, sharing a requestId and distinguished by `hop`. ' +
            'WebSocket frames are not captured.',
        inputSchema: z.object({
            limit: z
                .number()
                .int()
                .min(1)
                .max(MAX_NETWORK_REQUESTS_PER_CALL)
                .default(50)
                .describe('Maximum number of most-recent requests to return'),
            requestId: z
                .string()
                .optional()
                .describe('Return only this request, including every hop of its redirect chain. Pair with headerKeys to inspect one request in full.'),
            urlFilter: z
                .string()
                .optional()
                .describe('Case-insensitive substring match on the full (untruncated) request URL'),
            resourceType: caseInsensitiveEnum(RESOURCE_TYPES)
                .optional()
                .describe('Filter by CDP resource type. Any casing is accepted.'),
            status: caseInsensitiveEnum(['2xx', '3xx', '4xx', '5xx', 'failed', 'pending'])
                .optional()
                .describe('Filter by response status class, or by outcome: `failed` = network error/blocked, `pending` = still in flight.'),
            headerKeys: z
                .array(z.string())
                .min(1)
                .optional()
                .describe('Return only these headers, matched case-insensitively, on both requestHeaders and responseHeaders. Omit to return no headers. Pass ["*"] for every header — that is bounded only by `limit`, so use it with `requestId` or a small limit.'),
            clear: z.boolean().default(false).describe('Clear the capture buffer after returning entries'),
        }),
        outputSchema: z.object({
            requests: z.array(z.object({
                requestId: z.string(),
                method: z.string(),
                url: z
                    .string()
                    .describe('data: URIs are always collapsed; in a bulk listing long URLs are truncated too. Both are marked with `…`, and a marked value is NOT a usable URL — query a single `requestId` to get long URLs in full. `urlFilter` always matches the full URL.'),
                resourceType: z
                    .string()
                    .describe('CDP resource type (Document, Script, XHR, …); same vocabulary as the `resourceType` filter'),
                state: z
                    .enum(['pending', 'complete', 'failed', 'redirect'])
                    .describe('Lifecycle of this hop: `pending` = no terminal event yet (stays pending forever if the page navigated away mid-flight), `complete` = loaded, `failed` = network error or blocked, `redirect` = returned 3xx and continued on the next hop.'),
                initiator: z
                    .string()
                    .describe('Flattened to "<type> <url>:<line>", or just the type when no location is known. Compiled position, not source-mapped; capped at 200 chars.'),
                startedAt: z.string().describe('ISO-8601 wall-clock time the request was sent'),
                hop: z.number().optional().describe('Redirect hop index; omitted for the first hop'),
                status: z
                    .number()
                    .optional()
                    .describe('HTTP status of this hop — the 3xx itself when state is `redirect`. Absent until a response arrives.'),
                statusText: z.string().optional().describe('Reason phrase; usually absent over HTTP/2+, which has none'),
                mimeType: z.string().optional(),
                size: z
                    .number()
                    .optional()
                    .describe('Transferred on-the-wire bytes (encodedDataLength) — compressed, not the decoded body size'),
                durationMs: z
                    .number()
                    .optional()
                    .describe('Milliseconds from request start until this hop was closed out — by loadingFinished, loadingFailed, or the next hop taking over on a redirect'),
                fromCache: z
                    .boolean()
                    .optional()
                    .describe('Served from Chrome cache rather than the network; `size` is then typically 0'),
                redirectedTo: z
                    .string()
                    .optional()
                    .describe('Redirect target from the `Location` header; same truncation rules as `url`'),
                errorText: z
                    .string()
                    .optional()
                    .describe('CDP failure or block reason (e.g. `net::ERR_ABORTED`); present only when state is `failed`'),
                canceled: z
                    .boolean()
                    .optional()
                    .describe('The failure was a cancellation (navigating away, an aborted fetch), not a genuine network error — usually not worth reporting as a problem'),
                requestHeaders: z
                    .record(z.string(), z.string())
                    .optional()
                    .describe('The headers named by `headerKeys`, keyed by your own spelling; absent when `headerKeys` is omitted. A requested header missing from this map was not sent; one present with an empty string WAS sent, with an empty value.'),
                responseHeaders: z
                    .record(z.string(), z.string())
                    .optional()
                    .describe('Same projection as `requestHeaders`; `{}` when no response arrived'),
            })),
        }),
        annotations: {
            title: 'Get network requests',
            readOnlyHint: true,
        },
    }, async ({ limit, requestId, urlFilter, resourceType, status, headerKeys, clear }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        // True when this call performed the attach, so an empty buffer can be explained
        // rather than looking like "no traffic".
        const reattached = await capture.attach(client);
        const needle = urlFilter?.toLowerCase();
        const wantedType = resourceType?.toLowerCase();
        const filtered = capture.requests.filter((r) => {
            if (requestId && r.requestId !== requestId)
                return false;
            if (needle && !r.url.toLowerCase().includes(needle))
                return false;
            if (wantedType && r.resourceType.toLowerCase() !== wantedType)
                return false;
            if (status) {
                if (status === 'failed')
                    return r.state === 'failed';
                if (status === 'pending')
                    return r.state === 'pending';
                if (r.status == null)
                    return false;
                if (Math.floor(r.status / 100) !== Number(status[0]))
                    return false;
            }
            return true;
        });
        // A requestId query is a drill-down: bounded output, so long URLs stay intact.
        const requests = filtered.slice(-limit).map((r) => toOutputRecord(r, headerKeys, requestId == null));
        // Mirrors get_console_logs: `clear` empties the whole buffer, not the filtered slice.
        if (clear)
            capture.reset();
        const emptyMessage = reattached
            ? 'Network capture (re)started for a new Chrome session — the previous buffer was discarded. Reload the page or re-trigger the requests, then call this tool again.'
            : capture.requests.length === 0
                ? 'No network requests captured yet. Capture began when this server connected to the tab — reload the page to collect its requests.'
                : 'No network requests match the given filters.';
        return {
            content: requests.length === 0
                ? [{ type: 'text', text: emptyMessage }]
                : [{ type: 'text', text: JSON.stringify(requests, null, 2) }],
            structuredContent: { requests },
        };
    });
    server.registerTool('get_network_response_body', {
        description: 'Fetch the response body for one requestId from get_network_requests. ' +
            'Bodies are never buffered by this server — they are read from Chrome on demand, and Chrome discards them on navigation or when its own buffer limits are exceeded, so fetch promptly and before navigating away. ' +
            'Chrome stores at most one body per requestId, so for a redirect chain only the final hop has a body. ' +
            'Returns a JSON metadata block, then the body as a separate text block — kept separate so a large body is not JSON-escaped. ' +
            'Metadata carries requestId, base64Encoded, byteLength and method/url/status/mimeType, the last four replaced by a `note` when the capture buffer no longer holds the request, plus `truncated: true` when the body was cut at ' +
            `${MAX_RESPONSE_BODY_LENGTH} characters. ` +
            'A binary body is never returned: metadata carries `omitted` and there is no second content block.',
        inputSchema: z.object({
            requestId: z.string(),
        }),
        annotations: {
            title: 'Get network response body',
            readOnlyHint: true,
        },
    }, async ({ requestId }) => {
        const client = await getClient();
        if (!client)
            return NOT_CONNECTED;
        // True when this call performed the attach, which resets the capture buffer AND the
        // tombstone set — otherwise a perfectly valid id from the previous session would be
        // reported as invented.
        const reattached = await capture.attach(client);
        const record = capture.get(requestId);
        // Answer from our own record where it already settles the question, so we don't
        // report a confusing CDP error for a request that simply has no body yet.
        if (record?.state === 'pending') {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Request ${requestId} has not finished loading yet (no loadingFinished event). Retry in a moment.`,
                    },
                ],
                isError: true,
            };
        }
        if (record?.state === 'failed') {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Request ${requestId} failed (${record.errorText ?? 'unknown error'}); no response body is available.`,
                    },
                ],
                isError: true,
            };
        }
        let body;
        let base64Encoded;
        try {
            const result = await client.Network.getResponseBody({ requestId });
            body = result.body;
            base64Encoded = result.base64Encoded;
        }
        catch (e) {
            const message = e.message ?? '';
            // Chrome's message is identical for "unknown id" and "already discarded", so the
            // tombstone set is what lets us tell the user which one actually happened.
            if (!record) {
                const text = reattached
                    ? `Network capture (re)started for a new Chrome session, discarding every request captured before it — ${requestId} belonged to the previous session and is not invalid. Re-trigger the request, then fetch the body under its new requestId.`
                    : capture.wasDiscarded(requestId)
                        ? `Request ${requestId} was captured but its data has been discarded (page navigation, or the capture buffer overflowed). Re-trigger the request and fetch its body before navigating.`
                        : `Unknown requestId ${requestId}. It is not in the capture buffer (last ${MAX_NETWORK_REQUESTS} requests, pruned on navigation) and Chrome has no data for it. Call get_network_requests for current requestIds.`;
                return { content: [{ type: 'text', text }], isError: true };
            }
            const text = /evicted/i.test(message)
                ? `Response body for ${requestId} was discarded by Chrome (exceeded its network buffer limits — ${Math.round(NETWORK_MAX_TOTAL_BUFFER_SIZE / 1024 / 1024)} MB total / ${Math.round(NETWORK_MAX_RESOURCE_BUFFER_SIZE / 1024 / 1024)} MB per resource). Fetch bodies promptly after a request completes.`
                : `Chrome has no body for ${requestId} (status ${record.status ?? 'unknown'}${record.state === 'redirect' ? ', redirect hop' : ''}). The response may have had no body, or be a resource Chrome does not buffer. CDP said: ${message}`;
            return { content: [{ type: 'text', text }], isError: true };
        }
        const meta = {
            requestId,
            ...(record
                ? {
                    method: record.method,
                    url: formatUrl(record.url, false),
                    status: record.status,
                    mimeType: record.mimeType,
                }
                : { note: 'Metadata for this request was evicted from the capture buffer; body came from Chrome.' }),
            base64Encoded,
            byteLength: body.length,
        };
        // Dumping base64 image/font data into an agent's context is pure waste.
        if (base64Encoded && !/^text\/|json|xml|javascript|ecmascript/i.test(record?.mimeType ?? '')) {
            meta.omitted = 'binary body not returned';
            return { content: [{ type: 'text', text: JSON.stringify(meta, null, 2) }] };
        }
        const truncated = body.length > MAX_RESPONSE_BODY_LENGTH;
        if (truncated)
            meta.truncated = true;
        return {
            content: [
                { type: 'text', text: JSON.stringify(meta, null, 2) },
                { type: 'text', text: truncated ? body.slice(0, MAX_RESPONSE_BODY_LENGTH) : body },
            ],
        };
    });
}

import { describe, it, expect } from 'vitest';
import { captureOne, fireCdp, makeMockClient, sentEvent, setupMcpClient, setupServer } from '../test-helpers.js';

describe('get_network_requests', () => {
  it('returns an empty-state message before any requests are captured', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    expect((result.content as any)[0].text).toMatch(/No network requests captured yet/);
    expect(result.structuredContent).toEqual({ requests: [] });
  });

  it('passes large buffer sizes to Network.enable', async () => {
    const cdpClient = makeMockClient();
    const { attachNetwork } = await setupServer(cdpClient);

    await attachNetwork(cdpClient);

    expect((cdpClient as any).Network.enable).toHaveBeenCalledWith({
      maxTotalBufferSize: 104857600,
      maxResourceBufferSize: 10485760,
    });
  });

  it('registers listeners only once per client', async () => {
    const cdpClient = makeMockClient();
    const { attachNetwork } = await setupServer(cdpClient);

    await attachNetwork(cdpClient);
    await attachNetwork(cdpClient);

    expect((cdpClient as any).Network.enable).toHaveBeenCalledTimes(1);
  });

  it('captures a completed request with method, status, size, and duration', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: 'req-1',
      method: 'GET',
      url: 'https://api.example.com/users',
      resourceType: 'XHR',
      state: 'complete',
      status: 200,
      mimeType: 'application/json',
      size: 1234,
      durationMs: 250,
      initiator: 'script https://app/main.js:42',
    });
  });

  it('marks in-flight requests as pending', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests[0].state).toBe('pending');
    expect(requests[0].status).toBeUndefined();
  });

  it('records failure details from loadingFailed', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());
    fireCdp(cdpClient, 'Network', 'loadingFailed', {
      requestId: 'req-1',
      timestamp: 100.1,
      errorText: 'net::ERR_CONNECTION_REFUSED',
      canceled: false,
    });

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests[0]).toMatchObject({
      state: 'failed',
      errorText: 'net::ERR_CONNECTION_REFUSED',
    });
  });

  it('keeps each redirect hop as a separate record', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ request: { method: 'GET', url: 'https://example.com/old', headers: {} } }),
    );
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({
        timestamp: 100.05,
        request: { method: 'GET', url: 'https://example.com/new', headers: {} },
        redirectResponse: {
          status: 301,
          statusText: 'Moved Permanently',
          mimeType: 'text/html',
          headers: { location: 'https://example.com/new' },
        },
      }),
    );

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      state: 'redirect',
      status: 301,
      redirectedTo: 'https://example.com/new',
    });
    expect(requests[0].hop).toBeUndefined();
    expect(requests[1]).toMatchObject({ hop: 1, state: 'pending', url: 'https://example.com/new' });
  });

  it('prunes requests from the previous loader on main-frame navigation', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'old-1', loaderId: 'loader-1' }));
    // Chrome reports the new document's request BEFORE it reports the navigation.
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ requestId: 'new-1', loaderId: 'loader-2', type: 'Document' }),
    );
    fireCdp(cdpClient, 'Page', 'frameNavigated', {
      frame: { id: 'f1', loaderId: 'loader-2', url: 'https://example.com/' },
    });

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(1);
    expect(requests[0].requestId).toBe('new-1');
  });

  it('ignores navigation of a subframe', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());
    fireCdp(cdpClient, 'Page', 'frameNavigated', {
      frame: { id: 'f2', parentId: 'f1', loaderId: 'loader-9', url: 'https://ads/' },
    });

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    expect((result.structuredContent as any).requests).toHaveLength(1);
  });

  it('filters by resourceType case-insensitively', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'x-1', type: 'XHR' }));
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'i-1', type: 'Image' }));

    const exact = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { resourceType: 'XHR' },
    });
    // A bare z.enum would reject this during input validation, before the handler runs.
    const lower = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { resourceType: 'xhr' },
    });

    for (const result of [exact, lower]) {
      const { requests } = result.structuredContent as any;
      expect(requests).toHaveLength(1);
      expect(requests[0].requestId).toBe('x-1');
    }
  });

  it('accepts any casing for the status filter', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());
    fireCdp(cdpClient, 'Network', 'loadingFailed', {
      requestId: 'req-1',
      timestamp: 100.1,
      errorText: 'net::ERR_FAILED',
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { status: 'FAILED' },
    });

    expect((result.structuredContent as any).requests).toHaveLength(1);
  });

  it('filters by status class', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'req-2' }));
    fireCdp(cdpClient, 'Network', 'responseReceived', {
      requestId: 'req-2',
      type: 'XHR',
      response: { status: 404, mimeType: 'text/html', headers: {} },
    });
    fireCdp(cdpClient, 'Network', 'loadingFinished', {
      requestId: 'req-2',
      timestamp: 100.1,
      encodedDataLength: 10,
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { status: '4xx' },
    });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe(404);
  });

  it('filters by url substring', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({
        requestId: 'a',
        request: { method: 'GET', url: 'https://api.example.com/users', headers: {} },
      }),
    );
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({
        requestId: 'b',
        request: { method: 'GET', url: 'https://cdn.example.com/logo.png', headers: {} },
      }),
    );

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { urlFilter: 'CDN' },
    });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(1);
    expect(requests[0].requestId).toBe('b');
  });

  it('omits headers unless headerKeys is given', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const record = (result.structuredContent as any).requests[0];
    expect(record.requestHeaders).toBeUndefined();
    expect(record.responseHeaders).toBeUndefined();
  });

  // The fixtures deliver lowercase header names, the way HTTP/2 does. Asking for canonical
  // casing proves the lookup normalises AND that output keys echo the caller's spelling.
  it('projects only the named headers, matched case-insensitively', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork, {
      request: {
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: { accept: 'application/json', authorization: 'Bearer tok' },
      },
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { headerKeys: ['Accept', 'Content-Type'] },
    });

    const record = (result.structuredContent as any).requests[0];
    // toEqual, not toMatchObject: the unnamed `authorization` must be absent, and a named
    // header the message never carried must be omitted rather than returned as an empty string.
    expect(record.requestHeaders).toEqual({ Accept: 'application/json' });
    expect(record.responseHeaders).toEqual({ 'Content-Type': 'application/json' });
  });

  // The schema promises that a missing key means "not sent" while an empty-string value means
  // "sent, but empty". Both halves are asserted together because the distinction is the point:
  // a truthy check inside projectHeaders would collapse them, and nothing else would notice.
  it('keeps a header sent with an empty value, distinct from an absent one', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork, {
      request: {
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: { 'x-empty': '' },
      },
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { headerKeys: ['X-Empty', 'X-Missing'] },
    });

    const record = (result.structuredContent as any).requests[0];
    expect(record.requestHeaders).toEqual({ 'X-Empty': '' });
    expect(record.responseHeaders).toEqual({});
  });

  it('returns every header for headerKeys ["*"]', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork, {
      request: {
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: { accept: 'application/json', authorization: 'Bearer tok' },
      },
    });

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { headerKeys: ['*'] },
    });

    const record = (result.structuredContent as any).requests[0];
    expect(record.requestHeaders).toEqual({ accept: 'application/json', authorization: 'Bearer tok' });
    expect(record.responseHeaders).toEqual({ 'content-type': 'application/json' });
  });

  it('filters to one request by requestId, keeping every redirect hop', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: 'other-1' }));
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ request: { method: 'GET', url: 'https://example.com/old', headers: {} } }),
    );
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({
        timestamp: 100.05,
        request: { method: 'GET', url: 'https://example.com/new', headers: {} },
        redirectResponse: {
          status: 301,
          statusText: 'Moved Permanently',
          mimeType: 'text/html',
          headers: { location: 'https://example.com/new' },
        },
      }),
    );

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { requestId: 'req-1' },
    });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(2);
    expect(requests.every((r: any) => r.requestId === 'req-1')).toBe(true);
    expect(requests[0].hop).toBeUndefined();
    expect(requests[1].hop).toBe(1);
  });

  it('collapses long data URIs in the url field', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    const dataUri = 'data:image/png;base64,' + 'A'.repeat(5000);
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ type: 'Image', request: { method: 'GET', url: dataUri, headers: {} } }),
    );

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    const { requests } = result.structuredContent as any;
    expect(requests[0].url).toMatch(/^data:image\/png;base64,A+… \(data URI, 5022 chars\)$/);
  });

  it('returns a long url in full when filtered to one requestId', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    const longUrl = 'https://example.com/' + 'q'.repeat(600) + '/tail';
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ request: { method: 'GET', url: longUrl, headers: {} } }),
    );

    const bulk = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });
    const single = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { requestId: 'req-1' },
    });

    const bulkUrl = (bulk.structuredContent as any).requests[0].url;
    expect(bulkUrl).toContain('… (+');
    expect(bulkUrl.length).toBeLessThan(longUrl.length);
    expect((single.structuredContent as any).requests[0].url).toBe(longUrl);
  });

  // The reason to collapse a data URI is its unbounded length and uninformative tail.
  // Neither changes when only one record comes back, so this stays collapsed either way.
  it('still collapses a data URI when filtered to one requestId', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    const dataUri = 'data:image/png;base64,' + 'A'.repeat(5000);
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ type: 'Image', request: { method: 'GET', url: dataUri, headers: {} } }),
    );

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { requestId: 'req-1' },
    });

    expect((result.structuredContent as any).requests[0].url).toContain('(data URI, 5022 chars)');
  });

  it('matches filters against the full url, not the truncated one', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    const longUrl = 'https://example.com/' + 'q'.repeat(600) + '/needle';
    fireCdp(
      cdpClient,
      'Network',
      'requestWillBeSent',
      sentEvent({ request: { method: 'GET', url: longUrl, headers: {} } }),
    );

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { urlFilter: 'needle' },
    });

    expect((result.structuredContent as any).requests).toHaveLength(1);
  });

  it('evicts the oldest record beyond the buffer cap', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    for (let i = 0; i < 1001; i++) {
      fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: `r-${i}` }));
    }

    const result = await mcpClient.callTool({
      name: 'get_network_requests',
      arguments: { limit: 200 },
    });

    const { requests } = result.structuredContent as any;
    expect(requests).toHaveLength(200);
    expect(requests[requests.length - 1].requestId).toBe('r-1000');
    expect(requests.some((r: any) => r.requestId === 'r-0')).toBe(false);
  });

  it('does not lose captured requests when the debugger attaches later', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    // ensureDebuggerEvents runs its own reset block here; it must not touch the
    // network buffer, which has been filling since connect.
    await mcpClient.callTool({ name: 'get_debugger_state', arguments: {} });

    const result = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });
    expect((result.structuredContent as any).requests).toHaveLength(1);
  });

  it('returns not-connected message with isError when Chrome is unavailable', async () => {
    const client = await setupMcpClient(null);

    const result = await client.callTool({ name: 'get_network_requests', arguments: {} });

    expect((result.content as any)[0].text).toMatch(/Chrome is not connected/);
    expect(result.isError).toBe(true);
  });
});

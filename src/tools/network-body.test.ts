import { describe, it, expect, vi } from 'vitest';
import CDP from 'chrome-remote-interface';
import { captureOne, fireCdp, makeMockClient, sentEvent, setupMcpClient, setupServer } from '../test-helpers.js';

describe('get_network_response_body', () => {
  // A reconnect resets the tombstone set too, so without the reattached check this valid
  // id would be reported as "Unknown requestId" — telling the model it invented the id.
  it('blames the reconnect, not the requestId, after the client is swapped', async () => {
    const first = makeMockClient();
    const second = makeMockClient(
      undefined,
      undefined,
      {},
      {
        getResponseBody: vi.fn().mockRejectedValue(new Error('No resource with given identifier found')),
      },
    );
    let current: CDP.Client = first;
    const { mcpClient, attachNetwork } = await setupServer(() => current);
    await captureOne(first, attachNetwork);

    current = second;

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    const text = (result.content as any)[0].text;
    expect(result.isError).toBe(true);
    expect(text).toContain('new Chrome session');
    expect(text).not.toContain('Unknown requestId');
  });

  it('returns the body with metadata for a completed request', async () => {
    const getResponseBody = vi.fn().mockResolvedValue({ body: '{"ok":true}', base64Encoded: false });
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect(getResponseBody).toHaveBeenCalledWith({ requestId: 'req-1' });
    const meta = JSON.parse((result.content as any)[0].text);
    expect(meta).toMatchObject({ requestId: 'req-1', status: 200, byteLength: 11 });
    // Single-request tool, so the metadata url is not length-truncated either.
    expect(meta.url).toBe('https://api.example.com/users');
    expect((result.content as any)[1].text).toBe('{"ok":true}');
  });

  it('truncates bodies over the limit', async () => {
    const getResponseBody = vi.fn().mockResolvedValue({ body: 'x'.repeat(60000), base64Encoded: false });
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect(JSON.parse((result.content as any)[0].text).truncated).toBe(true);
    expect((result.content as any)[1].text).toHaveLength(50000);
  });

  it('reports an evicted body specifically', async () => {
    const getResponseBody = vi.fn().mockRejectedValue(new Error('Request content was evicted from inspector cache'));
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/discarded by Chrome/);
    expect(result.isError).toBe(true);
  });

  it('reports that a captured request was discarded by navigation', async () => {
    const getResponseBody = vi.fn().mockRejectedValue(new Error('No resource with given identifier found'));
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);
    fireCdp(cdpClient, 'Page', 'frameNavigated', {
      frame: { id: 'f1', loaderId: 'loader-2', url: 'https://example.com/' },
    });

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/was captured but its data has been discarded/);
    expect(result.isError).toBe(true);
  });

  it('reports a buffer-evicted request as discarded, not unknown', async () => {
    const getResponseBody = vi.fn().mockRejectedValue(new Error('No resource with given identifier found'));
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    for (let i = 0; i < 1001; i++) {
      fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: `r-${i}` }));
    }

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'r-0' },
    });

    expect((result.content as any)[0].text).toMatch(/was captured but its data has been discarded/);
    expect(result.isError).toBe(true);
  });

  it('reports a cleared request as discarded, not unknown', async () => {
    const getResponseBody = vi.fn().mockRejectedValue(new Error('No resource with given identifier found'));
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);
    await mcpClient.callTool({ name: 'clear_captures', arguments: { targets: ['network'] } });

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/was captured but its data has been discarded/);
    expect((result.content as any)[0].text).not.toContain('Unknown requestId');
    expect(result.isError).toBe(true);
  });

  it('still returns a body Chrome kept after the record was evicted', async () => {
    const getResponseBody = vi.fn().mockResolvedValue({ body: 'late but present', base64Encoded: false });
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    for (let i = 0; i < 1001; i++) {
      fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ requestId: `r-${i}` }));
    }

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'r-0' },
    });

    expect(JSON.parse((result.content as any)[0].text).note).toMatch(/evicted from the capture buffer/);
    expect((result.content as any)[1].text).toBe('late but present');
    expect(result.isError).toBeFalsy();
  });

  it('returns an unknown-requestId error for an id never seen', async () => {
    const getResponseBody = vi.fn().mockRejectedValue(new Error('No resource with given identifier found'));
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'nope' },
    });

    expect((result.content as any)[0].text).toMatch(/Unknown requestId nope/);
    expect(result.isError).toBe(true);
  });

  it('reports that the request is still loading', async () => {
    const getResponseBody = vi.fn();
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/has not finished loading yet/);
    expect(getResponseBody).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('surfaces a failed request without calling getResponseBody', async () => {
    const getResponseBody = vi.fn();
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent());
    fireCdp(cdpClient, 'Network', 'loadingFailed', {
      requestId: 'req-1',
      timestamp: 100.1,
      errorText: 'net::ERR_ABORTED',
    });

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/failed \(net::ERR_ABORTED\)/);
    expect(getResponseBody).not.toHaveBeenCalled();
  });

  it('does not return binary bodies', async () => {
    const getResponseBody = vi.fn().mockResolvedValue({ body: 'iVBORw0KGgo=', base64Encoded: true });
    const cdpClient = makeMockClient(undefined, undefined, {}, { getResponseBody });
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await attachNetwork(cdpClient);
    fireCdp(cdpClient, 'Network', 'requestWillBeSent', sentEvent({ type: 'Image' }));
    fireCdp(cdpClient, 'Network', 'responseReceived', {
      requestId: 'req-1',
      type: 'Image',
      response: { status: 200, mimeType: 'image/png', headers: {} },
    });
    fireCdp(cdpClient, 'Network', 'loadingFinished', {
      requestId: 'req-1',
      timestamp: 100.2,
      encodedDataLength: 900,
    });

    const result = await mcpClient.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect(result.content).toHaveLength(1);
    expect(JSON.parse((result.content as any)[0].text).omitted).toBe('binary body not returned');
  });

  it('returns not-connected message with isError when Chrome is unavailable', async () => {
    const client = await setupMcpClient(null);

    const result = await client.callTool({
      name: 'get_network_response_body',
      arguments: { requestId: 'req-1' },
    });

    expect((result.content as any)[0].text).toMatch(/Chrome is not connected/);
    expect(result.isError).toBe(true);
  });
});

describe('clear_captures', () => {
  it('clears the network buffer and reports how many records went', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const cleared = await mcpClient.callTool({ name: 'clear_captures', arguments: {} });
    const after = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    expect((cleared.structuredContent as any).cleared).toEqual({ console: 0, network: 1 });
    expect((after.structuredContent as any).requests).toHaveLength(0);
  });

  it('touches only the targets it was given', async () => {
    const cdpClient = makeMockClient();
    const { mcpClient, attachNetwork } = await setupServer(cdpClient);
    await captureOne(cdpClient, attachNetwork);

    const result = await mcpClient.callTool({
      name: 'clear_captures',
      arguments: { targets: ['console'] },
    });
    const after = await mcpClient.callTool({ name: 'get_network_requests', arguments: {} });

    expect((result.structuredContent as any).cleared).toEqual({ console: 0 });
    expect((after.structuredContent as any).requests).toHaveLength(1);
  });

  it('works without a connected tab', async () => {
    const mcpClient = await setupMcpClient(null);

    const result = await mcpClient.callTool({ name: 'clear_captures', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as any).cleared).toEqual({ console: 0, network: 0 });
  });
});

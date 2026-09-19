import { describe, it, expect, vi } from 'vitest';
import CDP from 'chrome-remote-interface';
import { makeMockClient, setupMcpClient } from '../test-helpers.js';

describe('list_tabs', () => {
  it('returns available tabs filtered by type and excluding devtools://', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce([
      { id: 'tab-1', type: 'page', title: 'My App', url: 'http://localhost:3000/' },
      { id: 'tab-2', type: 'page', title: 'About', url: 'http://localhost:3000/about' },
      { id: 'tab-3', type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/devtools_app.html' },
      { id: 'tab-4', type: 'service_worker', title: '', url: 'http://localhost:3000/sw.js' },
    ]);
    const mcpClient = await setupMcpClient(null);

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    const { tabs } = result.structuredContent as any;
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t: any) => t.targetId === 'tab-1')).toEqual({
      targetId: 'tab-1',
      title: 'My App',
      url: 'http://localhost:3000/',
      active: false,
    });
    expect(tabs.find((t: any) => t.targetId === 'tab-2')).toEqual({
      targetId: 'tab-2',
      title: 'About',
      url: 'http://localhost:3000/about',
      active: false,
    });

    vi.restoreAllMocks();
  });

  it('marks the currently connected tab with active: true', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce([
      { id: 'tab-1', type: 'page', title: 'My App', url: 'http://localhost:3000/' },
      { id: 'tab-2', type: 'page', title: 'About', url: 'http://localhost:3000/about' },
    ]);
    const mcpClient = await setupMcpClient(null, vi.fn(), () => 'tab-1');

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    const { tabs } = result.structuredContent as any;
    expect(tabs.find((t: any) => t.targetId === 'tab-1')).toMatchObject({ active: true });
    expect(tabs.find((t: any) => t.targetId === 'tab-2')).toMatchObject({ active: false });

    vi.restoreAllMocks();
  });

  it('returns not-connected with isError when Chrome is unavailable', async () => {
    vi.spyOn(CDP, 'List' as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const mcpClient = await setupMcpClient(null);

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    expect((result.content as any)[0].text).toMatch(/Chrome is not connected/);
    expect(result.isError).toBe(true);

    vi.restoreAllMocks();
  });
});

describe('switch_tab', () => {
  it('calls switchToTarget and returns new tab info', async () => {
    const newClient = makeMockClient(
      vi.fn().mockResolvedValue({ result: { value: { title: 'My App', url: 'http://localhost:3000/' } } }),
    );
    const switchToTarget = vi.fn().mockResolvedValue(newClient);
    const mcpClient = await setupMcpClient(null, switchToTarget);

    const result = await mcpClient.callTool({ name: 'switch_tab', arguments: { targetId: 'tab-1' } });

    expect(switchToTarget).toHaveBeenCalledWith('tab-1');
    expect((result.content as any)[0].text).toBe('Switched to: My App — http://localhost:3000/');
    expect(result.structuredContent).toEqual({ targetId: 'tab-1', title: 'My App', url: 'http://localhost:3000/' });
  });

  it('returns error message when target is not found', async () => {
    const switchToTarget = vi.fn().mockResolvedValue(null);
    const mcpClient = await setupMcpClient(null, switchToTarget);

    const result = await mcpClient.callTool({ name: 'switch_tab', arguments: { targetId: 'nonexistent' } });

    expect((result.content as any)[0].text).toMatch(/Failed to connect/);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import CDP from 'chrome-remote-interface';
import { makeMockClient, setupMcpClient } from '../test-helpers.js';
import { probeVisible } from '../targets.js';

// The probe opens a real connection per tab; listing stays real so CDP.List can be stubbed.
vi.mock('../targets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../targets.js')>()),
  probeVisible: vi.fn(),
}));

const TWO_TABS = [
  { id: 'tab-1', type: 'page', title: 'My App', url: 'http://localhost:3000/' },
  { id: 'tab-2', type: 'page', title: 'About', url: 'http://localhost:3000/about' },
];

// Visibility by targetId; a tab left out does not answer.
const visibility = (byId: Record<string, boolean>) =>
  vi.mocked(probeVisible).mockImplementation(async (id) => byId[id]);

describe('list_tabs', () => {
  beforeEach(() => {
    vi.mocked(probeVisible).mockReset();
  });

  it('returns available tabs filtered by type and excluding devtools://', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce([
      ...TWO_TABS,
      { id: 'tab-3', type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/devtools_app.html' },
      { id: 'tab-4', type: 'service_worker', title: '', url: 'http://localhost:3000/sw.js' },
    ]);
    visibility({ 'tab-1': false, 'tab-2': false });
    const mcpClient = await setupMcpClient(null);

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    const { tabs } = result.structuredContent as any;
    expect(tabs).toEqual([
      { targetId: 'tab-1', title: 'My App', url: 'http://localhost:3000/', active: false, connected: false },
      { targetId: 'tab-2', title: 'About', url: 'http://localhost:3000/about', active: false, connected: false },
    ]);
    expect(vi.mocked(probeVisible).mock.calls.map(([id]) => id)).toEqual(['tab-1', 'tab-2']);

    vi.restoreAllMocks();
  });

  it('tells the tab on screen apart from the one this server is connected to', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce(TWO_TABS);
    visibility({ 'tab-1': false, 'tab-2': true });
    const mcpClient = await setupMcpClient(null, vi.fn(), () => 'tab-1');

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    const { tabs } = result.structuredContent as any;
    expect(tabs.find((t: any) => t.targetId === 'tab-1')).toMatchObject({ active: false, connected: true });
    expect(tabs.find((t: any) => t.targetId === 'tab-2')).toMatchObject({ active: true, connected: false });

    vi.restoreAllMocks();
  });

  it('leaves active out for a tab that does not answer, rather than reporting it hidden', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce(TWO_TABS);
    visibility({ 'tab-2': false });
    const mcpClient = await setupMcpClient(null, vi.fn(), () => 'tab-1');

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    const { tabs } = result.structuredContent as any;
    expect(tabs[0]).toEqual({ targetId: 'tab-1', title: 'My App', url: 'http://localhost:3000/', connected: true });
    expect(tabs[1]).toMatchObject({ active: false });

    vi.restoreAllMocks();
  });

  it('marks a tab in each visible window active', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce(TWO_TABS);
    visibility({ 'tab-1': true, 'tab-2': true });
    const mcpClient = await setupMcpClient(null);

    const result = await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    const { tabs } = result.structuredContent as any;
    expect(tabs.map((t: any) => t.active)).toEqual([true, true]);

    vi.restoreAllMocks();
  });

  it('probes every tab at once, so the slowest bounds the call rather than the sum', async () => {
    vi.spyOn(CDP, 'List' as any).mockResolvedValueOnce(TWO_TABS);
    let inFlight = 0;
    let peak = 0;
    vi.mocked(probeVisible).mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return false;
    });
    const mcpClient = await setupMcpClient(null);

    await mcpClient.callTool({ name: 'list_tabs', arguments: {} });

    expect(peak).toBe(2);

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

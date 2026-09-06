import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NOT_CONNECTED } from '../constants.js';
import type { InspectorSession } from '../inspector-session.js';

// ── Tab management tools ──────────────────────────────────────────────────────

export function registerTabTools(
  server: McpServer,
  deps: {
    switchToTarget: (targetId: string) => Promise<CDP.Client | null>;
    getCurrentTargetId: () => string | null;
    session: InspectorSession;
  },
): void {
  const { switchToTarget, getCurrentTargetId, session } = deps;

  server.registerTool(
    'list_tabs',
    {
      description:
        'List all open Chrome page tabs with their targetIds, titles, and URLs. When you are unsure which tab to inspect, call this proactively to discover available tabs, then present the list to the user and ask which one to switch to — do NOT tell the user to switch tabs manually in Chrome.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        tabs: z.array(
          z.object({
            targetId: z.string(),
            title: z.string(),
            url: z.string(),
            active: z.boolean().describe('True if this tab is the current MCP target'),
          }),
        ),
      }),
      annotations: {
        title: 'List tabs',
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        const targets = (await CDP.List({ host: '127.0.0.1', port: 9222 })) as Array<{
          id: string;
          type: string;
          title: string;
          url: string;
        }>;
        const activeId = getCurrentTargetId();
        const tabs = targets
          .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
          .map((t) => ({
            targetId: t.id,
            title: t.title,
            url: t.url,
            active: t.id === activeId,
          }));
        return {
          content: [{ type: 'text', text: JSON.stringify(tabs, null, 2) }],
          structuredContent: { tabs },
        };
      } catch {
        return NOT_CONNECTED;
      }
    },
  );

  server.registerTool(
    'switch_tab',
    {
      description:
        'Switch the MCP connection to a specific Chrome tab. Use list_tabs first to get available targetIds.',
      inputSchema: z.object({
        targetId: z.string().describe('Target ID from list_tabs'),
      }),
      outputSchema: z.object({
        targetId: z.string(),
        title: z.string(),
        url: z.string(),
      }),
      annotations: {
        title: 'Switch tab',
      },
    },
    async ({ targetId }) => {
      const client = await switchToTarget(targetId);
      if (!client) {
        return {
          content: [
            { type: 'text', text: `Failed to connect to tab ${targetId}. Use list_tabs to check available targets.` },
          ],
          isError: true,
        };
      }
      await session.attach(client);
      const result = await client.Runtime.evaluate({
        expression: '({ title: document.title, url: location.href })',
        returnByValue: true,
      });
      const { title, url } = result.result.value as { title: string; url: string };
      return {
        content: [{ type: 'text', text: `Switched to: ${title} — ${url}` }],
        structuredContent: { targetId, title, url },
      };
    },
  );
}

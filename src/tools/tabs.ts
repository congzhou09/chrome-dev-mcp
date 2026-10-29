import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  NOT_CONNECTED,
  OWN_EXPRESSION,
  PAGE_COMMAND_TIMEOUT_MS,
  attachTimedOut,
  rendererTimedOut,
} from '../constants.js';
import { TIMED_OUT, withTimeout } from '../timeout.js';
import { type PageTarget, listPageTargets, probeVisible } from '../targets.js';
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
        'List open Chrome page tabs with their targetIds, titles and URLs. ' +
        '`active` marks a tab showing on screen — the selected tab of a window that is not minimised or fully covered, ' +
        'so several windows mean several — and is absent if the tab did not answer. `connected` marks the tab this ' +
        'server acts on; selecting another tab in Chrome does not change it, only switch_tab does.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        tabs: z.array(
          z.object({
            targetId: z.string(),
            title: z.string(),
            url: z.string(),
            active: z.boolean().optional(),
            connected: z.boolean(),
          }),
        ),
      }),
      annotations: {
        title: 'List tabs',
        readOnlyHint: true,
      },
    },
    async () => {
      let pages: PageTarget[];
      try {
        pages = await listPageTargets();
      } catch {
        return NOT_CONNECTED;
      }
      const connectedId = getCurrentTargetId();
      // All at once, so that however many tabs fail to answer, the call waits one
      // TARGET_PROBE_TIMEOUT_MS at most rather than one per tab.
      const visible = await Promise.all(pages.map((t) => probeVisible(t.id)));
      const tabs = pages.map((t, i) => ({
        targetId: t.id,
        title: t.title,
        url: t.url,
        ...(visible[i] !== undefined && { active: visible[i] }),
        connected: t.id === connectedId,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(tabs, null, 2) }],
        structuredContent: { tabs },
      };
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

      // The attach and the title read are both bounded: reporting the switch is not worth parking
      // the call. A fresh connect has just proved the target answers, so a hang here usually means
      // it wedged in between; staying on the current tab proves nothing, and it may already be stuck.
      if (!(await session.attach(client))) {
        return attachTimedOut(`switch_tab (connected to ${targetId}, but still attaching to it)`);
      }
      const result = await withTimeout(
        client.Runtime.evaluate({
          expression: '({ title: document.title, url: location.href })',
          returnByValue: true,
          ...OWN_EXPRESSION,
        }),
        PAGE_COMMAND_TIMEOUT_MS,
      );
      if (result === TIMED_OUT) return rendererTimedOut(`switch_tab (connected to ${targetId}, but reading its title)`);
      const { title, url } = result.result.value as { title: string; url: string };
      return {
        content: [{ type: 'text', text: `Switched to: ${title} — ${url}` }],
        structuredContent: { targetId, title, url },
      };
    },
  );
}

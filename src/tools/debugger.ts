import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NOT_CONNECTED } from '../constants.js';
import type { InspectorSession } from '../inspector-session.js';

// ── Debugger tools ────────────────────────────────────────────────────────────

export function registerDebuggerTools(
  server: McpServer,
  getClient: () => Promise<CDP.Client | null>,
  session: InspectorSession,
): void {
  server.registerTool(
    'get_debugger_state',
    {
      description:
        'Get current debugger state: whether execution is paused, the pause reason, hit breakpoints, and the full call stack with file/line info.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        paused: z.boolean(),
        reason: z
          .string()
          .optional()
          .describe('Pause reason (e.g. "breakpoint", "exception"). Present only when paused.'),
        hitBreakpoints: z.array(z.string()).optional().describe('IDs of breakpoints hit. Present only when paused.'),
        callStack: z
          .array(
            z.object({
              index: z.number(),
              functionName: z.string(),
              url: z.string(),
              lineNumber: z.number(),
              columnNumber: z.number(),
              compiledUrl: z.string().optional(),
              compiledLine: z.number().optional(),
              scopeTypes: z.array(z.string()),
            }),
          )
          .optional()
          .describe('Source-mapped positions when available. Present only when paused.'),
      }),
      annotations: {
        title: 'Get debugger state',
        readOnlyHint: true,
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await session.attach(client);

      if (!session.state.paused) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ paused: false }, null, 2) }],
          structuredContent: { paused: false },
        };
      }
      const callStack = await session.formatCallStack();
      const state = {
        paused: true,
        reason: session.state.pauseReason,
        hitBreakpoints: session.state.hitBreakpoints,
        callStack,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(state, null, 2) }],
        structuredContent: state,
      };
    },
  );

  server.registerTool(
    'get_scope_variables',
    {
      description:
        'Inspect variable values in a call frame scope. Only works when execution is paused. Use get_debugger_state first to find available frame indices.',
      inputSchema: z.object({
        frameIndex: z.number().default(0).describe('Call frame index (0 = top frame)'),
        scopeType: z
          .enum(['local', 'closure', 'block', 'global', 'script', 'module'])
          .default('local')
          .describe('Scope type to inspect'),
      }),
      outputSchema: z.object({
        variables: z.array(
          z.object({
            name: z.string(),
            type: z.string().optional(),
            value: z.unknown().optional(),
            preview: z.string().optional(),
          }),
        ),
      }),
      annotations: {
        title: 'Get scope variables',
        readOnlyHint: true,
      },
    },
    async ({ frameIndex, scopeType }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await session.attach(client);

      if (!session.state.paused) {
        return { content: [{ type: 'text', text: 'Debugger is not paused.' }], isError: true };
      }
      const frame = session.state.callFrames[frameIndex];
      if (!frame) {
        return { content: [{ type: 'text', text: `No call frame at index ${frameIndex}.` }], isError: true };
      }
      const scope = (frame.scopeChain ?? []).find((s: any) => s.type === scopeType);
      if (!scope) {
        const available = (frame.scopeChain ?? []).map((s: any) => s.type).join(', ');
        return {
          content: [{ type: 'text', text: `No "${scopeType}" scope in frame ${frameIndex}. Available: ${available}` }],
          isError: true,
        };
      }
      const props = await client.Runtime.getProperties({
        objectId: scope.object.objectId,
        ownProperties: true,
        generatePreview: true,
      });
      const variables = (props.result ?? [])
        .filter((p: any) => !p.name.startsWith('__'))
        .map((p: any) => ({
          name: p.name,
          type: p.value?.type,
          value: p.value?.value ?? p.value?.description,
          preview: p.value?.preview?.description,
        }));
      return {
        content: [{ type: 'text', text: JSON.stringify(variables, null, 2) }],
        structuredContent: { variables },
      };
    },
  );

  server.registerTool(
    'set_breakpoint',
    {
      description: 'Set a breakpoint by URL (exact or regex) + line number.',
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe('Exact script URL. Provide this or urlRegex; if both, urlRegex takes precedence.'),
        lineNumber: z.number().int().min(1).describe('Line number (1-indexed)'),
        columnNumber: z.number().int().min(1).optional().describe('Column number, 1-indexed (optional)'),
        condition: z.string().optional().describe('JS expression; breakpoint triggers only when truthy'),
        urlRegex: z
          .string()
          .optional()
          .describe('URL regex pattern. Provide this or url; if both, urlRegex takes precedence.'),
      }),
      outputSchema: z.object({
        breakpointId: z.string(),
        resolvedLocations: z
          .array(
            z.object({
              scriptId: z.string(),
              lineNumber: z.number(),
              columnNumber: z.number().optional(),
            }),
          )
          .describe(
            'May be empty if the script is not loaded yet; the breakpoint will bind automatically when Chrome parses the script',
          ),
      }),
      annotations: {
        title: 'Set breakpoint',
        idempotentHint: true,
      },
    },
    async ({ url, lineNumber, columnNumber, condition, urlRegex }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      if (!url && !urlRegex) {
        return {
          content: [{ type: 'text', text: 'Must provide either url or urlRegex.' }],
          isError: true,
        };
      }
      await session.attach(client);

      const params: {
        lineNumber: number;
        columnNumber?: number;
        condition?: string;
        url?: string;
        urlRegex?: string;
      } = {
        lineNumber: lineNumber - 1,
        ...(columnNumber !== undefined && { columnNumber: columnNumber - 1 }),
        ...(condition && { condition }),
        ...(urlRegex ? { urlRegex } : { url }),
      };
      const result = await client.Debugger.setBreakpointByUrl(params);
      const label = `${urlRegex ?? url}:${lineNumber}`;
      session.addBreakpoint(result.breakpointId, label);
      const data = { breakpointId: result.breakpointId, resolvedLocations: result.locations };
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    },
  );

  server.registerTool(
    'remove_breakpoint',
    {
      description:
        'Remove a breakpoint by ID. The ID is invalidated; use set_breakpoint to restore (returns a new ID).',
      inputSchema: z.object({ breakpointId: z.string() }),
      annotations: {
        title: 'Remove breakpoint',
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ breakpointId }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await session.attach(client);
      try {
        await client.Debugger.removeBreakpoint({ breakpointId });
      } finally {
        session.removeBreakpoint(breakpointId);
      }
      return { content: [{ type: 'text', text: `Removed breakpoint ${breakpointId}.` }] };
    },
  );

  server.registerTool(
    'list_breakpoints',
    {
      description:
        'List breakpoints tracked by this server (set via `set_breakpoint`). Breakpoints set outside this server (DevTools UI, other CDP clients, prior sessions) are not visible — CDP has no API to enumerate them.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        breakpoints: z.array(
          z.object({
            breakpointId: z.string(),
            location: z.string().describe('Human-readable "url:line" label'),
          }),
        ),
      }),
      annotations: {
        title: 'List breakpoints',
        readOnlyHint: true,
      },
    },
    async () => {
      const breakpoints = Array.from(session.breakpoints.entries()).map(([id, label]) => ({
        breakpointId: id,
        location: label,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(breakpoints, null, 2) }],
        structuredContent: { breakpoints },
      };
    },
  );

  server.registerTool(
    'pause_execution',
    {
      description:
        'Pause JavaScript execution immediately. After pausing, use get_debugger_state to inspect the call stack.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Pause execution',
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await session.attach(client);
      await client.Debugger.pause();
      return {
        content: [
          { type: 'text', text: 'Pause command sent. Call get_debugger_state to inspect the current position.' },
        ],
      };
    },
  );

  server.registerTool(
    'resume_execution',
    {
      description: 'Resume JavaScript execution after a breakpoint or pause.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Resume execution',
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await session.attach(client);
      await client.Debugger.resume({});
      return { content: [{ type: 'text', text: 'Execution resumed.' }] };
    },
  );

  server.registerTool(
    'step_over',
    {
      description:
        'Execute the current line and pause at the next line (does not enter function calls). Returns the new call stack position.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Step over',
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await session.attach(client);
      if (!session.state.paused) {
        return { content: [{ type: 'text', text: 'Not paused. Cannot step.' }], isError: true };
      }
      const pausePromise = session.waitForNextPause(client);
      await client.Debugger.stepOver({});
      const paused = await pausePromise;
      if (!paused) {
        return {
          content: [{ type: 'text', text: 'Stepped over — execution did not pause again (no more breakpoints).' }],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { paused: true, reason: session.state.pauseReason, callStack: await session.formatCallStack() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'step_into',
    {
      description: 'Step into the function call on the current line. Returns the new call stack position.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Step into',
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await session.attach(client);
      if (!session.state.paused) {
        return { content: [{ type: 'text', text: 'Not paused. Cannot step.' }], isError: true };
      }
      const pausePromise = session.waitForNextPause(client);
      await client.Debugger.stepInto({});
      const paused = await pausePromise;
      if (!paused) {
        return { content: [{ type: 'text', text: 'Stepped into — execution did not pause again.' }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { paused: true, reason: session.state.pauseReason, callStack: await session.formatCallStack() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'evaluate_at_frame',
    {
      description:
        'Evaluate a JavaScript expression in the scope of a paused call frame. Unlike evaluate_js, this has access to local variables, closure variables, and the current `this`. Only works when execution is paused.',
      inputSchema: z.object({
        expression: z.string().describe('JS expression to evaluate'),
        frameIndex: z
          .number()
          .default(0)
          .describe('Call frame index (0 = top frame); use get_debugger_state to find available frames'),
      }),
      annotations: {
        title: 'Evaluate at frame',
      },
    },
    async ({ expression, frameIndex }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await session.attach(client);

      if (!session.state.paused) {
        return {
          content: [{ type: 'text', text: 'Debugger is not paused. Use evaluate_js for global-scope evaluation.' }],
          isError: true,
        };
      }
      const frame = session.state.callFrames[frameIndex];
      if (!frame) {
        return { content: [{ type: 'text', text: `No call frame at index ${frameIndex}.` }], isError: true };
      }

      const result = await client.Debugger.evaluateOnCallFrame({
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: false,
        generatePreview: true,
      });

      if (result.exceptionDetails) {
        const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }

      const r = result.result;
      let text: string;
      if (r.value !== undefined) {
        text = JSON.stringify(r.value, null, 2);
      } else if (r.preview) {
        const props = (r.preview.properties ?? []).map((p: any) => `  ${p.name}: ${p.value}`).join(',\n');
        text = `${r.preview.description ?? r.type} {\n${props}\n}`;
      } else {
        text = r.description ?? r.type ?? 'undefined';
      }
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'step_out',
    {
      description: 'Step out of the current function and pause at the caller. Returns the new call stack position.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Step out',
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      await session.attach(client);
      if (!session.state.paused) {
        return { content: [{ type: 'text', text: 'Not paused. Cannot step.' }], isError: true };
      }
      const pausePromise = session.waitForNextPause(client);
      await client.Debugger.stepOut();
      const paused = await pausePromise;
      if (!paused) {
        return { content: [{ type: 'text', text: 'Stepped out — execution did not pause again.' }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { paused: true, reason: session.state.pauseReason, callStack: await session.formatCallStack() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

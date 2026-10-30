import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  NOT_CONNECTED,
  PAGE_COMMAND_TIMEOUT_MS,
  PAUSE_WAIT_TIMEOUT_MS,
  STEP_WAIT_TIMEOUT_MS,
  attachTimedOut,
  rendererTimedOut,
} from '../constants.js';
import { releaseRemoteObject, renderRemoteObject } from '../remote-object.js';
import { TIMED_OUT, withTimeout } from '../timeout.js';
import type { InspectorSession } from '../inspector-session.js';
import type { SourceLookup } from '../sourcemap.js';

const toolError = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

// Shared with the navigation tools, which report the same drops after a reload.
export const droppedBreakpointsSchema = z
  .array(z.object({ breakpointId: z.string(), location: z.string(), reason: z.string() }))
  .optional()
  .describe('Breakpoints set by `source` whose file has changed since: removed, and reported here once.');

// Why a named file could not be placed, worded for what the caller can do next.
const sourceNotPlaced = (source: string, line: number, lookup: Extract<SourceLookup, { found: false }>): string => {
  const list = (names: string[]) =>
    names.slice(0, 10).join(', ') + (names.length > 10 ? `, … (${names.length} in all)` : '');
  if (lookup.reason === 'ambiguous') {
    return `Error: "${source}" matches ${lookup.candidates.length} loaded files: ${list(lookup.candidates)}. Pass more of the path.`;
  }
  if (lookup.reason === 'no-code') {
    return `Error: ${lookup.candidates[0]} has no code at or after line ${line}.`;
  }
  if (lookup.candidates.length) {
    return (
      `Error: no loaded file matches "${source}" by directory and name. Loaded files with that name: ` +
      `${list(lookup.candidates)} — pass the path of the one you mean.`
    );
  }
  return (
    `Error: no loaded script has "${source}" — its code has not loaded yet (a route or chunk loaded on ` +
    'demand), or it is not part of this page. Load it, then set the breakpoint.'
  );
};

// attachTimedOut advises a retry once the page responds, which is no help to a pause: by then the
// loop is over, and a loop that never ends leaves the page unresponsive until the tab is reloaded
// or reopened. Only a debugger enabled before a loop began can stop it — Debugger.enable sent
// during one is not answered until it ends (see InspectorSession.attach), and Debugger.pause is
// refused without it ("Debugger agent is not enabled"). Hence the advice: a debugger tool call,
// which attaches or finds the attach done, then the hang. Measured, Chrome 156: with the debugger
// already enabled, a pause sent into a 3s loop was answered in 3ms and landed in 6ms.
const pauseAttachTimedOut = () => {
  const result = rendererTimedOut(
    'pause_execution (attaching the debugger)',
    'blocked in a synchronous loop, or blocked on a modal dialog',
  );
  result.content[0].text +=
    ' A loop can be paused only by a debugger attached before it started. Once the page responds again — for a ' +
    'loop that never ends, once the tab has been reloaded or reopened — call any debugger tool, such as ' +
    'get_debugger_state, before reproducing the hang; pause_execution can then stop it.';
  return result;
};

// A step tool's answer when its step has not paused within STEP_WAIT_TIMEOUT_MS. Not an error: the
// step is still in effect. Measured, Chrome 156, one case at a time:
//
// - Past the end of the code that was running, the next Runtime.evaluate paused on its own first
//   statement. One with `disableBreaks` did not, and the step stayed in effect after it.
//   Debugger.resume fails ("Can only perform operation while paused"), and the step stays in effect
//   after the failed resume too. A reload or a navigation drops the step.
// - Over an `await`, the step paused on the statement after it once the promise settled. A 100ms
//   interval ran meanwhile, and its callback did not pause.
// - In an endless loop, Debugger.pause was answered in 2ms and paused inside the loop in 5ms. A
//   reload then loaded the page in 18ms.
// - Over alert(), the step command was answered in 2ms. Once the dialog was closed, the step paused
//   at the next statement.
const STEP_NOT_PAUSED =
  `The step has not paused within ${STEP_WAIT_TIMEOUT_MS / 1000}s, but it is still in effect. Execution is in one ` +
  'of four states:\n' +
  '- Past the end of the code that was running, such as an event handler: the step pauses in the next script ' +
  'that runs, including an evaluate_js expression. Only a reload or a navigation cancels it.\n' +
  '- Waiting at an `await`: the step pauses once the awaited promise settles.\n' +
  '- In a long or endless loop: the page does not respond. pause_execution pauses inside the loop, and ' +
  'reload_tab then ends the loop.\n' +
  '- Blocked by an alert, confirm or prompt dialog: the page does not respond until the dialog is closed in the ' +
  'browser.\n' +
  'get_debugger_state shows whether the step has paused.';

// ── Debugger tools ────────────────────────────────────────────────────────────

export function registerDebuggerTools(
  server: McpServer,
  getClient: () => Promise<CDP.Client | null>,
  session: InspectorSession,
): void {
  // Chrome names the breakpoint it hit by its own id; the caller holds the one set_breakpoint
  // returned, a single id even for a file it placed in several scripts.
  const hitBreakpoints = () => [...new Set(session.state.hitBreakpoints.map((id) => session.breakpointIdFor(id)))];

  // Where execution stopped, for the tools that wait for a pause of their own: pause_execution
  // and the step tools. A step over a function call stops at any breakpoint inside that call,
  // not at the next statement. Chrome then gives the reason as "ambiguous" (measured, Chrome 156),
  // so the result names the breakpoint.
  const reportPause = async () => {
    const hit = hitBreakpoints();
    const data = {
      paused: true,
      reason: session.state.pauseReason,
      ...(hit.length > 0 && { hitBreakpoints: hit }),
      callStack: await session.formatCallStack(),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  };

  // The step tools differ only in the command they send. Each waits for the pause its step causes.
  // When no pause comes, the answer lists the possible reasons.
  const step = async (tool: string, send: (client: CDP.Client) => Promise<unknown>) => {
    const client = await getClient();
    if (!client) return NOT_CONNECTED;
    if (!(await session.attach(client))) return attachTimedOut(tool);
    if (!session.state.paused) return toolError('Not paused. Cannot step.');
    const landed = session.waitForNextPause(client, STEP_WAIT_TIMEOUT_MS);
    await send(client);
    if (await landed) return reportPause();
    return { content: [{ type: 'text' as const, text: STEP_NOT_PAUSED }] };
  };

  server.registerTool(
    'get_debugger_state',
    {
      description:
        'Get current debugger state: whether execution is paused, the pause reason, hit breakpoints, and the full call stack with file/line info.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        paused: z.boolean(),
        // Measured, Chrome 156: every breakpoint, this server's or DevTools', arrives as "other".
        reason: z
          .string()
          .optional()
          .describe('Pause reason (e.g. "other" for a breakpoint, "step", "exception"). Present only when paused.'),
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
              compiledColumn: z.number().optional(),
              scopeTypes: z.array(z.string()),
            }),
          )
          .optional()
          .describe('Source-mapped positions when available. Present only when paused.'),
        note: z.string().optional(),
        droppedBreakpoints: droppedBreakpointsSchema,
      }),
      annotations: {
        title: 'Get debugger state',
        readOnlyHint: true,
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      if (!(await session.attach(client))) return attachTimedOut('get_debugger_state');

      // A hot update applies without any navigation, so this is where a breakpoint it dropped
      // is most likely to be noticed — typically while checking why a pause never came.
      await session.settleSourceChecks();
      const dropped = session.takeDroppedBreakpoints();
      const droppedPart = dropped.length ? { droppedBreakpoints: dropped } : {};

      if (!session.state.paused) {
        const state = { paused: false, ...droppedPart };
        return {
          content: [{ type: 'text', text: JSON.stringify(state, null, 2) }],
          structuredContent: state,
        };
      }
      const callStack = await session.formatCallStack();
      const note = session.droppedHitNote();
      const state = {
        paused: true,
        reason: session.state.pauseReason,
        hitBreakpoints: hitBreakpoints(),
        callStack,
        ...(note && { note }),
        ...droppedPart,
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
      if (!(await session.attach(client))) return attachTimedOut('get_scope_variables');

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
      // The bound is not about the pause: a renderer halted at a breakpoint still services CDP,
      // and answering this is exactly what it is halted for. Nor is it about getters — measured,
      // Chrome 141, against an object whose getter busy-loops for 3000ms:
      //
      //   Runtime.getProperties + generatePreview      7ms   getter returned as an accessor
      //   Runtime.callFunctionOn + returnByValue    3005ms   getter INVOKED, 'GETTER_RAN' came back
      //
      // which is the same split DevTools renders as `(...)`, and it puts the hazard that
      // EVAL_DEEP_VALUE_TIMEOUT_MS exists for in remote-object.ts rather than in this call.
      //
      // What does scale here is width — own properties, previews generated for each:
      //
      //     1,000 properties      165ms
      //   100,000 properties   22,579ms
      //
      // A scope is the first of those; a fat global is a couple of thousand entries, so 10s is
      // ample for anything real. It is still the thinnest margin under PAGE_COMMAND_TIMEOUT_MS —
      // a pathological object outruns the bound where no document can — which is worth knowing
      // before widening what this tool fetches.
      const props = await withTimeout(
        client.Runtime.getProperties({
          objectId: scope.object.objectId,
          ownProperties: true,
          generatePreview: true,
        }),
        PAGE_COMMAND_TIMEOUT_MS,
      );
      if (props === TIMED_OUT) {
        return rendererTimedOut(
          'get_scope_variables',
          'running again after the pause was read, wedged since, or holding a scope wide enough that ' +
            'previewing it outruns the bound',
        );
      }
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
      description:
        'Set a breakpoint at a 1-based line (and column) of a file. Name the file with `source` — a path like ' +
        '"src/App.tsx", or the `url` of a frame get_debugger_state or get_console_logs reported. Either way the ' +
        'position is mapped through source maps into the code Chrome runs, so that code must already be loaded. ' +
        '`url`/`urlRegex` instead take a position in the script exactly as Chrome loads it, so a source-mapped ' +
        "position given to them lands on the wrong line or never binds; use a frame's " +
        '`compiledUrl`/`compiledLine`/`compiledColumn`. The script need not be loaded yet: an empty ' +
        '`resolvedLocations` means no loaded script matches yet, and the breakpoint binds when one loads — ' +
        'or never, if the URL is wrong. ' +
        'A `source` breakpoint is removed once its file changes, so set it again after an edit; the next state or ' +
        'navigation result lists it under `droppedBreakpoints`. A `url`/`urlRegex` breakpoint is kept through edits, ' +
        'so it may then stop on other code, or not at all.',
      inputSchema: z.object({
        source: z
          .string()
          .optional()
          .describe(
            'File to break in, as in your project: a path like "src/App.tsx" — more of it when the name alone ' +
              'matches several loaded files — an absolute path, or a source-mapped url. lineNumber and columnNumber ' +
              'are positions in this file.',
          ),
        url: z
          .string()
          .optional()
          .describe(
            'Exact URL of the script as Chrome loaded it. Provide this, urlRegex or source; if both url and urlRegex, urlRegex takes precedence.',
          ),
        urlRegex: z
          .string()
          .optional()
          .describe(
            'Regex on the URL of the script as Chrome loaded it. Provide this, url or source; if both url and urlRegex, urlRegex takes precedence.',
          ),
        lineNumber: z.number().int().min(1).describe('Line number (1-indexed)'),
        columnNumber: z.number().int().min(1).optional().describe('Column number, 1-indexed (optional)'),
        condition: z.string().optional().describe('JS expression; breakpoint triggers only when truthy'),
      }),
      outputSchema: z.object({
        breakpointId: z.string(),
        resolvedLocations: z
          .array(
            z.object({
              url: z.string(),
              lineNumber: z.number(),
              columnNumber: z.number(),
              source: z.string().optional(),
              sourceLine: z.number().optional(),
              sourceColumn: z.number().optional(),
            }),
          )
          .describe(
            'Where Chrome bound it in each loaded script, 1-based; source* give the source-mapped position. ' +
              'May be empty for url/urlRegex if the script is not loaded yet; the breakpoint will bind automatically when Chrome parses the script',
          ),
        note: z.string().optional(),
      }),
      annotations: {
        title: 'Set breakpoint',
        idempotentHint: true,
      },
    },
    async ({ url, lineNumber, columnNumber, condition, urlRegex, source }) => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      if (source && (url || urlRegex)) {
        return toolError('Give source, or url/urlRegex — not both: they number lines in different files.');
      }
      if (!source && !url && !urlRegex) {
        return toolError('Must provide source, url or urlRegex.');
      }
      if (!(await session.attach(client))) return attachTimedOut('set_breakpoint');

      // Every breakpoint below is set by the loaded script's URL, never by scriptId, because a
      // URL breakpoint survives a reload — and a reload is how a breakpoint in startup code gets hit.
      type Placement = { url?: string; urlRegex?: string; lineNumber: number; columnNumber?: number };
      let placements: Placement[];
      let lookup: Extract<SourceLookup, { found: true }> | undefined;
      if (source) {
        const located = await session.locateSource(source, lineNumber, columnNumber);
        if (!located.found) return toolError(sourceNotPlaced(source, lineNumber, located));
        lookup = located;
        // The exact URL of the copy that was mapped, not a pattern that also takes later copies.
        // A later copy is later code: Vite re-imports a hot-updated module as "App.tsx?t=…", and
        // a pattern binding there lands on these line and column numbers in code they no longer
        // describe. Chrome's breakpoint hints are meant to carry a breakpoint to where its code
        // moved, but in a React module they did not — measured, Vite 7, Chrome 155: one line
        // inserted above, and the pattern stopped one statement early; a second edit, inside
        // another function. Not binding at all is the lesser failure.
        placements = located.locations.map(({ url, lineNumber, columnNumber }) => ({ url, lineNumber, columnNumber }));
      } else {
        placements = [
          {
            ...(urlRegex ? { urlRegex } : { url }),
            lineNumber: lineNumber - 1,
            ...(columnNumber !== undefined && { columnNumber: columnNumber - 1 }),
          },
        ];
      }

      // One file can be loaded in several scripts — a module bundled into two chunks — and each
      // needs a breakpoint of its own. They are set as one, and undone as one if any is refused.
      const chromeIds: string[] = [];
      const bound: Array<{ scriptId: string; lineNumber: number; columnNumber?: number }> = [];
      try {
        for (const { columnNumber, ...placement } of placements) {
          const result = await client.Debugger.setBreakpointByUrl({
            ...placement,
            ...(columnNumber !== undefined && { columnNumber }),
            ...(condition && { condition }),
          });
          chromeIds.push(result.breakpointId);
          bound.push(...result.locations);
        }
      } catch (e) {
        for (const breakpointId of chromeIds) await client.Debugger.removeBreakpoint({ breakpointId }).catch(() => {});
        throw e;
      }

      const resolvedLocations = await Promise.all(
        bound.map((l) => session.describeLocation(l.scriptId, l.lineNumber, l.columnNumber ?? 0)),
      );

      // Chrome moves a breakpoint to the next spot that can take one, and the named line may have
      // had no code at all. Either way the line asked for is not the line it will stop on, which
      // is worth saying outright rather than leaving to a comparison of numbers.
      const first = resolvedLocations[0];
      const landed = first && (lookup ? (first.sourceLine ?? first.lineNumber) : first.lineNumber);
      const where = lookup ? lookup.source : (urlRegex ?? url);
      const note =
        landed !== undefined && landed !== lineNumber
          ? `Line ${lineNumber} has no code that can take a breakpoint; it is on line ${landed} of ${where}, the next one that does.`
          : undefined;

      const label =
        lookup && first ? `${lookup.source}:${landed} → ${first.url}:${first.lineNumber}` : `${where}:${lineNumber}`;
      const breakpointId = session.addBreakpoint(label, chromeIds);
      if (lookup) {
        await session.watchSourceBreakpoint(breakpointId, {
          key: lookup.key,
          display: lookup.source,
          column: columnNumber,
          condition,
          placements: lookup.locations.map(({ scriptId, url, lineNumber, columnNumber, sourceLine }, i) => ({
            chromeId: chromeIds[i],
            scriptId,
            url,
            lineNumber,
            columnNumber,
            sourceLine,
          })),
        });
      }
      const data = { breakpointId, resolvedLocations, ...(note && { note }) };
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
      if (!(await session.attach(client))) return attachTimedOut('remove_breakpoint');
      let known = false;
      try {
        for (const chromeId of session.chromeBreakpointIds(breakpointId)) {
          await client.Debugger.removeBreakpoint({ breakpointId: chromeId });
        }
      } finally {
        known = session.removeBreakpoint(breakpointId);
      }
      if (!known) {
        return toolError(
          `No breakpoint ${breakpointId}: it was removed already, or set before a tab switch or reconnect, ` +
            'which clears every breakpoint.',
        );
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
        'Pause JavaScript at the next statement that runs, and return the call stack if that happens within ' +
        `${PAUSE_WAIT_TIMEOUT_MS / 1000}s. On an idle page nothing runs, so the pause stays pending until script ` +
        'next does — a timer, an event, a click — and get_debugger_state reports it once it lands.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Pause execution',
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      if (!(await session.attach(client))) return pauseAttachTimedOut();
      if (session.state.paused) return reportPause();

      // Listening first: in a loop the pause lands within milliseconds of the command.
      const landed = session.waitForNextPause(client, PAUSE_WAIT_TIMEOUT_MS);
      // Bounded, because a page showing a modal dialog does not answer even this. Measured, Chrome
      // 156, the debugger already enabled: no answer while an alert() was open; once it was closed,
      // the pause was pending, and landed at the next statement that ran.
      const sent = await withTimeout(client.Debugger.pause(), PAUSE_WAIT_TIMEOUT_MS);
      if (sent === TIMED_OUT) {
        return toolError(
          `Error: the page did not take the pause within ${PAUSE_WAIT_TIMEOUT_MS / 1000}s — it may be showing a ` +
            'modal dialog (alert, confirm or prompt), which holds every command back until it is closed. The pause ' +
            'is still queued: once the dialog closes, it lands at the next statement that runs.',
        );
      }
      if (await landed) return reportPause();

      // Not an error: the pause is in place, it has only not landed. Measured, Chrome 156:
      // Debugger.resume refuses a pause that has not landed ("Can only perform operation while
      // paused"), and a navigation drops it — a reload included, a #hash change not.
      return {
        content: [
          {
            type: 'text',
            text:
              `No script ran within ${PAUSE_WAIT_TIMEOUT_MS / 1000}s, so nothing is paused yet. The pause stays ` +
              'pending, and cannot be withdrawn short of reloading the page: it lands at the next statement that ' +
              'runs — a timer, an event such as a click, or an evaluate_js expression. get_debugger_state shows it ' +
              'once it has landed, and resume_execution continues from there.',
          },
        ],
      };
    },
  );

  server.registerTool(
    'resume_execution',
    {
      description:
        'Resume execution while paused; it runs until the next breakpoint or pause. Returns at once rather than ' +
        'waiting for one.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Resume execution',
        destructiveHint: false,
      },
    },
    async () => {
      const client = await getClient();
      if (!client) return NOT_CONNECTED;
      if (!(await session.attach(client))) return attachTimedOut('resume_execution');
      // Chrome decides whether a pause is in place, not session.state. Measured, Chrome 156:
      // Debugger.resume fails with "Can only perform operation while paused" in two cases: nothing
      // is paused, or pause_execution asked for a pause that has not landed yet. In the second case
      // the failed resume does not cancel that pause; it still lands at the next statement that runs.
      try {
        await client.Debugger.resume({});
      } catch (err) {
        if (!/only perform operation while paused/i.test((err as Error).message)) throw err;
        return toolError(
          'Error: not paused — nothing to resume. A pause requested by pause_execution that has not landed yet ' +
            'is not withdrawn by this.',
        );
      }
      return { content: [{ type: 'text', text: 'Execution resumed.' }] };
    },
  );

  // CDP steps by statement, not by line, and a minified line holds many statements. Measured, Chrome
  // 156: the one line `a(); b(); c(); const x = a(), y = b(); return x + y;` took seven steps — one per
  // statement, one more for the second initializer, and one for the function's exit.
  server.registerTool(
    'step_over',
    {
      description:
        'While paused, run the current statement without stepping into the functions it calls, and pause at the ' +
        'next statement. After an event handler or timer callback returns, the step stays in effect: it pauses at ' +
        'the first statement of whatever script runs next, which may be unrelated code. Returns the new call ' +
        'stack, or a note if execution has not paused again within ' +
        `${STEP_WAIT_TIMEOUT_MS / 1000}s.`,
      inputSchema: z.object({}),
      annotations: {
        title: 'Step over',
        destructiveHint: false,
      },
    },
    () => step('step_over', (client) => client.Debugger.stepOver({})),
  );

  server.registerTool(
    'step_into',
    {
      description:
        'While paused, step into the function the current statement calls, or to the next statement if it calls ' +
        'none. After an event handler or timer callback returns, the step stays in effect: it pauses at the first ' +
        'statement of whatever script runs next, which may be unrelated code. Returns the new call stack, or a ' +
        'note if execution has not paused again within ' +
        `${STEP_WAIT_TIMEOUT_MS / 1000}s.`,
      inputSchema: z.object({}),
      annotations: {
        title: 'Step into',
        destructiveHint: false,
      },
    },
    () => step('step_into', (client) => client.Debugger.stepInto({})),
  );

  server.registerTool(
    'evaluate_at_frame',
    {
      description:
        'Evaluate a JavaScript expression in the scope of a paused call frame — it reads local variables, closure ' +
        'variables and the current `this`, which evaluate_js cannot. Only works while execution is paused: when it is ' +
        'not, this returns an error rather than silently falling back to global scope. Results come back as a ' +
        'preview — class name plus a first level of properties, marked `…` where Chrome truncated it — readable, ' +
        'not parseable as the value. Use get_debugger_state to find frame indices.',
      inputSchema: z.object({
        expression: z
          .string()
          .describe('JS source evaluated as-is. A function is not called — wrap it: `(() => { ... })()`'),
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
      if (!(await session.attach(client))) return attachTimedOut('evaluate_at_frame');

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

      // Preview-first, unlike evaluate_js: at a breakpoint the question is almost always
      // "what is this object", not "give me its bytes".
      const text = renderRemoteObject(result.result);
      releaseRemoteObject(client, result.result);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'step_out',
    {
      description:
        'While paused, run the rest of the current function and pause in its caller. An event handler or timer ' +
        'callback has no caller, so stepping out of one pauses in whatever script runs next. Returns the new ' +
        `call stack, or a note if execution has not paused again within ${STEP_WAIT_TIMEOUT_MS / 1000}s.`,
      inputSchema: z.object({}),
      annotations: {
        title: 'Step out',
        destructiveHint: false,
      },
    },
    () => step('step_out', (client) => client.Debugger.stepOut()),
  );
}

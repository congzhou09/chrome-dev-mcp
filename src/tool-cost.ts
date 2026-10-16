import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';

// What the tool definitions cost a caller, and the figures docs/tool-boundaries.md quotes from it.
// Not part of the server: `pnpm measure:tools [--write]` prints it and rewrites the doc, and
// tool-cost.test.ts fails when the doc has fallen behind the code.

export const DOC_PATH = new URL('../docs/tool-boundaries.md', import.meta.url);

// Rough English-prose ratio; tokenizers differ by client, so the doc reports tokens as "~N.Nk" only.
const CHARS_PER_TOKEN = 3.6;

// The group the doc quotes as one share alongside get_network_requests.
const STEPPING = ['step_over', 'step_into', 'step_out', 'resume_execution'];

// The doc's generated span sits between these. HTML comments, so they do not render; the start
// marker names the command, for whoever edits the doc by hand.
const START = '<!-- tool-cost: pnpm measure:tools --write -->';
const END = '<!-- /tool-cost -->';

export type ToolCost = { name: string; visible: number; wire: number };

export async function measureToolCost() {
  // No Chrome is needed: tools/list only reads the registrations, so these three CDP dependencies
  // are never called and the stubs never have to return a real client.
  const { server } = createServer(
    async () => null,
    async () => null,
    () => null,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tool-cost', version: '0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools(); // tools/list request
  await client.close();

  const len = (value: unknown) => (value === undefined ? 0 : JSON.stringify(value).length);
  const rows: ToolCost[] = tools
    .map((t) => ({
      name: t.name,
      visible: len({ name: t.name, description: t.description, input_schema: t.inputSchema }),
      // Everything tools/list puts on the wire, outputSchema and annotations included.
      wire: len(t),
    }))
    .sort((a, b) => b.visible - a.visible);
  const visible = rows.reduce((n, r) => n + r.visible, 0);
  const visibleOf = (names: string[]) => rows.filter((r) => names.includes(r.name)).reduce((n, r) => n + r.visible, 0);

  return {
    rows,
    visible,
    share: (names: string[]) => `${Math.round((visibleOf(names) / visible) * 100)}%`,
  };
}

export function renderDocSpan(cost: Awaited<ReturnType<typeof measureToolCost>>): string {
  const n = (x: number) => x.toLocaleString('en-US');
  return (
    `**${n(cost.visible)} characters (~${(cost.visible / CHARS_PER_TOKEN / 1000).toFixed(1)}k tokens) ` +
    `across ${cost.rows.length} tools**, of which \`get_network_requests\` alone is ` +
    `${cost.share(['get_network_requests'])} and the four stepping tools together ${cost.share(STEPPING)}.`
  );
}

// The span currently in the doc, and the doc with it replaced.
export async function readDocSpan(): Promise<{ current: string; replace: (span: string) => string }> {
  const doc = await readFile(DOC_PATH, 'utf8');
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${DOC_PATH.pathname} has no ${START} … ${END} span`);
  return {
    current: doc.slice(start + START.length, end),
    replace: (span) => doc.slice(0, start + START.length) + span + doc.slice(end),
  };
}

export async function writeDocSpan(span: string): Promise<void> {
  const { replace } = await readDocSpan();
  await writeFile(DOC_PATH, replace(span));
}

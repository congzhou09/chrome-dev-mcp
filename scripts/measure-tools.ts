// Prints what each tool definition costs a caller. With --write, also rewrites the figures in
// docs/tool-boundaries.md, which tool-cost.test.ts holds to the code. See src/tool-cost.ts.
// Run: pnpm measure:tools [--write]
import { measureToolCost, readDocSpan, renderDocSpan, writeDocSpan } from '../src/tool-cost.js';

const cost = await measureToolCost();
console.table(cost.rows.map((r) => ({ tool: r.name, visible: r.visible, share: cost.share([r.name]), wire: r.wire })));

const span = renderDocSpan(cost);
console.log(span);
if (process.argv.includes('--write')) {
  await writeDocSpan(span);
  console.log('Updated docs/tool-boundaries.md.');
} else if ((await readDocSpan()).current !== span) {
  console.log('docs/tool-boundaries.md is out of date — rerun with --write.');
}

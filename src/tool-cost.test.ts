import { describe, it, expect } from 'vitest';
import { measureToolCost, readDocSpan, renderDocSpan } from './tool-cost.js';

describe('docs/tool-boundaries.md', () => {
  // The doc argues from these figures, so a description or schema change that moves them has
  // to move the doc too. Fix by running `pnpm measure:tools --write`.
  it('quotes the current tool-definition cost', async () => {
    const { current } = await readDocSpan();
    expect(current, 'stale figures — run `pnpm measure:tools --write`').toBe(renderDocSpan(await measureToolCost()));
  });
});

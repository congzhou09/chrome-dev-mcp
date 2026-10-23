import { describe, it, expect } from 'vitest';
import { createSourceMapResolver, type SourceMapResolver } from './sourcemap.js';
import { inlineSourceMap } from './test-helpers.js';

const register = (
  maps: SourceMapResolver,
  scriptId: string,
  url: string,
  sourceMapURL?: string,
  executionContextId?: number,
  hash?: string,
) => maps.registerScript({ scriptId, url, sourceMapURL, executionContextId, hash });

// Shaped on what Vite 7 actually serves for src/App.tsx (measured, Chrome 155): the map names its
// source by bare file name, relative to the script, and the generated code runs a few lines
// behind the source — imports rewritten, type-only lines and comments gone. Source lines 4 and 7
// are a comment and a `type` alias, so nothing maps to them.
const viteAppMap = inlineSourceMap(
  ['App.tsx'],
  [
    [],
    [],
    [[0, 0, 1, 0]],
    [],
    [[0, 0, 9, 0]],
    [],
    [],
    [[2, 0, 12, 2]],
    [[4, 0, 13, 4]],
    [
      [4, 0, 14, 4],
      [17, 0, 14, 17],
    ],
    [[4, 0, 15, 4]],
  ],
);

describe('createSourceMapResolver().locate', () => {
  it('places a source line in the loaded script it was compiled into', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://localhost:5173/src/App.tsx', viteAppMap, 1);

    const lookup = await maps.locate('src/App.tsx', 14);

    // Source line 14 is generated line 10 — the four-line gap that makes a source line passed
    // straight to setBreakpointByUrl stop somewhere else entirely.
    expect(lookup).toEqual({
      found: true,
      source: 'http://localhost:5173/src/App.tsx',
      key: 'http:/localhost:5173/src/App.tsx',
      locations: [
        {
          scriptId: 's1',
          url: 'http://localhost:5173/src/App.tsx',
          lineNumber: 9,
          columnNumber: 4,
          sourceLine: 14,
          source: 'http://localhost:5173/src/App.tsx',
        },
      ],
    });
  });

  it('walks on from a line with no code to the next one that has some', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://localhost:5173/src/App.tsx', viteAppMap, 1);

    const lookup = await maps.locate('src/App.tsx', 7);

    expect(lookup.found && lookup.locations[0]).toMatchObject({ lineNumber: 4, sourceLine: 9 });
  });

  it('honours a column by taking the first code at or after it on that line', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://localhost:5173/src/App.tsx', viteAppMap, 1);

    const lookup = await maps.locate('src/App.tsx', 14, 11);

    expect(lookup.found && lookup.locations[0]).toMatchObject({ lineNumber: 9, columnNumber: 17, sourceLine: 14 });
  });

  it('matches webpack sources whatever their scheme, "./" or query, and an absolute path on disk', async () => {
    const maps = createSourceMapResolver();
    register(
      maps,
      's1',
      'webpack-internal:///./src/util.ts',
      inlineSourceMap(['webpack://app/./src/util.ts?18df'], [[], [[2, 0, 4, 2]]]),
      1,
    );

    for (const path of ['src/util.ts', 'D:\\work\\app\\src\\util.ts', 'webpack://app/src/util.ts?18df']) {
      const lookup = await maps.locate(path, 4);
      expect(lookup.found && lookup.locations[0], path).toMatchObject({
        url: 'webpack-internal:///./src/util.ts',
        lineNumber: 1,
        sourceLine: 4,
      });
    }
  });

  it('refuses a name that fits several files, and accepts enough of the path to pick one', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://x/a.js', inlineSourceMap(['webpack://app/src/a/index.ts'], [[[0, 0, 1, 0]]]), 1);
    register(maps, 's2', 'http://x/b.js', inlineSourceMap(['webpack://app/src/b/index.ts'], [[[0, 0, 1, 0]]]), 1);

    expect(await maps.locate('index.ts', 1)).toEqual({
      found: false,
      reason: 'ambiguous',
      candidates: ['webpack://app/src/a/index.ts', 'webpack://app/src/b/index.ts'],
    });
    expect(await maps.locate('src/b/index.ts', 1)).toMatchObject({
      found: true,
      locations: [{ url: 'http://x/b.js' }],
    });
  });

  it('does not settle for a file that only shares the name, but offers it', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://x/main.js', inlineSourceMap(['webpack://app/lib/Button.tsx'], [[[0, 0, 1, 0]]]), 1);

    expect(await maps.locate('src/components/Button.tsx', 1)).toEqual({
      found: false,
      reason: 'not-loaded',
      candidates: ['webpack://app/lib/Button.tsx'],
    });
  });

  it('treats a script without a map as the file itself, line for line', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://x/static/legacy.js?v=3', undefined, 1);

    expect(await maps.locate('static/legacy.js', 5)).toEqual({
      found: true,
      source: 'http://x/static/legacy.js',
      key: 'http:/x/static/legacy.js',
      locations: [{ scriptId: 's1', url: 'http://x/static/legacy.js?v=3', lineNumber: 4, sourceLine: 5 }],
    });
  });

  it('uses only the newest copy of a hot-updated module', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://localhost:5173/src/App.tsx', viteAppMap, 1);
    // The edit added a line above, so the same source line now sits one generated line lower.
    register(
      maps,
      's2',
      'http://localhost:5173/src/App.tsx?t=1700000000000',
      inlineSourceMap(['App.tsx'], [[], [], [], [], [], [], [], [], [], [], [[4, 0, 14, 4]]]),
      1,
    );

    const lookup = await maps.locate('src/App.tsx', 14);

    expect(lookup.found && lookup.locations).toEqual([
      {
        scriptId: 's2',
        url: 'http://localhost:5173/src/App.tsx?t=1700000000000',
        lineNumber: 10,
        columnNumber: 4,
        sourceLine: 14,
        source: 'http://localhost:5173/src/App.tsx',
      },
    ]);
  });

  it('says a line past the last code is not code, rather than placing it somewhere', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://x/u.js', inlineSourceMap(['u.ts'], [[[0, 0, 1, 0]]], ['a\nb\nc']), 1);

    expect(await maps.locate('u.ts', 2)).toEqual({ found: false, reason: 'no-code', candidates: ['http://x/u.ts'] });
  });

  it("forgets a destroyed context's scripts", async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://localhost:5173/src/App.tsx', viteAppMap, 1);
    register(maps, 's2', 'http://localhost:5173/src/other.ts', undefined, 2);

    maps.dropContext(1);
    expect((await maps.locate('src/App.tsx', 14)).found).toBe(false);
    expect((await maps.locate('src/other.ts', 1)).found).toBe(true);

    maps.dropContext();
    expect((await maps.locate('src/other.ts', 1)).found).toBe(false);
  });
});

describe('createSourceMapResolver().resolve', () => {
  // A reload after an edit brings the same URL back with a new map. Reading the old one against
  // the new code would report every position on the wrong source line.
  it('reads each script against its own map, not one cached for the URL', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://x/app.js', inlineSourceMap(['app.ts'], [[[0, 0, 10, 0]]]), 1);
    expect((await maps.resolve('s1', 0, 0))?.line).toBe(10);

    maps.dropContext(1);
    register(maps, 's2', 'http://x/app.js', inlineSourceMap(['app.ts'], [[[0, 0, 20, 0]]]), 2);
    expect((await maps.resolve('s2', 0, 0))?.line).toBe(20);
  });

  it('reports sources resolved against the script, not the bare name the map gives', async () => {
    const maps = createSourceMapResolver();
    register(maps, 's1', 'http://localhost:5173/src/App.tsx', viteAppMap, 1);

    expect(await maps.resolve('s1', 9, 4)).toMatchObject({ source: 'http://localhost:5173/src/App.tsx', line: 14 });
  });
});

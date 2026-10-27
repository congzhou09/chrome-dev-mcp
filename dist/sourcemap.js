import { LEAST_UPPER_BOUND, TraceMap, generatedPositionFor, originalPositionFor, sourceContentFor, } from '@jridgewell/trace-mapping';
const fetchTraceMap = async (scriptUrl, sourceMapURL) => {
    try {
        let raw;
        // Sources are resolved against this, which is what turns Vite's bare "App.tsx" into the
        // "http://localhost:5173/src/App.tsx" a caller can recognise. An inline map has no URL of
        // its own, so it resolves against the script, as the spec says.
        let base;
        if (sourceMapURL.startsWith('data:')) {
            const header = sourceMapURL.slice(0, sourceMapURL.indexOf(','));
            const payload = sourceMapURL.slice(header.length + 1);
            raw = header.endsWith(';base64') ? Buffer.from(payload, 'base64').toString('utf-8') : decodeURIComponent(payload);
            base = scriptUrl;
        }
        else {
            base = new URL(sourceMapURL, scriptUrl).href;
            const res = await fetch(base);
            if (!res.ok)
                return null;
            raw = await res.text();
        }
        return new TraceMap(raw, base);
    }
    catch {
        return null;
    }
};
export const withoutQuery = (url) => url.replace(/[?#].*$/s, '');
// What two locations are compared by: path segments, from the end. Neither scheme, host, query
// nor hash is something a caller can be expected to repeat — webpack hangs a "?ffb4" on every
// source, Vite a "?t=…" on every hot update — and "." is webpack's "./src/x.ts" habit.
const pathSegments = (location) => {
    const path = withoutQuery(location).replace(/\\/g, '/');
    let decoded = path;
    try {
        decoded = decodeURIComponent(path);
    }
    catch {
        // A stray "%" in a file name: compare it as written.
    }
    return decoded.split('/').filter((s) => s !== '' && s !== '.');
};
/** One file's identity across every load of it, whatever query or hash a load hangs on it. */
export const fileKey = (location) => pathSegments(location).join('/');
const sharedTail = (a, b) => {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n])
        n++;
    return n;
};
export function createSourceMapResolver() {
    // scriptId -> what Debugger.scriptParsed said about it.
    // `seq`: arrival sequence across all scripts; the newest load of a module wins.
    const scriptRegistry = new Map();
    let registered = 0;
    // scriptId -> its map, or null for none / a failed fetch. Keyed by script rather than by URL:
    // a reload after an edit brings the same URL back with different code and a different map,
    // and reading the old map against it would put every position on the wrong line. A promise,
    // so a burst of console entries from one script shares a single fetch.
    const sourceMapCache = new Map();
    const mapFor = (scriptId) => {
        const script = scriptRegistry.get(scriptId);
        if (!script?.sourceMapURL)
            return Promise.resolve(null);
        let map = sourceMapCache.get(scriptId);
        if (!map) {
            map = fetchTraceMap(script.url, script.sourceMapURL);
            sourceMapCache.set(scriptId, map);
        }
        return map;
    };
    // The first code at or after a 1-based line (and column) of `source`, as a generated position.
    // Comments, blank lines and type-only lines map to nothing, so asking for one walks on to the
    // next line that does — which is where a debugger would stop anyway.
    const firstCodeFrom = (map, source, line, column) => {
        const content = sourceContentFor(map, source);
        const lastLine = content ? content.split('\n').length : line + 5000;
        for (let l = line; l <= lastLine; l++) {
            const g = generatedPositionFor(map, {
                source,
                line: l,
                column: l === line && column ? column - 1 : 0,
                bias: LEAST_UPPER_BOUND,
            });
            if (g.line != null)
                return { sourceLine: l, lineNumber: g.line - 1, columnNumber: g.column };
        }
        return null;
    };
    // A script without a map is the file itself, so its positions are the file's, line for line.
    const positionIn = async (scriptId, source, line, column) => {
        if (source === undefined) {
            return { lineNumber: line - 1, ...(column ? { columnNumber: column - 1 } : {}), sourceLine: line };
        }
        const map = await mapFor(scriptId);
        return map && firstCodeFrom(map, source, line, column);
    };
    const forget = (scriptId) => {
        scriptRegistry.delete(scriptId);
        sourceMapCache.delete(scriptId);
    };
    return {
        registerScript({ scriptId, url, sourceMapURL, executionContextId, hash }) {
            scriptRegistry.set(scriptId, {
                url,
                sourceMapURL: sourceMapURL || undefined,
                executionContextId,
                hash,
                seq: registered++,
            });
        },
        async resolve(scriptId, line0, col) {
            const tracer = await mapFor(scriptId);
            if (!tracer)
                return null;
            // trace-mapping uses 1-based lines and 0-based columns
            const pos = originalPositionFor(tracer, { line: line0 + 1, column: col });
            if (pos.source == null)
                return null;
            return { source: pos.source, line: pos.line, column: pos.column, name: pos.name ?? undefined };
        },
        async locate(path, line, column) {
            const wanted = pathSegments(path);
            // A bare file name has to match on its own; anything longer has to agree on the directory
            // too, or "src/components/Button.tsx" would land in whichever Button.tsx happens to be loaded.
            const required = Math.min(2, wanted.length);
            const perScript = await Promise.all([...scriptRegistry].map(async ([scriptId, script]) => {
                const named = (location, source) => {
                    const segments = pathSegments(location);
                    const score = sharedTail(wanted, segments);
                    return score ? { scriptId, source, display: withoutQuery(location), key: segments.join('/'), score } : null;
                };
                if (!script.sourceMapURL) {
                    const hit = named(script.url);
                    return hit ? [hit] : [];
                }
                // A map that would not load cannot be read in either direction; its script's URL is
                // no stand-in, since that code is not the file.
                const map = await mapFor(scriptId);
                return (map?.resolvedSources ?? []).flatMap((source) => named(source, source) ?? []);
            }));
            const hits = perScript.flat();
            const best = hits.reduce((n, h) => Math.max(n, h.score), 0);
            if (best < required || best === 0) {
                return { found: false, reason: 'not-loaded', candidates: [...new Set(hits.map((h) => h.display))] };
            }
            const winners = hits.filter((h) => h.score === best);
            if (new Set(winners.map((h) => h.key)).size > 1) {
                return { found: false, reason: 'ambiguous', candidates: [...new Set(winners.map((h) => h.display))] };
            }
            // One module loaded twice under URLs that differ only in their query is one module edited:
            // Vite re-imports a hot-updated file as "App.tsx?t=…" and the old copy never runs again.
            // Only the newest counts. Different URLs — a module bundled into two chunks — both do.
            const newest = new Map();
            for (const hit of winners) {
                const url = withoutQuery(scriptRegistry.get(hit.scriptId).url);
                const held = newest.get(url);
                if (!held || scriptRegistry.get(held.scriptId).seq < scriptRegistry.get(hit.scriptId).seq) {
                    newest.set(url, hit);
                }
            }
            const locations = [];
            for (const hit of newest.values()) {
                const at = await positionIn(hit.scriptId, hit.source, line, column);
                if (at) {
                    const url = scriptRegistry.get(hit.scriptId).url;
                    locations.push({
                        scriptId: hit.scriptId,
                        url,
                        ...at,
                        ...(hit.source !== undefined && { source: hit.source }),
                    });
                }
            }
            const source = winners[0].display;
            if (!locations.length)
                return { found: false, reason: 'no-code', candidates: [source] };
            return { found: true, source, key: winners[0].key, locations };
        },
        async fileIn(scriptId, key) {
            const script = scriptRegistry.get(scriptId);
            if (!script)
                return null;
            if (!script.sourceMapURL)
                return fileKey(script.url) === key ? { content: null } : null;
            const map = await mapFor(scriptId);
            const source = map?.resolvedSources.find((s) => fileKey(s) === key);
            return source === undefined ? null : { source, content: sourceContentFor(map, source) };
        },
        positionIn,
        scriptUrl: (scriptId) => scriptRegistry.get(scriptId)?.url,
        scriptHash: (scriptId) => scriptRegistry.get(scriptId)?.hash,
        dropContext(executionContextId) {
            for (const [scriptId, script] of scriptRegistry) {
                if (executionContextId === undefined || script.executionContextId === executionContextId)
                    forget(scriptId);
            }
        },
        reset() {
            scriptRegistry.clear();
            sourceMapCache.clear();
        },
    };
}

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
const fetchTraceMap = async (scriptUrl, sourceMapURL) => {
    try {
        let raw;
        if (sourceMapURL.startsWith('data:')) {
            const b64 = sourceMapURL.slice(sourceMapURL.indexOf(',') + 1);
            raw = Buffer.from(b64, 'base64').toString('utf-8');
        }
        else {
            const mapUrl = new URL(sourceMapURL, scriptUrl).href;
            const res = await fetch(mapUrl);
            if (!res.ok)
                return null;
            raw = await res.text();
        }
        return new TraceMap(raw);
    }
    catch {
        return null;
    }
};
export function createSourceMapResolver() {
    // scriptId -> { url, sourceMapURL }; populated by Debugger.scriptParsed
    const scriptRegistry = new Map();
    // script url -> parsed TraceMap (null = no source map or fetch failed)
    const sourceMapCache = new Map();
    return {
        registerScript(scriptId, url, sourceMapURL) {
            scriptRegistry.set(scriptId, { url, sourceMapURL: sourceMapURL || undefined });
        },
        async resolve(scriptId, line0, col) {
            const script = scriptRegistry.get(scriptId);
            if (!script?.sourceMapURL)
                return null;
            if (!sourceMapCache.has(script.url)) {
                sourceMapCache.set(script.url, await fetchTraceMap(script.url, script.sourceMapURL));
            }
            const tracer = sourceMapCache.get(script.url);
            if (!tracer)
                return null;
            // trace-mapping uses 0-based line and column
            const pos = originalPositionFor(tracer, { line: line0 + 1, column: col });
            if (pos.source == null)
                return null;
            return { source: pos.source, line: pos.line, column: pos.column, name: pos.name ?? undefined };
        },
        reset() {
            scriptRegistry.clear();
            sourceMapCache.clear();
        },
    };
}

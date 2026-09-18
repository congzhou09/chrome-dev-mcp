import { EVAL_DEEP_VALUE_TIMEOUT_MS } from './constants.js';
import { TIMED_OUT, withTimeout } from './timeout.js';
// Rendering for CDP RemoteObjects, shared by evaluate_js and evaluate_at_frame.
//
// It lives in one place so the two tools differ only where they are MEANT to — evaluate_js
// is value-first (a Console: you want the real value), evaluate_at_frame is preview-first
// (a Watch pane: you want to see what the object is) — and never by accident.
//
// "Preview" is CDP's own noun, not a coinage here: `RemoteObject.preview` is a
// `Runtime.ObjectPreview`, requested with `generatePreview` and flagged `overflow` when
// Chrome truncates it. It carries a class name and one level of properties — enough to
// read, never enough to parse back into the value.
//
// Why neither tool asks for `returnByValue: true` up front, even though that is the
// obvious way to get a value: the serialisation it performs is lossy in a way the response
// does not record. Measured against Chrome 141:
//
//   document.body       -> {"type":"object","value":{}}          className/subtype stripped
//   new Error("boom")   -> {"type":"object","value":{}}
//   new Map([["k",1]])  -> {"type":"object","value":{}}
//   new Foo()           -> {"type":"object","value":{"a":1}}     class, getters, methods gone
//   querySelector(...)  -> THROWS -32000 Object reference chain is too long
//   ({a:1,b:{c:2}})     -> {"type":"object","value":{"a":1,"b":{"c":2}}}   (the good case)
//
// A `{}` from a DOM node is indistinguishable from a genuinely empty object, and `{a:1}`
// from a class instance is indistinguishable from a plain object — so "serialise by value,
// detect the loss, retry" cannot work: there is nothing to detect.
//
// Retrying is also not free. The -32000 is raised while serialising a value that has
// ALREADY been produced, so a second evaluate re-runs the expression: `evaluate_js('n++')`
// would increment twice.
//
// Hence: evaluate once in preview mode (which always answers and carries className/subtype),
// then upgrade to a value only for objects that survive the round-trip, reusing the
// objectId already in hand so the expression is never evaluated a second time.
// Containers whose entire meaning IS their contents, and which therefore lose nothing by
// value. Everything else is shown as a preview. `Object.create(null)` reports className
// 'Object' too, so it lands here correctly.
const isPlainData = (r) => r.subtype === 'array' || (r.className === 'Object' && r.subtype === undefined);
const previewLine = (entry) => entry.key ? `  ${entry.key.description} => ${entry.value.description}` : `  ${entry.value.description}`;
// Deep-serialises an object already held by `objectId`, without re-evaluating anything.
// Rejects on a reference cycle (-32000), which is a fallback signal, not an error to report.
//
// Bounded because serialisation is not the passive read it looks like: it INVOKES getters.
// Measured, Chrome 141 — `({ get slow() { busy(3000); return 'x' } })` came back after
// exactly 3001ms with the getter's value in it, and `get boom() { while (true) {} }` never
// came back at all. `isPlainData` routes any plain object here, so a single hostile or
// merely expensive getter is enough. See EVAL_DEEP_VALUE_TIMEOUT_MS for what the bound can
// and cannot rescue.
//
// Every failure lands on the same `ok: false`, and that is the point: this is an optional
// upgrade over a preview that is already a correct answer, so timing out degrades the
// output rather than turning into an error the caller has to handle.
const deepValue = async (client, objectId) => {
    try {
        const call = client.Runtime.callFunctionOn({
            objectId,
            functionDeclaration: 'function () { return this; }',
            returnByValue: true,
        });
        // The race abandons this promise on timeout. Without a handler of its own, a later
        // rejection would surface as an unhandledRejection with nobody listening.
        call.catch(() => { });
        const res = await withTimeout(call, EVAL_DEEP_VALUE_TIMEOUT_MS);
        if (res === TIMED_OUT || res.exceptionDetails)
            return { ok: false };
        return { ok: true, value: res.result.value };
    }
    catch {
        return { ok: false };
    }
};
// Preview-first: what the value IS, one level deep. Used as-is by evaluate_at_frame.
export const renderRemoteObject = (r) => {
    if (r.value !== undefined)
        return JSON.stringify(r.value, null, 2);
    // An Error's payload IS its stack, and `description` already carries it in full. Going
    // through the brace layout instead prints the stack twice — once as the head, once as the
    // `stack` property — and the newline inside the head breaks the layout on top of that.
    if (r.subtype === 'error' && r.description)
        return r.description;
    const preview = r.preview;
    if (preview) {
        // Map and Set carry their contents in `entries`; their `properties` holds only `size`,
        // so reading properties alone renders `Map(1) { size: 1 }` — true, and useless.
        const lines = preview.entries?.length
            ? preview.entries.map(previewLine)
            : (preview.properties ?? []).map((p) => 
            // An accessor carries no `value` in a preview — Chrome does not call getters to
            // build one. Interpolating the absent value prints `name: undefined`, which reads
            // as "this property IS undefined" rather than "this is a getter nobody called".
            // DevTools writes `(...)` here, and so do we.
            p.type === 'accessor' ? `  ${p.name}: (...)` : `  ${p.name}: ${p.value}`);
        // Chrome caps a preview at five-ish properties; without this marker a partial listing
        // reads as a complete one.
        if (preview.overflow)
            lines.push('  …');
        return `${preview.description ?? r.type} {\n${lines.join(',\n')}\n}`;
    }
    return r.description ?? r.type ?? 'undefined';
};
// Value-first: the real value when it survives serialisation, a preview when it does not.
// Used by evaluate_js. `r` must come from an evaluate with generatePreview.
export const renderValueFirst = async (client, r) => {
    if (r.value === undefined && r.objectId && isPlainData(r)) {
        const deep = await deepValue(client, r.objectId);
        if (deep.ok)
            return JSON.stringify(deep.value, null, 2);
    }
    return renderRemoteObject(r);
};
// Preview mode pins the object in the renderer heap until it is released. Failure is
// ignored on purpose: the object is already rendered, and a stale objectId (navigation,
// context destroyed) is exactly when this rejects.
//
// Fire-and-forget, deliberately not awaited. Nothing in the response depends on the release,
// and a renderer wedged inside a blocking getter answers this command exactly as reluctantly
// as the one that wedged it: measured, `releaseObject` on such a target had still not
// answered after 5000ms. Awaiting it was what carried a single evaluate_js past the MCP
// client's 60s limit even with the deep-value upgrade already bounded — bounding this one
// too would only trade a hang for a fixed tax on every call after a wedge.
export const releaseRemoteObject = (client, r) => {
    if (r?.objectId)
        void client.Runtime.releaseObject({ objectId: r.objectId }).catch(() => { });
};

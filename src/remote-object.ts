import type CDP from 'chrome-remote-interface';

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
const isPlainData = (r: any): boolean => r.subtype === 'array' || (r.className === 'Object' && r.subtype === undefined);

const previewLine = (entry: any): string =>
  entry.key ? `  ${entry.key.description} => ${entry.value.description}` : `  ${entry.value.description}`;

// Deep-serialises an object already held by `objectId`, without re-evaluating anything.
// Rejects on a reference cycle (-32000), which is a fallback signal, not an error to report.
const deepValue = async (client: CDP.Client, objectId: string): Promise<{ ok: boolean; value?: unknown }> => {
  try {
    const res = await client.Runtime.callFunctionOn({
      objectId,
      functionDeclaration: 'function () { return this; }',
      returnByValue: true,
    });
    if (res.exceptionDetails) return { ok: false };
    return { ok: true, value: res.result.value };
  } catch {
    return { ok: false };
  }
};

// Preview-first: what the value IS, one level deep. Used as-is by evaluate_at_frame.
export const renderRemoteObject = (r: any): string => {
  if (r.value !== undefined) return JSON.stringify(r.value, null, 2);

  // An Error's payload IS its stack, and `description` already carries it in full. Going
  // through the brace layout instead prints the stack twice — once as the head, once as the
  // `stack` property — and the newline inside the head breaks the layout on top of that.
  if (r.subtype === 'error' && r.description) return r.description;

  const preview = r.preview;
  if (preview) {
    // Map and Set carry their contents in `entries`; their `properties` holds only `size`,
    // so reading properties alone renders `Map(1) { size: 1 }` — true, and useless.
    const lines: string[] = preview.entries?.length
      ? preview.entries.map(previewLine)
      : (preview.properties ?? []).map((p: any) => `  ${p.name}: ${p.value}`);
    // Chrome caps a preview at five-ish properties; without this marker a partial listing
    // reads as a complete one.
    if (preview.overflow) lines.push('  …');
    return `${preview.description ?? r.type} {\n${lines.join(',\n')}\n}`;
  }

  return r.description ?? r.type ?? 'undefined';
};

// Value-first: the real value when it survives serialisation, a preview when it does not.
// Used by evaluate_js. `r` must come from an evaluate with generatePreview.
export const renderValueFirst = async (client: CDP.Client, r: any): Promise<string> => {
  if (r.value === undefined && r.objectId && isPlainData(r)) {
    const deep = await deepValue(client, r.objectId);
    if (deep.ok) return JSON.stringify(deep.value, null, 2);
  }
  return renderRemoteObject(r);
};

// Preview mode pins the object in the renderer heap until it is released. Failure is
// ignored on purpose: the object is already rendered, and a stale objectId (navigation,
// context destroyed) is exactly when this rejects.
export const releaseRemoteObject = async (client: CDP.Client, r: any): Promise<void> => {
  if (r?.objectId) await client.Runtime.releaseObject({ objectId: r.objectId }).catch(() => {});
};

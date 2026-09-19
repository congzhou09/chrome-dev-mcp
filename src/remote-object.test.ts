import { describe, it, expect, vi } from 'vitest';
import { makeMockClient, setupMcpClient } from './test-helpers.js';
import { EVAL_DEEP_VALUE_TIMEOUT_MS, EVAL_EXECUTION_TIMEOUT_MS, EVAL_SETTLE_TIMEOUT_MS } from './constants.js';

describe('evaluate_js', () => {
  // Mock shapes below are copied from real Chrome responses, not invented: preview mode is
  // what the tool now asks for, and by-value serialisation of a DOM node / Error / Map is
  // what it deliberately avoids. See remote-object.ts for the measurements.
  const PREVIEW_MODE = {
    returnByValue: false,
    generatePreview: true,
    replMode: true,
    timeout: EVAL_EXECUTION_TIMEOUT_MS,
  };

  // An evaluate that hangs until the test rejects it, so a rejection can be placed on
  // either side of Chrome's execution deadline. `called` fires when the handler actually
  // reached Runtime.evaluate — the in-memory transport round trip is more than one microtask.
  const pendingEvaluate = () => {
    let reject!: (err: unknown) => void;
    let onCalled!: () => void;
    const called = new Promise<void>((res) => (onCalled = res));
    const evaluate = vi.fn(
      () =>
        new Promise((_, rej) => {
          reject = rej;
          onCalled();
        }),
    );
    const rejectWith = (response: { code: number; message: string }) =>
      reject(Object.assign(new Error(response.message), { response }));
    return { evaluate, called, rejectWith };
  };

  it('evaluates once, in preview mode', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'number', value: 42, description: '42' } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: '40 + 2' } });

    expect(evaluate).toHaveBeenCalledWith({ expression: '40 + 2', ...PREVIEW_MODE });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect((result.content as any)[0].text).toBe('42');
  });

  // replMode is what the DevTools console passes, and it is what makes top-level `await`
  // parse. awaitPromise is its opposite number, not its companion: setting it would auto-await
  // a RETURNED promise, which the console never does — and under replMode it is inert anyway.
  it('asks for console semantics: replMode on, awaitPromise never set', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'string', value: 'AFTER_AWAIT' } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    await client.callTool({
      name: 'evaluate_js',
      arguments: { expression: "await new Promise(r => setTimeout(r, 10)); 'AFTER_AWAIT'" },
    });

    const [args] = evaluate.mock.calls[0];
    expect(args.replMode).toBe(true);
    expect(args).not.toHaveProperty('awaitPromise');
  });

  // Chrome's own `timeout` is the ONLY thing that stops runaway synchronous code: the renderer
  // is wedged and answers nothing, so a client-side race would hand back control while leaving
  // the tab spinning for every later call.
  it("bounds renderer execution with Chrome's own timeout", async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'number', value: 1 } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    await client.callTool({ name: 'evaluate_js', arguments: { expression: '1' } });

    expect(evaluate.mock.calls[0][0].timeout).toBe(EVAL_EXECUTION_TIMEOUT_MS);
  });

  // A `timeout` kill arrives as a rejected command, not as exceptionDetails, so it would
  // otherwise escape the handler entirely.
  it('reports a terminated expression rather than throwing: -32000 Execution was terminated', async () => {
    const response = { code: -32000, message: 'Execution was terminated' };
    const evaluate = vi.fn().mockRejectedValue(Object.assign(new Error(response.message), { response }));
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'while(true){}' } });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain(`terminated after ${EVAL_EXECUTION_TIMEOUT_MS}ms`);
  });

  // Under replMode the kill degrades to a bare -32603 "Internal error", which is the mode
  // this tool ships. The rejection has to be delayed past the deadline to be a real kill:
  // Chrome starts its `timeout` clock on receipt, so it cannot fire any earlier than this.
  it('reports a terminated expression rather than throwing: -32603 Internal error at the deadline', async () => {
    const { evaluate, called, rejectWith } = pendingEvaluate();
    const client = await setupMcpClient(makeMockClient(evaluate as any));

    vi.useFakeTimers();
    try {
      const call = client.callTool({ name: 'evaluate_js', arguments: { expression: 'while(true){}' } });
      await called;
      await vi.advanceTimersByTimeAsync(EVAL_EXECUTION_TIMEOUT_MS);
      rejectWith({ code: -32603, message: 'Internal error' });
      const result = await call;

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain(`terminated after ${EVAL_EXECUTION_TIMEOUT_MS}ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  // -32603 is JSON-RPC's generic "Internal error", shared by every internal failure in the
  // protocol. One that arrives before the deadline is somebody else's fault, and answering it
  // with the timeout sentence would be a confident lie that also loses the real error.
  it('does not disguise an early -32603 as a timeout', async () => {
    const { evaluate, called, rejectWith } = pendingEvaluate();
    const client = await setupMcpClient(makeMockClient(evaluate as any));

    const call = client.callTool({ name: 'evaluate_js', arguments: { expression: '1' } });
    await called;
    rejectWith({ code: -32603, message: 'Session with given id not found.' });
    const result = await call;

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).not.toContain('terminated after');
    expect((result.content as any)[0].text).toContain('Session with given id not found');
  });

  // `timeout` does not count time suspended at an `await`, so a promise that never settles
  // leaves the command pending forever with the renderer perfectly healthy. Only the
  // client-side race bounds that one.
  it("reports an expression that never settles, which Chrome's timeout does not cover", async () => {
    const evaluate = vi.fn().mockReturnValue(new Promise(() => {}));
    const client = await setupMcpClient(makeMockClient(evaluate));

    vi.useFakeTimers();
    try {
      const pending = client.callTool({
        name: 'evaluate_js',
        arguments: { expression: 'await new Promise(() => {})' },
      });
      await vi.advanceTimersByTimeAsync(EVAL_SETTLE_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain(`did not settle within ${EVAL_SETTLE_TIMEOUT_MS}ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  // Recognising the timeout codes must not turn into swallowing every CDP failure.
  it('does not disguise an unrelated CDP failure as a timeout', async () => {
    const response = { code: -32001, message: 'Cannot find context with specified id' };
    const evaluate = vi.fn().mockRejectedValue(Object.assign(new Error(response.message), { response }));
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: '1' } });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).not.toContain('terminated after');
    expect((result.content as any)[0].text).toContain('Cannot find context');
  });

  it('upgrades a plain object to its full deep value without re-evaluating the expression', async () => {
    const value = { a: 1, b: { c: [1, 2, { d: 3 }] } };
    const evaluate = vi.fn().mockResolvedValue({
      result: { type: 'object', className: 'Object', objectId: 'obj-1' },
    });
    const callFunctionOn = vi.fn().mockResolvedValue({ result: { type: 'object', value } });
    const client = await setupMcpClient(makeMockClient(evaluate, undefined, undefined, undefined, { callFunctionOn }));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: '({a:1,b:{c:[1,2,{d:3}]}})' } });

    expect((result.content as any)[0].text).toBe(JSON.stringify(value, null, 2));
    // The whole point of going through callFunctionOn: one evaluation, so `n++` increments once.
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(callFunctionOn).toHaveBeenCalledWith({
      objectId: 'obj-1',
      functionDeclaration: 'function () { return this; }',
      returnByValue: true,
    });
  });

  // Deep serialisation INVOKES getters, so a plain object — which isPlainData always routes
  // through callFunctionOn — can block there indefinitely. callFunctionOn takes no `timeout`
  // of its own, so the client-side race is the only bound available.
  it('falls back to the preview when the deep-value upgrade never returns', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        type: 'object',
        className: 'Object',
        objectId: 'obj-1',
        preview: {
          description: 'Object',
          overflow: false,
          properties: [{ name: 'n', type: 'number', value: '1' }],
        },
      },
    });
    const callFunctionOn = vi.fn().mockReturnValue(new Promise(() => {}));
    const client = await setupMcpClient(makeMockClient(evaluate, undefined, undefined, undefined, { callFunctionOn }));

    vi.useFakeTimers();
    try {
      const pending = client.callTool({
        name: 'evaluate_js',
        arguments: { expression: '({ n: 1, get boom() { while (true) {} } })' },
      });
      await vi.advanceTimersByTimeAsync(EVAL_DEEP_VALUE_TIMEOUT_MS + 1);
      const result = await pending;

      // Degraded, not failed: the preview is still a correct answer.
      expect(result.isError).toBeFalsy();
      expect((result.content as any)[0].text).toBe('Object {\n  n: 1\n}');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the preview when the value cannot be serialised (reference cycle)', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        type: 'object',
        className: 'Object',
        objectId: 'obj-1',
        preview: {
          description: 'Object',
          overflow: false,
          properties: [
            { name: 'n', type: 'number', value: '1' },
            { name: 'self', type: 'object', value: 'Object' },
          ],
        },
      },
    });
    // Real Chrome rejects with -32000 "Object reference chain is too long".
    const callFunctionOn = vi.fn().mockRejectedValue(new Error('Object reference chain is too long'));
    const client = await setupMcpClient(makeMockClient(evaluate, undefined, undefined, undefined, { callFunctionOn }));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'cyclic' } });

    expect((result.content as any)[0].text).toBe('Object {\n  n: 1,\n  self: Object\n}');
    expect(result.isError).toBeFalsy();
  });

  it('renders a DOM node as a preview instead of the empty object a by-value round-trip yields', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        type: 'object',
        subtype: 'node',
        className: 'HTMLDivElement',
        description: 'div#root',
        objectId: 'obj-1',
        preview: {
          type: 'object',
          subtype: 'node',
          description: 'div#root',
          overflow: true,
          properties: [{ name: 'id', type: 'string', value: 'root' }],
        },
      },
    });
    const callFunctionOn = vi.fn();
    const client = await setupMcpClient(makeMockClient(evaluate, undefined, undefined, undefined, { callFunctionOn }));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: "document.querySelector('div')" } });

    // Trailing marker: Chrome caps a preview, and a partial listing must not read as complete.
    expect((result.content as any)[0].text).toBe('div#root {\n  id: root,\n  …\n}');
    // Anything that is not a plain container must never be sent through a by-value round-trip.
    expect(callFunctionOn).not.toHaveBeenCalled();
  });

  // Chrome never calls getters to build a preview, so an accessor arrives with no `value`.
  // Printing the absent one claims the property is undefined, which is a different fact.
  it('renders an un-called getter as (...) rather than undefined', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        type: 'object',
        className: 'Object',
        objectId: 'obj-1',
        preview: {
          description: 'Object',
          overflow: false,
          properties: [
            { name: 'n', type: 'number', value: '1' },
            { name: 'boom', type: 'accessor' },
          ],
        },
      },
    });
    // Forces the preview path: the deep-value upgrade fails, as it does for a blocking getter.
    const callFunctionOn = vi.fn().mockRejectedValue(new Error('nope'));
    const client = await setupMcpClient(makeMockClient(evaluate, undefined, undefined, undefined, { callFunctionOn }));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'obj' } });

    expect((result.content as any)[0].text).toBe('Object {\n  n: 1,\n  boom: (...)\n}');
  });

  it('renders Map contents from preview entries rather than its size property', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        type: 'object',
        subtype: 'map',
        className: 'Map',
        description: 'Map(1)',
        objectId: 'obj-1',
        preview: {
          description: 'Map(1)',
          overflow: false,
          properties: [{ name: 'size', type: 'number', value: '1' }],
          entries: [{ key: { description: 'k' }, value: { description: '1' } }],
        },
      },
    });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'new Map([["k",1]])' } });

    expect((result.content as any)[0].text).toBe('Map(1) {\n  k => 1\n}');
  });

  it('releases the remote object preview mode pinned in the renderer', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: { type: 'object', className: 'Object', objectId: 'obj-1' },
    });
    const releaseObject = vi.fn().mockResolvedValue({});
    const client = await setupMcpClient(makeMockClient(evaluate, undefined, undefined, undefined, { releaseObject }));

    await client.callTool({ name: 'evaluate_js', arguments: { expression: '({})' } });

    expect(releaseObject).toHaveBeenCalledWith({ objectId: 'obj-1' });
  });

  it('renders an Error as its stack, not as a brace layout repeating the stack', async () => {
    const description = 'Error: boom\n    at <anonymous>:1:1';
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        type: 'object',
        subtype: 'error',
        className: 'Error',
        description,
        objectId: 'obj-1',
        preview: {
          subtype: 'error',
          description,
          overflow: false,
          properties: [
            { name: 'stack', type: 'string', value: description },
            { name: 'message', type: 'string', value: 'boom' },
          ],
        },
      },
    });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'new Error("boom")' } });

    expect((result.content as any)[0].text).toBe(description);
  });

  it('returns error message when expression throws', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {},
      exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x is not defined' } },
    });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'x' } });

    expect((result.content as any)[0].text).toBe('Error: ReferenceError: x is not defined');
  });

  it('returns "undefined" string when expression result is undefined', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'undefined' } });
    const client = await setupMcpClient(makeMockClient(evaluate));

    const result = await client.callTool({ name: 'evaluate_js', arguments: { expression: 'void 0' } });

    expect((result.content as any)[0].text).toBe('undefined');
  });
});

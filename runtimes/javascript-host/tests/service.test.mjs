import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, encodeFrame, decodeFrame } from '../dist/codec.js';
import { ComponentSession } from '../dist/component.js';
import { PROCESS_PROFILE } from '../dist/generated/protocol.js';

const invocation = JSON.parse(await readFile(new URL('../../../crates/plugin-sdk/tests/fixtures/invocation.request.json', import.meta.url), 'utf8')).body.data;
const binding = JSON.parse(await readFile(new URL('../../../crates/plugin-sdk/tests/fixtures/service.binding.json', import.meta.url), 'utf8'));
const instanceOf = ({ contributionId, ...instance }) => instance;
const activation = {
  instance: instanceOf(invocation.provider),
  services: [binding],
  capabilities: [{ contributionId: invocation.provider.contributionId, capability: {
    contract: invocation.capability, inputSchema: invocation.input.schema,
    outputSchema: invocation.outputSchema, errorSchema: invocation.errorSchema,
    profiles: [invocation.profile], effect: 'proposal',
    permissions: [{ kind: 'project-service', contract: binding.contract }],
    limits: { concurrency: 1, maxInputBytes: 1048576, maxOutputBytes: 65536, timeoutMs: 1000 },
  } }],
};
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const frame = body => ({ protocolVersion: PROCESS_PROFILE.protocolVersion, body });
function response(request, kind = 'succeeded', utf8 = '{"receipt":"child-a"}') {
  const payload = { schema: kind === 'succeeded' ? binding.outputSchema : binding.errorSchema, utf8, sha256: digest(utf8) };
  return { callId: request.callId, handleId: request.handleId, context: request.context,
    outcome: kind === 'succeeded' ? { kind, output: payload } : { kind, error: payload } };
}
async function harness(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'tsumugi-service-test-'));
  const entry = join(root, 'component.mjs');
  await writeFile(entry, source);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url)), entry], {
    cwd: root, env: {}, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ended = once(child, 'exit');
  let exited = false;
  child.once('exit', () => { exited = true; });
  t.after(async () => { if (!exited) child.kill('SIGKILL'); await ended; await rm(root, { recursive: true }); });
  child.stderr.resume();
  const frames = [];
  const decoder = new FrameDecoder();
  child.stdout.on('data', data => decoder.push(data, value => frames.push(value.body)));
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (!(await predicate())) {
      if (exited || Date.now() >= deadline) throw new Error('Service observation unavailable');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return {
    frames, ended, until,
    send: body => child.stdin.write(encodeFrame(frame(body))),
    marker: async name => {
      try { return await readFile(join(root, name), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    },
    async start(selected = activation) {
      this.send({ kind: 'activate', data: selected });
      await until(() => frames.some(value => value.kind === 'ready'));
    },
    async close() {
      this.send({ kind: 'close', data: { instance: activation.instance } });
      assert.deepEqual(await ended, [0, null]);
    },
  };
}
const calling = `export default {activate(api) {api.register(api.contributions[0].id, async (input,meta) => {
  const result = await meta.services.call(api.services[0].handleId,'{"units":["unit-a"]}','service-call-a');
  return {kind:'succeeded',utf8:JSON.stringify(result)};
});}};`;

test('service descriptors precede activation and serial calls preserve context and all outcomes', { timeout: 7000 }, async t => {
  const h = await harness(t, `export default {activate(api) {
    if (!Object.isFrozen(api.services) || !Object.isFrozen(api.services[0])
      || !Object.isFrozen(api.services[0].limits) || api.services[0].effect !== 'proposal') throw new Error('Mutable descriptor');
    api.register(api.contributions[0].id, async (input,meta) => {
      if (meta.services.bindings !== api.services || !Object.isFrozen(meta.services)) throw new Error('Wrong bindings');
      const results=[];
      for (let i=0;i<3;i++) {
        const result=await meta.services.call(api.services[0].handleId,'{"units":["unit-a"]}',i===0?'explicit-call':undefined);
        if (!Object.isFrozen(result) || !Object.isFrozen(result.context) || !Object.isFrozen(result.outcome)) throw new Error('Mutable response');
        results.push(result.outcome.kind);
      }
      return {kind:'succeeded',utf8:JSON.stringify(results)};
    });
  }};`);
  await h.start();
  assert.deepEqual(h.frames[0].data, activation);
  h.send({ kind: 'invoke', data: invocation });
  const callIds = new Set();
  for (const kind of ['succeeded', 'failed', 'unknown']) {
    await h.until(() => h.frames.filter(value => value.kind === 'service-request').length > callIds.size);
    const request = h.frames.filter(value => value.kind === 'service-request').at(-1).data;
    assert.deepEqual(request.context, invocation.context);
    assert.equal(request.context.inputDigest, invocation.input.sha256);
    assert.notEqual(request.input.sha256, request.context.inputDigest);
    assert.equal(request.input.sha256, digest(request.input.utf8));
    assert.deepEqual(request.input.schema, binding.inputSchema);
    assert.ok(!callIds.has(request.callId));
    if (callIds.size === 0) assert.equal(request.callId, 'explicit-call');
    else assert.match(request.callId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    callIds.add(request.callId);
    h.send({ kind: 'service-response', data: response(request, kind) });
  }
  await h.until(() => h.frames.some(value => value.kind === 'result'));
  assert.deepEqual(JSON.parse(h.frames.at(-1).data.outcome.output.utf8), ['succeeded', 'failed', 'unknown']);
  await h.close();
});

test('service call rejects concurrency, invalid input and duplicate IDs without sending extra work', { timeout: 7000 }, async t => {
  const h = await harness(t, `export default {activate(api) {api.register(api.contributions[0].id, async (input,meta) => {
    const call = meta.services.call(api.services[0].handleId,'{}','one-call');
    const failures=[];
    for (const invoke of [
      ()=>meta.services.call(api.services[0].handleId,'{}','concurrent'),
    ]) {try {invoke(); failures.push(false)} catch {failures.push(true)}}
    await call;
    for (const invoke of [
      ()=>meta.services.call(api.services[0].handleId,'{}','one-call'),
      ()=>meta.services.call('other-handle','{}','unknown-handle'),
      ()=>meta.services.call(api.services[0].handleId,'{}','bad call'),
      ()=>meta.services.call(api.services[0].handleId,'x'.repeat(4097),'too-large'),
      ()=>meta.services.call(api.services[0].handleId,String.fromCharCode(0xd800),'surrogate'),
    ]) {try {invoke(); failures.push(false)} catch {failures.push(true)}}
    return {kind:'succeeded',utf8:JSON.stringify(failures)};
  });}};`);
  await h.start();
  h.send({ kind: 'invoke', data: invocation });
  await h.until(() => h.frames.length === 2);
  h.send({ kind: 'service-response', data: response(h.frames[1].data) });
  await h.until(() => h.frames.length === 3);
  assert.deepEqual(h.frames.map(value => value.kind), ['ready', 'service-request', 'result']);
  assert.deepEqual(JSON.parse(h.frames[2].data.outcome.output.utf8), [true, true, true, true, true, true]);
  await h.close();
});

test('cancel or close rejects the pending promise and disposes without a late result', { timeout: 10000 }, async t => {
  for (const cancel of [true, false]) {
    const h = await harness(t, `import {writeFile} from 'node:fs/promises';
      export default {activate(api) {
        api.onDispose(()=>writeFile('cleaned','yes'));
        api.register(api.contributions[0].id, async (input,meta) => {
          try {await meta.services.call(api.services[0].handleId,'{}','waiting-call'); throw new Error('Unexpected response')}
          catch (error) {if (!meta.signal.aborted) throw error; await writeFile('rejected','yes')}
          return {kind:'succeeded',utf8:'late'};
        });
      }};`);
    await h.start();
    h.send({ kind: 'invoke', data: invocation });
    await h.until(() => h.frames.some(value => value.kind === 'service-request'));
    if (cancel) {
      h.send({ kind: 'cancel', data: { dispatchId: invocation.context.dispatchId } });
      await h.until(() => h.frames.some(value => value.kind === 'cancelled'));
    }
    await h.close();
    assert.equal(await h.marker('rejected'), 'yes');
    assert.equal(await h.marker('cleaned'), 'yes');
    assert.deepEqual(h.frames.map(value => value.kind), cancel
      ? ['ready', 'service-request', 'cancelled', 'closed'] : ['ready', 'service-request', 'closed']);
  }
});

test('unawaited pending service calls fail the channel instead of emitting a proposal or hanging', { timeout: 5000 }, async t => {
  const h = await harness(t, `export default {activate(api) {api.register(api.contributions[0].id, (input,meta) => {
    meta.services.call(api.services[0].handleId,'{}','unawaited-call');
    return {kind:'succeeded',utf8:'not-safe'};
  });}};`);
  await h.start();
  h.send({ kind: 'invoke', data: invocation });
  assert.deepEqual(await h.ended, [1, null]);
  assert.deepEqual(h.frames.map(value => value.kind), ['ready', 'service-request']);
});

test('service responses require exact call, handle, original context, outcome schema and bytes', { timeout: 20000 }, async t => {
  for (const corruption of ['call', 'handle', 'context', 'schema', 'digest', 'limit', 'failed-schema', 'unknown-schema']) {
    const h = await harness(t, calling);
    await h.start();
    h.send({ kind: 'invoke', data: invocation });
    await h.until(() => h.frames.length === 2);
    const result = response(h.frames[1].data);
    switch (corruption) {
      case 'call': result.callId = 'other-call'; break;
      case 'handle': result.handleId = 'other-handle'; break;
      case 'context': result.context = { ...result.context, inputDigest: h.frames[1].data.input.sha256 }; break;
      case 'schema': result.outcome.output.schema = { ...binding.outputSchema, behaviorVersion: 2 }; break;
      case 'digest': result.outcome.output.utf8 += ' '; break;
      case 'limit': result.outcome.output.utf8 = 'x'.repeat(4097); result.outcome.output.sha256 = digest(result.outcome.output.utf8); break;
      case 'failed-schema': result.outcome = { kind: 'failed', error: result.outcome.output }; break;
      case 'unknown-schema': result.outcome = { kind: 'unknown', error: result.outcome.output }; break;
    }
    h.send({ kind: 'service-response', data: result });
    assert.deepEqual(await h.ended, [1, null], corruption);
    assert.deepEqual(h.frames.map(value => value.kind), ['ready', 'service-request'], corruption);
  }
});

test('unsolicited and cancelled service responses are rejected without invoking old callbacks', { timeout: 10000 }, async t => {
  for (const cancel of [false, true]) {
    const h = await harness(t, calling);
    await h.start();
    let request = { callId: 'never-sent', handleId: binding.handleId, context: invocation.context };
    if (cancel) {
      h.send({ kind: 'invoke', data: invocation });
      await h.until(() => h.frames.length === 2);
      request = h.frames[1].data;
      h.send({ kind: 'cancel', data: { dispatchId: invocation.context.dispatchId } });
      await h.until(() => h.frames.some(value => value.kind === 'cancelled'));
    }
    h.send({ kind: 'service-response', data: response(request) });
    assert.deepEqual(await h.ended, [1, null]);
    assert.ok(!h.frames.some(value => value.kind === 'result'));
  }
});

test('callbacks from an earlier invocation cannot send services during a later invocation', { timeout: 7000 }, async t => {
  const h = await harness(t, `let old;
    export default {activate(api) {api.register(api.contributions[0].id, async (input,meta) => {
      if (!old) {old=meta.services.call; return {kind:'succeeded',utf8:'first'}}
      let refused=false;
      try {old(api.services[0].handleId,'{}','old-call')} catch {refused=true}
      const response=await meta.services.call(api.services[0].handleId,'{}','current-call');
      return {kind:'succeeded',utf8:JSON.stringify({refused,kind:response.outcome.kind})};
    });}};`);
  await h.start();
  h.send({ kind: 'invoke', data: invocation });
  await h.until(() => h.frames.length === 2);
  const next = structuredClone(invocation); next.context.dispatchId = 'next-dispatch';
  h.send({ kind: 'invoke', data: next });
  await h.until(() => h.frames.length === 3);
  assert.equal(h.frames[2].kind, 'service-request');
  assert.equal(h.frames[2].data.callId, 'current-call');
  assert.deepEqual(h.frames[2].data.context, next.context);
  h.send({ kind: 'service-response', data: response(h.frames[2].data) });
  await h.until(() => h.frames.length === 4);
  assert.deepEqual(JSON.parse(h.frames[3].data.outcome.output.utf8), { refused: true, kind: 'succeeded' });
  await h.close();
});

test('service call count is bounded across invocations and not reset by successful calls', { timeout: 10000 }, async t => {
  const h = await harness(t, `let consumed=false; export default {activate(api) {api.register(api.contributions[0].id, async (input,meta) => {
    if (consumed) {
      let refused=false; try {meta.services.call(api.services[0].handleId,'{}','new-invocation-call')} catch {refused=true}
      return {kind:'succeeded',utf8:JSON.stringify({refused})};
    }
    for(let i=0;i<${PROCESS_PROFILE.maxServiceCalls};i++) await meta.services.call(api.services[0].handleId,'{}','bounded-'+i);
    consumed=true;
    let refused=false; try {meta.services.call(api.services[0].handleId,'{}','one-too-many')} catch {refused=true}
    return {kind:'succeeded',utf8:JSON.stringify({refused})};
  });}};`);
  await h.start();
  h.send({ kind: 'invoke', data: invocation });
  for (let index = 0; index < PROCESS_PROFILE.maxServiceCalls; index++) {
    await h.until(() => h.frames.filter(value => value.kind === 'service-request').length === index + 1);
    h.send({ kind: 'service-response', data: response(h.frames.at(-1).data) });
  }
  await h.until(() => h.frames.some(value => value.kind === 'result'));
  assert.equal(h.frames.filter(value => value.kind === 'service-request').length, PROCESS_PROFILE.maxServiceCalls);
  assert.deepEqual(JSON.parse(h.frames.at(-1).data.outcome.output.utf8), { refused: true });
  const next = structuredClone(invocation); next.context.dispatchId = 'after-call-budget';
  h.send({ kind: 'invoke', data: next });
  await h.until(() => h.frames.filter(value => value.kind === 'result').length === 2);
  assert.equal(h.frames.filter(value => value.kind === 'service-request').length, PROCESS_PROFILE.maxServiceCalls);
  assert.deepEqual(JSON.parse(h.frames.at(-1).data.outcome.output.utf8), { refused: true });
  await h.close();
});

test('service activation rejects duplicate selections and invalid semantic descriptors', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tsumugi-service-binding-test-'));
  t.after(() => rm(root, { recursive: true }));
  const entry = join(root, 'component.mjs');
  await writeFile(entry, 'export default {activate(api){api.register(api.contributions[0].id, ()=>({kind:"succeeded",utf8:"{}"}));}};');
  for (const corruption of ['handle', 'provider', 'count', 'generation', 'digest', 'concurrency', 'input', 'name']) {
    const selected = structuredClone(activation);
    switch (corruption) {
      case 'handle': selected.services.push({ ...binding, providerId: 'example.other' }); break;
      case 'provider': selected.services.push({ ...binding, handleId: 'other-handle', contract: {
        behaviorVersion: 1, schemaVersion: 1, id: binding.contract.id,
      } }); break;
      case 'count': selected.services = Array(PROCESS_PROFILE.maxServiceBindings + 1).fill(binding); break;
      case 'generation': selected.services[0].activationGeneration = 0; break;
      case 'digest': selected.services[0].configurationDigest = 'A'.repeat(64); break;
      case 'concurrency': selected.services[0].limits.concurrency = 2; break;
      case 'input': selected.services[0].limits.maxInputBytes = PROCESS_PROFILE.maxInvocationPayloadBytes + 1; break;
      case 'name': selected.services[0].providerId = 'example..provider'; break;
    }
    const session = new ComponentSession(entry, async () => { assert.fail('Invalid activation emitted a frame'); }, () => {}, () => {});
    // Structurally valid cases reach the semantic owner; generation=0 is also
    // rejected by the Rust-generated receiver before activation.
    assert.throws(() => session.receive(decodeFrame(encodeFrame(frame({ kind: 'activate', data: selected })).subarray(4))), undefined, corruption);
  }
});

test('pending call is installed before transport can synchronously deliver its response', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tsumugi-service-reentrant-test-'));
  t.after(() => rm(root, { recursive: true }));
  const entry = join(root, 'component.mjs');
  await writeFile(entry, calling);
  const sent = [];
  let failed = false;
  let finished = false;
  const session = new ComponentSession(entry, async value => {
    sent.push(value.body);
    if (value.body.kind === 'service-request') {
      session.receive(frame({ kind: 'service-response', data: response(value.body.data) }));
    }
  }, () => { failed = true; }, () => { finished = true; });
  const until = async predicate => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      assert.ok(!failed && Date.now() < deadline);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  session.receive(frame({ kind: 'activate', data: activation }));
  await until(() => sent.length === 1);
  session.receive(frame({ kind: 'invoke', data: invocation }));
  await until(() => sent.length === 3);
  assert.deepEqual(JSON.parse(sent[2].data.outcome.output.utf8), response(sent[1].data));
  session.receive(frame({ kind: 'close', data: { instance: activation.instance } }));
  await until(() => finished);
  assert.equal(failed, false);
});

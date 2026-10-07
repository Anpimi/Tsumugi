import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, encodeFrame } from '../dist/codec.js';
import { PROCESS_PROFILE } from '../dist/generated/protocol.js';

const fixture = JSON.parse(await readFile(new URL('../../../crates/plugin-sdk/tests/fixtures/invocation.request.json', import.meta.url), 'utf8')).body.data;
const activation = {
  provider: fixture.provider,
  services: [],
  capability: { contract: fixture.capability, inputSchema: fixture.input.schema, outputSchema: fixture.outputSchema,
    errorSchema: fixture.errorSchema, profiles: [fixture.profile], effect: 'read-only', permissions: [{ kind: 'captured-input' }],
    limits: { concurrency: 1, maxInputBytes: 1048576, maxOutputBytes: 65536, timeoutMs: 1000 } },
};
async function harness(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'tsumugi-component-test-'));
  const entry = join(root, 'component.mjs');
  await writeFile(entry, source);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url)), entry], { env: {}, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = once(child, 'exit');
  let exited = false;
  child.once('exit', () => { exited = true; });
  t.after(async () => { if (!exited) child.kill('SIGKILL'); await ended; await rm(root, { recursive: true }); });
  child.stderr.resume();
  const frames = [];
  const decoder = new FrameDecoder();
  child.stdout.on('data', data => decoder.push(data, frame => frames.push(frame.body)));
  const waitFor = async predicate => {
    const end = Date.now() + 2000;
    while (!(await predicate())) {
      if (exited || Date.now() >= end) throw new Error('Expected lifecycle observation unavailable');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return {
    frames,
    send: body => child.stdin.write(encodeFrame({ protocolVersion: 2, body })),
    sendBatch: bodies => child.stdin.write(Buffer.concat(bodies.map(body => encodeFrame({ protocolVersion: 2, body })))),
    waitFor,
    marker: async name => { try { return await readFile(join(root, name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } },
    ended,
  };
}
const imports = `import {writeFile} from 'node:fs/promises'; const delay = ms => new Promise(resolve => setTimeout(resolve,ms));`;

test('close during asynchronous activation suppresses Ready and waits for owned cleanup', { timeout: 5000 }, async t => {
  const h = await harness(t, `${imports}
    export default {async activate(api) {
      api.register(() => ({kind:'succeeded',utf8:'unused'}));
      api.onDispose(async () => {await delay(20); await writeFile('cleaned','yes')});
      await writeFile('entered','yes');
      await delay(150);
      if (!api.signal.aborted) throw new Error('Scope signal was not aborted');
    }};`);
  h.send({ kind: 'activate', data: activation });
  await h.waitFor(async () => await h.marker('entered') === 'yes');
  h.send({ kind: 'close', data: { provider: activation.provider } });
  assert.deepEqual(await h.ended, [0, null]);
  assert.deepEqual(h.frames.map(f => f.kind), ['closed']);
  assert.equal(await h.marker('cleaned'), 'yes');
});

test('cancel followed by close suppresses a late result and waits for async cleanup', { timeout: 5000 }, async t => {
  const h = await harness(t, `${imports}
    export default {activate(api) {
      api.onDispose(async () => {await delay(20); await writeFile('cleaned','yes')});
      api.register(async (input,meta) => {
        await writeFile('entered','yes'); await delay(150);
        if (!meta.signal.aborted || !api.signal.aborted) throw new Error('Missing cancellation');
        await writeFile('late','resolved'); return {kind:'succeeded',utf8:input.utf8};
      });
    }};`);
  h.send({ kind: 'activate', data: activation });
  await h.waitFor(() => h.frames.length === 1);
  h.send({ kind: 'invoke', data: fixture });
  await h.waitFor(async () => await h.marker('entered') === 'yes');
  h.send({ kind: 'cancel', data: { dispatchId: fixture.context.dispatchId } });
  h.send({ kind: 'close', data: { provider: activation.provider } });
  assert.deepEqual(await h.ended, [0, null]);
  assert.deepEqual(h.frames.map(f => f.kind), ['ready', 'cancelled', 'closed']);
  assert.equal(await h.marker('late'), 'resolved');
  assert.equal(await h.marker('cleaned'), 'yes');
});

test('channel refuses a different provider and emits no proposal', { timeout: 5000 }, async t => {
  const h = await harness(t, `export default {activate(api){api.register(() => ({kind:'succeeded',utf8:'unexpected'}));}};`);
  h.send({ kind: 'activate', data: activation });
  await h.waitFor(() => h.frames.length === 1);
  const wrong = structuredClone(fixture); wrong.provider.instanceId = 'different-instance';
  h.send({ kind: 'invoke', data: wrong });
  assert.deepEqual(await h.ended, [1, null]);
  assert.deepEqual(h.frames.map(f => f.kind), ['ready']);
});

test('component metadata exposes the immutable actual channel independently of payload claims', { timeout: 5000 }, async t => {
  const h = await harness(t, `export default {activate(api){api.register((input,meta) => {
    const claimed = JSON.parse(input.utf8).provider;
    let mutationRefused = false;
    try { meta.provider.plugin.id = claimed.plugin.id; } catch { mutationRefused = true; }
    return {kind:'succeeded',utf8:JSON.stringify({provider:meta.provider,
      frozen:Object.isFrozen(meta) && Object.isFrozen(meta.provider) && Object.isFrozen(meta.provider.plugin),
      mutationRefused})};
  });}};`);
  const request = structuredClone(fixture);
  request.input.utf8 = JSON.stringify({ provider: { plugin: { id: 'payload-forgery' } } });
  request.input.sha256 = createHash('sha256').update(request.input.utf8, 'utf8').digest('hex');
  request.context.inputDigest = request.input.sha256;
  h.send({ kind: 'activate', data: activation });
  await h.waitFor(() => h.frames.length === 1);
  h.send({ kind: 'invoke', data: request });
  await h.waitFor(() => h.frames.length === 2);
  const result = h.frames[1].data;
  assert.equal(result.outcome.kind, 'succeeded');
  assert.deepEqual(JSON.parse(result.outcome.output.utf8), {
    provider: activation.provider, frozen: true, mutationRefused: true,
  });
  assert.deepEqual(result.provider, activation.provider);
  h.send({ kind: 'close', data: { provider: activation.provider } });
  assert.deepEqual(await h.ended, [0, null]);
});

test('cancelled queued invocation never enters the component handler', { timeout: 5000 }, async t => {
  const h = await harness(t, `${imports} export default {activate(api){
    api.register(async () => {await writeFile('entered','yes'); return {kind:'succeeded',utf8:'unexpected'}});
  }};`);
  h.send({ kind: 'activate', data: activation });
  await h.waitFor(() => h.frames.length === 1);
  h.sendBatch([
    { kind: 'invoke', data: fixture },
    { kind: 'cancel', data: { dispatchId: fixture.context.dispatchId } },
    { kind: 'close', data: { provider: activation.provider } },
  ]);
  assert.deepEqual(await h.ended, [0, null]);
  assert.deepEqual(h.frames.map(f => f.kind), ['ready', 'cancelled', 'closed']);
  assert.equal(await h.marker('entered'), '');
});

test('a completed result permits the next call before transport flush acknowledgement', { timeout: 5000 }, async t => {
  const { ComponentSession } = await import('../dist/component.js');
  const root = await mkdtemp(join(tmpdir(), 'tsumugi-component-flush-'));
  t.after(() => rm(root, { recursive: true }));
  const entry = join(root, 'component.mjs');
  await writeFile(entry, `export default {activate(api){api.register(input=>({kind:'succeeded',utf8:input.utf8}));}};`);
  const sent = [];
  const flushes = [];
  let failed = false;
  let finished = false;
  const session = new ComponentSession(entry, async frame => {
    sent.push(frame.body);
    if (frame.body.kind === 'result') await new Promise(resolve => flushes.push(resolve));
  }, () => { failed = true; }, () => { finished = true; });
  const until = async predicate => {
    const end = Date.now() + 2000;
    while (!predicate()) { assert.ok(!failed && Date.now() < end); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  session.receive({ protocolVersion: 2, body: { kind: 'activate', data: activation } });
  await until(() => sent.length === 1);
  session.receive({ protocolVersion: 2, body: { kind: 'invoke', data: fixture } });
  await until(() => sent.length === 2);
  const next = structuredClone(fixture); next.context.dispatchId = 'dispatch-next';
  session.receive({ protocolVersion: 2, body: { kind: 'invoke', data: next } });
  await until(() => sent.length === 3);
  assert.equal(sent[2].data.context.dispatchId, 'dispatch-next');
  for (const resolve of flushes) resolve();
  session.receive({ protocolVersion: 2, body: { kind: 'close', data: { provider: activation.provider } } });
  await until(() => finished);
  assert.equal(failed, false);
});

test('complete result budgets can exceed raw declaration limits without rejecting bounded output', { timeout: 10000 }, async t => {
  for (const kind of ['succeeded', 'failed', 'unknown']) {
    const h = await harness(t, `export default {activate(api){api.register(() => ({kind:${JSON.stringify(kind)},utf8:'éé'}));}};`);
    const captured = structuredClone(activation);
    captured.capability.limits.maxOutputBytes = 4;
    const request = structuredClone(fixture);
    request.maxResultBytes = 65536;
    h.send({ kind: 'activate', data: captured });
    await h.waitFor(() => h.frames.length === 1);
    h.send({ kind: 'invoke', data: request });
    await h.waitFor(() => h.frames.length === 2);
    const result = h.frames[1];
    assert.equal(result.kind, 'result');
    assert.equal(result.data.outcome.kind, kind);
    const payload = result.data.outcome[kind === 'succeeded' ? 'output' : 'error'];
    assert.equal(payload.utf8, 'éé');
    assert.equal(Buffer.byteLength(payload.utf8), captured.capability.limits.maxOutputBytes);
    const framed = encodeFrame({ protocolVersion: 2, body: result });
    assert.ok(framed.length - 4 > captured.capability.limits.maxOutputBytes);
    assert.ok(framed.length - 4 <= request.maxResultBytes);
    h.send({ kind: 'close', data: { provider: captured.provider } });
    assert.deepEqual(await h.ended, [0, null]);
  }
});

test('raw output exceeding the captured declaration is rejected for every outcome', { timeout: 10000 }, async t => {
  for (const kind of ['succeeded', 'failed', 'unknown']) {
    const h = await harness(t, `export default {activate(api){api.register(() => ({kind:${JSON.stringify(kind)},utf8:'ééx'}));}};`);
    const captured = structuredClone(activation);
    captured.capability.limits.maxOutputBytes = 4;
    h.send({ kind: 'activate', data: captured });
    await h.waitFor(() => h.frames.length === 1);
    h.send({ kind: 'invoke', data: fixture });
    assert.deepEqual(await h.ended, [1, null]);
    assert.deepEqual(h.frames.map(frame => frame.kind), ['ready']);
  }
});

test('result frame budget includes opaque payload escaping and metadata', { timeout: 5000 }, async t => {
  const utf8 = '\u0001'.repeat(128);
  const h = await harness(t, `export default {activate(api){api.register(() => ({kind:'succeeded',utf8:${JSON.stringify(utf8)}}));}};`);
  const captured = structuredClone(activation);
  captured.capability.limits.maxOutputBytes = 1024;
  const request = structuredClone(fixture);
  const result = { context: request.context, provider: captured.provider, capability: request.capability,
    profile: request.profile, resultId: '11111111-1111-4111-8111-111111111111',
    outcome: { kind: 'succeeded', output: { schema: request.outputSchema, utf8,
      sha256: createHash('sha256').update(utf8, 'utf8').digest('hex') } } };
  request.maxResultBytes = encodeFrame({ protocolVersion: 2, body: { kind: 'result', data: result } }).length - 5;
  assert.ok(Buffer.byteLength(utf8) < captured.capability.limits.maxOutputBytes);
  assert.ok(Buffer.byteLength(utf8) < request.maxResultBytes);
  h.send({ kind: 'activate', data: captured });
  await h.waitFor(() => h.frames.length === 1);
  h.send({ kind: 'invoke', data: request });
  assert.deepEqual(await h.ended, [1, null]);
  assert.deepEqual(h.frames.map(frame => frame.kind), ['ready']);
});

test('a larger raw declaration cannot enlarge the generated SDK payload ceiling', { timeout: 10000 }, async t => {
  const limit = PROCESS_PROFILE.maxInvocationPayloadBytes;
  const captured = structuredClone(activation);
  captured.capability.limits.maxInputBytes = limit + 1;
  captured.capability.limits.maxOutputBytes = limit + 1;
  const outgoing = await harness(t, `export default {activate(api){api.register(() => ({kind:'succeeded',utf8:'x'.repeat(${limit + 1})}));}};`);
  outgoing.send({ kind: 'activate', data: captured });
  await outgoing.waitFor(() => outgoing.frames.length === 1);
  const request = structuredClone(fixture);
  request.maxResultBytes = PROCESS_PROFILE.maxFrameBytes;
  outgoing.send({ kind: 'invoke', data: request });
  assert.deepEqual(await outgoing.ended, [1, null]);
  assert.deepEqual(outgoing.frames.map(frame => frame.kind), ['ready']);

  const incoming = await harness(t, `${imports} export default {activate(api){api.register(async () => {
    await writeFile('entered','yes'); return {kind:'succeeded',utf8:'unexpected'};
  });}};`);
  incoming.send({ kind: 'activate', data: captured });
  await incoming.waitFor(() => incoming.frames.length === 1);
  const oversized = structuredClone(request);
  oversized.input.utf8 = 'x'.repeat(limit + 1);
  oversized.input.sha256 = createHash('sha256').update(oversized.input.utf8, 'utf8').digest('hex');
  oversized.context.inputDigest = oversized.input.sha256;
  incoming.send({ kind: 'invoke', data: oversized });
  assert.deepEqual(await incoming.ended, [1, null]);
  assert.deepEqual(incoming.frames.map(frame => frame.kind), ['ready']);
  assert.equal(await incoming.marker('entered'), '');
});

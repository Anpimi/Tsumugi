import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, encodeFrame } from '../dist/codec.js';

const fixture = JSON.parse(await readFile(new URL('../../../crates/plugin-sdk/tests/fixtures/invocation.request.json', import.meta.url), 'utf8')).body.data;
const activation = {
  provider: fixture.provider,
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
    send: body => child.stdin.write(encodeFrame({ protocolVersion: 1, body })),
    sendBatch: bodies => child.stdin.write(Buffer.concat(bodies.map(body => encodeFrame({ protocolVersion: 1, body })))),
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
  session.receive({ protocolVersion: 1, body: { kind: 'activate', data: activation } });
  await until(() => sent.length === 1);
  session.receive({ protocolVersion: 1, body: { kind: 'invoke', data: fixture } });
  await until(() => sent.length === 2);
  const next = structuredClone(fixture); next.context.dispatchId = 'dispatch-next';
  session.receive({ protocolVersion: 1, body: { kind: 'invoke', data: next } });
  await until(() => sent.length === 3);
  assert.equal(sent[2].data.context.dispatchId, 'dispatch-next');
  for (const resolve of flushes) resolve();
  session.receive({ protocolVersion: 1, body: { kind: 'close', data: { provider: activation.provider } } });
  await until(() => finished);
  assert.equal(failed, false);
});

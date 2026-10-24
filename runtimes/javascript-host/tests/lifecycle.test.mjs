import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FrameDecoder, encodeFrame } from '../dist/codec.js';
import { PROCESS_PROFILE } from '../dist/generated/protocol.js';

const fixture = JSON.parse(await readFile(new URL('../../../crates/plugin-sdk/tests/fixtures/invocation.request.json', import.meta.url), 'utf8')).body.data;
const instanceOf = ({ contributionId, ...instance }) => instance;
const activation = {
  instance: instanceOf(fixture.provider),
  services: [],
  capabilities: [{ contributionId: fixture.provider.contributionId, capability: { contract: fixture.capability, inputSchema: fixture.input.schema, outputSchema: fixture.outputSchema,
    errorSchema: fixture.errorSchema, profiles: [fixture.profile], effect: 'read-only', permissions: [{ kind: 'captured-input' }],
    limits: { concurrency: 1, maxInputBytes: 1048576, maxOutputBytes: 65536, timeoutMs: 1000 }
  } }],
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
    send: body => child.stdin.write(encodeFrame({ protocolVersion: PROCESS_PROFILE.protocolVersion, body })),
    sendBatch: bodies => child.stdin.write(Buffer.concat(bodies.map(body => encodeFrame({ protocolVersion: PROCESS_PROFILE.protocolVersion, body })))),
    waitFor,
    marker: async name => { try { return await readFile(join(root, name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } },
    writeMarker: (name, value) => writeFile(join(root, name), value),
    ended,
  };
}
const imports = `import {writeFile} from 'node:fs/promises'; const delay = ms => new Promise(resolve => setTimeout(resolve,ms));`;

function multiActivation() {
  const captured = structuredClone(activation);
  const second = structuredClone(captured.capabilities[0]);
  second.contributionId = 'second';
  for (const key of ['contract', 'inputSchema', 'outputSchema', 'errorSchema']) second.capability[key].id += '-second';
  second.capability.profiles[0].id += '-second';
  captured.capabilities.push(second);
  return captured;
}
function requestFor(captured, index, dispatchId) {
  const member = captured.capabilities[index];
  const request = structuredClone(fixture);
  request.provider = { ...structuredClone(captured.instance), contributionId: member.contributionId };
  request.context.dispatchId = dispatchId;
  request.capability = structuredClone(member.capability.contract);
  request.input.schema = structuredClone(member.capability.inputSchema);
  request.outputSchema = structuredClone(member.capability.outputSchema);
  request.errorSchema = structuredClone(member.capability.errorSchema);
  request.profile = structuredClone(member.capability.profiles[0]);
  return request;
}

test('the runtime refuses empty, duplicate, oversized and invalid capability rosters before setup', async () => {
  const { ComponentSession } = await import('../dist/component.js');
  for (const change of [
    value => { value.capabilities = []; },
    value => { value.capabilities.push(structuredClone(value.capabilities[0])); },
    value => { value.capabilities = Array.from({ length: PROCESS_PROFILE.maxCapabilities + 1 }, (_, index) => ({ ...value.capabilities[0], contributionId: `member-${index}` })); },
    value => { value.capabilities[0].contributionId = 'invalid member'; },
  ]) {
    const captured = structuredClone(activation);
    change(captured);
    const session = new ComponentSession('/unused/component.mjs', () => assert.fail('Unexpected frame'), () => assert.fail('Unexpected asynchronous setup'), () => assert.fail('Unexpected close'));
    assert.throws(() => session.receive({ protocolVersion: PROCESS_PROFILE.protocolVersion, body: { kind: 'activate', data: captured } }), /Invalid capability roster/);
  }
});

test('Ready waits for complete asynchronous setup and each roster member receives its exact invocation', { timeout: 5000 }, async t => {
  const captured = multiActivation();
  const h = await harness(t, `import {readFile,writeFile} from 'node:fs/promises';
    export default {async activate(api) {
      if ('contribution' in api || !Object.isFrozen(api.instance) || !Object.isFrozen(api.instance.plugin)
        || !Object.isFrozen(api.contributions) || api.contributions.some(c=>!Object.isFrozen(c) || !Object.isFrozen(c.contract))) throw new Error('Facade mismatch');
      for (const member of api.contributions) api.register(member.id, (input,meta) => {
        if (meta.provider.contributionId !== member.id) throw new Error('Wrong handler');
        return {kind:'succeeded',utf8:JSON.stringify({id:member.id,provider:meta.provider})};
      });
      await writeFile('setup-waiting','yes');
      for (;;) {
        try { await readFile('release-setup'); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve=>setTimeout(resolve,5));
      }
    }};`);
  h.send({ kind: 'activate', data: captured });
  await h.waitFor(async () => await h.marker('setup-waiting') === 'yes');
  assert.deepEqual(h.frames, []);
  await h.writeMarker('release-setup', 'yes');
  await h.waitFor(() => h.frames.length === 1);
  assert.deepEqual(h.frames[0], { kind: 'ready', data: captured });
  for (const index of [1, 0, 1]) {
    const request = requestFor(captured, index, `member-call-${h.frames.length}`);
    request.context.projectId += `-${index}`;
    h.send({ kind: 'invoke', data: request });
    const count = h.frames.length;
    await h.waitFor(() => h.frames.length > count);
    const result = h.frames.at(-1).data;
    assert.deepEqual(result.provider, request.provider);
    assert.deepEqual(result.context, request.context);
    assert.deepEqual(result.capability, request.capability);
    assert.deepEqual(result.outcome.output.schema, request.outputSchema);
    assert.deepEqual(JSON.parse(result.outcome.output.utf8), { id: request.provider.contributionId, provider: request.provider });
  }
  h.send({ kind: 'close', data: { instance: captured.instance } });
  assert.deepEqual(await h.ended, [0, null]);
  assert.deepEqual(h.frames.at(-1), { kind: 'closed', data: { instance: captured.instance } });
});

for (const failure of ['missing', 'duplicate', 'extra', 'old-api', 'partial-throw']) {
  test(`incomplete setup ${failure} disposes the entire roster without Ready`, { timeout: 5000 }, async t => {
    const h = await harness(t, `${imports} export default {async activate(api) {
      api.onDispose(async()=>{await delay(10);await writeFile('cleaned','yes')});
      const handler=()=>({kind:'succeeded',utf8:'unexpected'});
      if (${JSON.stringify(failure)}==='old-api') { try { api.register(handler); } catch {} return; }
      api.register(api.contributions[0].id,handler);
      if (${JSON.stringify(failure)}==='missing') return;
      if (${JSON.stringify(failure)}==='partial-throw') throw new Error('Partial setup failure');
      api.register(api.contributions[1].id,handler);
      // Even a component that catches a registration error cannot publish Ready.
      try { api.register(${JSON.stringify(failure)}==='extra'?'undeclared':api.contributions[0].id,handler); } catch {}
    }};`);
    h.send({ kind: 'activate', data: multiActivation() });
    assert.deepEqual(await h.ended, [1, null]);
    assert.deepEqual(h.frames, []);
    assert.equal(await h.marker('cleaned'), 'yes');
  });
}

test('a caught late registration invalidates the old callable set and waits for cleanup', { timeout: 5000 }, async t => {
  const h = await harness(t, `${imports} export default {activate(api) {
    api.onDispose(async()=>{await delay(10);await writeFile('cleaned','yes')});
    for (const member of api.contributions) api.register(member.id,()=>{
      try { api.register(member.id,()=>({kind:'succeeded',utf8:'replacement'})); } catch {}
      return {kind:'succeeded',utf8:'unexpected'};
    });
  }};`);
  const captured = multiActivation();
  h.send({ kind: 'activate', data: captured });
  await h.waitFor(() => h.frames.length === 1);
  h.send({ kind: 'invoke', data: requestFor(captured, 1, 'late-register') });
  assert.deepEqual(await h.ended, [1, null]);
  assert.deepEqual(h.frames.map(frame => frame.kind), ['ready']);
  assert.equal(await h.marker('cleaned'), 'yes');
});

for (const mismatch of ['member', 'schema', 'profile', 'null-profile', 'instance', 'generation', 'close-instance']) {
  test(`the frozen roster refuses ${mismatch} substitution`, { timeout: 5000 }, async t => {
    const h = await harness(t, `export default {activate(api) {
      for (const member of api.contributions) api.register(member.id,()=>({kind:'succeeded',utf8:'unexpected'}));
    }};`);
    const captured = multiActivation();
    h.send({ kind: 'activate', data: captured });
    await h.waitFor(() => h.frames.length === 1);
    const request = requestFor(captured, 1, 'wrong-member-call');
    if (mismatch === 'member') request.provider.contributionId = 'undeclared';
    if (mismatch === 'schema') request.input.schema = fixture.input.schema;
    if (mismatch === 'profile') request.profile = fixture.profile;
    if (mismatch === 'null-profile') request.profile = null;
    if (mismatch === 'instance') request.provider.instanceId += '-wrong';
    if (mismatch === 'generation') request.provider.activationGeneration += 1;
    h.send(mismatch === 'close-instance'
      ? { kind: 'close', data: { instance: { ...captured.instance, activationGeneration: captured.instance.activationGeneration + 1 } } }
      : { kind: 'invoke', data: request });
    assert.deepEqual(await h.ended, [1, null]);
    assert.deepEqual(h.frames.map(frame => frame.kind), ['ready']);
  });
}

test('output limits belong to the selected member rather than the first declaration', { timeout: 5000 }, async t => {
  const h = await harness(t, `export default {activate(api) {
    for (const member of api.contributions) api.register(member.id,()=>({kind:'succeeded',utf8:'ééx'}));
  }};`);
  const captured = multiActivation();
  captured.capabilities[1].capability.limits.maxOutputBytes = 4;
  h.send({ kind: 'activate', data: captured });
  await h.waitFor(() => h.frames.length === 1);
  h.send({ kind: 'invoke', data: requestFor(captured, 1, 'member-output-limit') });
  assert.deepEqual(await h.ended, [1, null]);
  assert.deepEqual(h.frames.map(frame => frame.kind), ['ready']);
});

test('close during asynchronous activation suppresses Ready and waits for owned cleanup', { timeout: 5000 }, async t => {
  const h = await harness(t, `${imports}
    export default {async activate(api) {
      api.register(api.contributions[0].id, () => ({kind:'succeeded',utf8:'unused'}));
      api.onDispose(async () => {await delay(20); await writeFile('cleaned','yes')});
      await writeFile('entered','yes');
      await delay(150);
      if (!api.signal.aborted) throw new Error('Scope signal was not aborted');
    }};`);
  h.send({ kind: 'activate', data: activation });
  await h.waitFor(async () => await h.marker('entered') === 'yes');
  h.send({ kind: 'close', data: { instance: activation.instance } });
  assert.deepEqual(await h.ended, [0, null]);
  assert.deepEqual(h.frames.map(f => f.kind), ['closed']);
  assert.equal(await h.marker('cleaned'), 'yes');
});

for (const stage of ['close', 'activation-failure']) {
  test(`${stage} waits for every concurrent cleanup despite synchronous and asynchronous failures`, { timeout: 5000 }, async t => {
    const h = await harness(t, `import {readFile,writeFile} from 'node:fs/promises';
      export default {activate(api) {
        api.onDispose(() => {throw new Error('Synchronous cleanup failure')});
        api.onDispose(async () => {
          await writeFile('cleanup-waiting','yes');
          for (;;) {
            try {await readFile('cleanup-peer'); await readFile('release-cleanup'); break}
            catch (error) {if (error.code !== 'ENOENT') throw error}
            await new Promise(resolve => setTimeout(resolve,5));
          }
          await writeFile('cleaned','yes');
        });
        api.onDispose(async () => {
          await writeFile('cleanup-peer','yes');
          throw new Error('Asynchronous cleanup failure');
        });
        api.register(api.contributions[0].id, () => ({kind:'succeeded',utf8:'unused'}));
        if (${JSON.stringify(stage)} === 'activation-failure') throw new Error('Setup failed');
      }};`);
    h.send({ kind: 'activate', data: activation });
    if (stage === 'close') {
      await h.waitFor(() => h.frames.length === 1);
      h.send({ kind: 'close', data: { instance: activation.instance } });
    }
    await h.waitFor(async () => await h.marker('cleanup-waiting') === 'yes'
      && await h.marker('cleanup-peer') === 'yes');
    assert.deepEqual(h.frames.map(frame => frame.kind), stage === 'close' ? ['ready'] : []);
    assert.equal(await h.marker('cleaned'), '');
    await h.writeMarker('release-cleanup', 'yes');
    assert.deepEqual(await h.ended, [1, null]);
    assert.equal(await h.marker('cleaned'), 'yes');
    assert.ok(!h.frames.some(frame => frame.kind === 'closed'));
  });
}

test('duplicate Close is refused without reentering cleanup or emitting a second Closed', { timeout: 5000 }, async t => {
  const { ComponentSession } = await import('../dist/component.js');
  const root = await mkdtemp(join(tmpdir(), 'tsumugi-component-close-'));
  t.after(() => rm(root, { recursive: true }));
  const entry = join(root, 'component.mjs');
  await writeFile(entry, `let entered, release;
    export const observations = {cleanups:0};
    export const cleanupStarted = new Promise(resolve => {entered=resolve});
    export const finishCleanup = () => release();
    export default {activate(api) {
      api.register(api.contributions[0].id, input => ({kind:'succeeded',utf8:input.utf8}));
      api.onDispose(async () => {
        observations.cleanups++; entered();
        await new Promise(resolve => {release=resolve});
      });
    }};`);
  const component = await import(pathToFileURL(entry).href);
  const sent = [];
  let failures = 0;
  let finishes = 0;
  const session = new ComponentSession(entry, async frame => { sent.push(frame.body); },
    () => { failures++; }, () => { finishes++; });
  const until = async predicate => {
    const end = Date.now() + 2000;
    while (!predicate()) { assert.ok(failures === 0 && Date.now() < end); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  session.receive({ protocolVersion: PROCESS_PROFILE.protocolVersion, body: { kind: 'activate', data: activation } });
  await until(() => sent.length === 1);
  const close = { protocolVersion: PROCESS_PROFILE.protocolVersion, body: { kind: 'close', data: { instance: activation.instance } } };
  session.receive(close);
  await component.cleanupStarted;
  assert.throws(() => session.receive(close), /Unexpected process frame/);
  assert.equal(component.observations.cleanups, 1);
  assert.deepEqual(sent.map(frame => frame.kind), ['ready']);
  assert.equal(finishes, 0);
  component.finishCleanup();
  await until(() => finishes === 1);
  assert.throws(() => session.receive(close), /Unexpected process frame/);
  assert.equal(component.observations.cleanups, 1);
  assert.deepEqual(sent.map(frame => frame.kind), ['ready', 'closed']);
  assert.equal(failures, 0);
});

test('cancel followed by close suppresses a late result and waits for async cleanup', { timeout: 5000 }, async t => {
  const h = await harness(t, `${imports}
    export default {activate(api) {
      api.onDispose(async () => {await delay(20); await writeFile('cleaned','yes')});
      api.register(api.contributions[0].id, async (input,meta) => {
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
  h.send({ kind: 'close', data: { instance: activation.instance } });
  assert.deepEqual(await h.ended, [0, null]);
  assert.deepEqual(h.frames.map(f => f.kind), ['ready', 'cancelled', 'closed']);
  assert.equal(await h.marker('late'), 'resolved');
  assert.equal(await h.marker('cleaned'), 'yes');
});

test('cancelled old channel cannot publish a late result or register during a new channel invocation', { timeout: 5000 }, async t => {
  const a = await harness(t, `${imports}
    export default {activate(api) {
      api.onDispose(async () => {
        const refused = callback => { try { callback(); return null; } catch (error) { return error.message; } };
        await writeFile('old-denied', JSON.stringify([
          refused(() => api.register(api.contributions[0].id, () => ({kind:'succeeded',utf8:'obsolete'}))),
          refused(() => api.onDispose(() => {}))
        ]));
        await delay(20); await writeFile('cleaned','yes');
      });
      api.register(api.contributions[0].id, async (input,meta) => {
        await writeFile('entered','yes'); await delay(150);
        if (!meta.signal.aborted || !api.signal.aborted) throw new Error('Missing original cancellation');
        await writeFile('late','resolved'); return {kind:'succeeded',utf8:input.utf8};
      });
    }};`);
  const b = await harness(t, `${imports}
    export default {activate(api) {
      api.onDispose(async () => { await writeFile('cleaned','yes'); });
      api.register(api.contributions[0].id, async (input,meta) => {
        await writeFile('entered','yes'); await delay(400);
        if (meta.signal.aborted || api.signal.aborted) throw new Error('New channel was cancelled');
        await writeFile('returned','yes'); return {kind:'succeeded',utf8:input.utf8};
      });
    }};`);
  const next = structuredClone(fixture);
  next.provider.plugin.version = '0.2.0';
  next.provider.packageDigest = 'b'.repeat(64);
  next.provider.instanceId += '-new';
  next.context.dispatchId += '-new';
  const nextActivation = { ...structuredClone(activation), instance: instanceOf(next.provider) };
  a.send({ kind: 'activate', data: activation });
  b.send({ kind: 'activate', data: nextActivation });
  await a.waitFor(() => a.frames.length === 1);
  await b.waitFor(() => b.frames.length === 1);
  a.send({ kind: 'invoke', data: fixture });
  await a.waitFor(async () => await a.marker('entered') === 'yes');
  b.send({ kind: 'invoke', data: next });
  await b.waitFor(async () => await b.marker('entered') === 'yes');
  a.send({ kind: 'cancel', data: { dispatchId: fixture.context.dispatchId } });
  a.send({ kind: 'close', data: { instance: activation.instance } });
  assert.deepEqual(await a.ended, [0, null]);
  assert.deepEqual(a.frames.map(frame => frame.kind), ['ready', 'cancelled', 'closed']);
  assert.equal(await a.marker('late'), 'resolved');
  assert.equal(await a.marker('cleaned'), 'yes');
  assert.deepEqual(JSON.parse(await a.marker('old-denied')), ['Inactive component', 'Inactive component']);
  assert.deepEqual(b.frames.map(frame => frame.kind), ['ready']);
  assert.equal(await b.marker('cleaned'), '');
  await b.waitFor(() => b.frames.some(frame => frame.kind === 'result'));
  const result = b.frames.find(frame => frame.kind === 'result').data;
  assert.deepEqual(result.context, next.context);
  assert.deepEqual(result.provider, next.provider);
  assert.equal(result.outcome.kind, 'succeeded');
  assert.equal(result.outcome.output.utf8, next.input.utf8);
  b.send({ kind: 'close', data: { instance: nextActivation.instance } });
  assert.deepEqual(await b.ended, [0, null]);
  assert.equal(await b.marker('returned'), 'yes');
  assert.equal(await b.marker('cleaned'), 'yes');
  assert.deepEqual(b.frames.map(frame => frame.kind), ['ready', 'result', 'closed']);
});

test('channel refuses a different provider and emits no proposal', { timeout: 5000 }, async t => {
  const h = await harness(t, `export default {activate(api){api.register(api.contributions[0].id, () => ({kind:'succeeded',utf8:'unexpected'}));}};`);
  h.send({ kind: 'activate', data: activation });
  await h.waitFor(() => h.frames.length === 1);
  const wrong = structuredClone(fixture); wrong.provider.instanceId = 'different-instance';
  h.send({ kind: 'invoke', data: wrong });
  assert.deepEqual(await h.ended, [1, null]);
  assert.deepEqual(h.frames.map(f => f.kind), ['ready']);
});

test('component metadata exposes the immutable actual channel independently of payload claims', { timeout: 5000 }, async t => {
  const h = await harness(t, `export default {activate(api){api.register(api.contributions[0].id, (input,meta) => {
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
    provider: fixture.provider, frozen: true, mutationRefused: true,
  });
  assert.deepEqual(result.provider, fixture.provider);
  h.send({ kind: 'close', data: { instance: activation.instance } });
  assert.deepEqual(await h.ended, [0, null]);
});

test('cancelled queued invocation never enters the component handler', { timeout: 5000 }, async t => {
  const h = await harness(t, `${imports} export default {activate(api){
    api.register(api.contributions[0].id, async () => {await writeFile('entered','yes'); return {kind:'succeeded',utf8:'unexpected'}});
  }};`);
  h.send({ kind: 'activate', data: activation });
  await h.waitFor(() => h.frames.length === 1);
  h.sendBatch([
    { kind: 'invoke', data: fixture },
    { kind: 'cancel', data: { dispatchId: fixture.context.dispatchId } },
    { kind: 'close', data: { instance: activation.instance } },
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
  await writeFile(entry, `export default {activate(api){api.register(api.contributions[0].id, input=>({kind:'succeeded',utf8:input.utf8}));}};`);
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
  session.receive({ protocolVersion: PROCESS_PROFILE.protocolVersion, body: { kind: 'activate', data: activation } });
  await until(() => sent.length === 1);
  session.receive({ protocolVersion: PROCESS_PROFILE.protocolVersion, body: { kind: 'invoke', data: fixture } });
  await until(() => sent.length === 2);
  const next = structuredClone(fixture); next.context.dispatchId = 'dispatch-next';
  session.receive({ protocolVersion: PROCESS_PROFILE.protocolVersion, body: { kind: 'invoke', data: next } });
  await until(() => sent.length === 3);
  assert.equal(sent[2].data.context.dispatchId, 'dispatch-next');
  for (const resolve of flushes) resolve();
  session.receive({ protocolVersion: PROCESS_PROFILE.protocolVersion, body: { kind: 'close', data: { instance: activation.instance } } });
  await until(() => finished);
  assert.equal(failed, false);
});

test('complete result budgets can exceed raw declaration limits without rejecting bounded output', { timeout: 10000 }, async t => {
  for (const kind of ['succeeded', 'failed', 'unknown']) {
    const h = await harness(t, `export default {activate(api){api.register(api.contributions[0].id, () => ({kind:${JSON.stringify(kind)},utf8:'éé'}));}};`);
    const captured = structuredClone(activation);
    captured.capabilities[0].capability.limits.maxOutputBytes = 4;
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
    assert.equal(Buffer.byteLength(payload.utf8), captured.capabilities[0].capability.limits.maxOutputBytes);
    const framed = encodeFrame({ protocolVersion: PROCESS_PROFILE.protocolVersion, body: result });
    assert.ok(framed.length - 4 > captured.capabilities[0].capability.limits.maxOutputBytes);
    assert.ok(framed.length - 4 <= request.maxResultBytes);
    h.send({ kind: 'close', data: { instance: captured.instance } });
    assert.deepEqual(await h.ended, [0, null]);
  }
});

test('raw output exceeding the captured declaration is rejected for every outcome', { timeout: 10000 }, async t => {
  for (const kind of ['succeeded', 'failed', 'unknown']) {
    const h = await harness(t, `export default {activate(api){api.register(api.contributions[0].id, () => ({kind:${JSON.stringify(kind)},utf8:'ééx'}));}};`);
    const captured = structuredClone(activation);
    captured.capabilities[0].capability.limits.maxOutputBytes = 4;
    h.send({ kind: 'activate', data: captured });
    await h.waitFor(() => h.frames.length === 1);
    h.send({ kind: 'invoke', data: fixture });
    assert.deepEqual(await h.ended, [1, null]);
    assert.deepEqual(h.frames.map(frame => frame.kind), ['ready']);
  }
});

test('result frame budget includes opaque payload escaping and metadata', { timeout: 5000 }, async t => {
  const utf8 = '\u0001'.repeat(128);
  const h = await harness(t, `export default {activate(api){api.register(api.contributions[0].id, () => ({kind:'succeeded',utf8:${JSON.stringify(utf8)}}));}};`);
  const captured = structuredClone(activation);
  captured.capabilities[0].capability.limits.maxOutputBytes = 1024;
  const request = structuredClone(fixture);
  const result = { context: request.context, provider: fixture.provider, capability: request.capability,
    profile: request.profile, resultId: '11111111-1111-4111-8111-111111111111',
    outcome: { kind: 'succeeded', output: { schema: request.outputSchema, utf8,
      sha256: createHash('sha256').update(utf8, 'utf8').digest('hex') } } };
  request.maxResultBytes = encodeFrame({ protocolVersion: PROCESS_PROFILE.protocolVersion, body: { kind: 'result', data: result } }).length - 5;
  assert.ok(Buffer.byteLength(utf8) < captured.capabilities[0].capability.limits.maxOutputBytes);
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
  captured.capabilities[0].capability.limits.maxInputBytes = limit + 1;
  captured.capabilities[0].capability.limits.maxOutputBytes = limit + 1;
  const outgoing = await harness(t, `export default {activate(api){api.register(api.contributions[0].id, () => ({kind:'succeeded',utf8:'x'.repeat(${limit + 1})}));}};`);
  outgoing.send({ kind: 'activate', data: captured });
  await outgoing.waitFor(() => outgoing.frames.length === 1);
  const request = structuredClone(fixture);
  request.maxResultBytes = PROCESS_PROFILE.maxFrameBytes;
  outgoing.send({ kind: 'invoke', data: request });
  assert.deepEqual(await outgoing.ended, [1, null]);
  assert.deepEqual(outgoing.frames.map(frame => frame.kind), ['ready']);

  const incoming = await harness(t, `${imports} export default {activate(api){api.register(api.contributions[0].id, async () => {
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

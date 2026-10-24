import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import validate from '../javascript/validate-tool-declaration.mjs';

const binary = process.env.TSUMUGI_PLUGIN_CONTRACT;
assert.ok(binary && isAbsolute(binary), 'Set TSUMUGI_PLUGIN_CONTRACT to the current SDK CLI.');
const original = JSON.parse(readFileSync(new URL('fixtures/tool.declaration.json', import.meta.url), 'utf8'));
function isolated(run) {
  const root = mkdtempSync(join(tmpdir(), 'tsumugi-tool-contract-'));
  const invoke = value => {
    const path = join(root, 'tool.json');
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return JSON.parse(execFileSync(binary, ['validate-tool-declaration', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  };
  try { run(invoke); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('generated JavaScript and Rust tool contracts preserve exact Unicode and choices', () => isolated(invoke => {
  const input = structuredClone(original);
  input.title = '术语 👩🏽‍💻'; input.description = 'Preserve e\u0301 and 日本語.\nNo authorization.';
  assert.equal(validate(input), true);
  assert.deepEqual(invoke(input), input);
  input.profile = null; input.skill = null; input.supportingResources = [];
  assert.equal(validate(input), true);
  assert.deepEqual(invoke(input), input);
}));

test('generated structural validation rejects authority and duplicated capability fields', () => {
  for (const mutate of [
    i => { i.grant = true; }, i => { i.inputSchema = {}; }, i => { i.profile.schemaVersion = 0; },
    i => { i.supportingResources = ['terms', 5]; }, i => { delete i.capabilityId; },
  ]) {
    const input = structuredClone(original); mutate(input); assert.equal(validate(input), false);
  }
});

test('structural JavaScript checks do not replace bounded strict Rust semantics', () => isolated(invoke => {
  for (const mutate of [
    i => { i.name = '../outside'; }, i => { i.title = ' '; },
    i => { i.description = 'é'.repeat(2049); }, i => { i.supportingResources.push('terms'); },
  ]) {
    const input = structuredClone(original); mutate(input);
    assert.equal(validate(input), true); assert.throws(() => invoke(input));
  }
  assert.throws(() => invoke(JSON.stringify(original).replace('{', '{"capabilityId":"other",')));
}));

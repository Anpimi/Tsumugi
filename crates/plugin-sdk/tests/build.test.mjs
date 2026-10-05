import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import validateInput from '../javascript/validate-build-input.mjs';
import validateArtifacts from '../javascript/validate-artifact-set.mjs';
import validateCheck from '../javascript/validate-artifact-check-input.mjs';

const binary = process.env.TSUMUGI_PLUGIN_CONTRACT;
assert.ok(binary && isAbsolute(binary), 'Set TSUMUGI_PLUGIN_CONTRACT to the built SDK CLI.');
const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const declaration = fixture('build.declaration.json');
function input(kind = 'webvtt') {
  const source = fixture(`${kind}.content.json`).body.data;
  source.profile = structuredClone(declaration.profile);
  return { source, targetLanguage: 'ja-JP', targets: source.units.map(unit => ({
    unitId: unit.id, sourceRevisionId: unit.sourceRevisionId, text: '決定済み 👩🏽‍💻 é\n😀',
  })), configuration: [], outputPaths: ['locales/ja-JP.txt'], outputLimits: structuredClone(declaration.outputLimits) };
}
function output(input) {
  const utf8 = '\ufefffixed output 👩🏽‍💻 é\r\n';
  return { profile: input.source.profile, sourceSetId: input.source.sourceSetId,
    targetLanguage: input.targetLanguage, artifacts: [{ id: 'output-1', logicalPath: 'locales/ja-JP.txt',
      role: 'translation', utf8, sha256: digest(utf8) }] };
}
function receive(kind, value) {
  const directory = mkdtempSync(join(tmpdir(), 'tsumugi-build-data-'));
  try {
    const file = join(directory, 'input.json'); writeFileSync(file, JSON.stringify(value));
    return JSON.parse(execFileSync(binary, [`validate-${kind}`, file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('build data preserves complete source evidence and decided Unicode through Rust', () => {
  for (const kind of ['webvtt', 'smapi']) {
    const captured = input(kind); assert.equal(validateInput(captured), true);
    assert.deepEqual(receive('build-input', captured), captured);
    const built = output(captured); assert.equal(validateArtifacts(built), true);
    assert.deepEqual(receive('artifact-set', built), built);
  }
});
test('build structural receivers reject unknown nested fields and invalid numeric bounds', () => {
  for (const mutate of [
    value => { value.outputLimits.maxArtifacts = 0; },
    value => { value.outputLimits.maxArtifacts = 1.5; },
    value => { value.outputLimits.maxTotalBytes = 2097153; },
    value => { value.targets[0].projectStore = true; },
    value => { delete value.configuration; },
    value => { delete value.outputPaths; },
  ]) {
    const captured = input(); mutate(captured);
    assert.equal(validateInput(captured), false); assert.throws(() => receive('build-input', captured));
  }
});
test('Rust semantic receiver rejects changed hashes, unsafe paths and missing revisions', () => {
  const captured = input(); captured.targets[0].sourceRevisionId = 'wrong-revision';
  assert.equal(validateInput(captured), true); assert.throws(() => receive('build-input', captured));
  for (const mutate of [
    value => { value.artifacts[0].utf8 += 'changed'; },
    value => { value.artifacts[0].logicalPath = '../outside.txt'; },
    value => { value.artifacts[0].logicalPath = 'CON.txt'; },
  ]) {
    const built = output(input()); mutate(built);
    assert.equal(validateArtifacts(built), true); assert.throws(() => receive('artifact-set', built));
  }
});
test('independent checker data covers actual output without granting publication', () => {
  const captured = input(); const built = output(captured); const manifest = fixture('build.manifest.json');
  const checks = { input: captured, output: built, requirements: [{
    key: { rule: declaration.artifactRules[0], implementation: { kind: 'plugin', provider: {
      plugin: manifest.plugin, componentId: 'worker', contributionId: 'check-artifact', packageDigest: 'a'.repeat(64),
    } } }, inputDigest: 'b'.repeat(64), scopeDigest: 'c'.repeat(64), targets: ['output-1'],
    mandatory: true, waivable: false, notApplicable: null,
  }] };
  assert.equal(validateCheck(checks), true); assert.deepEqual(receive('artifact-check-input', checks), checks);
  checks.requirements[0].targets = ['source-artifact'];
  assert.equal(validateCheck(checks), true); assert.throws(() => receive('artifact-check-input', checks));
  checks.requirements[0].targets = ['output-1'];
  checks.output.artifacts[0].logicalPath = 'other-safe-path.txt';
  assert.equal(validateCheck(checks), true); assert.throws(() => receive('artifact-check-input', checks));
});

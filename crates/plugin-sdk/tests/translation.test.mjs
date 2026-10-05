import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import validateInput from '../javascript/validate-translation-extraction-input.mjs';
import validateExchange from '../javascript/validate-translation-exchange.mjs';
import validateCheck from '../javascript/validate-translation-extraction-check-input.mjs';

const binary = process.env.TSUMUGI_PLUGIN_CONTRACT;
assert.ok(binary && isAbsolute(binary), 'Set TSUMUGI_PLUGIN_CONTRACT to the current built SDK CLI.');
const fixture = name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const read = name => JSON.parse(readFileSync(fixture(name), 'utf8'));
const invoke = (...args) => execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const ref = id => ({ id, schemaVersion: 1, behaviorVersion: 1 });
function isolated(run) {
  const root = mkdtempSync(join(tmpdir(), 'tsumugi-translation-contract-'));
  const write = (name, value) => { const path = join(root, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
  try { run(write); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('generated translation structure roundtrips fixed Unicode and raw capture through Rust', () => isolated(write => {
  const input = read('translation-extraction.input.json'); const proposal = read('translation.exchange.json');
  assert.equal(validateInput(input), true); assert.equal(validateExchange(proposal), true);
  assert.equal(digest(input.artifacts[0].utf8), input.artifacts[0].sha256);
  assert.ok(input.artifacts[0].utf8.startsWith('\ufeff'));
  const inputPath = write('input.json', input); const proposalPath = write('proposal.json', proposal);
  assert.deepEqual(JSON.parse(invoke('validate-translation-extraction-input', inputPath)), input);
  assert.deepEqual(JSON.parse(invoke('validate-translation-exchange', proposalPath)), proposal);
  assert.deepEqual(JSON.parse(invoke('match-translation-extraction', inputPath, proposalPath)), proposal);
  const original = Buffer.from(input.artifacts[0].utf8);
  for (const entry of proposal.entries) {
    const range = entry.source.range;
    assert.equal(JSON.parse(original.subarray(range.start, range.end)), entry.text);
  }
  invoke('validate-translation-import-declaration', fixture('translation-import.declaration.json'));
  proposal.artifacts[0].utf8 += '\n'; proposal.artifacts[0].sha256 = digest(proposal.artifacts[0].utf8);
  invoke('validate-translation-exchange', write('replacement.json', proposal));
  assert.throws(() => invoke('match-translation-extraction', inputPath, write('replacement.json', proposal)));
}));

test('translation JSON.parse and structural validators do not replace strict semantic receiving', () => isolated(write => {
  const input = read('translation-extraction.input.json');
  const raw = JSON.stringify(input).replace('"importId":"import-1"', '"importId":"other","importId":"import-1"');
  assert.equal(validateInput(JSON.parse(raw)), true);
  assert.throws(() => invoke('validate-translation-extraction-input', write('duplicate.json', raw)));
  const unsafe = structuredClone(input); unsafe.artifacts[0].logicalPath = '../zh.json';
  assert.equal(validateInput(unsafe), true);
  assert.throws(() => invoke('validate-translation-extraction-input', write('unsafe.json', unsafe)));
  const wrongHash = structuredClone(input); wrongHash.artifacts[0].sha256 = '0'.repeat(64);
  assert.equal(validateInput(wrongHash), true);
  assert.throws(() => invoke('validate-translation-extraction-input', write('wrong-hash.json', wrongHash)));
  for (const changed of [{ ...input, grant: true }, { ...input, languageEvidence: 'inferred' }, { ...input, sourceSnapshotId: null }]) assert.equal(validateInput(changed), false);
  const proposal = read('translation.exchange.json'); proposal.entries[0].unitId = 'project-unit';
  assert.equal(validateExchange(proposal), false);
  assert.throws(() => invoke('validate-translation-exchange', write('allocation.json', proposal)));
}));

test('translation checks retain fixed independent mandatory requirements across the receiver', () => isolated(write => {
  const input = read('translation-extraction.input.json'); const proposal = read('translation.exchange.json');
  const manifest = read('translation-import.manifest.json');
  const request = { input, proposal, requirements: [{ key: { rule: ref('sample.translation-semantics'), implementation: { kind: 'plugin', provider: {
    plugin: manifest.plugin, componentId: 'worker', contributionId: 'source-check', packageDigest: 'a'.repeat(64),
  } } }, inputDigest: digest(JSON.stringify(input)), scopeDigest: digest(JSON.stringify(proposal)), targets: [input.importId], mandatory: true, waivable: false, notApplicable: null }] };
  assert.equal(validateCheck(request), true);
  assert.deepEqual(JSON.parse(invoke('validate-translation-extraction-check-input', write('check.json', request))), request);
  for (const mutate of [value => { value.requirements = []; }, value => { value.requirements[0].targets = ['other']; }, value => { value.requirements[0].waivable = true; }, value => { value.requirements[0].mandatory = false; }, value => { value.proposal.sourceSnapshotId = 'other'; }]) {
    const changed = structuredClone(request); mutate(changed);
    assert.throws(() => invoke('validate-translation-extraction-check-input', write('changed.json', changed)));
  }
  // Domain meaning is deliberately absent from generic association: this
  // structurally valid forgery still needs the independent domain checker.
  const forged = structuredClone(request); forged.proposal.entries[0].text = 'forged';
  invoke('validate-translation-extraction-check-input', write('forged.json', forged));
}));

test('all generated translation schemas are current at the actual Rust source', () => {
  for (const kind of ['translation-extraction-input', 'translation-exchange', 'translation-extraction-check-input', 'translation-import-declaration', 'translation-types']) {
    const path = fileURLToPath(new URL(`../schemas/${kind}.schema.json`, import.meta.url));
    assert.equal(invoke(`check-${kind}-schema`, path).trim(), 'Schema is current.');
  }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import validateInput from '../javascript/validate-review-check-input.mjs';
import validateDeclaration from '../javascript/validate-review-declaration.mjs';
import validateError from '../javascript/validate-review-check-error.mjs';

const binary = process.env.TSUMUGI_PLUGIN_CONTRACT;
assert.ok(binary && isAbsolute(binary), 'Set TSUMUGI_PLUGIN_CONTRACT to the current built SDK CLI.');
const fixture = name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const read = name => JSON.parse(readFileSync(fixture(name), 'utf8'));
function isolated(run) {
  const root = mkdtempSync(join(tmpdir(), 'tsumugi-review-contract-'));
  const invoke = (kind, value) => {
    const path = join(root, 'input.json');
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return JSON.parse(execFileSync(binary, [`validate-${kind}`, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  };
  try { run(invoke); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('generated review structure and Rust preserve exact Unicode source and selected text', () => isolated(invoke => {
  const input = read('review.input.json'); const declaration = read('review.declaration.json');
  assert.equal(validateInput(input), true); assert.equal(validateDeclaration(declaration), true);
  assert.deepEqual(invoke('review-check-input', input), input);
  assert.deepEqual(invoke('review-declaration', declaration), declaration);
  for (const translationText of [null, '']) {
    const value = structuredClone(input); value.selections[0].translationText = translationText;
    assert.equal(validateInput(value), true);
    assert.deepEqual(invoke('review-check-input', value), value);
    assert.deepEqual(value.source, input.source);
  }
  assert.ok(input.selections[0].translationText.includes('e\u0301'));
  const error = { code: 'invalid-translation', unitId: 'unit-0', detail: 'Unsupported text structure' };
  assert.equal(validateError(error), true);
  assert.deepEqual(invoke('review-check-error', error), error);
}));

test('review structural JavaScript validation does not replace strict Rust scope and policy checks', () => isolated(invoke => {
  const input = read('review.input.json');
  for (const mutate of [
    value => { value.selections[0].sourceRevisionId = 'other'; },
    value => { value.requirements = []; },
    value => { value.requirements[0].mandatory = false; },
    value => { value.requirements[0].waivable = true; },
    value => { value.requirements[0].targets = ['other']; },
    value => { value.requirements[0].notApplicable = { code: 'missing-translation', basisDigest: 'd'.repeat(64) }; },
  ]) {
    const changed = structuredClone(input); mutate(changed);
    assert.equal(validateInput(changed), true);
    assert.throws(() => invoke('review-check-input', changed));
  }
  const duplicate = JSON.stringify(input).replace('"targetLanguage":"zh-CN"', '"targetLanguage":"en-US","targetLanguage":"zh-CN"');
  assert.equal(validateInput(JSON.parse(duplicate)), true);
  assert.throws(() => invoke('review-check-input', duplicate));
  assert.equal(validateInput({ ...input, approved: true }), false);
  assert.equal(validateError({ code: 'ignore', unitId: null, detail: 'Passed' }), false);
}));

test('review missing-translation scope remains explicit and cannot include selected targets', () => isolated(invoke => {
  const input = read('review.input.json');
  input.selections[0].translationText = null;
  input.requirements[1].notApplicable = { code: 'missing-translation', basisDigest: 'd'.repeat(64) };
  assert.equal(validateInput(input), true);
  assert.deepEqual(invoke('review-check-input', input), input);
  const unit = input.source.units[1];
  input.selections.push({ unitId: unit.id, sourceRevisionId: unit.sourceRevisionId, translationText: 'present' });
  for (const requirement of input.requirements) requirement.targets.push(unit.id);
  assert.throws(() => invoke('review-check-input', input));
}));

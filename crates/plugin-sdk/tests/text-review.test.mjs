import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import validateInput from '../javascript/validate-text-review-input.mjs';
import validateDeclaration from '../javascript/validate-text-review-declaration.mjs';
import validateReport from '../javascript/validate-text-review-report.mjs';

const binary = process.env.TSUMUGI_PLUGIN_CONTRACT;
assert.ok(binary && isAbsolute(binary), 'Set TSUMUGI_PLUGIN_CONTRACT to the current built SDK CLI.');
const fixture = name => JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/text-review.${name}.json`, import.meta.url)), 'utf8'));
function isolated(run) {
  const root = mkdtempSync(join(tmpdir(), 'tsumugi-text-review-contract-'));
  const save = (name, value) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const invoke = (kind, value) => JSON.parse(execFileSync(binary,
    [`validate-text-review-${kind}`, save('value.json', value)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const match = (input, report) => JSON.parse(execFileSync(binary,
    ['match-text-review-report', save('input.json', input), save('report.json', report)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  try { run({ invoke, match }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('generated text-review structures and strict Rust retain captured Unicode, resource pins and advisory policy', () => isolated(({ invoke, match }) => {
  const input = fixture('input');
  const declaration = fixture('declaration');
  const report = fixture('report');
  assert.equal(validateInput(input), true);
  assert.equal(validateDeclaration(declaration), true);
  assert.equal(validateReport(report), true);
  assert.deepEqual(invoke('input', input), input);
  assert.deepEqual(invoke('declaration', declaration), declaration);
  assert.deepEqual(match(input, report), report);
  assert.equal(declaration.disposition, 'advisory');
  assert.ok(input.requirements.every(requirement => !requirement.mandatory && !requirement.waivable));
  assert.ok(input.selections[0].translationText.includes('e\u0301'));
  assert.equal(report.diagnostics[0].location.range.end, input.selections[0].translationText.length);
  for (const translationText of [null, '']) {
    const changed = structuredClone(input);
    changed.selections[0].translationText = translationText;
    assert.deepEqual(invoke('input', changed), changed);
  }
}));

test('structural text-review validation cannot replace strict captured scope and policy checks', () => isolated(({ invoke }) => {
  const input = fixture('input');
  for (const mutate of [
    value => { value.requirements[0].mandatory = true; },
    value => { value.requirements[0].waivable = true; },
    value => { value.requirements[0].targets = ['other']; },
    value => { value.requirements[0].notApplicable = { code: 'missing-translation', basisDigest: 'd'.repeat(64) }; },
    value => { value.resources.push(structuredClone(value.resources[0])); },
    value => { value.selections[0].sourceText = '\ud800'; },
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    assert.equal(validateInput(changed), true);
    assert.throws(() => invoke('input', changed));
  }
  assert.equal(validateInput({ ...input, approved: true }), false);
  assert.equal(validateDeclaration({ ...fixture('declaration'), disposition: 'mandatory' }), false);
}));

test('strict text-review report reception rejects forged provenance and invalid scalar boundaries while retaining non-success states', () => isolated(({ match }) => {
  const input = fixture('input');
  const report = fixture('report');
  for (const mutate of [
    value => { value.results[0].inputDigest = 'd'.repeat(64); },
    value => { value.results[0].coveredTargets = ['other']; value.results[0].outcome.findings[0].target = 'other'; value.diagnostics[0].target = 'other'; },
    value => { value.results[0].key.implementation.provider.packageDigest = 'd'.repeat(64); value.diagnostics[0].key.implementation.provider.packageDigest = 'd'.repeat(64); },
    value => { value.diagnostics[0].location.range.start = 1; },
    value => { value.diagnostics[0].location.range.end += 1; },
    value => { value.diagnostics[0].resourceEntry.contributionId = 'other'; },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.equal(validateReport(changed), true);
    assert.throws(() => match(input, changed));
  }
  for (const kind of ['failed', 'cancelled', 'unavailable']) {
    const changed = structuredClone(report);
    changed.results[0].outcome = { kind };
    changed.diagnostics = [];
    assert.deepEqual(match(input, changed), changed);
  }
  const missing = structuredClone(input);
  missing.selections[0].translationText = null;
  missing.requirements[0].notApplicable = { code: 'missing-translation', basisDigest: 'd'.repeat(64) };
  const notApplicable = structuredClone(report);
  notApplicable.results[0].outcome = { kind: 'not-applicable', basis: missing.requirements[0].notApplicable };
  notApplicable.diagnostics = [];
  assert.deepEqual(match(missing, notApplicable), notApplicable);
  assert.throws(() => match(input, notApplicable));
}));

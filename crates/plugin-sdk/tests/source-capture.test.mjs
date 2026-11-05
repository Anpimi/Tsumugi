import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { encodeSourceCaptureSummary, validateSourceCaptureSummary } from '../javascript/source-capture.mjs';
import { SOURCE_CAPTURE_SUMMARY_PROFILE as profile } from '../javascript/source-capture-profile.mjs';

const binary = process.env.TSUMUGI_PLUGIN_CONTRACT;
assert.ok(binary && isAbsolute(binary), 'Set TSUMUGI_PLUGIN_CONTRACT to the exact built SDK CLI.');
const fixture = () => ({ materials: [{ source: { artifactId: 'captured', range: { encoding: 'raw-byte', start: 0, end: 4 } },
  properties: [{ label: 'Captured label', values: ['é 👩🏽‍💻 <literal>'] }, { label: 'Explicit absence', values: [] }],
  counts: { items: 2, itemsWithFields: 1, declaredFields: 2, nonEmptyFields: 1 },
  groups: [{ label: 'Declared', counts: { items: 1, itemsWithFields: 1, declaredFields: 2, nonEmptyFields: 1 } },
    { label: 'No declared fields', counts: { items: 1, itemsWithFields: 0, declaredFields: 0, nonEmptyFields: 0 } }] }] });
function receive(value) {
  const directory = mkdtempSync(join(tmpdir(), 'tsumugi-source-capture-'));
  try {
    const file = join(directory, 'summary.json'); writeFileSync(file, JSON.stringify(value));
    return JSON.parse(execFileSync(binary, ['validate-source-capture-summary', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function rejected(value) {
  assert.equal(validateSourceCaptureSummary(value), false);
  assert.throws(() => encodeSourceCaptureSummary(value), /Invalid source capture summary/);
  assert.throws(() => receive(value));
}

test('JavaScript and Rust preserve Unicode properties, explicit absence and matching counts', () => {
  const value = fixture();
  assert.equal(validateSourceCaptureSummary(value), true);
  assert.deepEqual(JSON.parse(encodeSourceCaptureSummary(value)), value);
  assert.deepEqual(receive(value), value);
  assert.deepEqual(profile, JSON.parse(execFileSync(binary, ['profile-source-capture'], { encoding: 'utf8' })));
  assert.throws(() => { profile.maxBytes++; }, TypeError);
  assert.throws(() => { profile.contract.schemaVersion++; }, TypeError);
});

test('source capture is bounded plain data without project identities or permission fields', () => {
  for (const change of [
    value => { value.projectId = 'not-authority'; },
    value => { value.materials[0].grant = true; },
    value => { value.materials[0].counts.items = -1; },
    value => { value.materials[0].counts.items = 2 ** 32; },
    value => { value.materials[0].properties[0].label = '\nunsafe'; },
    value => { value.materials[0].properties[0].label = 'unsafe\u0085'; },
    value => { value.materials[0].properties[0].values = ['\ud800']; },
    value => { value.materials[0].source.artifactId = ''; },
    value => { value.materials[0].source.range.start = 4; },
    value => { value.materials[0].source.range.encoding = 'unknown'; },
  ]) { const value = fixture(); change(value); rejected(value); }
});

test('inconsistent counts and duplicate material, property or group identities are refused', () => {
  for (const change of [
    value => { value.materials[0].counts.nonEmptyFields = 3; },
    value => { value.materials[0].counts.itemsWithFields = 0; },
    value => { value.materials[0].groups[0].counts.items = 2; },
    value => { value.materials.push(structuredClone(value.materials[0])); },
    value => { value.materials[0].properties.push(structuredClone(value.materials[0].properties[0])); },
    value => { value.materials[0].groups.push(structuredClone(value.materials[0].groups[0])); },
    value => { value.materials = []; },
  ]) { const value = fixture(); change(value); rejected(value); }
});

test('per-field and total encoded-byte limits agree without truncation', () => {
  let value = fixture(); value.materials[0].properties[0].values = ['x'.repeat(profile.maxTextBytes + 1)]; rejected(value);
  value = fixture(); value.materials[0].properties[0].values = ['界'.repeat(Math.floor(profile.maxTextBytes / 3) + 1)]; rejected(value);
  value = fixture(); value.materials[0].properties[0].label = '界'.repeat(Math.floor(profile.maxLabelBytes / 3) + 1); rejected(value);
  value = fixture(); value.materials[0].properties[0].values = Array(profile.maxValues + 1).fill('x'); rejected(value);
  value = fixture(); value.materials[0].properties[0].values = Array(64).fill('x'.repeat(profile.maxTextBytes)); rejected(value);
});

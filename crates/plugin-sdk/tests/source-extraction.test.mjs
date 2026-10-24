import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import validateSourceInput from '../javascript/validate-source-extraction-input.mjs';
import validateSourceCheck from '../javascript/validate-source-extraction-check-input.mjs';

// A caller supplies the already-built SDK harness. This test never installs or
// builds dependencies and operates only on public fixtures and its own tempdir.
const binary = process.env.TSUMUGI_PLUGIN_CONTRACT;
assert.ok(binary && isAbsolute(binary), 'Set TSUMUGI_PLUGIN_CONTRACT to the absolute built SDK CLI.');
const fixture = name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const invoke = (...args) => execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');

test('JavaScript source capture retains Unicode bytes through the Rust receiver', () => {
  const input = readJSON(fixture('source-extraction.input.json'));
  const content = readJSON(fixture('webvtt.content.json'));
  assert.equal(validateSourceInput(input), true);
  assert.equal(digest(input.artifacts[0].utf8), input.artifacts[0].sha256);
  assert.ok(input.artifacts[0].utf8.includes('👩🏽‍💻 é\r\n'));
  const temporary = mkdtempSync(join(tmpdir(), 'tsumugi-source-contract-'));
  try {
    const capture = join(temporary, 'input.json');
    writeFileSync(capture, JSON.stringify(input));
    assert.deepEqual(JSON.parse(invoke('validate-source-extraction-input', capture)), input);
    assert.deepEqual(JSON.parse(invoke('match-source-extraction', capture, fixture('webvtt.content.json'))), content);
    assert.deepEqual(JSON.parse(invoke('validate-source-extraction-error', fixture('source-extraction.error.json'))),
      readJSON(fixture('source-extraction.error.json')));

    // The incoming material stays independently fixed even when a JS producer
    // returns self-consistent new bytes with a valid replacement digest.
    const response = join(temporary, 'response.json');
    content.body.data.artifacts[0].utf8 += '\n';
    content.body.data.artifacts[0].sha256 = digest(content.body.data.artifacts[0].utf8);
    writeFileSync(response, JSON.stringify(content));
    invoke('validate-exchange', response);
    assert.throws(() => invoke('match-source-extraction', capture, response));
    const unknown = { ...input, arbitraryRevision: 1 };
    assert.equal(validateSourceInput(unknown), false);
    const wrongType = structuredClone(input);
    wrongType.artifacts[0].utf8 = 42;
    assert.equal(validateSourceInput(wrongType), false);
    const zeroVersion = structuredClone(input);
    zeroVersion.profile.schemaVersion = 0;
    assert.equal(validateSourceInput(zeroVersion), false);
    input.artifacts[0].logicalPath = '../source.vtt';
    // Structural JS validation alone cannot interpret safe logical paths.
    assert.equal(validateSourceInput(input), true);
    writeFileSync(capture, JSON.stringify(input));
    assert.throws(() => invoke('validate-source-extraction-input', capture));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('JSON.parse does not replace strict Serde or generic semantic validation', () => {
  const input = readJSON(fixture('source-extraction.input.json'));
  const raw = JSON.stringify(input).replace('"sourceSetId":"source-set"',
    '"sourceSetId":"first-set","sourceSetId":"source-set"');
  assert.equal(validateSourceInput(JSON.parse(raw)), true);
  const temporary = mkdtempSync(join(tmpdir(), 'tsumugi-source-contract-'));
  try {
    const capture = join(temporary, 'duplicate.json');
    writeFileSync(capture, raw);
    assert.throws(() => invoke('validate-source-extraction-input', capture));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('committed source schemas stay current with the Rust schema owner', () => {
  for (const [command, file] of [
    ['check-source-extraction-input-schema', 'source-extraction-input.schema.json'],
    ['check-source-extraction-error-schema', 'source-extraction-error.schema.json'],
    ['check-source-extraction-check-input-schema', 'source-extraction-check-input.schema.json'],
    ['check-check-results-schema', 'check-results.schema.json'],
    ['check-content-types-schema', 'content-types.schema.json'],
  ]) {
    const path = fileURLToPath(new URL(`../schemas/${file}`, import.meta.url));
    invoke(command, path);
  }
});

test('source check schema retains selected identity and the Rust receiver fixes mandatory scope', () => {
  const source = readJSON(fixture('source-extraction.input.json'));
  const proposal = readJSON(fixture('webvtt.content.json')).body.data;
  const requirement = readJSON(fixture('checks.set.json')).body.data.requirements.find(r => r.key.implementation.kind === 'plugin');
  requirement.targets = [source.sourceSetId];
  const input = { source, proposal, requirements: [requirement] };
  assert.equal(validateSourceCheck(input), true);
  const temporary = mkdtempSync(join(tmpdir(), 'tsumugi-source-check-contract-'));
  try {
    const capture = join(temporary, 'input.json');
    writeFileSync(capture, JSON.stringify(input));
    assert.deepEqual(JSON.parse(invoke('validate-source-extraction-check-input', capture)), input);
    delete proposal.units[0].occurrences[0].nativeIdentity.display.source;
    assert.equal(validateSourceCheck(input), false);
    proposal.units[0].occurrences[0].nativeIdentity.display.source = null;
    requirement.waivable = true;
    assert.equal(validateSourceCheck(input), true); // policy semantics belong to Rust
    writeFileSync(capture, JSON.stringify(input));
    assert.throws(() => invoke('validate-source-extraction-check-input', capture));
    requirement.waivable = false;
    requirement.key.implementation.provider.activeInstance = 'claim';
    assert.equal(validateSourceCheck(input), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

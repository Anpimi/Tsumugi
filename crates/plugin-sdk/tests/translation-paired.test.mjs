import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import validateInput from '../javascript/validate-paired-translation-extraction-input.mjs';
import validateCheck from '../javascript/validate-paired-translation-extraction-check-input.mjs';
import validateLegacy from '../javascript/validate-translation-extraction-input.mjs';

const binary = process.env.TSUMUGI_PLUGIN_CONTRACT;
assert.ok(binary && isAbsolute(binary), 'Set TSUMUGI_PLUGIN_CONTRACT to the built SDK CLI.');
const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const invoke = (...args) => execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
function isolated(run) {
  const root = mkdtempSync(join(tmpdir(), 'tsumugi-paired-translation-'));
  const write = (name, value) => { const path = join(root,name); writeFileSync(path,JSON.stringify(value)); return path; };
  try { run(write); } finally { rmSync(root,{recursive:true,force:true}); }
}
function input() {
  const input = fixture('translation-extraction.input.json');
  input.pairedSource = { sourceLanguage:'en-US', artifacts: structuredClone(input.artifacts) };
  return input;
}

test('paired receiver requires explicit original material and leaves the old family closed', () => isolated(write => {
  const value = input();
  assert.equal(validateInput(value),true);
  assert.equal(validateLegacy(value),false);
  assert.deepEqual(JSON.parse(invoke('validate-paired-translation-extraction-input',write('input.json',value))),value);
  for (const original of [undefined,null,{}, {sourceLanguage:'en-US',artifacts:[]}]) {
    const changed = input(); changed.pairedSource = original;
    assert.throws(() => invoke('validate-paired-translation-extraction-input',write('invalid.json',changed)));
    if (original === null || original === undefined) assert.equal(validateInput(changed),false);
  }
}));

test('independent paired checks retain originals and refuse replacement target material', () => isolated(write => {
  const value = input(), proposal = fixture('translation.exchange.json');
  const request = {input:value,proposal,requirements:[{
    key:{rule:{id:'sample.rule',schemaVersion:1,behaviorVersion:1},implementation:{kind:'plugin',provider:{
      plugin:{publisher:'example',id:'plain-text',version:'0.1.0'},componentId:'worker',contributionId:'source-check',packageDigest:'a'.repeat(64),
    }}},inputDigest:'b'.repeat(64),scopeDigest:'c'.repeat(64),targets:[value.importId],mandatory:true,waivable:false,notApplicable:null,
  }]};
  assert.equal(validateCheck(request),true);
  assert.deepEqual(JSON.parse(invoke('validate-paired-translation-extraction-check-input',write('check.json',request))),request);
  assert.deepEqual(JSON.parse(invoke('match-paired-translation-extraction',write('input.json',value),write('proposal.json',proposal))),proposal);
  delete request.input.pairedSource;
  assert.equal(validateCheck(request),false);
  assert.throws(() => invoke('validate-paired-translation-extraction-check-input',write('missing-source.json',request)));
  value.pairedSource = input().pairedSource;
  proposal.artifacts[0].logicalPath = 'other.json';
  assert.throws(() => invoke('match-paired-translation-extraction',write('input.json',value),write('proposal.json',proposal)));
}));

test('paired generated schemas match the actual Rust producer', () => {
  for (const kind of ['extraction-input','exchange','extraction-check-input','import-declaration','types']) {
    const path = fileURLToPath(new URL(`../schemas/paired-translation-${kind}.schema.json`,import.meta.url));
    assert.equal(invoke(`check-paired-translation-${kind}-schema`,path).trim(),'Schema is current.');
  }
});

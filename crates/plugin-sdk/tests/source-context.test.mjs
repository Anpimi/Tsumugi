import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { validateSourceContextFacts, encodeSourceContextFacts } from '../javascript/source-context.mjs';
import { SOURCE_CONTEXT_FACTS_PROFILE as profile } from '../javascript/source-context-profile.mjs';

const binary = process.env.TSUMUGI_PLUGIN_CONTRACT;
assert.ok(binary && isAbsolute(binary), 'Set TSUMUGI_PLUGIN_CONTRACT to the exact built SDK CLI.');
const fixture = JSON.parse(readFileSync(new URL('fixtures/source-context-facts.json', import.meta.url), 'utf8'));
function receive(value) {
  const directory = mkdtempSync(join(tmpdir(), 'tsumugi-source-context-'));
  try {
    const file = join(directory, 'facts.json'); writeFileSync(file, JSON.stringify(value));
    return JSON.parse(execFileSync(binary, ['validate-source-context-facts', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function rejected(value) {
  assert.equal(validateSourceContextFacts(value), false);
  assert.throws(() => encodeSourceContextFacts(value), /Invalid source context facts/);
  assert.throws(() => receive(value));
}

test('JavaScript and Rust retain explicit extracted and inferred origins and exact Unicode', () => {
  assert.equal(validateSourceContextFacts(fixture), true);
  assert.deepEqual(JSON.parse(encodeSourceContextFacts(fixture)), fixture);
  assert.deepEqual(receive(fixture), fixture);
  assert.equal(fixture.facts[1].origin.kind, 'inferred');
  assert.match(fixture.facts[0].text, /👩🏽‍💻 é/);
  assert.equal(encodeSourceContextFacts(fixture).includes('é'), false);
  assert.deepEqual(receive({ facts: [] }), { facts: [] });
});

test('JavaScript limits and contract identity are generated from the exact Rust owner', () => {
  const actual = JSON.parse(execFileSync(binary, ['profile-source-context'], { encoding: 'utf8' }));
  assert.deepEqual(profile, actual);
  assert.throws(() => { profile.maxBytes++; }, TypeError);
  assert.throws(() => { profile.contract.schemaVersion++; }, TypeError);
  assert.deepEqual(profile.contract, { id: 'tsumugi.source-context-facts', schemaVersion: 1, behaviorVersion: 1 });
});

test('missing origins, manual promotion, unknown fields and missing inference rationale are refused', () => {
  const values = [];
  let value = structuredClone(fixture); delete value.facts[0].origin; values.push(value);
  value = structuredClone(fixture); value.facts[0].origin.kind = 'manual'; values.push(value);
  value = structuredClone(fixture); delete value.facts[1].origin.rationale; values.push(value);
  value = structuredClone(fixture); value.confirmed = true; values.push(value);
  value = structuredClone(fixture); value.facts[0].projectId = 'not-a-project-grant'; values.push(value);
  value = structuredClone(fixture); value.facts[0].kind = 'unknown-category'; values.push(value);
  for (const value of values) rejected(value);
});

test('duplicate fact identity and repeated evidence are not merged or silently dropped', () => {
  let value = structuredClone(fixture); value.facts[1].id = value.facts[0].id; rejected(value);
  value = structuredClone(fixture); value.facts[0].origin.sources.push(structuredClone(value.facts[0].origin.sources[0])); rejected(value);
});

test('UTF-8 text budgets and invalid UTF-16 strings agree with the Rust receiver', () => {
  const value = { facts: [structuredClone(fixture.facts[0])] };
  value.facts[0].text = '🧵'.repeat(profile.maxTextBytes / 4);
  assert.equal(validateSourceContextFacts(value), true); assert.deepEqual(receive(value), value);
  value.facts[0].text += 'é'; rejected(value);
  value.facts[0].text = '\ud800'; rejected(value);
  value.facts[0].text = ''; rejected(value);
});

test('aggregate encoded bytes and fact count have independent hard limits', () => {
  const value = { facts: Array.from({ length: profile.maxFacts }, (_, index) => ({ ...structuredClone(fixture.facts[0]), id: `fact-${index}`, text: 'a'.repeat(profile.maxTextBytes / 2) })) };
  assert.ok(new TextEncoder().encode(JSON.stringify(value)).length > profile.maxBytes); rejected(value);
  value.facts.forEach(fact => { fact.text = 'a'; }); assert.equal(validateSourceContextFacts(value), true); assert.deepEqual(receive(value), value);
  value.facts.push({ ...structuredClone(fixture.facts[0]), id: 'one-too-many' }); rejected(value);
});

test('nonempty bounded evidence, opaque identifiers and ordered ranges are required', () => {
  let value = structuredClone(fixture); value.facts[0].origin.sources = []; rejected(value);
  value = structuredClone(fixture); value.facts[0].origin.sources = Array.from({ length: profile.maxSources + 1 }, (_, index) => ({ ...structuredClone(fixture.facts[0].origin.sources[0]), artifactId: `captured-${index}` })); rejected(value);
  value = structuredClone(fixture); value.facts[0].origin.sources[0].range.end = 0; rejected(value);
  value = structuredClone(fixture); value.facts[0].origin.sources[0].artifactId = 'invalid artifact'; rejected(value);
  value = structuredClone(fixture); value.facts[1].origin.rationale = ''; rejected(value);
  value = structuredClone(fixture); value.facts[0].id += '\n'; rejected(value);
  value = structuredClone(fixture); value.facts[0].origin.sources[0].artifactId += '\n'; rejected(value);
});

test('data parsing does not pretend to establish a captured artifact association', () => {
  const value = structuredClone(fixture); value.facts[0].origin.sources[0].artifactId = 'another-captured-set';
  assert.equal(validateSourceContextFacts(value), true); assert.deepEqual(receive(value), value);
  // The ContentExchange receiver's associated-artifact and Unicode-range
  // assertions are exercised in source_context.rs, before domain adoption.
});

test('encoding checks one captured data snapshot rather than serializing mutable getters again', () => {
  const value = structuredClone(fixture); let reads = 0;
  Object.defineProperty(value.facts[0], 'text', { enumerable: true, get() { reads++; return reads === 1 ? fixture.facts[0].text : '\ud800'; } });
  const encoded = encodeSourceContextFacts(value); assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(encoded), fixture); assert.deepEqual(receive(JSON.parse(encoded)), fixture);
});

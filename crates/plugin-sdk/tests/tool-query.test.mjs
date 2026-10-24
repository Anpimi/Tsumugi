import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createToolQuery, ToolQueryError } from '../javascript/tool-query.mjs';
const declaration = JSON.parse(readFileSync(new URL('fixtures/tool.query.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('fixtures/tool.manifest.json', import.meta.url), 'utf8'));
const capability = manifest.contributions[0].contribution.declaration;
const binding = () => ({ declaration: structuredClone(declaration), capability: { declaration: structuredClone(capability) } });
const input = () => ({ text: 'Preserve e\u0301 👩🏽‍💻 and 日本語.\nNo rewrite.', target: 'ja', selections: ['term'] });
const rejects = (run, code) => assert.throws(run, error => error instanceof ToolQueryError && error.code === code);

test('the shared query helper preserves original template, explicit scope and Unicode across single/batch payloads', () => {
  const source = binding(), before = structuredClone(source), presentation = createToolQuery(source);
  const first = presentation.prepare(input());
  assert.deepEqual(first, { basis: { revision: 'é-👩🏽‍💻' }, target: 'ja', rows: [{ id: 'original-query', text: input().text, selected: ['term'] }] });
  const batch = ['validity', 'no match'].map(text => presentation.prepare({ ...input(), text }));
  assert.equal(batch[0].rows[0].text, 'validity'); assert.equal(batch[1].rows[0].text, 'no match');
  assert.deepEqual(source, before);
  first.rows[0].selected.push('other');
  assert.deepEqual(presentation.prepare(input()).rows[0].selected, ['term']);
  source.declaration.query.inputTemplate.basis.revision = 'replaced';
  assert.equal(presentation.prepare(input()).basis.revision, 'é-👩🏽‍💻');
  assert.throws(() => { presentation.query.inputTemplate.target = 'changed'; });
});

test('the shared query helper rejects empty, oversized, malformed or changed explicit inputs without normalizing them', () => {
  const presentation = createToolQuery(binding());
  for (const text of ['', ' \n', '\ud800', '\udc00']) rejects(() => presentation.prepare({ ...input(), text }), 'text-required');
  rejects(() => presentation.prepare({ ...input(), text: 'é'.repeat(129) }), 'limit-exceeded');
  assert.equal(presentation.prepare({ ...input(), text: 'é'.repeat(128) }).rows[0].text.length, 128);
  for (const target of ['zh-cn', 'en', ' ja']) rejects(() => presentation.prepare({ ...input(), target }), 'invalid-selection');
  for (const selections of [[], ['term', 'term'], ['unknown']]) rejects(() => presentation.prepare({ ...input(), selections }), 'invalid-selection');
  const small = binding(); small.capability.declaration.limits.maxInputBytes = 256;
  const compact = createToolQuery(small);
  rejects(() => compact.prepare({ ...input(), text: `x${'\n'.repeat(200)}` }), 'limit-exceeded');
});

test('output presentation distinguishes empty matches from invalid, missing and oversized results and retains untrusted strings', () => {
  const presentation = createToolQuery(binding());
  assert.deepEqual(presentation.entries({ results: [{ entries: [] }] }), []);
  assert.deepEqual(presentation.entries({ results: [{ entries: [{ value: '可靠性', note: '<script>untrusted</script>' }] }] }), [['可靠性', '<script>untrusted</script>']]);
  for (const output of [{}, { results: [] }, { results: [{ entries: null }] }, { results: [{ entries: [{ value: 'term' }] }] }, { results: [{ entries: [{ value: 5, note: 'text' }] }] }, { results: [{ entries: Array.from({ length: 3 }, () => ({ value: 'x', note: 'x' })) }] }]) {
    rejects(() => presentation.entries(output), 'invalid-result');
  }
  rejects(() => presentation.entries({ results: [{ entries: [{ value: 'x'.repeat(2048), note: 'x' }] }] }), 'invalid-result');
  const cyclic = {}; cyclic.self = cyclic;
  rejects(() => presentation.entries(cyclic), 'invalid-result');
});

test('unbound schemas, authority claims and unsafe or overlapping paths never become a query interface', () => {
  const mutations = [
    b => { b.declaration.query.inputSchema.behaviorVersion++; },
    b => { b.declaration.query.outputSchema.id = 'other'; },
    b => { b.declaration.query.textPath = ['__proto__']; },
    b => { b.declaration.query.output.columns[0].path = ['constructor']; },
    b => { b.declaration.query.target.path = b.declaration.query.textPath; },
    b => { b.declaration.query.selections.options.push(b.declaration.query.selections.options[0]); },
    b => { b.declaration.query.script = 'do not execute'; },
    b => { b.capability.declaration.effect = 'proposal'; },
    b => { b.capability.declaration.permissions.push({ kind: 'network', destination: 'https://example.test' }); },
  ];
  for (const mutate of mutations) { const candidate = binding(); mutate(candidate); rejects(() => createToolQuery(candidate), 'invalid-declaration'); }
  const headless = binding(); delete headless.declaration.query;
  rejects(() => createToolQuery(headless), 'unavailable');
});

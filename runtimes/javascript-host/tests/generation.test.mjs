import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import inputValid from '../../../crates/plugin-sdk/javascript/validate-generation-service-input.mjs';
import receiptValid from '../../../crates/plugin-sdk/javascript/validate-generation-service-receipt.mjs';
import errorValid from '../../../crates/plugin-sdk/javascript/validate-generation-service-error.mjs';

const original = JSON.parse(await readFile(new URL('../../../crates/plugin-sdk/tests/fixtures/generation.input.json', import.meta.url), 'utf8'));

test('generated generation input uses the SDK fixture and rejects authority overrides', () => {
  assert.equal(inputValid(original), true);
  for (const key of ['config', 'payload', 'model', 'destination', 'sharing', 'effects', 'lease', 'parentTask', 'confirmed', 'budget']) {
    assert.equal(inputValid({ ...original, [key]: true }), false, key);
  }
  for (const unitIds of [[], [original.unitIds[0], original.unitIds[0]], Array.from({ length: 101 }, (_, i) => `unit-${i}`), ['bad identity'], ['x'.repeat(129)]]) {
    assert.equal(inputValid({ ...original, unitIds }), false);
  }
  assert.equal(inputValid({ ...original, unitIds: Array.from({ length: 100 }, (_, i) => String(i).padStart(128, '0')) }), true);
});

test('generated receipts and finite errors contain no renewal or retry authority', () => {
  const receipt = { taskId: original.taskId, attemptId: original.attemptId, inputDigest: 'a'.repeat(64) };
  assert.equal(receiptValid(receipt), true);
  for (const [key, value] of [['inputDigest', 'A'.repeat(64)], ['taskId', 'bad identity'], ['lease', true], ['grantId', true], ['completed', true]]) {
    assert.equal(receiptValid({ ...receipt, [key]: value }), false, key);
  }
  for (const code of ['invalid-input', 'unavailable', 'permission-denied', 'cancelled', 'limit-exceeded', 'conflict', 'busy', 'storage-failed', 'outcome-unknown']) {
    assert.equal(errorValid({ code }), true, code);
  }
  for (const error of [{ code: 'success' }, { code: 'outcome-unknown', retry: true }, { code: 'permission-denied', reason: 'untrusted' }]) {
    assert.equal(errorValid(error), false);
  }
});

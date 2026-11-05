import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, encodeFrame, FrameDecoder } from '../dist/codec.js';
import { PROCESS_PROFILE } from '../dist/generated/protocol.js';
import { JsonFrameDecoder } from '../dist/framing.js';
const frame = { protocolVersion: PROCESS_PROFILE.protocolVersion, body: { kind: 'ping', data: { nonce: 'roundtrip' } } };

test('shared framing preserves each channel aggregate allowance independently', () => {
  const packet = Buffer.from([0, 0, 0, 4, 1, 2, 3, 4]);
  const found = [];
  const narrow = new JsonFrameDecoder(bytes => [...bytes], 4, 16);
  narrow.push(Buffer.concat([packet, packet]), value => found.push(value));
  assert.equal(found.length, 2);
  assert.throws(() => narrow.push(packet, () => assert.fail()), /Session input limit/);
  const wider = new JsonFrameDecoder(bytes => [...bytes], 4, 24);
  wider.push(Buffer.concat([packet, packet, packet]), value => found.push(value));
  wider.finish();
  assert.equal(found.length, 5);
  assert.throws(() => wider.push(packet, () => assert.fail()), /Session input limit/);
});

test('fragmented and coalesced frames preserve boundaries', () => {
  const bytes = encodeFrame(frame);
  const decoder = new FrameDecoder();
  const found = [];
  for (const byte of bytes) decoder.push(Buffer.from([byte]), item => found.push(item));
  decoder.push(Buffer.concat([bytes, bytes]), item => found.push(item));
  decoder.finish();
  assert.deepEqual(found, [frame, frame, frame]);
});
test('strict wire parser rejects duplicate decoded keys, malformed JSON and invalid Unicode', () => {
  for (const source of [
    '{"protocolVersion":3,"protocolVersion":3,"body":{"kind":"ping","data":{"nonce":"x"}}}',
    '{"protocolVersion":3,"body":{"kind":"ping","data":{"nonce":"x","no\\u006ece":"y"}}}',
    '{"protocolVersion":3,"body":{"kind":"ping","data":{"nonce":"x",}}}',
    '{"protocolVersion":3,/* comment */"body":{"kind":"ping","data":{"nonce":"x"}}}',
    '\ufeff' + JSON.stringify(frame), JSON.stringify(frame) + 'true',
    '{"protocolVersion":3,"body":{"kind":"ping","data":{"nonce":"\\ud800"}}}',
    JSON.stringify(frame).replace(':3,', ':3.0,'),
    JSON.stringify(frame).replace(':3,', ':3e0,'),
    JSON.stringify(frame).replace(':3,', ':9007199254740993,'),
    JSON.stringify({ ...frame, unexpected: true }), JSON.stringify({ ...frame, protocolVersion: 99 }),
    JSON.stringify({ ...frame, protocolVersion: 2 }),
  ]) assert.throws(() => decodeFrame(Buffer.from(source)));
  assert.throws(() => decodeFrame(Buffer.from([0xff])));
  assert.throws(() => decodeFrame(Buffer.from('['.repeat(65) + ']'.repeat(65))));
});
test('prefix bounds and truncated streams fail before delivery', () => {
  for (const size of [0, PROCESS_PROFILE.maxFrameBytes + 1, 0xffffffff]) {
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(size);
    assert.throws(() => new FrameDecoder().push(prefix, () => assert.fail()));
  }
  for (const length of [1, 3, 4, 5, encodeFrame(frame).length - 1]) {
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame(frame).subarray(0, length), () => assert.fail());
    assert.throws(() => decoder.finish());
  }
});

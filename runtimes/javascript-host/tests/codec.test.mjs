import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, encodeFrame, FrameDecoder } from '../dist/codec.js';
import { PROCESS_PROFILE } from '../dist/generated/protocol.js';
const frame = { protocolVersion: 1, body: { kind: 'ping', data: { nonce: 'roundtrip' } } };

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
    '{"protocolVersion":1,"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":"x"}}}',
    '{"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":"x","no\\u006ece":"y"}}}',
    '{"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":"x",}}}',
    '{"protocolVersion":1,/* comment */"body":{"kind":"ping","data":{"nonce":"x"}}}',
    '\ufeff' + JSON.stringify(frame), JSON.stringify(frame) + 'true',
    '{"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":"\\ud800"}}}',
    JSON.stringify(frame).replace(':1,', ':1.0,'),
    JSON.stringify(frame).replace(':1,', ':1e0,'),
    JSON.stringify(frame).replace(':1,', ':9007199254740993,'),
    JSON.stringify({ ...frame, unexpected: true }), JSON.stringify({ ...frame, protocolVersion: 99 }),
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

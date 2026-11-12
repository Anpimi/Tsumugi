import validate from './generated/validate-process.mjs';
import { PROCESS_PROFILE } from './generated/protocol.js';
import type { ProcessFrame } from '../../../crates/plugin-sdk/javascript/process.js';

export { scalarString } from './framing.js';
import { parseFrameJson, ChunkedJsonFrameDecoder, jsonPieces } from './framing.js';
export function decodeFrame(bytes: Uint8Array): ProcessFrame {
  const value = parseFrameJson(bytes, PROCESS_PROFILE.maxFrameBytes);
  if (!validate(value)) throw new Error('Invalid process frame');
  return value as ProcessFrame;
}
export function encodeFrame(value: ProcessFrame): Buffer {
  // Convenience for small callers/tests. The process writer uses frameChunks.
  return Buffer.concat([...frameChunks(value)]);
}
export function frameByteLength(value: ProcessFrame): number {
  if (!validate(value)) throw new Error('Invalid process frame');
  let total = 0;
  for (const piece of jsonPieces(value)) {
    total += piece.length;
    if (total > PROCESS_PROFILE.maxFrameBytes) throw new Error('Frame limit');
  }
  return total;
}
export function* frameChunks(value: ProcessFrame): Generator<Buffer> {
  if (!validate(value)) throw new Error('Invalid process frame');
  let chunk = Buffer.allocUnsafe(PROCESS_PROFILE.maxChunkBytes + 4);
  let offset = 4;
  let total = 0;
  for (const piece of jsonPieces(value)) {
    total += piece.length;
    if (total > PROCESS_PROFILE.maxFrameBytes) throw new Error('Frame limit');
    for (let source = 0; source < piece.length;) {
      const count = Math.min(piece.length - source, chunk.length - offset);
      piece.copy(chunk, offset, source, source + count);
      source += count;
      offset += count;
      if (offset === chunk.length) {
        chunk.writeUInt32BE(offset - 4);
        yield chunk;
        chunk = Buffer.allocUnsafe(PROCESS_PROFILE.maxChunkBytes + 4);
        offset = 4;
      }
    }
  }
  if (offset > 4) { chunk.writeUInt32BE(offset - 4); yield chunk.subarray(0, offset); }
  yield Buffer.alloc(4);
}
export class FrameDecoder extends ChunkedJsonFrameDecoder<ProcessFrame> {
  constructor() { super(decodeFrame, PROCESS_PROFILE.maxChunkBytes, PROCESS_PROFILE.maxFrameBytes, PROCESS_PROFILE.maxSessionBytes); }
}

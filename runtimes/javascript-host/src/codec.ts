import validate from './generated/validate-process.mjs';
import { PROCESS_PROFILE } from './generated/protocol.js';
import type { ProcessFrame } from '../../../crates/plugin-sdk/javascript/process.js';

export { scalarString } from './framing.js';
import { parseFrameJson, JsonFrameDecoder } from './framing.js';
export function decodeFrame(bytes: Uint8Array): ProcessFrame {
  const value = parseFrameJson(bytes, PROCESS_PROFILE.maxFrameBytes);
  if (!validate(value)) throw new Error('Invalid process frame');
  return value as ProcessFrame;
}
export function encodeFrame(value: ProcessFrame): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  decodeFrame(bytes);
  const result = Buffer.allocUnsafe(bytes.length + 4);
  result.writeUInt32BE(bytes.length);
  bytes.copy(result, 4);
  return result;
}
export class FrameDecoder extends JsonFrameDecoder<ProcessFrame> {
  constructor() { super(decodeFrame, PROCESS_PROFILE.maxFrameBytes); }
}

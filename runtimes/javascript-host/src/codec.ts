import { visit } from 'jsonc-parser';
import validate from './generated/validate-process.mjs';
import { PROCESS_PROFILE } from './generated/protocol.js';
import type { ProcessFrame } from '../../../crates/plugin-sdk/javascript/process.js';

export function scalarString(value: string): void {
  for (const character of value) {
    const cp = character.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('Invalid Unicode scalar');
  }
}
export function decodeFrame(bytes: Uint8Array): ProcessFrame {
  if (!bytes.length || bytes.length > PROCESS_PROFILE.maxFrameBytes) throw new Error('Frame limit');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const objects: Set<string>[] = [];
  let depth = 0;
  const begin = () => { if (++depth > 64) throw new Error('JSON nesting limit'); };
  visit(text, {
    onObjectBegin() { begin(); objects.push(new Set()); },
    onObjectProperty(key) {
      scalarString(key);
      const keys = objects.at(-1)!;
      if (keys.has(key)) throw new Error('Duplicate JSON member');
      keys.add(key);
    },
    onObjectEnd() { objects.pop(); depth--; },
    onArrayBegin: begin,
    onArrayEnd() { depth--; },
    onLiteralValue(value, offset, length) {
      if (typeof value === 'string') scalarString(value);
      // All numeric wire fields are integer identities/limits. Do not round
      // Rust u64 identities through an unsafe JavaScript number.
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || !/^(0|[1-9][0-9]*)$/.test(text.slice(offset, offset + length)))) throw new Error('Invalid wire integer');
    },
    onError() { throw new Error('Invalid JSON'); },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  const value: unknown = JSON.parse(text);
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
/** Allocates only after checking a complete prefix; retains at most one frame. */
export class FrameDecoder {
  private prefix = Buffer.alloc(4);
  private prefixOffset = 0;
  private body: Buffer | undefined;
  private bodyOffset = 0;
  private total = 0;
  push(chunk: Buffer, receive: (frame: ProcessFrame) => void): void {
    this.total += chunk.length;
    if (this.total > 64 * 1024 * 1024) throw new Error('Session input limit');
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const n = Math.min(4 - this.prefixOffset, chunk.length - offset);
        chunk.copy(this.prefix, this.prefixOffset, offset, offset + n);
        offset += n;
        this.prefixOffset += n;
        if (this.prefixOffset < 4) continue;
        const size = this.prefix.readUInt32BE();
        if (!size || size > PROCESS_PROFILE.maxFrameBytes) throw new Error('Frame limit');
        this.body = Buffer.allocUnsafe(size);
        this.bodyOffset = 0;
      }
      const n = Math.min(this.body.length - this.bodyOffset, chunk.length - offset);
      chunk.copy(this.body, this.bodyOffset, offset, offset + n);
      offset += n;
      this.bodyOffset += n;
      if (this.bodyOffset === this.body.length) {
        const frame = decodeFrame(this.body);
        this.body = undefined;
        this.prefixOffset = 0;
        receive(frame);
      }
    }
  }
  finish(): void {
    if (this.body || this.prefixOffset) throw new Error('Truncated frame');
  }
}

import validate from "./generated/validate-frame.mjs";
import type { MemberFrame } from "./generated/frame.js";
import { MEMBER_PROFILE } from "./generated/profile.js";
import { JsonFrameDecoder, parseFrameJson } from "../../javascript-host/src/framing.js";

export function decodeFrame(bytes: Uint8Array): MemberFrame {
  // Pi events include fractional durations and cost projections. Identity and
  // limit fields still pass the generated integer schemas and safe-number check.
  const value = parseFrameJson(bytes, MEMBER_PROFILE.maxFrameBytes, false);
  if (!validate(value)) throw new Error("Invalid member frame");
  return value as MemberFrame;
}

export function encodeFrame(frame: MemberFrame): Buffer {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  decodeFrame(bytes);
  const result = Buffer.allocUnsafe(bytes.length + 4);
  result.writeUInt32BE(bytes.length);
  bytes.copy(result, 4);
  return result;
}

export class FrameDecoder extends JsonFrameDecoder<MemberFrame> {
  constructor() { super(decodeFrame, MEMBER_PROFILE.maxFrameBytes); }
}

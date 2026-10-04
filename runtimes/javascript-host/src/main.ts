import { isAbsolute } from 'node:path';
import { ComponentSession } from './component.js';
import { FrameDecoder, encodeFrame } from './codec.js';

// This is lifecycle isolation, not a Node permission sandbox. The Rust parent
// captures the module, clears environment, bounds pipes and kills timed-out groups.
const fail = () => {
  process.stderr.write('JavaScript component channel failed.\n');
  process.exit(1);
};
const entry = process.argv[2];
const [major, minor] = process.versions.node.split('.').map(Number);
if (process.argv.length !== 3 || !entry || !isAbsolute(entry) || major !== 26 || minor! < 10) fail();
let pending = 0;
let total = 0;
const session = new ComponentSession(entry!, frame => {
  const bytes = encodeFrame(frame);
  total += bytes.length;
  if (pending >= 2 || total > 16 * 1024 * 1024) throw new Error('Output limit');
  pending++;
  return new Promise<void>((resolve, reject) => process.stdout.write(bytes, error => {
    pending--;
    if (error) reject(new Error('Output unavailable')); else resolve();
  }));
}, fail, () => process.exit(0));
const decoder = new FrameDecoder();
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
process.stdin.on('data', (bytes: Buffer) => {
  try { decoder.push(bytes, frame => session.receive(frame)); } catch { fail(); }
});
process.stdin.on('end', () => { try { decoder.finish(); } finally { fail(); } });
process.stdin.on('error', fail);
process.stdout.on('error', fail);

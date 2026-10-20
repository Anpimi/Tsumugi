import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectMachO, prepare } from '../scripts/prepare-desktop-runtime.mjs';

// Loader-only synthetic bytes, deliberately not an executable/authenticated
// distribution. No test launches these bytes or promotes them into approval.
function executable({ minimum = 0x000d0500, extra, external = false } = {}) {
  const stringCommand = (type, name, base) => {
    const length = Math.ceil((base + Buffer.byteLength(name) + 1) / 8) * 8;
    const bytes = Buffer.alloc(length);
    bytes.writeUInt32LE(type, 0);
    bytes.writeUInt32LE(length, 4);
    bytes.writeUInt32LE(base, 8);
    bytes.write(name, base);
    return bytes;
  };
  const target = Buffer.alloc(24);
  target.writeUInt32LE(0x32, 0);
  target.writeUInt32LE(24, 4);
  target.writeUInt32LE(1, 8);
  target.writeUInt32LE(minimum, 12);
  const libraries = [
    '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
    '/System/Library/Frameworks/Security.framework/Versions/A/Security',
    '/usr/lib/libc++.1.dylib', external ? '@rpath/libnode.dylib' : '/usr/lib/libSystem.B.dylib',
  ].map(name => stringCommand(0xc, name, 24));
  const commands = [target, stringCommand(0xe, '/usr/lib/dyld', 12), ...libraries];
  if (extra) commands.push(stringCommand(extra, '/external/runtime', 12));
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(commands.reduce((total, bytes) => total + bytes.length, 0), 20);
  return Buffer.concat([header, ...commands]);
}

test('loader inspection preserves the actual minimum and system imports', () => {
  const observed = inspectMachO(executable());
  assert.equal(observed.minimumSystemVersion, '13.5');
  assert.equal(observed.systemLibraries.length, 4);
});

test('loader inspection rejects external imports, rpaths and unknown commands', () => {
  assert.throws(() => inspectMachO(executable({ external: true })), /profile/);
  assert.throws(() => inspectMachO(executable({ extra: 0x8000001c })), /external runtime/);
  assert.throws(() => inspectMachO(executable({ extra: 0xff })), /external runtime/);
});

test('loader inspection rejects wrong architecture, minimum and truncated commands', () => {
  const wrong = executable();
  wrong.writeUInt32LE(0x01000007, 4);
  assert.throws(() => inspectMachO(wrong), /arm64/);
  assert.throws(() => inspectMachO(executable({ minimum: 0x000e0000 })), /profile/);
  assert.throws(() => inspectMachO(executable().subarray(0, 40)), /load commands/);
  const invalid = executable();
  invalid.writeUInt32LE(7, 36);
  assert.throws(() => inspectMachO(invalid), /command length/);
});

test('preparation rejects an unpinned archive before creating output', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tsumugi-runtime-preparation-'));
  try {
    const archive = join(root, 'node.tar.xz');
    const output = join(root, 'prepared');
    await mkdir(join(root, 'host'));
    await writeFile(archive, 'untrusted archive');
    await assert.rejects(prepare(['--node-archive', archive, '--host-source', join(root, 'host'),
      '--inspector', join(root, 'inspector'), '--output', output]), /pinned official distribution/);
    assert.deepEqual((await readdir(root)).sort(), ['host', 'node.tar.xz']);
  } finally { await rm(root, { recursive: true }); }
});

test('preparation refuses an existing output without changing its bytes', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tsumugi-runtime-preparation-'));
  try {
    const sentinel = join(root, 'sentinel');
    await writeFile(sentinel, 'preserved');
    await assert.rejects(prepare(['--node-archive', join(root, 'missing'), '--host-source', join(root, 'host'),
      '--inspector', join(root, 'inspector'), '--output', root]), /already exists/);
    assert.equal(await readFile(sentinel, 'utf8'), 'preserved');
  } finally { await rm(root, { recursive: true }); }
});

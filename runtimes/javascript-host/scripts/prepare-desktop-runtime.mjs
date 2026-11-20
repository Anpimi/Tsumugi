// Build tooling for a fixed distribution. It never executes the selected Node
// binary, a plugin or the prepared Host, and never installs or approves them.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MACOS_LOCK = JSON.parse(await fs.readFile(join(HERE, 'node-distribution.macos-aarch64.json'), 'utf8'));
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_NODE_BYTES = 160 * 1024 * 1024;
const USAGE = 'usage: prepare-desktop-runtime.mjs --node-archive <absolute-pinned-archive> --host-source <absolute-trusted-production-deploy> --inspector <absolute-tsumugi-plugin-runtime> --output <absolute-new-directory>';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
class PreparationError extends Error {}
const fail = message => { throw new PreparationError(message); };

function options(args) {
  const flags = ['--node-archive', '--host-source', '--inspector', '--output'];
  const result = {};
  if (args.length !== flags.length * 2) fail(USAGE);
  for (let i = 0; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || Object.hasOwn(result, args[i]) || !isAbsolute(args[i + 1] ?? '')) fail(USAGE);
    result[args[i]] = args[i + 1];
  }
  return result;
}

// Capture the selected archive once. Extraction uses these verified bytes,
// without reopening the selected source path.
async function archiveBytes(path, lock) {
  if (process.platform === 'win32' && !(await fs.lstat(path)).isFile()) {
    fail('Node archive must be a bounded regular file.');
  }
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_ARCHIVE_BYTES) fail('Node archive must be a bounded regular file.');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = await file.read(bytes, count, bytes.length - count, null);
      if (next.bytesRead === 0) break;
      count += next.bytesRead;
    }
    const after = await file.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) fail('Node archive changed during capture.');
    const captured = bytes.subarray(0, count);
    if (sha256(captured) !== lock.archiveSha256) fail('Node archive does not match the pinned official distribution.');
    return captured;
  } finally { await file.close(); }
}

// Parent-owned build tools have a bounded lifetime/output; child diagnostics
// are not copied into distributable metadata or exposed with local paths.
function command(executable, args, input, maximum, env) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    const chunks = [];
    let length = 0;
    let stderr = 0;
    let failure;
    const stop = message => { failure ??= new PreparationError(message); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('Runtime preparation tool exceeded its deadline.'), 60_000);
    child.on('error', () => { failure ??= new PreparationError('Runtime preparation tool could not start.'); });
    child.stdin.on('error', () => { failure ??= new PreparationError('Runtime preparation tool input failed.'); });
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > maximum) stop('Runtime preparation tool exceeded its output limit.');
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.length;
      if (stderr > 4096) stop('Runtime preparation tool exceeded its diagnostic limit.');
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new PreparationError('Runtime preparation tool failed.'));
      else accept(Buffer.concat(chunks, length));
    });
    child.stdin.end(input);
  });
}

// Check the actual loader boundary, not a version string or descriptor claim.
// This distribution profile deliberately admits one thin arm64 Mach-O only.
export function inspectMachO(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf
    || bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== 2) {
    fail('Node is not the pinned thin macOS arm64 executable.');
  }
  const commands = bytes.readUInt32LE(16);
  const size = bytes.readUInt32LE(20);
  if (commands > 4096 || size > bytes.length - 32) fail('Invalid Mach-O load commands.');
  const end = 32 + size;
  let cursor = 32;
  let minimum;
  let linker;
  const libraries = [];
  const passiveCommands = new Set([0x19, 0x80000034, 0x80000033, 0x2, 0xb,
    0x1b, 0x2a, 0x80000028, 0x26, 0x29, 0x1d]);
  const stringAt = (start, limit) => {
    const zero = bytes.indexOf(0, start);
    if (start >= limit || zero < start || zero >= limit) fail('Invalid Mach-O loader string.');
    const value = bytes.subarray(start, zero);
    if (value.some(byte => byte < 0x20 || byte > 0x7e)) fail('Invalid Mach-O loader string.');
    return value.toString('ascii');
  };
  const libraryCommands = new Set([0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023]);
  for (let i = 0; i < commands; i += 1) {
    if (cursor + 8 > end) fail('Truncated Mach-O load command.');
    const type = bytes.readUInt32LE(cursor);
    const length = bytes.readUInt32LE(cursor + 4);
    if (length < 8 || length % 8 !== 0 || length > end - cursor) fail('Invalid Mach-O command length.');
    if (libraryCommands.has(type)) {
      if (length < 24) fail('Truncated Mach-O library command.');
      const offset = bytes.readUInt32LE(cursor + 8);
      if (offset < 24 || offset >= length) fail('Invalid Mach-O library offset.');
      libraries.push(stringAt(cursor + offset, cursor + length));
    } else if (type === 0xe) {
      if (length < 16 || linker !== undefined) fail('Invalid Mach-O dynamic linker.');
      const offset = bytes.readUInt32LE(cursor + 8);
      if (offset < 12 || offset >= length) fail('Invalid Mach-O linker offset.');
      linker = stringAt(cursor + offset, cursor + length);
    } else if (type === 0x32) {
      if (length < 24 || minimum !== undefined || bytes.readUInt32LE(cursor + 8) !== 1
        || 24 + 8 * bytes.readUInt32LE(cursor + 20) !== length) fail('Invalid Mach-O macOS target.');
      const encoded = bytes.readUInt32LE(cursor + 12);
      minimum = `${encoded >>> 16}.${(encoded >>> 8) & 0xff}${(encoded & 0xff) ? `.${encoded & 0xff}` : ''}`;
    } else if (!passiveCommands.has(type)) {
      fail('Node loader uses an unsupported external runtime dependency.');
    }
    cursor += length;
  }
  if (cursor !== end || minimum !== MACOS_LOCK.minimumSystemVersion || linker !== '/usr/lib/dyld'
    || JSON.stringify(libraries.toSorted()) !== JSON.stringify(MACOS_LOCK.systemLibraries.toSorted())) {
    fail('Node loader does not match the pinned macOS system-library profile.');
  }
  return { minimumSystemVersion: minimum, systemLibraries: libraries.toSorted() };
}

function inspectWindowsNode(bytes, lock) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) {
    fail('Node is not the pinned Windows x64 executable.');
  }
  const header = bytes.readUInt32LE(60);
  if (header < 64 || header + 26 > bytes.length || bytes.readUInt32LE(header) !== 0x4550
    || bytes.readUInt16LE(header + 4) !== 0x8664 || bytes.readUInt16LE(header + 24) !== 0x20b) {
    fail('Node is not the pinned Windows x64 executable.');
  }
  // The exact verified executable pin also binds the audited DLL imports.
  return { minimumSystemVersion: lock.minimumSystemVersion, systemLibraries: lock.systemLibraries };
}

async function distribution() {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return {
      operatingSystem: 'macos', architecture: 'aarch64', lock: MACOS_LOCK,
      toolEntrypoint: 'bin/node', archiveEntrypoint: 'bin/node', tar: '/usr/bin/tar',
      inspectNode: inspectMachO, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    };
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) fail('Windows SystemRoot is unavailable.');
    const system = join(systemRoot, 'System32');
    const lock = JSON.parse(await fs.readFile(join(HERE, 'node-distribution.windows-x86_64.json'), 'utf8'));
    return {
      operatingSystem: 'windows', architecture: 'x86_64', lock, toolEntrypoint: 'bin/node.exe',
      archiveEntrypoint: 'node.exe', tar: join(system, 'tar.exe'), inspectNode: inspectWindowsNode,
      env: { SystemRoot: systemRoot, PATH: system },
    };
  }
  fail('Runtime preparation requires macOS arm64 or Windows x64.');
}

async function extractNodeFiles(execute, { operatingSystem, tar, lock, archiveEntrypoint }, archive, parent) {
  const root = lock.archive.replace(/(?:\.tar\.xz|\.zip)$/, '');
  const extract = async (source, input) => [
    await execute(tar, ['-xOf', source, '--', `${root}/${archiveEntrypoint}`], input, MAX_NODE_BYTES),
    await execute(tar, ['-xOf', source, '--', `${root}/LICENSE`], input, 1024 * 1024),
  ];
  if (operatingSystem !== 'windows') return extract('-', archive);

  // Windows tar needs a seekable ZIP to find all entries in this distribution.
  // Stage the captured bytes under a new name and still verify each selected
  // file against its independent pin before preparing any runtime resources.
  const staging = await fs.mkdtemp(join(parent, '.node-archive-'));
  const source = join(staging, lock.archive);
  try {
    await fs.writeFile(source, archive, { flag: 'wx', mode: 0o600 });
    return await extract(source, undefined);
  } finally {
    await fs.rm(source, { force: true });
    await fs.rmdir(staging);
  }
}

export async function prepare(args) {
  const config = options(args);
  const platform = await distribution();
  const { operatingSystem, architecture, lock, toolEntrypoint, inspectNode, env } = platform;
  const execute = (binary, argv, input, limit) => command(binary, argv, input, limit, env);
  const output = join(await fs.realpath(dirname(config['--output'])), basename(config['--output']));
  try { await fs.lstat(output); fail('Output already exists; choose a new directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!(await fs.lstat(config['--host-source'])).isDirectory()) fail('Host input must be a real production deploy directory.');
  const source = await fs.realpath(config['--host-source']);
  const inside = (root, selected) => {
    const suffix = relative(root, selected);
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  };
  if (inside(source, output) || inside(output, source)) fail('Host input and preparation output must be separate.');
  const archive = await archiveBytes(config['--node-archive'], lock);
  const [node, license] = await extractNodeFiles(execute, platform, archive, dirname(output));
  if (sha256(node) !== lock.files[toolEntrypoint] || sha256(license) !== lock.files.LICENSE) {
    fail('Selected Node files do not match the pinned distribution.');
  }
  const loader = inspectNode(node, lock);
  await fs.mkdir(output, { mode: 0o700 });
  // Any later failure leaves this new preparation directory for explicit review;
  // no existing file/directory is overwritten and no automatic cleanup occurs.
  const tool = join(output, 'tool');
  const host = join(output, 'host');
  await fs.mkdir(tool, { mode: 0o700 });
  await fs.mkdir(join(tool, 'bin'), { mode: 0o700 });
  await fs.writeFile(join(tool, toolEntrypoint), node, { mode: 0o755, flag: 'wx' });
  await fs.writeFile(join(tool, 'LICENSE'), license, { mode: 0o644, flag: 'wx' });
  // These files become installed application resources. Normalize their modes
  // even when the builder uses a restrictive umask; staging stays private.
  await fs.chmod(join(tool, toolEntrypoint), 0o755);
  await fs.chmod(join(tool, 'LICENSE'), 0o644);
  await execute(process.execPath, [join(HERE, 'package-runtime.mjs'),
    '--source', source, '--output', host], undefined, 4096);
  const requestPath = join(output, 'inspection-request.json');
  await fs.writeFile(requestPath, JSON.stringify({ profile: 'node-system-libraries-v1',
    toolVersion: lock.version, toolEntrypoint, hostEntrypoint: 'dist/main.js' }), { mode: 0o600, flag: 'wx' });
  const inspected = JSON.parse((await execute(config['--inspector'], ['inspect', tool, host, requestPath], undefined, 16 * 1024)).toString('utf8'));
  if (inspected.environment?.platform?.operatingSystem !== operatingSystem
    || inspected.environment.platform.architecture !== architecture
    || inspected.environment.profile !== 'node-system-libraries-v1'
    || inspected.environment.toolVersion !== lock.version
    || inspected.environment.tool.treeDigest !== lock.toolTreeDigest
    || inspected.environment.tool.entrypoint !== toolEntrypoint
    || inspected.environment.host.entrypoint !== 'dist/main.js') fail('Runtime inspector returned an unexpected platform/profile.');
  await fs.writeFile(join(output, 'inspection.json'), `${JSON.stringify(inspected, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(join(output, 'distribution.json'), `${JSON.stringify({
    formatVersion: 1, distribution: lock.archive, version: lock.version,
    url: lock.url, checksumsUrl: lock.checksumsUrl, archiveSha256: lock.archiveSha256,
    selectedFiles: lock.files, ...loader,
    verification: 'Fixed archive and selected-file SHA-256 pins; no network update, signature verification or execution approval.',
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return inspected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch(error => {
    // Fixed diagnostics do not disclose selected filesystem paths.
    if (error instanceof PreparationError) process.stderr.write(`${error.message}\n`);
    process.stderr.write('Runtime preparation failed. Review the explicit inputs and any partial output; use a new output directory.\n');
    process.exitCode = 1;
  });
}

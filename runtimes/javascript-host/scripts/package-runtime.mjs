// Preparation from a trusted, quiescent production deploy, not source capture,
// package authentication or permission to execute code. No dependency code runs.
import * as fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const PACKAGES = new Map([
  ['jsonc-parser', { version: '3.3.1', dependencies: {} }],
]);
const HOST_DEPENDENCIES = { 'jsonc-parser': '3.3.1' };
// Preparation limits are deliberately narrower than runtime admission limits.
const MAX_FILES = 1024;
const MAX_ENTRIES = 4096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const METADATA = new Set([
  'node_modules', '.pnpm', '.git', '.DS_Store', '.modules.yaml',
  '.pnpm-workspace-state-v1.json', '.package-lock.json', '.npmrc', '.yarnrc',
  '.yarnrc.yml',
]);
const SOURCE_FILE = /\.(?:[cm]?js|[cm]?ts)$/;
const PRIVATE_PATHS = [
  '/Users/', '/home/', '/private/var/', '/var/folders/', '/.pnpm/', '/.npm/',
  'file:///',
];
const USAGE = 'usage: package-runtime.mjs --source <absolute-production-deploy> --output <absolute-new-directory>';

class PackagingError extends Error {}
const fail = message => { throw new PackagingError(message); };
const inside = (root, path) => {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
};
const sameEntries = (actual, expected) => actual != null
  && typeof actual === 'object' && !Array.isArray(actual)
  && JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(expected).sort());

function options(args) {
  const values = new Map();
  const flags = ['--source', '--output'];
  if (args.length !== flags.length * 2) fail(USAGE);
  for (let i = 0; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || values.has(args[i]) || !isAbsolute(args[i + 1] ?? '')) fail(USAGE);
    values.set(args[i], args[i + 1]);
  }
  return Object.fromEntries(values);
}

async function regularBytes(path) {
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail('Expected a bounded regular input file.');
  const bytes = await fs.readFile(path);
  if (bytes.length !== stat.size || bytes.length > MAX_FILE_BYTES) fail('Input changed during packaging.');
  return { bytes, executable: (stat.mode & 0o111) !== 0 };
}

async function manifest(root) {
  const file = await regularBytes(join(root, 'package.json'));
  let data;
  try { data = JSON.parse(file.bytes.toString('utf8')); }
  catch { fail('Invalid input package manifest.'); }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) fail('Invalid input package manifest.');
  // Installed cache provenance is not a public package manifest. Refuse it
  // rather than changing published package.json bytes behind the caller's back.
  if (Object.keys(data).some(key => key.startsWith('_'))) fail('Installed package metadata is not supported.');
  return { data, file };
}

function dependencyFields(data, dependencies) {
  if (!sameEntries(data.dependencies ?? {}, dependencies)
    || !sameEntries(data.optionalDependencies ?? {}, {})
    || !sameEntries(data.peerDependencies ?? {}, {})
    || (data.bundledDependencies?.length ?? 0) !== 0
    || (data.bundleDependencies?.length ?? 0) !== 0) fail('Production dependency closure does not match the pinned profile.');
  const metadata = data.peerDependenciesMeta ?? {};
  if (!sameEntries(metadata, {})) {
    fail('Unsupported required or unknown peer dependency.');
  }
}

// Follow only the named, pinned dependency edges in this explicit trusted input.
// Search from each real owner so pnpm's package-local dependencies are selected.
// Never search an ancestor outside the deploy or use a global dependency store.
async function resolvePackage(source, owner, name) {
  for (let cursor = owner; inside(source, cursor); cursor = dirname(cursor)) {
    if (basename(cursor) !== 'node_modules') {
      const candidate = join(cursor, 'node_modules', ...name.split('/'));
      let stat;
      try { stat = await fs.lstat(candidate); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        const resolved = await fs.realpath(candidate);
        if (!inside(source, resolved) || !(await fs.lstat(resolved)).isDirectory()) {
          fail('A dependency resolves outside the trusted deploy.');
        }
        return resolved;
      }
    }
    if (cursor === source) break;
  }
  fail('A pinned production dependency is missing.');
}

async function main(args) {
  const config = options(args);
  if (!(await fs.lstat(config['--source'])).isDirectory()) fail('Source must be a real production deploy directory.');
  const source = await fs.realpath(config['--source']);
  const output = join(await fs.realpath(dirname(config['--output'])), basename(config['--output']));
  if (inside(source, output) || inside(output, source)) fail('Source and output directories must be separate.');
  try { await fs.lstat(output); fail('Output already exists; choose a new directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const host = await manifest(source);
  if (host.data.name !== '@tsumugi/javascript-host' || host.data.type !== 'module'
    || host.data.engines?.node !== '>=26.10.0 <27') fail('Unexpected Host production manifest.');
  dependencyFields(host.data, HOST_DEPENDENCIES);

  const files = new Map();
  const names = new Map();
  let total = 0;
  const privatePaths = [...PRIVATE_PATHS, source, config['--source']];
  function registerName(path) {
    if (!path || path.length > 1024 || path.includes('\\') || path.includes(':')
      || /[\u0000-\u001f\u007f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')) fail('Unsupported output path.');
    const key = path.normalize('NFC').toLowerCase();
    if (names.has(key) && names.get(key) !== path) fail('Portable output path collision.');
    names.set(key, path);
    if (names.size > MAX_ENTRIES) fail('Runtime directory preparation limit exceeded.');
  }
  function add(path, file) {
    registerName(path);
    let bytes = file.bytes;
    if (SOURCE_FILE.test(path)) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const clean = text
        .replace(/^[\t ]*\/\/[#@][\t ]*(?:sourceMappingURL|sourceURL)=.*(?:\r?\n|$)/gm, '')
        .replace(/\/\*[#@][\t ]*(?:sourceMappingURL|sourceURL)=[\s\S]*?\*\//g, '');
      bytes = Buffer.from(clean, 'utf8');
    }
    if (privatePaths.some(value => bytes.includes(Buffer.from(value)))) fail('Input contains a machine-local path or cache reference.');
    if (files.has(path)) fail('Duplicate output file.');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES || files.size >= MAX_FILES) fail('Runtime package preparation limit exceeded.');
    files.set(path, { bytes, executable: file.executable });
  }
  async function tree(root, prefix, depth = 0) {
    if (depth > 32 || !(await fs.lstat(root)).isDirectory()) fail('Expected a bounded real directory.');
    registerName(prefix);
    for (const name of (await fs.readdir(root)).sort()) {
      if (METADATA.has(name) || name.endsWith('.map')) continue;
      if (name.startsWith('.')) fail('Unknown hidden input file.');
      const input = join(root, name);
      const outputPath = `${prefix}/${name}`;
      const stat = await fs.lstat(input);
      if (stat.isDirectory()) await tree(input, outputPath, depth + 1);
      else if (stat.isFile()) add(outputPath, await regularBytes(input));
      else fail('Public package files must be regular files and directories.');
    }
  }

  add('package.json', host.file);
  await tree(join(source, 'dist'), 'dist');
  for (const required of [
    'dist/main.js', 'dist/component.js', 'dist/codec.js',
    'dist/generated/protocol.js', 'dist/generated/validate-process.mjs',
  ]) if (!files.has(required)) fail('The compiled Host is incomplete.');

  const selected = new Map();
  async function collect(name, owner) {
    const root = await resolvePackage(source, owner, name);
    if (selected.has(name)) {
      if (selected.get(name) !== root) fail('Conflicting dependency owners.');
      return;
    }
    const expected = PACKAGES.get(name);
    if (!expected) fail('Unexpected production dependency.');
    const packageManifest = await manifest(root);
    if (packageManifest.data.name !== name || packageManifest.data.version !== expected.version
      || packageManifest.data.license !== 'MIT') fail('Unexpected production package identity.');
    dependencyFields(packageManifest.data, expected.dependencies);
    selected.set(name, root);
    const prefix = `node_modules/${name}`;
    await tree(root, prefix);
    if (![`${prefix}/LICENSE`, `${prefix}/LICENSE.md`].some(path => files.has(path))) {
      fail('A production package license is missing.');
    }
    // Verify the published Node entrypoint rather than assuming an index.js.
    const entrypoint = packageManifest.data.main?.replace(/^\.\//, '');
    if (typeof entrypoint !== 'string' || !files.has(`${prefix}/${entrypoint}`)) fail('A production package entrypoint is missing.');
    for (const dependency of Object.keys(expected.dependencies).sort()) await collect(dependency, root);
  }
  for (const dependency of Object.keys(HOST_DEPENDENCIES).sort()) await collect(dependency, source);
  if (selected.size !== PACKAGES.size) fail('Production dependency closure is incomplete.');

  // Read and validate everything before creating the caller's fresh output.
  // Fresh writes break pnpm hard links; no links or installation metadata remain.
  await fs.mkdir(output, { mode: 0o700 });
  await fs.chmod(output, 0o700);
  const directories = new Set([output]);
  async function parents(path) {
    let directory = output;
    for (const part of path.split('/').slice(0, -1)) {
      directory = join(directory, part);
      if (directories.has(directory)) continue;
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.chmod(directory, 0o700);
      directories.add(directory);
    }
  }
  for (const [path, file] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const destination = join(output, ...path.split('/'));
    await parents(path);
    await fs.writeFile(destination, file.bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
    await fs.chmod(destination, file.executable ? 0o755 : 0o644);
  }
  process.stdout.write(`Prepared Host runtime: ${files.size} files, ${total} bytes, ${selected.size} pinned production dependency.\n`);
}

try { await main(process.argv.slice(2)); }
catch (error) {
  process.stderr.write(`${error instanceof PackagingError ? error.message : 'Runtime package IO failed; any partial output must be discarded before a fresh retry.'}\n`);
  process.exitCode = 1;
}

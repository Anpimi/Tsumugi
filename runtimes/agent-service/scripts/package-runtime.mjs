import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !isAbsolute(args[1])) {
  throw new Error('usage: package-runtime.mjs --output <absolute-new-directory>');
}
const output = resolve(args[1]);
try { await lstat(output); throw new Error('Output already exists'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
// This is emitted from the same Core authority as the member's TypeScript
// profile. Packaging never chooses a second protocol version or runs generation.
const profile = JSON.parse(await readFile(new URL('../src/generated/profile.json', import.meta.url), 'utf8'));
if (!Number.isSafeInteger(profile.protocolVersion) || profile.protocolVersion < 1 || profile.protocolVersion > 0xffffffff) {
  throw new Error('Invalid generated member protocol profile');
}
const bundled = await build({
  absWorkingDir: root,
  entryPoints: [join(source, 'src/worker.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node26',
  mainFields: ['module', 'main'],
  outfile: 'worker.mjs', write: false, metafile: true, sourcemap: false,
  legalComments: 'inline', logLevel: 'silent',
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
for (const file of Object.values(bundled.metafile.outputs)) {
  if (file.imports.some(entry => entry.external && !builtins.has(entry.path))) {
    throw new Error('Member bundle contains an unresolved external dependency');
  }
}
if (bundled.warnings.length || bundled.outputFiles.length !== 1
    || bundled.outputFiles[0].contents.length > 16 * 1024 * 1024) {
  throw new Error('Member bundle is incomplete or exceeds its limit');
}
const files = new Map([['worker.mjs', bundled.outputFiles[0].contents],
  ['manifest.json', JSON.stringify({ format: 'tsumugi-member-runtime', version: 1,
    protocolVersion: profile.protocolVersion, entrypoint: 'worker.mjs' }, null, 2) + '\n'],
  ['LICENSE', await readFile(join(root, 'crates/plugin-sdk/LICENSE'))]]);
const packages = new Map();
for (const meta of Object.values(bundled.metafile.outputs)) {
  for (const [input, usage] of Object.entries(meta.inputs)) {
    if (!usage.bytesInOutput || !input.includes('node_modules/')) continue;
    let directory = dirname(await realpath(resolve(root, input)));
    while (directory !== dirname(directory)) {
      try {
        const info = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (typeof info.name === 'string' && typeof info.version === 'string') {
          packages.set(directory, info); break;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = dirname(directory);
    }
  }
}
const notices = [];
for (const [directory, info] of [...packages].sort((a, b) => `${a[1].name}@${a[1].version}`.localeCompare(`${b[1].name}@${b[1].version}`))) {
  const licenses = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!/^(licen[cs]e|copying|notice)([.-]|$)/i.test(name)) continue;
    const path = join(directory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid dependency license');
    const destination = `licenses/${String(notices.length).padStart(3, '0')}-${info.name.replace(/[^A-Za-z0-9.-]/g, '_')}-${name}`;
    files.set(destination, await readFile(path)); licenses.push(destination);
  }
  if (!licenses.length && ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai'].includes(info.name)
      && info.version === '1.3.0' && info.license === 'MIT'
      && info.repository?.url === 'git+https://github.com/earendil-works/pi.git') {
    // These npm artifacts omit their monorepo license; retain the pinned upstream notice.
    const destination = 'licenses/pi-1.3.0.txt';
    files.set(destination, await readFile(join(source, 'licenses/pi-1.3.0.txt')));
    licenses.push(destination);
  }
  if (!licenses.length) throw new Error(`Missing license for bundled dependency ${info.name}`);
  notices.push({ name: info.name, version: info.version, license: info.license ?? null, files: licenses });
}
files.set('licenses/THIRD-PARTY.json', JSON.stringify(notices, null, 2) + '\n');
if (files.size > 256 || [...files.values()].reduce((sum, data) => sum + Buffer.byteLength(data), 0) > 24 * 1024 * 1024) {
  throw new Error('Member artifact exceeds its captured tree limits');
}
// Publish only a complete new artifact; never replace an existing candidate.
const staging = await mkdtemp(join(dirname(output), '.member-runtime-'));
try {
  for (const [name, bytes] of files) {
    const path = join(staging, name);
    if (relative(staging, path).startsWith('..')) throw new Error('Invalid output member');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o644 });
    // Installed resource files must remain readable across installation users,
    // independently of the builder's umask. The owned staging stays private.
    await chmod(path, 0o644);
  }
  await rename(staging, output);
} catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
console.log(`Packaged member runtime: ${files.size} files, ${notices.length} dependency notices.`);

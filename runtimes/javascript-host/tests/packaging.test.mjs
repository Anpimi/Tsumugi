import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packager = fileURLToPath(new URL('../scripts/package-runtime.mjs', import.meta.url));
const hostManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// These trusted-input fixtures check preparation policy, not dependency
// authenticity, working component code or permission to execute an artifact.
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'tsumugi-host-packaging-'));
  const source = join(root, 'deploy');
  const output = join(root, 'prepared');
  const dependency = join(source, 'node_modules/jsonc-parser');
  try {
    await mkdir(join(source, 'dist/generated'), { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify(hostManifest));
    for (const file of ['main.js', 'component.js', 'codec.js', 'generated/protocol.js', 'generated/validate-process.mjs']) {
      await writeFile(join(source, 'dist', file), 'export {};\n//# sourceMappingURL=local.map\n');
    }
    await mkdir(join(dependency, 'lib/umd'), { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({
      name: 'jsonc-parser', version: '3.3.1', license: 'MIT', main: './lib/umd/main.js',
    }));
    await writeFile(join(dependency, 'lib/umd/main.js'), 'module.exports = {};\n');
    await writeFile(join(dependency, 'LICENSE.md'), 'Synthetic preparation fixture license.\n');
    const invoke = (extra = []) => spawnSync(process.execPath,
      [packager, '--source', source, '--output', output, ...extra],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 });
    await run({ root, source, output, dependency, invoke });
  } finally { await rm(root, { recursive: true }); }
}

test('packaging retains the current closure and refuses to overwrite an output', async () => {
  await fixture(async ({ output, invoke }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 pinned production dependency/);
    assert.deepEqual(await readdir(join(output, 'node_modules')), ['jsonc-parser']);
    assert.equal(await readFile(join(output, 'dist/component.js'), 'utf8'), 'export {};\n');
    const license = await readFile(join(output, 'node_modules/jsonc-parser/LICENSE.md'), 'utf8');
    assert.match(license, /Synthetic preparation fixture/);
    const repeated = invoke();
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /Output already exists/);
    assert.equal(await readFile(join(output, 'node_modules/jsonc-parser/LICENSE.md'), 'utf8'), license);
  });
});

test('packaging refuses historical dependency declarations and removed options before output', async () => {
  await fixture(async ({ source, output, invoke }) => {
    await writeFile(join(source, 'package.json'), JSON.stringify({
      ...hostManifest, dependencies: { ...hostManifest.dependencies, cordis: '4.0.0-rc.10' },
    }));
    const result = invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dependency closure/);
    await assert.rejects(readFile(join(output, 'package.json')), { code: 'ENOENT' });
    const removed = invoke(['--cordis-license', join(source, 'LICENSE')]);
    assert.equal(removed.status, 1);
    assert.match(removed.stderr, /usage:/);
  });
});

test('packaging refuses missing licenses and undeclared peers without creating output', async () => {
  await fixture(async ({ dependency, output, invoke }) => {
    await rm(join(dependency, 'LICENSE.md'));
    const result = invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /license is missing/);
    await writeFile(join(dependency, 'LICENSE.md'), 'Synthetic preparation fixture license.\n');
    const manifestPath = join(dependency, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, peerDependencies: { 'unknown-peer': '1.0.0' } }));
    const peer = invoke();
    assert.equal(peer.status, 1);
    assert.match(peer.stderr, /dependency closure/);
    await assert.rejects(readFile(join(output, 'package.json')), { code: 'ENOENT' });
  });
});

test('packaging cannot capture a dependency outside the selected deploy', async () => {
  await fixture(async ({ root, source, dependency, output, invoke }) => {
    await rm(dependency, { recursive: true });
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(source, 'node_modules/jsonc-parser'));
    const result = invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the trusted deploy/);
    await assert.rejects(readFile(join(output, 'package.json')), { code: 'ENOENT' });
  });
});

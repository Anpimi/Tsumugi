import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--bootstrap' || !isAbsolute(args[1]))) throw new Error('usage: test-process.mjs [--bootstrap <absolute-built-host>]');
const bootstrap = args[1] ?? fileURLToPath(new URL('../dist/main.js', import.meta.url));
const result = spawnSync('cargo', [
  'test', '--locked', '--offline', '-p', 'tsumugi-plugin-host', '--features', 'javascript-conformance', '--test', 'javascript',
], {
  cwd: fileURLToPath(new URL('../../../', import.meta.url)),
  stdio: 'inherit',
  env: { ...process.env, TSUMUGI_PARENT_ONLY: 'synthetic-private-parent-value', TSUMUGI_TEST_NODE: process.execPath,
    TSUMUGI_TEST_JS_HOST_BOOTSTRAP: bootstrap },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

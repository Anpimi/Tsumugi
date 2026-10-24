import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
const args = process.argv.slice(2);
const names = ['--tool', '--host', '--approval'];
if (args.length !== 6 || names.some((name, index) => args[index * 2] !== name || !isAbsolute(args[index * 2 + 1]))) {
  throw new Error('usage: test-process.mjs --tool <absolute-tool-tree> --host <absolute-clean-host-tree> --approval <absolute-approved-descriptor-json>');
}
const result = spawnSync('cargo', [
  'test', '--locked', '--offline', '-p', 'tsumugi-plugin-host', '--features', 'javascript-conformance', '--test', 'javascript', '--', '--test-threads=1',
], {
  cwd: fileURLToPath(new URL('../../../', import.meta.url)),
  stdio: 'inherit',
  env: { ...process.env, TSUMUGI_PARENT_ONLY: 'synthetic-private-parent-value',
    TSUMUGI_TEST_RUNTIME_TOOL: args[1], TSUMUGI_TEST_RUNTIME_HOST: args[3], TSUMUGI_TEST_RUNTIME_APPROVAL: args[5] },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

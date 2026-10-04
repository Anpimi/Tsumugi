import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compile } from 'json-schema-to-typescript';
import Ajv from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';

const root = new URL('../../../', import.meta.url);
const schemaURL = new URL('crates/plugin-sdk/schemas/process-frame.schema.json', root);
const cargo = (...args) => execFileSync('cargo', [
  'run', '--quiet', '--locked', '--offline', '-p', 'tsumugi-plugin-sdk',
  '--features', 'schema', '--bin', 'tsumugi-plugin-contract', '--', ...args,
], { cwd: fileURLToPath(root), encoding: 'utf8' });
cargo('check-process-schema', fileURLToPath(schemaURL));
const schema = JSON.parse(await readFile(schemaURL, 'utf8'));
const profile = JSON.parse(cargo('profile-process'));
const banner = '// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.\n';
const ajv = new Ajv({ strict: true, code: { source: true, esm: true, lines: true } });
const outputs = [
  [new URL('crates/plugin-sdk/javascript/process.d.ts', root), await compile(schema, 'ProcessFrame', {
    bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
  })],
  [new URL('../src/generated/validate-process.mjs', import.meta.url), banner + standaloneCode(ajv, ajv.compile(schema))],
  [new URL('../src/generated/protocol.ts', import.meta.url), `${banner}export const PROCESS_PROFILE = ${JSON.stringify(profile, null, 2)} as const;\n`],
];
for (const [url, source] of outputs) {
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== source) throw new Error(`Stale generated contract: ${url.pathname.split('/').at(-1)}`);
  } else await writeFile(url, source);
}
console.log(process.argv.includes('--check') ? 'Generated contracts are current.' : 'Generated SDK types and process validator.');

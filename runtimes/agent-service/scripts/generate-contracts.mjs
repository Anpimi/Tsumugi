import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Ajv from 'ajv/dist/2020.js';
import { standaloneValidator, contractTypes } from '../../../crates/plugin-sdk/scripts/schema-output.mjs';

const root = new URL('../../../', import.meta.url);
const { schema, profile } = JSON.parse(execFileSync('cargo', [
  'run', '--quiet', '--locked', '--offline', '-p', 'tsumugi-core', '--features', 'wire-schema',
  '--bin', 'tsumugi-member-wire-schema',
], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
const banner = '// Generated from the Core member channel. Run pnpm generate:contracts; do not edit.\n';
const ajvPackage = new URL(import.meta.resolve('ajv/package.json'));
const manifest = JSON.parse(await readFile(ajvPackage, 'utf8'));
const license = await readFile(new URL('LICENSE', ajvPackage), 'utf8');
const attribution = `// Standalone generator: ${manifest.name} ${manifest.version} (${manifest.license}).\n`
  + license.trimEnd().split('\n').map(line => line ? `// ${line}` : '//').join('\n') + '\n';
const output = new URL('../src/generated/', import.meta.url);
await mkdir(output, { recursive: true });
const sources = {
  'profile.json': JSON.stringify(profile, null, 2) + '\n',
  'frame.schema.json': JSON.stringify(schema, null, 2) + '\n',
  'frame.d.ts': await contractTypes(schema, 'MemberFrame', banner),
  'validate-frame.mjs': banner + attribution + standaloneValidator(new Ajv({ strict: true, code: { source: true, esm: true, lines: true } }), schema),
  'profile.ts': `${banner}export const MEMBER_PROFILE = ${JSON.stringify(profile, null, 2)} as const;\n`,
};
for (const [name, text] of Object.entries(sources)) {
  const file = new URL(name, output);
  if (process.argv.includes('--check')) {
    if (await readFile(file, 'utf8') !== text) throw new Error(`Stale member contract: ${name}`);
  } else await writeFile(file, text);
}
console.log(process.argv.includes('--check') ? 'Member contracts are current.' : 'Generated Core member contracts.');

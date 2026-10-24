import { standaloneValidator } from './schema-output.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compile } from 'json-schema-to-typescript';
import Ajv from 'ajv/dist/2020.js';

const root = new URL('../', import.meta.url);
const schemaURL = new URL('schemas/process-frame.schema.json', root);
const exchangeSchemaURL = new URL('schemas/content-exchange.schema.json', root);
const contentTypesURL = new URL('schemas/content-types.schema.json', root);
const sourceInputURL = new URL('schemas/source-extraction-input.schema.json', root);
const sourceCheckInputURL = new URL('schemas/source-extraction-check-input.schema.json', root);
const cargo = (...args) => execFileSync('cargo', [
  'run', '--quiet', '--locked', '--offline', '--manifest-path',
  fileURLToPath(new URL('Cargo.toml', root)),
  '--features', 'schema', '--bin', 'tsumugi-plugin-contract', '--', ...args,
], { cwd: fileURLToPath(root), encoding: 'utf8' });
cargo('check-schema', fileURLToPath(new URL('schemas/plugin-manifest.schema.json', root)));
cargo('check-process-schema', fileURLToPath(schemaURL));
cargo('check-exchange-schema', fileURLToPath(exchangeSchemaURL));
cargo('check-content-types-schema', fileURLToPath(contentTypesURL));
for (const kind of ['input', 'error', 'check-input']) {
  cargo(`check-source-extraction-${kind}-schema`, fileURLToPath(
    new URL(`schemas/source-extraction-${kind}.schema.json`, root),
  ));
}
cargo('check-source-import-declaration-schema', fileURLToPath(new URL('schemas/source-import-declaration.schema.json', root)));
cargo('check-check-results-schema', fileURLToPath(new URL('schemas/check-results.schema.json', root)));
const buildSchemas = new Map();
for (const kind of ['build-input', 'artifact-set', 'artifact-check-input', 'build-declaration', 'build-error', 'build-types']) {
  const url = new URL(`schemas/${kind}.schema.json`, root);
  cargo(`check-${kind}-schema`, fileURLToPath(url));
  buildSchemas.set(kind, JSON.parse(await readFile(url, 'utf8')));
}
const translationSchemas = new Map();
for (const kind of ['translation-extraction-input', 'translation-exchange', 'translation-extraction-check-input', 'translation-import-declaration', 'translation-types']) {
  const url = new URL(`schemas/${kind}.schema.json`, root);
  cargo(`check-${kind}-schema`, fileURLToPath(url));
  translationSchemas.set(kind, JSON.parse(await readFile(url, 'utf8')));
}
const reviewSchemas = new Map();
for (const kind of ['review-check-input', 'review-declaration', 'review-check-error', 'review-types']) {
  const url = new URL(`schemas/${kind}.schema.json`, root);
  cargo(`check-${kind}-schema`, fileURLToPath(url));
  reviewSchemas.set(kind, JSON.parse(await readFile(url, 'utf8')));
}
const toolSchemas = new Map();
for (const kind of ['tool-declaration', 'tool-types']) {
  const url = new URL(`schemas/${kind}.schema.json`, root);
  cargo(`check-${kind}-schema`, fileURLToPath(url));
  toolSchemas.set(kind, JSON.parse(await readFile(url, 'utf8')));
}
const textReviewSchemas = new Map();
for (const kind of ['text-review-input', 'text-review-declaration', 'text-review-report', 'text-review-types']) {
  const url = new URL(`schemas/${kind}.schema.json`, root);
  cargo(`check-${kind}-schema`, fileURLToPath(url));
  textReviewSchemas.set(kind, JSON.parse(await readFile(url, 'utf8')));
}
const generationSchemas = new Map();
for (const kind of ['generation-component-input', 'generation-service-input', 'generation-service-receipt', 'generation-service-error', 'generation-service-types']) {
  const url = new URL(`schemas/${kind}.schema.json`, root);
  cargo(`check-${kind}-schema`, fileURLToPath(url));
  generationSchemas.set(kind, JSON.parse(await readFile(url, 'utf8')));
}
const sourceContextURL = new URL('schemas/source-context-facts.schema.json', root);
cargo('check-source-context-facts-schema', fileURLToPath(sourceContextURL));
const sourceContextSchema = JSON.parse(await readFile(sourceContextURL, 'utf8'));
const sourceContextProfile = JSON.parse(cargo('profile-source-context'));
const schema = JSON.parse(await readFile(schemaURL, 'utf8'));
const contentTypes = JSON.parse(await readFile(contentTypesURL, 'utf8'));
const sourceInput = JSON.parse(await readFile(sourceInputURL, 'utf8'));
const sourceCheckInput = JSON.parse(await readFile(sourceCheckInputURL, 'utf8'));
const banner = '// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.\n';
const ajvPackageURL = new URL(import.meta.resolve('ajv/package.json'));
const ajvPackage = JSON.parse(await readFile(ajvPackageURL, 'utf8'));
const ajvLicense = await readFile(new URL('LICENSE', ajvPackageURL), 'utf8');
const sourceValidatorAttribution = `// Standalone generator: ${ajvPackage.name} ${ajvPackage.version} (${ajvPackage.license}).\n`
  + ajvLicense.trimEnd().split('\n').map(line => line ? `// ${line}` : '//').join('\n') + '\n';
const ajv = new Ajv({ strict: true, code: { source: true, esm: true, lines: true } });
// Ajv names generated functions in compilation order. Retain the process-schema
// compilation so SDK output stays unchanged while no Host files are emitted.
standaloneValidator(ajv, schema);
const sourceInputValidator = standaloneValidator(ajv, sourceInput);
const sourceCheckInputValidator = standaloneValidator(ajv, sourceCheckInput);
for (const validator of [sourceInputValidator, sourceCheckInputValidator]) {
  if (/^\s*import\s/m.test(validator) || /\brequire\s*\(/.test(validator)) {
    throw new Error('The generated source validator requires a runtime dependency.');
  }
}
const outputs = [
  [new URL('javascript/process.d.ts', root), await compile(schema, 'ProcessFrame', {
    bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
  })],
  [new URL('javascript/content.d.ts', root), await compile(contentTypes, 'SourceExtractionTypes', {
    bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
  })],
  [new URL('javascript/validate-source-extraction-input.mjs', root), banner + sourceValidatorAttribution + sourceInputValidator],
  [new URL('javascript/validate-source-extraction-check-input.mjs', root), banner + sourceValidatorAttribution + sourceCheckInputValidator],
];
outputs.push([new URL('javascript/build.d.ts', root), await compile(buildSchemas.get('build-types'), 'BuildTypes', {
  bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
})]);
for (const kind of ['build-input', 'artifact-set', 'artifact-check-input']) {
  const validator = standaloneValidator(ajv, buildSchemas.get(kind));
  if (/^\s*import\s/m.test(validator) || /\brequire\s*\(/.test(validator)) {
    throw new Error('The generated build validator requires a runtime dependency.');
  }
  outputs.push([new URL(`javascript/validate-${kind}.mjs`, root), banner + sourceValidatorAttribution + validator]);
}
outputs.push([new URL('javascript/translation.d.ts', root), await compile(translationSchemas.get('translation-types'), 'TranslationTypes', {
  bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
})]);
for (const kind of ['translation-extraction-input', 'translation-exchange', 'translation-extraction-check-input']) {
  const validator = standaloneValidator(ajv, translationSchemas.get(kind));
  if (/^\s*import\s/m.test(validator) || /\brequire\s*\(/.test(validator)) {
    throw new Error('The generated translation validator requires a runtime dependency.');
  }
  outputs.push([new URL(`javascript/validate-${kind}.mjs`, root), banner + sourceValidatorAttribution + validator]);
}
outputs.push([new URL('javascript/review.d.ts', root), await compile(reviewSchemas.get('review-types'), 'ReviewTypes', {
  bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
})]);
for (const kind of ['review-check-input', 'review-declaration', 'review-check-error']) {
  const validator = standaloneValidator(ajv, reviewSchemas.get(kind));
  if (/^\s*import\s/m.test(validator) || /\brequire\s*\(/.test(validator)) {
    throw new Error('The generated review validator requires a runtime dependency.');
  }
  outputs.push([new URL(`javascript/validate-${kind}.mjs`, root), banner + sourceValidatorAttribution + validator]);
}
outputs.push([new URL('javascript/tool.d.ts', root), await compile(toolSchemas.get('tool-types'), 'ToolTypes', {
  bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
})]);
const toolValidator = standaloneValidator(ajv, toolSchemas.get('tool-declaration'));
if (/^\s*import\s/m.test(toolValidator) || /\brequire\s*\(/.test(toolValidator)) {
  throw new Error('The generated tool validator requires a runtime dependency.');
}
outputs.push([new URL('javascript/validate-tool-declaration.mjs', root), banner + sourceValidatorAttribution + toolValidator]);
outputs.push([new URL('javascript/text-review.d.ts', root), await compile(textReviewSchemas.get('text-review-types'), 'TextReviewTypes', {
  bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
})]);
for (const kind of ['text-review-input', 'text-review-declaration', 'text-review-report']) {
  const validator = standaloneValidator(ajv, textReviewSchemas.get(kind));
  if (/^\s*import\s/m.test(validator) || /\brequire\s*\(/.test(validator)) {
    throw new Error('The generated text review validator requires a runtime dependency.');
  }
  outputs.push([new URL(`javascript/validate-${kind}.mjs`, root), banner + sourceValidatorAttribution + validator]);
}
outputs.push([new URL('javascript/generation.d.ts', root), await compile(generationSchemas.get('generation-service-types'), 'GenerationServiceTypes', {
  bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
})]);
outputs.push([new URL('javascript/generation-component.d.ts', root), await compile(generationSchemas.get('generation-component-input'), 'GenerationComponentInput', {
  bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
})]);
for (const kind of ['generation-service-input', 'generation-service-receipt', 'generation-service-error']) {
  const validator = standaloneValidator(ajv, generationSchemas.get(kind));
  if (/^\s*import\s/m.test(validator) || /\brequire\s*\(/.test(validator)) {
    throw new Error('The generated generation validator requires a runtime dependency.');
  }
  outputs.push([new URL(`javascript/validate-${kind}.mjs`, root), banner + sourceValidatorAttribution + validator]);
}
outputs.push([new URL('javascript/source-context.d.ts', root), await compile(sourceContextSchema, 'SourceContextFacts', {
  bannerComment: banner, additionalProperties: false, unreachableDefinitions: true,
})]);
const sourceContextValidator = standaloneValidator(ajv, sourceContextSchema);
if (/^\s*import\s/m.test(sourceContextValidator) || /\brequire\s*\(/.test(sourceContextValidator)) {
  throw new Error('The generated context validator requires a runtime dependency.');
}
outputs.push([new URL('javascript/validate-source-context-facts.mjs', root), banner + sourceValidatorAttribution + sourceContextValidator]);
outputs.push([new URL('javascript/source-context-profile.mjs', root), `${banner}const profile = ${JSON.stringify(sourceContextProfile, null, 2)};\nObject.freeze(profile.contract);\nexport const SOURCE_CONTEXT_FACTS_PROFILE = Object.freeze(profile);\n`]);
const componentValidator = standaloneValidator(ajv, generationSchemas.get('generation-component-input'));
if (/^\s*import\s/m.test(componentValidator) || /\brequire\s*\(/.test(componentValidator)) {
  throw new Error('The generated component input validator requires a runtime dependency.');
}
outputs.push([new URL('javascript/validate-generation-component-input.mjs', root), banner + sourceValidatorAttribution + componentValidator]);
for (const [url, source] of outputs) {
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== source) throw new Error(`Stale generated contract: ${url.pathname.split('/').at(-1)}`);
  } else await writeFile(url, source);
}
console.log(process.argv.includes('--check') ? 'Generated contracts are current.' : 'Generated SDK types and validators.');

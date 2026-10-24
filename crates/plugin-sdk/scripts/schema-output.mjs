import standaloneCode from 'ajv/dist/standalone/index.js';
import { compile } from 'json-schema-to-typescript';

export function standaloneValidator(ajv, schema) {
  const source = standaloneCode(ajv, ajv.compile(schema));
  if (/^\s*import\s/m.test(source) || /\brequire\s*\(/.test(source)) {
    throw new Error('The generated validator requires a runtime dependency.');
  }
  return source;
}
export function contractTypes(schema, name, banner) {
  return compile(schema, name, { bannerComment: banner, additionalProperties: false, unreachableDefinitions: true });
}

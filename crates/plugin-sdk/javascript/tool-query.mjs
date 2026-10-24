// Bounded presentation of the original read-only capability. This helper never
// authenticates bindings, grants execution, parses domain data or adopts results.
import validateTool from './validate-tool-declaration.mjs';

export class ToolQueryError extends Error {
  constructor(code, field) { super(code); this.name = 'ToolQueryError'; this.code = code; this.field = field; }
}
const fail = (code, field) => { throw new ToolQueryError(code, field); };
const same = (a, b) => a?.id === b?.id && a?.schemaVersion === b?.schemaVersion && a?.behaviorVersion === b?.behaviorVersion;
const validText = value => {
  if (typeof value !== 'string') return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
const bytes = value => new TextEncoder().encode(value).length;
const path = parts => {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 8
    || parts.some(key => typeof key === 'string'
      ? !key || bytes(key) > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)
      : !Number.isInteger(key) || key < 0 || key >= 2000)) fail('invalid-declaration', 'path');
};
function locate(value, parts, code = 'invalid-declaration') {
  path(parts);
  for (const key of parts) {
    if (!value || typeof value !== 'object' || (Array.isArray(value) !== (typeof key === 'number'))
      || !Object.hasOwn(value, key)) fail(code, 'path');
    value = value[key];
  }
  return value;
}
function replace(value, parts, input) {
  locate(value, parts);
  let parent = value;
  for (const key of parts.slice(0, -1)) parent = parent[key];
  parent[parts.at(-1)] = input;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function selection(value) {
  if (!value.options.length || value.options.length > 64 || value.minSelected > value.maxSelected
    || value.maxSelected < 1 || value.maxSelected > value.options.length
    || new Set(value.options.map(option => option.value)).size !== value.options.length) fail('invalid-declaration', 'options');
  path(value.path);
}

/** Use only after rebinding against an actual captured package. UI and Agent
 * consumers share fixed payload construction; each input still needs the
 * original capability's domain validation and application execution consent. */
export function createToolQuery(binding) {
  if (!binding?.declaration?.query) fail('unavailable', 'query');
  if (!validateTool(binding.declaration)) fail('invalid-declaration', 'query');
  const declaration = structuredClone(binding.declaration);
  const query = declaration.query, capability = binding.capability?.declaration;
  if (!same(query.inputSchema, capability?.inputSchema) || !same(query.outputSchema, capability?.outputSchema)
    || capability?.effect !== 'read-only' || !Array.isArray(capability?.permissions)
    || capability.permissions.some(permission => permission.kind !== 'captured-input')
    || !Number.isInteger(capability?.limits?.maxInputBytes) || capability.limits.maxInputBytes < 1
    || !Number.isInteger(capability?.limits?.maxOutputBytes) || capability.limits.maxOutputBytes < 1
    || query.maxTextBytes < 1 || query.maxTextBytes > capability.limits.maxInputBytes
    || bytes(JSON.stringify(declaration)) > 16384) fail('invalid-declaration', 'capability');
  const maxInput = capability.limits.maxInputBytes;
  const maxOutput = capability.limits.maxOutputBytes;
  selection(query.target); selection(query.selections);
  if (query.target.minSelected !== 1 || query.target.maxSelected !== 1) fail('invalid-declaration', 'target');
  const paths = [query.textPath, query.target.path, query.selections.path];
  paths.forEach(path);
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const shorter = paths[i].length <= paths[j].length ? paths[i] : paths[j];
    const longer = shorter === paths[i] ? paths[j] : paths[i];
    if (shorter.every((part, k) => part === longer[k])) fail('invalid-declaration', 'overlapping-paths');
  }
  const templateText = locate(query.inputTemplate, query.textPath);
  const templateTarget = locate(query.inputTemplate, query.target.path);
  const templateSelections = locate(query.inputTemplate, query.selections.path);
  if (!validText(templateText) || bytes(templateText) > query.maxTextBytes
    || !query.target.options.some(option => option.value === templateTarget)
    || !Array.isArray(templateSelections) || templateSelections.length > query.selections.maxSelected
    || new Set(templateSelections).size !== templateSelections.length
    || templateSelections.some(value => !query.selections.options.some(option => option.value === value))) fail('invalid-declaration', 'template');
  const output = query.output;
  path(output.entriesPath);
  if (!output.columns.length || output.columns.length > 8 || output.maxEntries < 1 || output.maxEntries > 128
    || new Set(output.columns.map(column => JSON.stringify(column.path))).size !== output.columns.length) fail('invalid-declaration', 'output');
  output.columns.forEach(column => path(column.path));
  freeze(query);
  return Object.freeze({
    query,
    prepare({ text, target, selections }) {
      if (!validText(text) || !text.trim()) fail('text-required', 'text');
      if (bytes(text) > query.maxTextBytes) fail('limit-exceeded', 'text');
      if (!query.target.options.some(option => option.value === target)) fail('invalid-selection', 'target');
      if (!Array.isArray(selections) || selections.length < query.selections.minSelected
        || selections.length > query.selections.maxSelected || new Set(selections).size !== selections.length
        || selections.some(value => !query.selections.options.some(option => option.value === value))) fail('invalid-selection', 'selections');
      const payload = structuredClone(query.inputTemplate);
      replace(payload, query.textPath, text); replace(payload, query.target.path, target);
      replace(payload, query.selections.path, [...selections]);
      if (bytes(JSON.stringify(payload)) > maxInput) fail('limit-exceeded', 'input');
      return payload;
    },
    entries(outputValue) {
      let encoded;
      try { encoded = JSON.stringify(outputValue); } catch { fail('invalid-result', 'output'); }
      if (typeof encoded !== 'string' || bytes(encoded) > maxOutput) fail('invalid-result', 'output');
      const entries = locate(outputValue, output.entriesPath, 'invalid-result');
      if (!Array.isArray(entries) || entries.length > output.maxEntries) fail('invalid-result', 'entries');
      return entries.map(entry => output.columns.map(column => {
        const text = locate(entry, column.path, 'invalid-result');
        if (!validText(text)) fail('invalid-result', 'column');
        return text;
      }));
    },
  });
}

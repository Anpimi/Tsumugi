import shape from './validate-source-context-facts.mjs';
import { SOURCE_CONTEXT_FACTS_PROFILE as profile } from './source-context-profile.mjs';

const encoder = new TextEncoder(), identifier = new RegExp(profile.identifierPattern, 'u');
const text = value => typeof value === 'string' && value.isWellFormed()
  && value.length > 0 && encoder.encode(value).length <= profile.maxTextBytes;

/** Validate a plain data value before encoding. References still require the
 * receiver's captured artifacts, domain check and scope; this grants no consent. */
export function validateSourceContextFacts(value) {
  try {
    if (!shape(value) || value.facts.length > profile.maxFacts) return false;
    const ids = new Set();
    for (const fact of value.facts) {
      if (!identifier.test(fact.id) || ids.has(fact.id) || !text(fact.text)) return false;
      ids.add(fact.id);
      if (fact.origin.kind === 'inferred' && !text(fact.origin.rationale)) return false;
      const sources = fact.origin.sources;
      if (!sources.length || sources.length > profile.maxSources) return false;
      const references = new Set();
      for (const source of sources) {
        if (!identifier.test(source.artifactId) || source.range.start >= source.range.end) return false;
        const reference = JSON.stringify([source.artifactId, source.range.encoding, source.range.start, source.range.end]);
        if (references.has(reference)) return false;
        references.add(reference);
      }
    }
    return encoder.encode(JSON.stringify(value)).length <= profile.maxBytes;
  } catch {
    return false;
  }
}

/** Encoding snapshots data and preserves its extracted/inferred category. It cannot
 * create a human project revision or an independently checked source fact. */
export function encodeSourceContextFacts(value) {
  try {
    const captured = structuredClone(value);
    if (!validateSourceContextFacts(captured)) throw new Error();
    return JSON.stringify(captured);
  } catch {
    throw new TypeError('Invalid source context facts');
  }
}

import shape from './validate-source-capture-summary.mjs';
import { SOURCE_CAPTURE_SUMMARY_PROFILE as profile } from './source-capture-profile.mjs';

const encoder = new TextEncoder(), identifier = new RegExp(profile.identifierPattern, 'u');
const label = value => typeof value === 'string' && value.isWellFormed() && value.trim().length > 0
  && encoder.encode(value).length <= profile.maxLabelBytes && !/\p{Cc}/u.test(value);
const text = value => typeof value === 'string' && value.isWellFormed() && value.length > 0
  && encoder.encode(value).length <= profile.maxTextBytes && !value.includes('\0');
const counts = value => value.itemsWithFields <= value.items
  && (value.declaredFields === 0) === (value.itemsWithFields === 0)
  && value.itemsWithFields <= value.declaredFields && value.nonEmptyFields <= value.declaredFields;
const fields = ['items', 'itemsWithFields', 'declaredFields', 'nonEmptyFields'];

/** Plain presentation data only. The receiver still validates captured artifacts,
 * range positions and independent domain evidence. This grants no read or consent. */
export function validateSourceCaptureSummary(value) {
  try {
    if (!shape(value) || !value.materials.length || value.materials.length > profile.maxMaterials) return false;
    const artifacts = new Set();
    for (const material of value.materials) {
      const reference = material.source;
      if (!identifier.test(reference.artifactId) || artifacts.has(reference.artifactId)
        || reference.range.start >= reference.range.end || !counts(material.counts)
        || material.properties.length > profile.maxProperties || material.groups.length > profile.maxGroups) return false;
      artifacts.add(reference.artifactId);
      const properties = new Set(), groups = new Set(), totals = [0, 0, 0, 0];
      for (const property of material.properties) {
        if (!label(property.label) || properties.has(property.label) || property.values.length > profile.maxValues
          || !property.values.every(text)) return false;
        properties.add(property.label);
      }
      for (const group of material.groups) {
        if (!label(group.label) || groups.has(group.label) || !counts(group.counts)) return false;
        groups.add(group.label);
        fields.forEach((key, index) => { totals[index] += group.counts[key]; });
      }
      if (material.groups.length && fields.some((key, index) => totals[index] !== material.counts[key])) return false;
    }
    return encoder.encode(JSON.stringify(value)).length <= profile.maxBytes;
  } catch {
    return false;
  }
}

export function encodeSourceCaptureSummary(value) {
  try {
    const captured = structuredClone(value);
    if (!validateSourceCaptureSummary(captured)) throw new Error();
    return JSON.stringify(captured);
  } catch {
    throw new TypeError('Invalid source capture summary');
  }
}

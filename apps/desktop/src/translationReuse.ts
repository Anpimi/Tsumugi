import type { TranslationReuseOrigin } from "./generated/translation.requests";
import type { TranslationReuseOrigin as SavedTranslationReuseOrigin } from "./generated/translation.responses";
import { jsonIdentity } from "./pluginToolChoices";

/** Preserve Serde's nullable selection when an input becomes a saved record. */
export function canonicalTranslationReuse(value: TranslationReuseOrigin | null | undefined): SavedTranslationReuseOrigin | null | undefined {
  return value == null ? value : { ...value, targetSelectionId: value.targetSelectionId ?? null };
}

export function sameTranslationReuse(left: TranslationReuseOrigin | null | undefined, right: TranslationReuseOrigin | null | undefined) {
  return jsonIdentity(canonicalTranslationReuse(left) ?? null) === jsonIdentity(canonicalTranslationReuse(right) ?? null);
}

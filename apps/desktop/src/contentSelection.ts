import type { ReviewScopeCapture } from "./reviewCommands";
import { validateResponseScope } from "./generated/review.validators";

/** A user selection intent, including its original bases, never a current read or execution grant. */
export interface ContentSelection {
  projectId: string;
  sessionToken: string;
  capture: ReviewScopeCapture;
  excluded: readonly string[];
}
export function fixedContentSelection(selection: ContentSelection): ContentSelection {
  const units = selection.capture.units.map(unit => Object.freeze({ ...unit }));
  Object.freeze(units);
  const capture = Object.freeze({ ...selection.capture, units });
  return Object.freeze({ ...selection, capture, excluded: Object.freeze([...selection.excluded]) });
}
export function contentSelectionIds(selection: ContentSelection): string[] {
  const excluded = new Set(selection.excluded);
  return selection.capture.units.filter(unit => !excluded.has(unit.unitId)).map(unit => unit.unitId);
}
export function validContentSelection(selection: ContentSelection): boolean {
  if (!selection || !Array.isArray(selection.excluded) || !validateResponseScope(selection.capture)) return false;
  const members = new Set(selection.capture.units.map(unit => unit.unitId));
  return members.size === selection.capture.units.length && new Set(selection.excluded).size === selection.excluded.length
    && selection.excluded.every(id => members.has(id));
}

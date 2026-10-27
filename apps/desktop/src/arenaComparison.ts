import type { ComparisonView } from "./arenaCommands";
import { validateResponseComparison } from "./generated/arena.validators";

/** Current target and candidate eligibility are distinct from persisted display positions. */
export function comparisonBasis(view: ComparisonView) {
  return JSON.stringify([view.comparisonId, view.unitId, view.locale, view.sourceRevisionId, view.sourceText, view.selectionId, view.basis,
    view.rows.map(row => [row.revisionId, row.sourceRevisionId, row.text, row.basisCurrent, row.candidateDisposition])]);
}

export function confirmComparisonRead(view: ComparisonView, comparisonId: string) {
  if (!validateResponseComparison(view) || view.comparisonId !== comparisonId || view.rows.length < 2 || view.rows.length > 4
    || new Set(view.rows.map(row => row.revisionId)).size !== view.rows.length || (!view.blind && !view.revealed)
    || (view.blind && !view.revealed && view.rows.some(row => row.model !== null || row.recipe !== null))) {
    throw new Error("Invalid Arena business acknowledgement");
  }
}

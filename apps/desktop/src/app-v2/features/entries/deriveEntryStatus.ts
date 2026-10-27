import type { StatusGlyphState } from "../../../design-system/StatusGlyph";
import type { DraftSummary } from "../../../draftCommands";
import type { SegmentRow } from "../../../segmentCommands";
import type { DraftEntry } from "../editor/translationDrafts";

export type EntryStatusLabelKey =
  | "entryStatusUntranslated"
  | "entryStatusDraft"
  | "entryStatusPendingConfirmation"
  | "entryStatusNewerDraft"
  | "entryStatusRetainedDraft"
  | "entryStatusCandidate"
  | "entryStatusTranslated"
  | "entryStatusReviewed"
  | "entryStatusSourceChanged"
  | "entryStatusResourcesChanged"
  | "entryStatusDraftBasisChanged"
  | "entryStatusRetainedDraftSourceChanged"
  | "entryStatusChangesRequested"
  | "entryStatusTermConflict"
  | "entryStatusQaIssue"
  | "entryStatusQaUnavailable"
  | "entryStatusQaIncomplete";

export interface EntryStatusView {
  state: StatusGlyphState;
  labelKey: EntryStatusLabelKey;
  protected: boolean;
}
export type EntryStatusDraft = DraftEntry | DraftSummary;

/** Projects existing facts into one glyph; it does not assess delivery eligibility. */
export function deriveEntryStatus(row: SegmentRow, draft?: EntryStatusDraft | null): EntryStatusView {
  const { content, qualification, applicability } = row;
  const status = (state: StatusGlyphState, labelKey: EntryStatusLabelKey): EntryStatusView => ({
    state, labelKey, protected: row.protection.protected,
  });
  const decision = content.currentDecision;
  const blockers = qualification.blockers;
  if (decision?.kind === "request-changes" && decision.basis === content.basis)
    return status("blocked", "entryStatusChangesRequested");
  if (row.terms.conflictingEntryCount > 0) return status("blocked", "entryStatusTermConflict");

  // The owner excludes waived findings. Raw QA finding counts include them and
  // advisory findings, so they cannot establish a blocking problem themselves.
  if (blockers.some(reason => reason.code === "qa-issue")) return status("blocked", "entryStatusQaIssue");
  if (blockers.some(reason => reason.code === "qa-unavailable")) return status("blocked", "entryStatusQaUnavailable");
  if (blockers.some(reason => reason.code === "qa-incomplete-coverage")) return status("blocked", "entryStatusQaIncomplete");

  if (applicability.sourceBasisCurrent === false) return status("stale", "entryStatusSourceChanged");
  // A captured resource difference remains historical after a successful recheck.
  // The owner separately tells us whether that difference still requires review.
  if (applicability.resourceReviewRequired) return status("stale", "entryStatusResourcesChanged");

  // Unopened retained input has metadata but no loaded text to compare. Keep
  // that observation distinct from a loaded draft that is known to differ.
  if (draft && "sourceRevisionId" in draft) return draft.sourceRevisionId !== content.sourceRevisionId
    ? status("stale", "entryStatusRetainedDraftSourceChanged") : status("draft", "entryStatusRetainedDraft");
  if (draft?.value) {
    const { value } = draft;
    const hasDraft = value.pending !== null || (value.merge != null || value.text !== (value.basis.text ?? ""))
      || draft.newerInputAfterConfirmation;
    if (hasDraft && !draft.basisCurrent) return status("stale", "entryStatusDraftBasisChanged");
    if (hasDraft) return status("draft", value.pending !== null ? "entryStatusPendingConfirmation"
      : draft.newerInputAfterConfirmation ? "entryStatusNewerDraft" : "entryStatusDraft");
  }
  if (row.aiCandidateCount > 0) return status("candidate", "entryStatusCandidate");
  if (content.selectionId === null) return status("untranslated", "entryStatusUntranslated");
  if (decision?.kind === "approve" && decision.basis === content.basis) return status("reviewed", "entryStatusReviewed");
  return status("translated", "entryStatusTranslated");
}

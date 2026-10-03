import type { SessionRequest } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import { sourceCommands } from "./sourceCommands";
import type { TranslationFilesRequest, TranslationCaptureRequest, TranslationStartRequest, TranslationPreviewRequest, TranslationAdoptRequest, TranslationHistoryRequest, TranslationActionRequest, TranslationSaveRequest, TranslationSelectRequest } from "./generated/translation.requests";
import type { TranslationSaveReceipt } from "./generated/translation.responses";
import { validateResponseFiles, validateResponsePreflight, validateResponseAttempt, validateResponsePreview, validateResponsePrepared, validateResponseHistory, validateResponseAction, validateResponseSaved, validateResponseSelected } from "./generated/translation.validators";

export type { TranslationStartRequest, TranslationAdoptRequest, TranslationSaveRequest, TranslationSelectRequest, TranslationAdoptionConfirmation as TranslationConfirmation, TranslationSelectionDecision as TranslationDecision } from "./generated/translation.requests";
export type { TranslationMatch, TranslationOrigin, TranslationEntry, TranslationSelection, TranslationPreviewRow, TranslationPreview, TranslationPreflight, TranslationRevision, TranslationHistory, TranslationEditBasis, TranslationSaveReceipt } from "./generated/translation.responses";

export function translationHistoryAfter(ordinal: string, pageSize: number): string {
  const after = BigInt(ordinal) - BigInt(pageSize);
  return (after > 0n ? after : 0n).toString();
}

export const translationCommands = {
  selectFolder: (request: SessionRequest) => sourceCommands.select(request),
  files: (request: TranslationFilesRequest) => checkedInvoke("list_translation_files", request, validateResponseFiles),
  preflight: (request: TranslationCaptureRequest) => checkedInvoke("preflight_translation", request, validateResponsePreflight),
  start: (request: TranslationStartRequest) => checkedInvoke("start_translation_import", request, validateResponseAttempt),
  preview: (request: TranslationPreviewRequest) => checkedInvoke("read_translation_preview", request, validateResponsePreview),
  prepare: (request: TranslationAdoptRequest) => checkedInvoke("prepare_translation_adoption", request, validateResponsePrepared),
  history: (request: TranslationHistoryRequest) => checkedInvoke("read_translation_history", request, validateResponseHistory),
  action: (request: TranslationActionRequest) => checkedInvoke("read_translation_action", request, validateResponseAction),
  save: async (request: TranslationSaveRequest) => validateSaveReceipt(await checkedInvoke("save_translation_revision", request, validateResponseSaved), request),
  select: (request: TranslationSelectRequest) => checkedInvoke("select_translation_revision", request, validateResponseSelected),
};

function invalidSaveReceipt() {
  return Object.assign(new Error("Invalid save receipt"), { outcome: "unknown", reason: "invalid-save-receipt" });
}

/** Shape validation does not replace binding the confirmation to this save. */
export function validateSaveReceipt(value: unknown, request: TranslationSaveRequest): TranslationSaveReceipt {
  if (!validateResponseSaved(value)) throw invalidSaveReceipt();
  const { basis, selection, revision } = value;
  if (value.projectId !== request.projectId || value.actionId !== request.actionId
    || selection.actionId !== request.actionId || revision.actionId !== request.actionId
    || selection.unitId !== request.unitId || revision.unitId !== request.unitId
    || selection.locale !== request.locale || revision.locale !== request.locale
    || selection.previousEventId !== (request.expectedSelectionId ?? null)
    || BigInt(selection.sequence) === 0n || BigInt(revision.ordinal) === 0n
    || (selection.sequence === "1") !== (selection.previousEventId === null)
    || revision.revisionId !== selection.revisionId || revision.originKind !== "manual"
    || revision.text !== request.text || revision.sourceRevisionId !== request.sourceRevisionId
    || basis.sourceSnapshotId !== revision.sourceSnapshotId
    || basis.sourceRevisionId !== revision.sourceRevisionId || basis.selectionId !== selection.eventId
    || ![revision.attemptId, revision.resultId, revision.itemId, revision.artifactId,
      revision.logicalPath, revision.declaredLocale, revision.nativeKey, revision.fileDigest].every(field => field === null)
    || revision.contributors.length !== 0) throw invalidSaveReceipt();
  return value;
}

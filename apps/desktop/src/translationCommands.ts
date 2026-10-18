import type { AdoptionAction, Receipt } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import type { TranslationCheckPrepareRequest, TranslationCheckFinishRequest, TranslationProjectionPrepareRequest, TranslationProjectionStartRequest, PluginStartRequest, TranslationSourceRequest, PluginTranslationSelectRequest, PluginTranslationCaptureRequest, TranslationFilesRequest, TranslationPreviewRequest, TranslationAdoptRequest, TranslationHistoryRequest, TranslationActionRequest, TranslationSaveRequest, TranslationSelectRequest } from "./generated/translation.requests";
import type { TranslationSaveReceipt, Responses } from "./generated/translation.responses";
import type { Requests } from "./generated/translation.requests";
import { validateResponseAdoptionAction } from "./generated/translation.validators";
import type { PluginTranslationRequest, PluginTranslationView } from "./pluginCommands";
import { validateRequestAdopt, validateResponseCheckReview, validateResponseProjectionReview, validateResponseChecked, validateResponseSource, validateResponsePluginSelection, validateResponsePluginPreflight, validateResponseFiles, validateResponseAttempt, validateResponsePreview, validateResponsePrepared, validateResponseHistory, validateResponseAction, validateResponseSaveAction, validateResponseSelectionAction, validateResponseSaved, validateResponseSelected } from "./generated/translation.validators";
import { validateResponseAdoption } from "./generated/execution.validators";
import { validateResponseProjectionStartAction, validateResponseCandidateDecision, validateResponseCandidateAction } from "./generated/translation.validators";
import type { CandidateDecisionRequest } from "./generated/translation.requests";
import type { CandidateDecision } from "./generated/translation.responses";
export type { CandidateDecisionRequest } from "./generated/translation.requests";
export type { CandidateDecision, CandidateDecisionWrite, CandidateDisposition } from "./generated/translation.responses";

export type { TranslationCheckPrepareRequest, TranslationCheckFinishRequest, TranslationProjectionPrepareRequest, TranslationProjectionStartRequest, PluginStartRequest, TranslationSourceRequest, PluginTranslationSelectRequest, PluginTranslationCaptureRequest, TranslationAdoptRequest, TranslationSaveRequest, TranslationSelectRequest, TranslationAdoptionConfirmation as TranslationConfirmation, TranslationSelectionDecision as TranslationDecision } from "./generated/translation.requests";
export type { TranslationCheckReview, TranslationProjectionReview, TranslationSourceContext, PluginTranslationSelection, PluginTranslationPreflight, TranslationMatch, TranslationOrigin, TranslationEntry, TranslationSelection, TranslationPreviewRow, TranslationPreview, TranslationRevision, TranslationHistory, TranslationEditBasis, TranslationSaveReceipt } from "./generated/translation.responses";

export function translationHistoryAfter(ordinal: string, pageSize: number): string {
  const after = BigInt(ordinal) - BigInt(pageSize);
  return (after > 0n ? after : 0n).toString();
}

export const translationCommands = {
  decideCandidate: async (request: CandidateDecisionRequest) => confirmCandidateDecision(request, await checkedInvoke("decide_translation_candidate", request, validateResponseCandidateDecision)),
  candidateAction: (request: TranslationActionRequest) => checkedInvoke("read_translation_candidate_action", request, validateResponseCandidateAction),
  pluginSource: (request: TranslationSourceRequest) => checkedInvoke("read_plugin_translation_source", request, validateResponseSource),
  selectPlugin: (request: PluginTranslationSelectRequest) => checkedInvoke("select_plugin_translation", request, validateResponsePluginSelection),
  pluginFiles: (request: TranslationFilesRequest) => checkedInvoke("list_plugin_translation_files", request, validateResponseFiles),
  preflightPlugin: (request: PluginTranslationCaptureRequest) => checkedInvoke("preflight_plugin_translation", request, validateResponsePluginPreflight),
  startPlugin: (request: PluginStartRequest) => checkedInvoke("start_plugin_translation", request, validateResponseAttempt),
  prepareCheck: (request: TranslationCheckPrepareRequest) => checkedInvoke("prepare_translation_check", request, validateResponseCheckReview),
  startCheck: (request: PluginStartRequest) => checkedInvoke("start_translation_check", request, validateResponseAttempt),
  finishCheck: (request: TranslationCheckFinishRequest) => checkedInvoke("finish_translation_check", request, validateResponseChecked),
  prepareProjection: (request: TranslationProjectionPrepareRequest) => checkedInvoke("prepare_translation_projection", request, validateResponseProjectionReview),
  startProjection: (request: TranslationProjectionStartRequest) => checkedInvoke("start_translation_projection", request, validateResponseAttempt),
  projectionStartAction: async (request: TranslationProjectionStartRequest): Promise<Responses["projectionStartAction"]> => {
    const result = await checkedInvoke("read_translation_projection_start", request, validateResponseProjectionStartAction);
    if (result !== null && (result.projectId !== request.projectId || result.attemptId !== request.attemptId || result.inputDigest !== request.inputDigest)) {
      throw new Error("Invalid original translation projection start proof");
    }
    return result;
  },
  preview: (request: TranslationPreviewRequest) => checkedInvoke("read_translation_preview", request, validateResponsePreview),
  prepare: (request: TranslationAdoptRequest) => checkedInvoke("prepare_translation_adoption", request, validateResponsePrepared),
  adoptionAction: (request: Requests["adoptionAction"]): Promise<Responses["adoptionAction"]> => checkedInvoke("read_translation_adoption_action", request, validateResponseAdoptionAction),
  history: (request: TranslationHistoryRequest) => checkedInvoke("read_translation_history", request, validateResponseHistory),
  action: (request: TranslationActionRequest) => checkedInvoke("read_translation_action", request, validateResponseAction),
  saveAction: async (request: TranslationSaveRequest) => {
    const receipt = await checkedInvoke("read_translation_save_action", request, validateResponseSaveAction);
    return receipt === null ? null : validateSaveReceipt(receipt, request);
  },
  selectionAction: async (request: TranslationSelectRequest) => {
    const selection = await checkedInvoke("read_translation_selection_action", request, validateResponseSelectionAction);
    return selection === null ? null : confirmTranslationSelection(request, selection);
  },
  save: async (request: TranslationSaveRequest) => validateSaveReceipt(await checkedInvoke("save_translation_revision", request, validateResponseSaved), request),
  select: async (request: TranslationSelectRequest) => confirmTranslationSelection(request, await checkedInvoke("select_translation_revision", request, validateResponseSelected)),
};

export function confirmCandidateDecision(request: CandidateDecisionRequest, value: CandidateDecision) {
  const expected = request.decision, actual = value.request;
  if (actual.projectId !== request.projectId || Object.keys(expected).length !== Object.keys(actual).length
    || Object.entries(expected).some(([key, field]) => actual[key as keyof typeof actual] !== field)) {
    throw Object.assign(new Error("Invalid candidate decision acknowledgement"), { outcome: "unknown", reason: "invalid-candidate-decision-receipt" });
  }
  return value;
}

export function matchesTranslationEnvironment(view: PluginTranslationView, request: PluginTranslationRequest) {
  return view.resourceId === request.resourceId && view.environmentDigest === request.environmentDigest
    && [view.extractor.provider, view.checker.provider].every(provider => provider.packageDigest === request.package.packageDigest
      && provider.plugin.id === request.package.plugin.id && provider.plugin.version === request.package.plugin.version
      && provider.plugin.publisher === request.package.plugin.publisher);
}
export function translationRequest(view: PluginTranslationView): PluginTranslationRequest {
  return { package: { plugin: view.extractor.provider.plugin, packageDigest: view.extractor.provider.packageDigest },
    resourceId: view.resourceId, environmentDigest: view.environmentDigest };
}

function invalidImportReceipt() {
  return Object.assign(new Error("Invalid translation import acknowledgement"), { outcome: "unknown", reason: "invalid-import-receipt" });
}
function normalizedConfirmation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  return { resultDigest: fields.resultDigest, sourceSnapshotId: fields.sourceSnapshotId, occurrenceId: fields.occurrenceId,
    sourceRevisionId: fields.sourceRevisionId, targetUnitId: fields.targetUnitId,
    expectedSelectionId: fields.expectedSelectionId ?? null, decision: fields.decision };
}
export function sameTranslationConfirmation(left: unknown, right: unknown) {
  return normalizedConfirmation(left) !== null && JSON.stringify(normalizedConfirmation(left)) === JSON.stringify(normalizedConfirmation(right));
}
/** The execution adoption unit is distinct from the business target unit. */
export function confirmTranslationAction(request: TranslationAdoptRequest, recoveryUnitId: string, action: AdoptionAction) {
  if (!validateResponsePrepared(action) || action.projectId !== request.projectId || action.attemptId !== request.attemptId
    || action.actionId !== request.actionId || action.operation !== "translation-import" || action.unitId !== recoveryUnitId
    || action.resultIds.length !== 1 || action.resultIds[0] !== request.resultId
    || !validateRequestAdopt({ ...request, confirmation: action.parameters })
    || !sameTranslationConfirmation(action.parameters, request.confirmation)) throw invalidImportReceipt();
}
export function confirmTranslationReceipt(request: TranslationAdoptRequest, recoveryUnitId: string, receipt: Receipt, previousSelectionSequence: string | null) {
  if (!validateResponseAdoption(receipt) || receipt.projectId !== request.projectId || receipt.attemptId !== request.attemptId
    || receipt.actionId !== request.actionId || receipt.unitId !== recoveryUnitId || !/^[a-f0-9]{64}$/.test(receipt.requestDigest)) throw invalidImportReceipt();
  const revision = receipt.changes.filter(change => change.kind === "translation-revision");
  const selection = receipt.changes.filter(change => change.kind === "translation-selection");
  const selects = request.confirmation.decision !== "candidate-only";
  if (receipt.changes.length !== (selects ? 2 : 1) || receipt.changes[0]?.kind !== "translation-revision"
    || (selects && receipt.changes[1]?.kind !== "translation-selection") || revision.length !== 1 || selection.length !== (selects ? 1 : 0)
    || !validateResponseAttempt(revision[0].id) || BigInt(revision[0].revision) === 0n
    || (selects && (!validateResponseAttempt(selection[0].id) || selection[0].revision !== (BigInt(previousSelectionSequence ?? "0") + 1n).toString()))) throw invalidImportReceipt();
  return receipt;
}
export function confirmTranslationSelection(request: TranslationSelectRequest, value: unknown) {
  if (!validateResponseSelected(value) || value.actionId !== request.actionId || value.unitId !== request.unitId
    || value.locale !== request.locale || value.revisionId !== request.revisionId
    || value.previousEventId !== (request.expectedSelectionId ?? null) || BigInt(value.sequence) === 0n
    || (value.sequence === "1") !== (value.previousEventId === null)) throw invalidSaveReceipt();
  return value;
}

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

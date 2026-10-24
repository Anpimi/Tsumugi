import type { AdoptionAction, Receipt, SessionRequest } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import type { CaptureRequest, StartRequest, SourceAdoptionActionRequest, SourceAdoptRequest, PreviewRequest, ContentRequest, ComparisonRequest, HistoryRequest, HistoryContentRequest, LineageRequest, ImpactRequest } from "./generated/source.requests";
import type { Responses } from "./generated/source.responses";
import { validateResponseAdoptionAction, validateResponseStartAction, validateRequestAdopt, validateResponseIntegration, validateResponseSelection, validateResponsePreflight, validateResponseAttempt, validateResponseCancelled, validateResponseScope, validateResponsePage, validateResponseComparison, validateResponseHistory, validateResponseLineage, validateResponseEstimates, validateResponseImpact, validateResponseAction } from "./generated/source.validators";

export type { CaptureRequest, StartRequest, SourceAdoptRequest, SourceConfirmation } from "./generated/source.requests";
export type { SourceSelection, IntegrationDescriptor, FileCoverage as Coverage, Preflight, ContentScope, LineageChoice, SourceOccurrence, ContentRow, ContentPage, SourceChange, SourceChangeKind, SourceChangePage, SourceHistoryEntry, SourceHistory, LineageEvidence, SourceImpactBasis, SourceImpactSummary, SourceImpactRow, SourceImpactStatus, SourceImpactPage } from "./generated/source.responses";
export const sourceCommands = {
  integration: (request: SessionRequest, integrationId = "stardew-smapi") => checkedInvoke(integrationId === "webvtt" ? "read_webvtt_integration" : "read_source_integration", request, validateResponseIntegration),
  select: (request: SessionRequest, integrationId = "stardew-smapi") => checkedInvoke(integrationId === "webvtt" ? "select_webvtt_source" : "select_source", request, validateResponseSelection),
  preflight: (request: CaptureRequest) => checkedInvoke("preflight_source", request, validateResponsePreflight),
  start: (request: StartRequest) => checkedInvoke("start_source_import", request, validateResponseAttempt),
  startAction: async (request: StartRequest) => confirmSourceStart(request, await checkedInvoke("read_source_import_start", request, validateResponseStartAction)),
  cancelCapture: (request: SessionRequest) => checkedInvoke("cancel_source_capture", request, validateResponseCancelled),
  scope: (request: SessionRequest) => checkedInvoke("read_content_scope", request, validateResponseScope),
  preview: (request: PreviewRequest) => checkedInvoke("read_source_preview", request, validateResponsePage),
  content: (request: ContentRequest) => checkedInvoke("read_source_content", request, validateResponsePage),
  compare: (request: Omit<ComparisonRequest, "filter"> & { filter?: string }) => checkedInvoke("read_source_comparison", { base: null, filter: "", ...request }, validateResponseComparison),
  history: (request: HistoryRequest) => checkedInvoke("read_source_history", request, validateResponseHistory),
  historyContent: (request: HistoryContentRequest) => checkedInvoke("read_source_history_content", request, validateResponsePage),
  lineage: (request: LineageRequest) => checkedInvoke("read_source_lineage", request, validateResponseLineage),
  estimate: (request: SourceAdoptRequest) => checkedInvoke("estimate_source_update", request, validateResponseEstimates),
  impact: (request: ImpactRequest) => checkedInvoke("read_source_impact", request, validateResponseImpact),
  prepare: (request: SourceAdoptRequest) => checkedInvoke("prepare_source_adoption", request, validateResponseAction),
  adoptionAction: (request: SourceAdoptionActionRequest): Promise<Responses["adoptionAction"]> => checkedInvoke("read_source_adoption_action", request, validateResponseAdoptionAction),
};

function normalizedConfirmation(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const lineage = fields.lineage === undefined ? [] : fields.lineage;
  if (!Array.isArray(lineage)) return null;
  return { resultDigest: fields.resultDigest, identityPolicy: fields.identityPolicy, expectedContentRevision: fields.expectedContentRevision,
    sourceLanguage: fields.sourceLanguage, expectedCurrentSnapshot: fields.expectedCurrentSnapshot ?? null,
    lineageBaseSnapshot: fields.lineageBaseSnapshot ?? null, actor: fields.actor ?? null,
    lineage: lineage.map(choice => {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) return null;
      const row = choice as Record<string, unknown>;
      return { newOrdinal: row.newOrdinal, oldOccurrenceId: row.oldOccurrenceId, decision: row.decision, reason: row.reason };
    }) };
}
export function sameSourceConfirmation(left: unknown, right: unknown) {
  const normalized = normalizedConfirmation(left);
  return normalized !== null && JSON.stringify(normalized) === JSON.stringify(normalizedConfirmation(right));
}
/** Schema validity alone does not associate an acknowledgement with this action. */
export function confirmSourceAction(request: SourceAdoptRequest, unitId: string, action: AdoptionAction) {
  if (action.projectId !== request.projectId || action.attemptId !== request.attemptId || action.actionId !== request.actionId
    || action.unitId !== unitId || action.operation !== "source-import" || action.resultIds.length !== 1 || action.resultIds[0] !== request.resultId
    || !validateRequestAdopt({ ...request, confirmation: action.parameters })
    || !sameSourceConfirmation(action.parameters, request.confirmation)) {
    throw new Error("Invalid source preparation acknowledgement");
  }
}
export function confirmSourceReceipt(request: SourceAdoptRequest, unitId: string, receipt: Receipt): string {
  const change = receipt.changes[0];
  if (receipt.projectId !== request.projectId || receipt.attemptId !== request.attemptId || receipt.actionId !== request.actionId || receipt.unitId !== unitId
    || !/^[a-f0-9]{64}$/.test(receipt.requestDigest) || receipt.changes.length !== 1 || change?.kind !== "source-snapshot" || !validateResponseAttempt(change.id)
    || change.revision !== (BigInt(request.confirmation.expectedContentRevision) + 1n).toString()) {
    throw new Error("Invalid source adoption acknowledgement");
  }
  return change.id;
}

export function confirmSourceStart(request: StartRequest, value: unknown): Responses["startAction"] {
  if (!validateResponseStartAction(value) || value !== null && (value.request.projectId !== request.projectId
    || value.request.attemptId !== request.attemptId || value.request.selectionId !== request.selectionId
    || value.request.sourceLanguage !== request.sourceLanguage || !/^[a-f0-9]{64}$/.test(value.inputDigest))) {
    throw new Error("Invalid source start acknowledgement");
  }
  return value;
}

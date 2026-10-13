import type { AdoptionAction, Receipt, SessionRequest } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import { pluginCommands, type PluginSourceRequest, type PluginSourceView } from "./pluginCommands";
import type { SourceAdoptRequest, PreviewRequest, ContentRequest, ComparisonRequest, HistoryRequest, HistoryContentRequest, LineageRequest, ImpactRequest, PluginSourceSelectRequest, PluginCaptureRequest, PluginStartRequest, SourceCheckPrepareRequest, SourceCheckFinishRequest } from "./generated/source.requests";
import { validateRequestAdopt, validateResponseAttempt, validateResponseCancelled, validateResponseScope, validateResponsePage, validateResponseComparison, validateResponseHistory, validateResponseLineage, validateResponseEstimates, validateResponseImpact, validateResponseAction, validateResponsePluginSelection, validateResponsePluginPreflight, validateResponseCheckReview } from "./generated/source.validators";

export type { SourceAdoptRequest, SourceConfirmation } from "./generated/source.requests";
export type { PluginSourceSelectRequest, PluginCaptureRequest, PluginStartRequest, SourceCheckPrepareRequest, SourceCheckFinishRequest } from "./generated/source.requests";
export type { PluginSourceSelection, PluginSourcePreflight, SourceCheckReview, PluginSourceSelection as SourceSelection, PluginSourcePreflight as Preflight } from "./generated/source.responses";
export type { PluginStartRequest as StartRequest } from "./generated/source.requests";
export type { FileCoverage as Coverage, ContentScope, LineageChoice, SourceOccurrence, ContentRow, ContentPage, SourceChange, SourceChangeKind, SourceChangePage, SourceHistoryEntry, SourceHistory, LineageEvidence, SourceImpactBasis, SourceImpactSummary, SourceImpactRow, SourceImpactStatus, SourceImpactPage } from "./generated/source.responses";
export const sourceCommands = {
  integration: (_request: SessionRequest, source: PluginSourceRequest) => pluginCommands.source(source),
  selectPlugin: (request: PluginSourceSelectRequest) => checkedInvoke("select_plugin_source", request, validateResponsePluginSelection),
  capturePlugin: (request: PluginCaptureRequest) => checkedInvoke("preflight_plugin_source", request, validateResponsePluginPreflight),
  startPlugin: (request: PluginStartRequest) => checkedInvoke("start_plugin_source", request, validateResponseAttempt),
  prepareCheck: (request: SourceCheckPrepareRequest) => checkedInvoke("prepare_source_check", request, validateResponseCheckReview),
  startCheck: (request: PluginStartRequest) => checkedInvoke("start_source_check", request, validateResponseAttempt),
  finishCheck: (request: SourceCheckFinishRequest) => checkedInvoke("finish_source_check", request, validateResponseCancelled),
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
};

export function sameSourceEnvironment(view: PluginSourceView, request: PluginSourceRequest) {
  return view.resourceId === request.resourceId && view.environmentDigest === request.environmentDigest
    && [view.extractor.provider, view.checker.provider].every(provider => provider.packageDigest === request.package.packageDigest
      && provider.plugin.id === request.package.plugin.id && provider.plugin.publisher === request.package.plugin.publisher
      && provider.plugin.version === request.package.plugin.version);
}
export function sourceRequest(view: PluginSourceView): PluginSourceRequest {
  return { package: { plugin: view.extractor.provider.plugin, packageDigest: view.extractor.provider.packageDigest },
    resourceId: view.resourceId, environmentDigest: view.environmentDigest };
}

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

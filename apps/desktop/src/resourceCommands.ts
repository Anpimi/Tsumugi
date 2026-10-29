import { jsonIdentity } from "./pluginToolChoices";
import type { CorrectionBasisRequest, CorrectionCaptureRequest, ResourceActionRequest } from "./generated/resource.requests";
import { validateResponseCorrectionBasis, validateResponseCorrectionCapture, validateResponseCorrectionAction, validateResponseDecisionAction } from "./generated/resource.validators";
import type { Responses, CorrectionTermEvidence, CorrectionTermReceipt, ResourceDecisionResult, ResourcePreview } from "./generated/resource.responses";
export type { CorrectionTermBasis, CorrectionTermEvidence, CorrectionTermReceipt, GlossaryCaptureOrigin } from "./generated/resource.responses";
export type { CaptureCorrectionTerm } from "./generated/resource.requests";
import type { ContextFactRequest, ContextFactsRequest, ContextFactActionRequest, ContextFactHistoryRequest } from "./generated/resource.requests";
import { validateResponseContextFact, validateResponseContextFacts, validateResponseContextFactAction, validateResponseContextFactHistory } from "./generated/resource.validators";
export type { ContextFactWrite, ContextFactDisposition, SourceFactBasis } from "./generated/resource.requests";
export type { ContextFactDecision, ContextFactHistory } from "./generated/resource.responses";
import type { ContextFactDecision, ContextFactHistory } from "./generated/resource.responses";
import type { SessionRequest } from "./executionCommands";
import type { TermCurrentRequest } from "./generated/resource.requests";
import { validateResponseCurrentTerm } from "./generated/resource.validators";
import type { ContextResourceSaveRequest, ContextResourceWithdrawRequest, ContextResourceCurrentRequest,
  ContextResourceListRequest, ContextResourceHistoryRequest, ContextResourceActionRequest,
  ContextResourceRecoveryRequest, ContextResourceResolveRequest } from "./generated/resource.requests";
import { validateResponseContextResourceSaved, validateResponseContextResourceWithdrawn, validateResponseContextResourceCurrent,
  validateResponseContextResourcePage, validateResponseContextResourceHistory, validateResponseContextResourceAction,
  validateResponseContextResourceRecovery, validateResponseContextResourceResolution } from "./generated/resource.validators";
export type { SaveContextResource, WithdrawContextResource, ContextResourceKind, ContextResourceScope, ContextResourceAction } from "./generated/resource.requests";
export type { ContextResourceRevision, ContextResourceActionRead, ContextResourcePage,
  ContextResourceResolution, ContextResourceResolutionEntry, ContextResourceCapture, ContextResourceRecovery } from "./generated/resource.responses";
import type { ContextResourceAction } from "./generated/resource.requests";
import type { ContextResourcePage, ContextResourceRevision } from "./generated/resource.responses";
import { checkedInvoke } from "./ipc";
import type { TranslationMemoryPageRequest, TranslationMemoryEntryRequest, TranslationMemoryReuseRequest } from "./generated/resource.requests";
import type { TranslationMemoryEntry } from "./generated/resource.responses";
import { validateResponseTranslationMemoryPage, validateResponseTranslationMemoryEntry, validateResponseTranslationMemoryReuse } from "./generated/resource.validators";
import { validateResponseObservedTermAction, validateResponseObservedContextAction, validateResponseObservedContextCaptureAction,
  validateResponseObservedCorrectionAction, validateResponseObservedDecisionAction, validateResponseObservedFactAction } from "./generated/resource.validators";
export type { TranslationMemoryFilter, PrepareTranslationMemoryReuse } from "./generated/resource.requests";
export type { TranslationMemoryEntry, TranslationMemoryPage, TranslationMemoryReusePreview,
  TranslationMemoryQuality, TranslationMemorySourceLabel } from "./generated/resource.responses";
import type { TbxPreviewRequest, TmxPreviewRequest, CaptureListRequest, CaptureRequest, TermRequest, DecisionRequest, TermListRequest, TermHistoryRequest, UnitLocaleRequest, ContextWriteRequest, ContextCaptureRequest, SuggestionRequest, ImpactRequest } from "./generated/resource.requests";
import { validateResponseTbxPreview, validateResponseTmxPreview, validateResponseCaptures, validateResponseCapture, validateResponsePreview, validateResponseDecision, validateResponseTerm, validateResponseTermAction, validateResponseContextAction, validateResponseContextCaptureAction, validateResponseTerms, validateResponseResolution, validateResponseContext, validateResponseSavedContext, validateResponseContextCapture, validateResponseSuggestions, validateResponseImpacts } from "./generated/resource.validators";

export type { SaveTerm, SaveContext, CaptureContext, ResourceDecision } from "./generated/resource.requests";
export type { TbxPreviewRequest, TmxPreviewRequest } from "./generated/resource.requests";
export type { TbxFilePreview, TbxExchangePreview, TbxExchangeRow, TbxTermPreview, TbxLicenseStatus, TbxLossEntry, TbxLossKind, TbxLossSample, TbxRowReason, TbxRowStatus, TbxTermReason } from "./generated/resource.responses";
export type { TmxFilePreview, TmxExchangePreview, TmxExchangeRow, TmxProvenance, TmxLossEntry, TmxLossSample, TmxRowReason, TmxLossKind, TmxRowStatus, TmxLicenseStatus } from "./generated/resource.responses";
export type { GlossaryEntry, GlossaryCapture, TermRevision, TermOrigin, ResourceChangeKind, ResourceDecisionKind as DecisionKind, ResourcePreviewRow, ResourcePreview, ResourceDecisionResult, TermResolution, TermResolutionEntry, ContextRevision, ContextCapture, ContextItem, ContextOmission, TmSuggestion, TmMatchKind, ImpactReason, ImpactItem, ImpactPage, ResourceImpactKind, ResourceImpactConfidence, ResourceImpactStatus } from "./generated/resource.responses";

export function confirmContextFact(request: ContextFactRequest["decision"], value: ContextFactDecision) {
  if (jsonIdentity(value.request)!==jsonIdentity(request)) throw Object.assign(new Error("Invalid context fact acknowledgement"),{outcome:"unknown",reason:"context-fact-receipt"});
  return value;
}
export function confirmCorrectionCapture(request: CorrectionCaptureRequest["capture"], value: CorrectionTermReceipt) {
  if (jsonIdentity(value.request) !== jsonIdentity(request) || value.capture.origin.kind !== "correction"
    || jsonIdentity(value.capture.origin.basis) !== jsonIdentity(request.basis)
    || value.capture.targetLocale !== request.basis.locale || value.capture.count !== 1) {
    throw Object.assign(new Error("Invalid correction capture acknowledgement"), { outcome: "unknown" });
  }
  return value;
}
function sameOriginal(actual: object, expected: object) {
  const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
  return Object.keys(a).every(key => jsonIdentity(a[key] ?? null) === jsonIdentity(b[key] ?? null))
    && Object.keys(b).every(key => Object.hasOwn(a, key));
}

function sameContextAction(actual: ContextResourceAction, expected: ContextResourceRecoveryRequest["action"]) {
  return actual.kind === expected.kind && sameOriginal(actual.request, expected.request);
}
function contextActionProject(action: ContextResourceAction) {
  return action.kind === "proposal-adoption" ? action.request.proposal.projectId : action.request.projectId;
}
function contextReceiptMatches(value: ContextResourceRevision, action: ContextResourceAction) {
  if (action.kind === "proposal-adoption") return value.projectId === action.request.proposal.projectId
    && value.actionId === action.request.actionId && !value.withdrawn && !!value.proposalOrigin
    && jsonIdentity(value.proposalOrigin.proposal) === jsonIdentity(action.request.proposal)
    && value.proposalOrigin.entryIndex === action.request.entryIndex;
  const request = action.request;
  if (value.projectId !== request.projectId || value.actionId !== request.actionId
    || value.actor !== request.actor || value.reason !== request.reason) return false;
  if (action.kind === "withdraw") return value.withdrawn && value.contextId === action.request.contextId
    && value.previousRevisionId === action.request.expectedRevisionId;
  const save = action.request;
  return !value.withdrawn && (save.contextId == null || value.contextId === save.contextId)
    && (save.subjectId == null ? save.contextId != null || value.subjectId === value.contextId : value.subjectId === save.subjectId)
    && value.previousRevisionId === (save.expectedRevisionId ?? null)
    && value.kind === save.kind && value.locale === save.locale && value.name === save.name && value.text === save.text
    && jsonIdentity(value.scope) === jsonIdentity(save.scope) && jsonIdentity(value.sourceBasis) === jsonIdentity(save.sourceBasis);
}
function contextPageMatches(value: ContextResourcePage, request: { projectId: string; offset: number; limit: number; basis?: string | null }) {
  return value.rows.length <= request.limit && value.rows.every(row => row.projectId === request.projectId)
    && (request.basis == null || value.basis === request.basis)
    && (value.nextOffset === null || value.rows.length > 0 && value.nextOffset === request.offset + value.rows.length);
}

function memoryEntry(value: TranslationMemoryEntry, projectId: string, locale: string) {
  const revision = value.revision, quality = value.quality;
  return value.projectId === projectId && revision.locale === locale && BigInt(revision.ordinal) > 0n
    && /^[0-9a-f]{64}$/.test(value.basis) && value.sourceLabel.occurrenceCount > 0
    && [quality.latestDecision, quality.pastApproval, quality.currentApproval].every(decision => decision === null
      || decision.unitId === revision.unitId && decision.locale === locale && decision.revisionId === revision.revisionId
        && decision.sourceRevisionId === revision.sourceRevisionId && /^[0-9a-f]{64}$/.test(decision.basis))
    && (quality.pastApproval === null || quality.pastApproval.kind === "approve")
    && (quality.currentApproval === null || quality.currentApproval.kind === "approve" && quality.pastApproval !== null
      && value.isCurrentSelection && value.isCurrentSource)
    && (revision.reuseOrigin == null || revision.reuseOrigin.targetUnitId === revision.unitId && /^[0-9a-f]{64}$/.test(revision.reuseOrigin.donorBasis));
}
function memoryFilterIdentity(filter: TranslationMemoryPageRequest["filter"]) {
  return jsonIdentity({ ...filter, sourceText: filter.sourceText ?? null, translationText: filter.translationText ?? null, origin: filter.origin ?? null });
}

export const resourceCommands = {
  observeTermAction: (input: TermRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("observe_term_save_action", request,
      (value): value is Responses["observedTermAction"] => validateResponseObservedTermAction(value)
        && request.projectId === request.term.projectId && (value === null || sameOriginal(value.request, request.term)));
  },
  observeContextAction: (input: ContextWriteRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("observe_context_save_action", request,
      (value): value is Responses["observedContextAction"] => validateResponseObservedContextAction(value)
        && request.projectId === request.context.projectId && (value === null || sameOriginal(value.request, request.context)));
  },
  observeContextCaptureAction: (input: ContextCaptureRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("observe_context_capture_action", request,
      (value): value is Responses["observedContextCaptureAction"] => validateResponseObservedContextCaptureAction(value)
        && request.projectId === request.capture.projectId && (value === null || sameOriginal(value.request, request.capture)));
  },
  observeCorrectionAction: (input: CorrectionCaptureRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("observe_correction_term_action", request,
      (value): value is Responses["observedCorrectionAction"] => validateResponseObservedCorrectionAction(value)
        && request.projectId === request.capture.basis.projectId && (value === null || sameOriginal(value.request, request.capture)
          && value.capture.origin.kind === "correction" && jsonIdentity(value.capture.origin.basis) === jsonIdentity(request.capture.basis)
          && value.capture.targetLocale === request.capture.basis.locale && value.capture.count === 1));
  },
  observeDecisionAction: (input: DecisionRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("observe_resource_decision_action", request,
      (value): value is Responses["observedDecisionAction"] => validateResponseObservedDecisionAction(value)
        && request.projectId === request.decision.projectId && (value === null || sameOriginal(value.request, request.decision)));
  },
  observeFactAction: (input: ContextFactRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("observe_context_fact_action", request,
      (value): value is Responses["observedFactAction"] => validateResponseObservedFactAction(value)
        && request.projectId === request.decision.basis.scope.projectId && (value === null || sameOriginal(value.request, request.decision)));
  },
  translationMemoryPage: (request: TranslationMemoryPageRequest) => {
    const captured = structuredClone(request), filter = captured.filter;
    return checkedInvoke("list_translation_memory", captured,
      (value): value is Responses["translationMemoryPage"] => validateResponseTranslationMemoryPage(value)
        && value.projectId === captured.projectId && memoryFilterIdentity(value.filter) === memoryFilterIdentity(filter)
        && /^[0-9a-f]{64}$/.test(value.basis) && value.rows.length <= captured.limit
        && new Set(value.rows.map(entry => entry.revision.revisionId)).size === value.rows.length
        && value.rows.every(entry => memoryEntry(entry, captured.projectId, filter.targetLocale) && entry.sourceLocale === filter.sourceLocale
          && (filter.sourceText == null || entry.sourceText.includes(filter.sourceText))
          && (filter.translationText == null || entry.revision.text.includes(filter.translationText))
          && (filter.origin == null || entry.revision.originKind === filter.origin)
          && (filter.selection === "all" || entry.isCurrentSelection === (filter.selection === "current")))
        && (value.nextCursor === null || value.rows.length > 0 && value.nextCursor !== captured.cursor)
        && new TextEncoder().encode(JSON.stringify(value)).length <= 1024 * 1024);
  },
  translationMemoryEntry: (request: TranslationMemoryEntryRequest) => {
    const captured = structuredClone(request);
    return checkedInvoke("read_translation_memory_entry", captured,
      (value): value is Responses["translationMemoryEntry"] => validateResponseTranslationMemoryEntry(value)
        && memoryEntry(value, captured.projectId, captured.locale) && value.revision.unitId === captured.unitId
        && value.revision.revisionId === captured.revisionId);
  },
  prepareTranslationMemoryReuse: (request: TranslationMemoryReuseRequest) => {
    const captured = structuredClone(request), reuse = captured.reuse;
    return checkedInvoke("prepare_translation_memory_reuse", captured,
      (value): value is Responses["translationMemoryReuse"] => validateResponseTranslationMemoryReuse(value)
        && captured.projectId === reuse.projectId && memoryEntry(value.donor, captured.projectId, reuse.locale)
        && value.donor.revision.unitId === reuse.donorUnitId && value.donor.revision.revisionId === reuse.donorRevisionId
        && value.donor.basis === reuse.donorBasis && value.donor.revision.candidateDecision?.request.disposition !== "rejected"
        && value.target.unitId === reuse.unitId && value.target.locale === reuse.locale
        && value.target.sourceRevisionId === reuse.sourceRevisionId && value.target.selectionId === (reuse.expectedSelectionId ?? null)
        && value.reuseOrigin.targetUnitId === reuse.unitId && value.reuseOrigin.targetSourceSnapshotId === value.target.sourceSnapshotId
        && value.reuseOrigin.targetSourceRevisionId === reuse.sourceRevisionId && value.reuseOrigin.targetSelectionId === (reuse.expectedSelectionId ?? null)
        && value.reuseOrigin.donorUnitId === reuse.donorUnitId && value.reuseOrigin.donorSourceRevisionId === value.donor.revision.sourceRevisionId
        && value.reuseOrigin.donorTranslationRevisionId === reuse.donorRevisionId && value.reuseOrigin.donorBasis === reuse.donorBasis);
  },
  saveContextResource: (request: ContextResourceSaveRequest) => checkedInvoke("save_context_resource", request,
    (value): value is Responses["contextResourceSaved"] => validateResponseContextResourceSaved(value)
      && value.projectId === request.projectId && contextReceiptMatches(value, { kind: "save", request: request.resource })),
  withdrawContextResource: (request: ContextResourceWithdrawRequest) => checkedInvoke("withdraw_context_resource", request,
    (value): value is Responses["contextResourceWithdrawn"] => validateResponseContextResourceWithdrawn(value)
      && value.projectId === request.projectId && contextReceiptMatches(value, { kind: "withdraw", request: request.resource })),
  contextResourceCurrent: (request: ContextResourceCurrentRequest) => checkedInvoke("read_context_resource_current", request,
    (value): value is Responses["contextResourceCurrent"] => validateResponseContextResourceCurrent(value)
      && (value === null || value.projectId === request.projectId && value.contextId === request.contextId)),
  contextResourcePage: (request: ContextResourceListRequest) => checkedInvoke("read_context_resource_page", request,
    (value): value is Responses["contextResourcePage"] => validateResponseContextResourcePage(value) && contextPageMatches(value, request)
      && value.rows.every(row => row.locale === request.locale && (request.kind == null || row.kind === request.kind))),
  contextResourceHistory: (request: ContextResourceHistoryRequest) => checkedInvoke("read_context_resource_history", request,
    (value): value is Responses["contextResourceHistory"] => validateResponseContextResourceHistory(value) && contextPageMatches(value, request)
      && value.rows.every(row => row.contextId === request.contextId)),
  contextResourceAction: (request: ContextResourceActionRequest) => checkedInvoke("read_context_resource_action", request,
    (value): value is Responses["contextResourceAction"] => validateResponseContextResourceAction(value)
      && (value === null || value.receipt.projectId === request.projectId && value.receipt.actionId === request.actionId
        && contextActionProject(value.request) === request.projectId && value.request.request.actionId === request.actionId
        && contextReceiptMatches(value.receipt, value.request))),
  reconcileContextResourceAction: (request: ContextResourceRecoveryRequest) => checkedInvoke("reconcile_context_resource_action", request,
    (value): value is Responses["contextResourceRecovery"] => validateResponseContextResourceRecovery(value)
      && request.action.kind !== "proposal-adoption" && sameContextAction(value.request, request.action) && contextActionProject(value.request) === request.projectId
      && (value.status === "recorded" ? value.receipt !== null && value.receipt.projectId === request.projectId
        && contextReceiptMatches(value.receipt, value.request) : value.status === "retry-allowed" && value.receipt === null)),
  resolveContextResources: (request: ContextResourceResolveRequest) => checkedInvoke("resolve_context_resources", request,
    (value): value is Responses["contextResourceResolution"] => validateResponseContextResourceResolution(value)
      && request.scope.projectId === request.projectId && jsonIdentity(value.scope) === jsonIdentity(request.scope)
      && value.entries.every(entry => entry.revision.projectId === request.projectId && entry.revision.locale === request.scope.locale)),
  correctionBasis: (request: CorrectionBasisRequest) => checkedInvoke("read_correction_term_basis", request,
    (value): value is CorrectionTermEvidence => validateResponseCorrectionBasis(value)
      && value.basis.projectId === request.projectId && value.basis.unitId === request.unitId
      && value.basis.locale === request.locale && value.basis.after.selectionId === request.afterSelectionId),
  captureCorrection: async (request: CorrectionCaptureRequest) => confirmCorrectionCapture(request.capture,
    await checkedInvoke("capture_correction_term", request, validateResponseCorrectionCapture)),
  correctionAction: (request: ResourceActionRequest) => checkedInvoke("read_correction_term_action", request,
    (value): value is CorrectionTermReceipt | null => validateResponseCorrectionAction(value)
      && (value === null || value.request.actionId === request.actionId && value.request.basis.projectId === request.projectId)),
  decisionAction: (request: DecisionRequest) => checkedInvoke("read_resource_decision_action", request,
    (value): value is Responses["decisionAction"] => validateResponseDecisionAction(value)
      && (value === null || sameOriginal(value.request, request.decision)
        && sameOriginal(value.receipt.request, request.decision)
        && value.receipt.actionId === request.decision.actionId && value.receipt.decision === request.decision.decision)),
  factDecisions: (request: ContextFactsRequest) => checkedInvoke("read_context_fact_decisions",request,(value):value is ContextFactDecision[] => validateResponseContextFacts(value) && value.length<=request.facts.length && new Set(value.map(v=>`${v.request.basis.fact.blockIndex}:${v.request.basis.fact.factIndex}`)).size===value.length && value.every(v=>jsonIdentity(v.request.basis.scope)===jsonIdentity(request.scope) && request.facts.some(f=>f.blockIndex===v.request.basis.fact.blockIndex && f.factIndex===v.request.basis.fact.factIndex))),
  factHistory: (request: ContextFactHistoryRequest) => checkedInvoke("read_context_fact_history",request,(value):value is ContextFactHistory => validateResponseContextFactHistory(value) && value.rows.length<=request.limit && value.rows.every(v=>v.request.basis.scope.projectId===request.projectId && v.request.basis.scope.unitId===request.unitId && v.request.basis.scope.locale===request.locale) && (value.nextOffset===null || value.nextOffset===request.offset+request.limit)),
  factAction: (request: ContextFactActionRequest) => checkedInvoke("read_context_fact_action",request,(value):value is ContextFactDecision|null => validateResponseContextFactAction(value) && (value===null || value.request.actionId===request.actionId && value.request.basis.scope.projectId===request.projectId)),
  decideFact: async (request: ContextFactRequest) => confirmContextFact(request.decision,await checkedInvoke("decide_context_fact",request,validateResponseContextFact)),
  previewTbx: async (request: TbxPreviewRequest) => {
    const result = await checkedInvoke("preview_tbx_exchange", request, validateResponseTbxPreview);
    if (result && (result.projectId !== request.projectId || result.preview.targetLocale !== request.locale)) {
      throw new Error("Invalid TBX preview association");
    }
    return result;
  },
  previewTmx: async (request: TmxPreviewRequest) => {
    const result = await checkedInvoke("preview_tmx_exchange", request, validateResponseTmxPreview);
    if (result && (result.projectId !== request.projectId || result.preview.targetLocale !== request.locale)) {
      throw new Error("Invalid TMX preview association");
    }
    return result;
  },
  captures: (request: CaptureListRequest) => checkedInvoke("list_resource_captures", request, validateResponseCaptures),
  chooseFile: (request: SessionRequest) => checkedInvoke("choose_resource_file", request, validateResponseCapture),
  preview: (request: CaptureRequest) => checkedInvoke("read_resource_preview", request,
    (value): value is ResourcePreview => validateResponsePreview(value) && value.capture.captureId === request.captureId
      && (value.capture.origin.kind === "correction" ? value.correction !== null
        && jsonIdentity(value.correction.evidence.basis) === jsonIdentity(value.capture.origin.basis)
        && value.capture.origin.basis.projectId === request.projectId && value.capture.origin.basis.locale === value.capture.targetLocale
        : value.correction === null) && (value.capture.origin.kind === "mcp" ? value.mcp !== null
          && value.capture.origin.provenance.basis.projectId === request.projectId && value.capture.origin.provenance.basis.locale === value.capture.targetLocale
          : value.mcp === null)),
  decide: (request: DecisionRequest) => checkedInvoke("decide_resource_entry", request, validateResponseDecision),
  saveTerm: (request: TermRequest) => checkedInvoke("save_term", request, validateResponseTerm),
  termAction: (request: TermRequest) => checkedInvoke("read_term_save_action", request,
    (value): value is Responses["termAction"] => validateResponseTermAction(value)
      && (value === null || sameOriginal(value.request, request.term))),
  terms: (request: TermListRequest) => checkedInvoke("read_terms", request, validateResponseTerms),
  termCurrent: (request: TermCurrentRequest) => checkedInvoke("read_term_current", request,
    (value): value is Responses["currentTerm"] => validateResponseCurrentTerm(value) && (value === null || value.termId === request.termId)),
  termHistory: (request: TermHistoryRequest) => checkedInvoke("read_term_history", request, validateResponseTerms),
  resolve: (request: UnitLocaleRequest) => checkedInvoke("resolve_terms", request, validateResponseResolution),
  context: (request: UnitLocaleRequest) => checkedInvoke("read_context_revision", request, validateResponseContext),
  saveContext: (request: ContextWriteRequest) => checkedInvoke("save_context", request, validateResponseSavedContext),
  contextAction: (request: ContextWriteRequest) => checkedInvoke("read_context_save_action", request,
    (value): value is Responses["contextAction"] => validateResponseContextAction(value)
      && (value === null || sameOriginal(value.request, request.context))),
  captureContext: (request: ContextCaptureRequest) => checkedInvoke("capture_context", request, validateResponseContextCapture),
  contextCaptureAction: (request: ContextCaptureRequest) => checkedInvoke("read_context_capture_action", request,
    (value): value is Responses["contextCaptureAction"] => validateResponseContextCaptureAction(value)
      && (value === null || sameOriginal(value.request, request.capture))),
  captureAction: (request: ContextCaptureRequest) => resourceCommands.contextCaptureAction(request),
  readCapture: (request: CaptureRequest) => checkedInvoke("read_context_capture", request, validateResponseContextCapture),
  suggestions: (request: SuggestionRequest) => checkedInvoke("tm_suggestions", request, validateResponseSuggestions),
  impacts: (request: ImpactRequest) => checkedInvoke("resource_impacts", request, validateResponseImpacts),
};

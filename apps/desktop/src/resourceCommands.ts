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
import { checkedInvoke } from "./ipc";
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
export const resourceCommands = {
  correctionBasis: (request: CorrectionBasisRequest) => checkedInvoke("read_correction_term_basis", request,
    (value): value is CorrectionTermEvidence => validateResponseCorrectionBasis(value)
      && value.basis.projectId === request.projectId && value.basis.unitId === request.unitId
      && value.basis.locale === request.locale && value.basis.after.selectionId === request.afterSelectionId),
  captureCorrection: async (request: CorrectionCaptureRequest) => confirmCorrectionCapture(request.capture,
    await checkedInvoke("capture_correction_term", request, validateResponseCorrectionCapture)),
  correctionAction: (request: ResourceActionRequest) => checkedInvoke("read_correction_term_action", request,
    (value): value is CorrectionTermReceipt | null => validateResponseCorrectionAction(value)
      && (value === null || value.request.actionId === request.actionId && value.request.basis.projectId === request.projectId)),
  decisionAction: (request: ResourceActionRequest) => checkedInvoke("read_resource_decision_action", request,
    (value): value is ResourceDecisionResult | null => validateResponseDecisionAction(value)
      && (value === null || value.request.actionId === request.actionId && value.request.projectId === request.projectId)),
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
      && (value === null || jsonIdentity(value.request) === jsonIdentity(request.term))),
  terms: (request: TermListRequest) => checkedInvoke("read_terms", request, validateResponseTerms),
  termHistory: (request: TermHistoryRequest) => checkedInvoke("read_term_history", request, validateResponseTerms),
  resolve: (request: UnitLocaleRequest) => checkedInvoke("resolve_terms", request, validateResponseResolution),
  context: (request: UnitLocaleRequest) => checkedInvoke("read_context_revision", request, validateResponseContext),
  saveContext: (request: ContextWriteRequest) => checkedInvoke("save_context", request, validateResponseSavedContext),
  contextAction: (request: ContextWriteRequest) => checkedInvoke("read_context_save_action", request,
    (value): value is Responses["contextAction"] => validateResponseContextAction(value)
      && (value === null || jsonIdentity(value.request) === jsonIdentity(request.context))),
  captureContext: (request: ContextCaptureRequest) => checkedInvoke("capture_context", request, validateResponseContextCapture),
  contextCaptureAction: (request: ContextCaptureRequest) => checkedInvoke("read_context_capture_action", request,
    (value): value is Responses["contextCaptureAction"] => validateResponseContextCaptureAction(value)
      && (value === null || jsonIdentity(value.request) === jsonIdentity(request.capture))),
  readCapture: (request: CaptureRequest) => checkedInvoke("read_context_capture", request, validateResponseContextCapture),
  suggestions: (request: SuggestionRequest) => checkedInvoke("tm_suggestions", request, validateResponseSuggestions),
  impacts: (request: ImpactRequest) => checkedInvoke("resource_impacts", request, validateResponseImpacts),
};

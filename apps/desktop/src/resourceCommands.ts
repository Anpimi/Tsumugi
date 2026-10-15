import type { SessionRequest } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import type { TmxPreviewRequest, CaptureListRequest, CaptureRequest, TermRequest, DecisionRequest, TermListRequest, TermHistoryRequest, UnitLocaleRequest, ContextWriteRequest, ContextCaptureRequest, SuggestionRequest, ImpactRequest } from "./generated/resource.requests";
import { validateResponseTmxPreview, validateResponseCaptures, validateResponseCapture, validateResponsePreview, validateResponseDecision, validateResponseTerm, validateResponseTerms, validateResponseResolution, validateResponseContext, validateResponseSavedContext, validateResponseContextCapture, validateResponseSuggestions, validateResponseImpacts } from "./generated/resource.validators";

export type { SaveTerm, SaveContext, CaptureContext, ResourceDecision } from "./generated/resource.requests";
export type { TmxPreviewRequest } from "./generated/resource.requests";
export type { TmxFilePreview, TmxExchangePreview, TmxExchangeRow, TmxProvenance, TmxLossEntry, TmxLossSample, TmxRowReason, TmxLossKind, TmxRowStatus, TmxLicenseStatus } from "./generated/resource.responses";
export type { GlossaryEntry, GlossaryCapture, TermRevision, TermOrigin, ResourceChangeKind, ResourceDecisionKind as DecisionKind, ResourcePreviewRow, ResourcePreview, ResourceDecisionResult, TermResolution, TermResolutionEntry, ContextRevision, ContextCapture, ContextItem, ContextOmission, TmSuggestion, TmMatchKind, ImpactReason, ImpactItem, ImpactPage, ResourceImpactKind, ResourceImpactConfidence, ResourceImpactStatus } from "./generated/resource.responses";

export const resourceCommands = {
  previewTmx: async (request: TmxPreviewRequest) => {
    const result = await checkedInvoke("preview_tmx_exchange", request, validateResponseTmxPreview);
    if (result && (result.projectId !== request.projectId || result.preview.targetLocale !== request.locale)) {
      throw new Error("Invalid TMX preview association");
    }
    return result;
  },
  captures: (request: CaptureListRequest) => checkedInvoke("list_resource_captures", request, validateResponseCaptures),
  chooseFile: (request: SessionRequest) => checkedInvoke("choose_resource_file", request, validateResponseCapture),
  preview: (request: CaptureRequest) => checkedInvoke("read_resource_preview", request, validateResponsePreview),
  decide: (request: DecisionRequest) => checkedInvoke("decide_resource_entry", request, validateResponseDecision),
  saveTerm: (request: TermRequest) => checkedInvoke("save_term", request, validateResponseTerm),
  terms: (request: TermListRequest) => checkedInvoke("read_terms", request, validateResponseTerms),
  termHistory: (request: TermHistoryRequest) => checkedInvoke("read_term_history", request, validateResponseTerms),
  resolve: (request: UnitLocaleRequest) => checkedInvoke("resolve_terms", request, validateResponseResolution),
  context: (request: UnitLocaleRequest) => checkedInvoke("read_context_revision", request, validateResponseContext),
  saveContext: (request: ContextWriteRequest) => checkedInvoke("save_context", request, validateResponseSavedContext),
  captureContext: (request: ContextCaptureRequest) => checkedInvoke("capture_context", request, validateResponseContextCapture),
  readCapture: (request: CaptureRequest) => checkedInvoke("read_context_capture", request, validateResponseContextCapture),
  suggestions: (request: SuggestionRequest) => checkedInvoke("tm_suggestions", request, validateResponseSuggestions),
  impacts: (request: ImpactRequest) => checkedInvoke("resource_impacts", request, validateResponseImpacts),
};

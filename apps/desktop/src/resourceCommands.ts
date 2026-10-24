import * as validators from "./generated/resource.validators";
import type { SessionRequest } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import type { CaptureListRequest, CaptureRequest, TermRequest, DecisionRequest, TermListRequest, TermHistoryRequest, UnitLocaleRequest, ContextWriteRequest, ContextCaptureRequest, SuggestionRequest, ImpactRequest } from "./generated/resource.requests";
import { validateResponseCaptures, validateResponseCapture, validateResponsePreview, validateResponseDecision, validateResponseTerm, validateResponseTerms, validateResponseResolution, validateResponseContext, validateResponseSavedContext, validateResponseContextCapture, validateResponseSuggestions, validateResponseImpacts } from "./generated/resource.validators";

export type { SaveTerm, SaveContext, CaptureContext, ResourceDecision } from "./generated/resource.requests";
export type { GlossaryEntry, GlossaryCapture, TermRevision, TermOrigin, ResourceChangeKind, ResourceDecisionKind as DecisionKind, ResourcePreviewRow, ResourcePreview, ResourceDecisionResult, TermResolution, TermResolutionEntry, ContextRevision, ContextCapture, ContextItem, ContextOmission, TmSuggestion, TmMatchKind, ImpactReason, ImpactItem, ImpactPage, ResourceImpactKind, ResourceImpactConfidence, ResourceImpactStatus } from "./generated/resource.responses";

function sameOriginal(actual: object, expected: object) {
  const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
  return Object.keys(a).every(key => JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null))
    && Object.keys(b).every(key => Object.hasOwn(a, key));
}

export const resourceCommands = {
  decisionAction: async (request: DecisionRequest) => {
    const value = await checkedInvoke("read_resource_decision_action", request, validators.validateResponseDecisionAction);
    if (value === null) return null;
    if (!sameOriginal(value.request, request.decision)) throw new Error("Invalid original resource action");
    if (!(value.receipt.actionId === request.decision.actionId && value.receipt.decision === request.decision.decision)) throw new Error("Invalid saved resource receipt");
    return value.receipt;
  },
  captureAction: async (request: ContextCaptureRequest) => {
    const value = await checkedInvoke("read_context_capture_action", request, validators.validateResponseCaptureAction);
    if (value === null) return null;
    if (!sameOriginal(value.request, request.capture)) throw new Error("Invalid original resource action");
    if (!(value.receipt.unitId === request.capture.unitId && value.receipt.locale === request.capture.locale
      && value.receipt.sourceRevisionId === request.capture.sourceRevisionId && value.receipt.budgetBytes === request.capture.budgetBytes)) throw new Error("Invalid saved resource receipt");
    return value.receipt;
  },
  contextAction: async (request: ContextWriteRequest) => {
    const value = await checkedInvoke("read_context_save_action", request, validators.validateResponseContextAction);
    if (value === null) return null;
    if (!sameOriginal(value.request, request.context)) throw new Error("Invalid original resource action");
    if (!(value.receipt.unitId === request.context.unitId && value.receipt.locale === request.context.locale
      && value.receipt.text === request.context.text && value.receipt.reason === request.context.reason
      && value.receipt.previousRevisionId === (request.context.expectedRevisionId ?? null))) throw new Error("Invalid saved resource receipt");
    return value.receipt;
  },
  termAction: async (request: TermRequest) => {
    const value = await checkedInvoke("read_term_save_action", request, validators.validateResponseTermAction);
    if (value === null) return null;
    if (!sameOriginal(value.request, request.term)) throw new Error("Invalid original resource action");
    if (!(value.receipt.locale === request.term.locale && value.receipt.source === request.term.source
      && JSON.stringify(value.receipt.aliases) === JSON.stringify(request.term.aliases) && value.receipt.target === request.term.target
      && value.receipt.protected === request.term.protected && value.receipt.scopeUnitId === (request.term.scopeUnitId ?? null)
      && value.receipt.reason === request.term.reason && value.receipt.previousRevisionId === (request.term.expectedRevisionId ?? null)
      && (request.term.termId == null || value.receipt.termId === request.term.termId)
      && value.receipt.originKind === "manual" && value.receipt.captureId === null && value.receipt.externalEntryId === null && !value.receipt.removed)) throw new Error("Invalid saved resource receipt");
    return value.receipt;
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

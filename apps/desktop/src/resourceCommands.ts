import { invoke } from "@tauri-apps/api/core";
import type { SessionRequest } from "./executionCommands";

export interface GlossaryEntry {
  id: string; source: string; aliases: string[]; target: string;
  protected: boolean; nativeKey: string | null; reason: string;
}
export interface GlossaryCapture {
  captureId: string; resourceId: string; revision: string; license: string;
  sourceLocale: string; targetLocale: string; digest: string; count: number;
}
export interface TermRevision {
  revisionId: string; termId: string; locale: string; source: string;
  aliases: string[]; target: string; protected: boolean; scopeUnitId: string | null;
  reason: string; originKind: "manual" | "external"; captureId: string | null;
  externalEntryId: string | null; previousRevisionId: string | null; removed: boolean;
}
export type ResourceChangeKind = "added" | "edited" | "removed" | "unchanged" | "override";
export type DecisionKind = "adopt" | "keep" | "ignore" | "override";
export interface ResourcePreviewRow {
  entry: GlossaryEntry; kind: ResourceChangeKind;
  current: TermRevision | null; scopeUnitId: string | null;
}
export interface ResourcePreview {
  capture: GlossaryCapture; rows: ResourcePreviewRow[]; removed: TermRevision[];
}
export interface ResourceDecision {
  projectId: string; actionId: string; captureId: string; entryId: string;
  expectedRevisionId: string | null; decision: DecisionKind;
}
export interface ResourceDecisionResult {
  actionId: string; decision: DecisionKind; revision: TermRevision | null;
}
export interface SaveTerm {
  projectId: string; actionId: string; termId: string | null; locale: string;
  source: string; aliases: string[]; target: string; protected: boolean;
  scopeUnitId: string | null; expectedRevisionId: string | null; reason: string;
}
export interface TermResolution {
  unitId: string; locale: string; sourceRevisionId: string;
  entries: Array<{ source: string; selected: TermRevision | null; conflicting: TermRevision[] }>;
}
export interface SaveContext {
  projectId: string; actionId: string; unitId: string; locale: string;
  sourceRevisionId: string; expectedRevisionId: string | null; text: string; reason: string;
}
export interface ContextRevision {
  revisionId: string; unitId: string; locale: string; text: string; reason: string;
  previousRevisionId: string | null;
}
export interface CaptureContext {
  projectId: string; actionId: string; unitId: string; locale: string;
  sourceRevisionId: string; budgetBytes: number;
}
export interface ContextCapture {
  captureId: string; unitId: string; locale: string; sourceRevisionId: string;
  budgetBytes: number;
  included: Array<{ kind: string; revisionId: string; text: string; provenance: string }>;
  omitted: Array<{ kind: string; reference: string; reason: string }>;
}
export interface TmSuggestion {
  unitId: string; sourceRevisionId: string; sourceText: string;
  translationRevisionId: string; translationText: string; targetLocale: string;
  originKind: "manual" | "import"; isCurrentSelection: boolean;
  hasHumanApproval: boolean; matchKind: "exact" | "fuzzy"; scorePercent: number;
}
export interface ImpactReason {
  changeId: string; kind: "term" | "context"; oldRevisionId: string | null;
  newRevisionId: string; oldValue: string | null; newValue: string; newRemoved: boolean;
  confidence: "explicit-unit" | "literal-possible";
}
export interface ImpactItem {
  unitId: string; locale: string; sourceRevisionId: string; nativeKey: string; sourceText: string;
  selectionEventId: string; translationRevisionId: string;
  status: "needs-revalidation" | "unresolved"; reasons: ImpactReason[];
}
export interface ImpactPage {
  items: ImpactItem[]; totalAffected: number; nextOffset: number | null; coverage: string;
}

export const resourceCommands = {
  captures: (request: SessionRequest & { limit: number }) =>
    invoke<GlossaryCapture[]>("list_resource_captures", { request }),
  chooseFile: (request: SessionRequest) =>
    invoke<GlossaryCapture | null>("choose_resource_file", { request }),
  preview: (request: SessionRequest & { captureId: string }) =>
    invoke<ResourcePreview>("read_resource_preview", { request }),
  decide: (request: SessionRequest & { decision: ResourceDecision }) =>
    invoke<ResourceDecisionResult>("decide_resource_entry", { request }),
  saveTerm: (request: SessionRequest & { term: SaveTerm }) =>
    invoke<TermRevision>("save_term", { request }),
  terms: (request: SessionRequest & { locale: string; afterTermId: string | null; limit: number }) =>
    invoke<TermRevision[]>("read_terms", { request }),
  termHistory: (request: SessionRequest & { termId: string; offset: number; limit: number }) =>
    invoke<TermRevision[]>("read_term_history", { request }),
  resolve: (request: SessionRequest & { unitId: string; locale: string }) =>
    invoke<TermResolution>("resolve_terms", { request }),
  context: (request: SessionRequest & { unitId: string; locale: string }) =>
    invoke<ContextRevision | null>("read_context_revision", { request }),
  saveContext: (request: SessionRequest & { context: SaveContext }) =>
    invoke<ContextRevision>("save_context", { request }),
  captureContext: (request: SessionRequest & { capture: CaptureContext }) =>
    invoke<ContextCapture>("capture_context", { request }),
  readCapture: (request: SessionRequest & { captureId: string }) =>
    invoke<ContextCapture>("read_context_capture", { request }),
  suggestions: (request: SessionRequest & { unitId: string; locale: string; offset: number; limit: number }) =>
    invoke<TmSuggestion[]>("tm_suggestions", { request }),
  impacts: (request: SessionRequest & { locale: string; offset: number; limit: number }) =>
    invoke<ImpactPage>("resource_impacts", { request }),
};

import type { SessionRequest } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import type { CaptureRequest, StartRequest, SourceAdoptRequest, PreviewRequest, ContentRequest, ComparisonRequest, HistoryRequest, HistoryContentRequest, LineageRequest, ImpactRequest } from "./generated/source.requests";
import { validateResponseIntegration, validateResponseSelection, validateResponsePreflight, validateResponseAttempt, validateResponseCancelled, validateResponseScope, validateResponsePage, validateResponseComparison, validateResponseHistory, validateResponseLineage, validateResponseEstimates, validateResponseImpact, validateResponseAction } from "./generated/source.validators";

export type { CaptureRequest, StartRequest, SourceAdoptRequest, SourceConfirmation } from "./generated/source.requests";
export type { SourceSelection, IntegrationDescriptor, FileCoverage as Coverage, Preflight, ContentScope, LineageChoice, SourceOccurrence, ContentRow, ContentPage, SourceChange, SourceChangeKind, SourceChangePage, SourceHistoryEntry, SourceHistory, LineageEvidence, SourceImpactBasis, SourceImpactSummary, SourceImpactRow, SourceImpactStatus, SourceImpactPage } from "./generated/source.responses";
export const sourceCommands = {
  integration: (request: SessionRequest, integrationId = "stardew-smapi") => checkedInvoke(integrationId === "webvtt" ? "read_webvtt_integration" : "read_source_integration", request, validateResponseIntegration),
  select: (request: SessionRequest, integrationId = "stardew-smapi") => checkedInvoke(integrationId === "webvtt" ? "select_webvtt_source" : "select_source", request, validateResponseSelection),
  preflight: (request: CaptureRequest) => checkedInvoke("preflight_source", request, validateResponsePreflight),
  start: (request: StartRequest) => checkedInvoke("start_source_import", request, validateResponseAttempt),
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

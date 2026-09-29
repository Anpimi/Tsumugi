import { invoke } from "@tauri-apps/api/core";
import type { AdoptionAction, SessionRequest } from "./executionCommands";

export interface SourceSelection { selectionId: string; folderName: string }
export interface IntegrationDescriptor { id: string; version: string; capabilityId: string; capabilityVersion: string; inputVersion: number; outputVersion: number; formatProfiles: string[]; requiredFiles: string[]; permissions: string[]; available: boolean; reason: string | null }
export interface Coverage { artifactId: string; logicalPath: string; role: string; sha256: string }
export interface Preflight { namespace: string; count: number; sourceLanguage: string; diagnostics: string[]; files: Coverage[] }
export interface ContentScope { revision: string; currentSnapshot: string | null }
export interface LineageChoice { newOrdinal: number; oldOccurrenceId: string; decision: "continue" | "reject"; reason: string }
export interface SourceConfirmation { resultDigest: string; identityPolicy: string; expectedContentRevision: string; sourceLanguage: string; expectedCurrentSnapshot?: string | null; lineage?: LineageChoice[]; actor?: string | null; lineageBaseSnapshot?: string | null }
export interface SourceOccurrence { ordinal: number; artifactId: string; namespace: string; key: string; text: string; keyByteRange: [number, number]; valueByteRange: [number, number]; identityBasis: string }
export interface ContentRow { occurrenceId: string | null; unitId: string | null; sourceRevisionId: string | null; occurrence: SourceOccurrence }
export interface ContentPage { snapshotId: string | null; attemptId: string; resultId: string; scope: ContentScope; confirmation: SourceConfirmation; namespace: string; coverage: Coverage[]; total: number; nextOrdinal: number | null; diagnostics: string[]; rows: ContentRow[] }
export interface SourceChange { kind: "unchanged" | "moved" | "changed" | "added" | "removed" | "rename-candidate" | "ambiguous"; old: ContentRow | null; new: SourceOccurrence | null; candidates: ContentRow[] }
export interface SourceChangePage { scope: ContentScope; attemptId: string; resultId: string; previousSnapshotId: string; confirmation: SourceConfirmation; total: number; filteredTotal: number; unchanged: number; moved: number; changed: number; added: number; ambiguous: number; removed: number; nextOrdinal: number | null; rows: SourceChange[] }
export interface SourceHistoryEntry { snapshotId: string; revision: number; current: boolean; total: number; actionId: string; resultDigest: string; coverage: Coverage[] }
export interface SourceHistory { snapshots: SourceHistoryEntry[]; total: number; nextOffset: number | null }
export interface LineageEvidence { old: ContentRow; oldSnapshotId: string; relationship: string; decision: string; actor: string | null; reason: string | null; actionId: string; policy: string; appliedRelation: string | null }
export interface SourceImpactBasis { basis: string; evidence: { sourceSnapshotId: string; sourceRevisionId: string; selectionId: string | null; revisionId: string | null; contextRevisionId: string | null; termRevisionIds: string[] }; actionId: string; kind: string; translationText: string | null }
export interface SourceImpactSummary { locale: string; preserved: number; reassess: number; unresolved: number; total: number }
export interface SourceImpactRow { current: ContentRow; previous: ContentRow | null; previousBases: SourceImpactBasis[]; locale: string; status: "preserved" | "reassess" | "unresolved"; reasons: string[]; selectionId: string | null; translationRevisionId: string | null; reviewBasis: string; lineage: LineageEvidence[] }
export interface SourceImpactPage { snapshotId: string; summary: SourceImpactSummary; nextOrdinal: number | null; rows: SourceImpactRow[] }
export interface CaptureRequest extends SessionRequest { selectionId: string; sourceLanguage: string }
export interface StartRequest extends CaptureRequest { attemptId: string }
export interface SourceAdoptRequest extends SessionRequest { attemptId: string; resultId: string; actionId: string; confirmation: SourceConfirmation }
export const sourceCommands = {
  integration: (request: SessionRequest) => invoke<IntegrationDescriptor>("read_source_integration", { request }),
  select: (request: SessionRequest) => invoke<SourceSelection | null>("select_source", { request }),
  preflight: (request: CaptureRequest) => invoke<Preflight>("preflight_source", { request }),
  start: (request: StartRequest) => invoke<string>("start_source_import", { request }),
  cancelCapture: (request: SessionRequest) => invoke<void>("cancel_source_capture", { request }),
  scope: (request: SessionRequest) => invoke<ContentScope>("read_content_scope", { request }),
  preview: (request: SessionRequest & { attemptId: string; resultId: string; after: number; limit: number }) => invoke<ContentPage>("read_source_preview", { request }),
  content: (request: SessionRequest & { snapshotId: string; after: number; limit: number }) => invoke<ContentPage>("read_source_content", { request }),
  compare: (request: SessionRequest & { attemptId: string; resultId: string; after: number; limit: number; base?: string | null; filter?: string }) => invoke<SourceChangePage>("read_source_comparison", { request: { base: null, filter: "", ...request } }),
  history: (request: SessionRequest & { offset: number; limit: number }) => invoke<SourceHistory>("read_source_history", { request }),
  historyContent: (request: SessionRequest & { snapshotId: string; query: string; after: number; limit: number }) => invoke<ContentPage>("read_source_history_content", { request }),
  lineage: (request: SessionRequest & { snapshotId: string; ordinal: number }) => invoke<LineageEvidence[]>("read_source_lineage", { request }),
  estimate: (request: SourceAdoptRequest) => invoke<SourceImpactSummary[]>("estimate_source_update", { request }),
  impact: (request: SessionRequest & { snapshotId: string; locale: string; after: number; limit: number }) => invoke<SourceImpactPage>("read_source_impact", { request }),
  prepare: (request: SourceAdoptRequest) => invoke<AdoptionAction>("prepare_source_adoption", { request }),
};

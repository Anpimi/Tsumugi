import { invoke } from "@tauri-apps/api/core";
import type { AdoptionAction, SessionRequest } from "./executionCommands";

export interface SourceSelection { selectionId: string; folderName: string }
export interface IntegrationDescriptor { id: string; version: string; capabilityId: string; capabilityVersion: string; inputVersion: number; outputVersion: number; formatProfiles: string[]; requiredFiles: string[]; permissions: string[]; available: boolean; reason: string | null }
export interface Coverage { artifactId: string; logicalPath: string; role: string; sha256: string }
export interface Preflight { namespace: string; count: number; sourceLanguage: string; diagnostics: string[]; files: Coverage[] }
export interface ContentScope { revision: string; currentSnapshot: string | null }
export interface SourceConfirmation { resultDigest: string; identityPolicy: string; expectedContentRevision: string; sourceLanguage: string }
export interface SourceOccurrence { ordinal: number; artifactId: string; namespace: string; key: string; text: string; keyByteRange: [number, number]; valueByteRange: [number, number]; identityBasis: string }
export interface ContentRow { occurrenceId: string | null; unitId: string | null; sourceRevisionId: string | null; occurrence: SourceOccurrence }
export interface ContentPage { snapshotId: string | null; attemptId: string; resultId: string; scope: ContentScope; confirmation: SourceConfirmation; namespace: string; coverage: Coverage[]; total: number; nextOrdinal: number | null; diagnostics: string[]; rows: ContentRow[] }
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
  prepare: (request: SourceAdoptRequest) => invoke<AdoptionAction>("prepare_source_adoption", { request }),
};

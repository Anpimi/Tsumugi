import { invoke } from "@tauri-apps/api/core";
import type { AdoptionAction, SessionRequest } from "./executionCommands";
import type { SourceSelection } from "./sourceCommands";

export type TranslationMatch = "unique" | "unmatched" | "ambiguous" | "selected-conflict" | "source-changed" | "applied";
export type TranslationDecision = "candidate-only" | "select-if-empty" | "replace";
export interface TranslationEntry { ordinal: number; artifactId: string; nativeKey: string; text: string; keyByteRange: [number, number]; valueByteRange: [number, number] }
export interface TranslationSelection { eventId: string; unitId: string; locale: string; sequence: string; revisionId: string; actionId: string; previousEventId: string | null }
export interface TranslationPreviewRow { entry: TranslationEntry; itemId: string; resultId: string; resultDigest: string; unitId: string | null; occurrenceId: string | null; sourceRevisionId: string | null; sourceText: string | null; currentSelection: TranslationSelection | null; currentText: string | null; status: TranslationMatch }
export interface TranslationPreview { attemptId: string; bundleId: string; fixedSourceSnapshotId: string; currentSourceSnapshotId: string; resultDigest: string; fileDigest: string; logicalPath: string; declaredLocale: string; targetLocale: string; basis: string; total: number; unique: number; unmatched: number; ambiguous: number; selectedConflicts: number; sourceChanged: number; applied: number; nextOrdinal: number | null; rows: TranslationPreviewRow[] }
export interface TranslationPreflight { fileName: string; fileDigest: string; declaredLocale: string; targetLocale: string; count: number; sourceSnapshotId: string }
export interface TranslationRevision { revisionId: string; unitId: string; locale: string; ordinal: string; text: string; sourceSnapshotId: string; sourceRevisionId: string; originKind: "import" | "manual" | "ai"; contributors?: string[]; actionId: string; attemptId: string | null; resultId: string | null; itemId: string | null; artifactId: string | null; logicalPath: string | null; declaredLocale: string | null; nativeKey: string | null; fileDigest: string | null }
export interface TranslationHistory { unitId: string; locale: string; total: string; current: TranslationSelection | null; currentText: string | null; rows: TranslationRevision[]; nextOrdinal: string | null }
export interface TranslationConfirmation { resultDigest: string; sourceSnapshotId: string; occurrenceId: string; sourceRevisionId: string; targetUnitId: string; expectedSelectionId: string | null; decision: TranslationDecision }
export interface TranslationStartRequest extends SessionRequest { selectionId: string; fileName: string; targetLocale: string; languageConfirmed: boolean; expectedFileDigest: string; expectedSourceSnapshotId: string; attemptId: string }
export interface TranslationAdoptRequest extends SessionRequest { attemptId: string; itemId: string; resultId: string; actionId: string; confirmation: TranslationConfirmation }
export interface TranslationSaveRequest extends SessionRequest { actionId: string; unitId: string; locale: string; sourceRevisionId: string; expectedSelectionId: string | null; text: string }
export interface TranslationEditBasis { sourceSnapshotId: string; sourceRevisionId: string; selectionId: string }
export interface TranslationSaveReceipt { projectId: string; actionId: string; basis: TranslationEditBasis; selection: TranslationSelection; revision: TranslationRevision }
export function translationHistoryAfter(ordinal: string, pageSize: number): string {
  const after = BigInt(ordinal) - BigInt(pageSize);
  return (after > 0n ? after : 0n).toString();
}
export interface TranslationSelectRequest extends SessionRequest { actionId: string; unitId: string; locale: string; sourceRevisionId: string; expectedSelectionId: string | null; revisionId: string }

export const translationCommands = {
  selectFolder: (request: SessionRequest) => invoke<SourceSelection | null>("select_source", { request }),
  files: (request: SessionRequest & { selectionId: string }) => invoke<string[]>("list_translation_files", { request }),
  preflight: (request: SessionRequest & { selectionId: string; fileName: string; targetLocale: string }) => invoke<TranslationPreflight>("preflight_translation", { request }),
  start: (request: TranslationStartRequest) => invoke<string>("start_translation_import", { request }),
  preview: (request: SessionRequest & { attemptId: string; after: number; limit: number; basis: string | null }) => invoke<TranslationPreview>("read_translation_preview", { request }),
  prepare: (request: TranslationAdoptRequest) => invoke<AdoptionAction>("prepare_translation_adoption", { request }),
  history: (request: SessionRequest & { unitId: string; locale: string; afterOrdinal: string; limit: number }) => invoke<TranslationHistory>("read_translation_history", { request }),
  action: (request: SessionRequest & { unitId: string; locale: string; actionId: string }) => invoke<TranslationSelection | null>("read_translation_action", { request }),
  save: async (request: TranslationSaveRequest) => validateSaveReceipt(await invoke<unknown>("save_translation_revision", { request }), request),
  select: (request: TranslationSelectRequest) => invoke<TranslationSelection>("select_translation_revision", { request }),
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identity(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function positiveInteger(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
function invalidSaveReceipt() {
  return Object.assign(new Error("Invalid save receipt"), { outcome: "unknown", reason: "invalid-save-receipt" });
}

/** Malformed or misattributed responses do not confirm a mutation. */
export function validateSaveReceipt(value: unknown, request: TranslationSaveRequest): TranslationSaveReceipt {
  if (!record(value) || !record(value.basis) || !record(value.selection) || !record(value.revision)) throw invalidSaveReceipt();
  const { basis, selection, revision } = value;
  if (value.projectId !== request.projectId || value.actionId !== request.actionId
    || selection.actionId !== request.actionId || revision.actionId !== request.actionId
    || selection.unitId !== request.unitId || revision.unitId !== request.unitId
    || selection.locale !== request.locale || revision.locale !== request.locale
    || !identity(selection.eventId) || !identity(selection.revisionId)
    || selection.previousEventId !== request.expectedSelectionId
    || !positiveInteger(selection.sequence) || !positiveInteger(revision.ordinal)
    || (selection.sequence === "1") !== (selection.previousEventId === null)
    || revision.revisionId !== selection.revisionId || revision.originKind !== "manual"
    || revision.text !== request.text || revision.sourceRevisionId !== request.sourceRevisionId
    || !identity(revision.sourceSnapshotId) || basis.sourceSnapshotId !== revision.sourceSnapshotId
    || basis.sourceRevisionId !== revision.sourceRevisionId || basis.selectionId !== selection.eventId
    || ![revision.attemptId, revision.resultId, revision.itemId, revision.artifactId,
      revision.logicalPath, revision.declaredLocale, revision.nativeKey, revision.fileDigest].every(field => field === null)
    || !Array.isArray(revision.contributors) || revision.contributors.length !== 0) throw invalidSaveReceipt();
  return value as unknown as TranslationSaveReceipt;
}

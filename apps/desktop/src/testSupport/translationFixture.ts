import translation from "../../test/fixtures/translation-commands.json";
import execution from "../../test/fixtures/executionCommands.contract.json";
import type { AdoptionAction, AttemptDetail, Receipt } from "../executionCommands";
import type { TranslationAdoptRequest, TranslationPreview, TranslationPreviewRow } from "../translationCommands";
import { validateResponsePreview } from "../generated/translation.validators";
import { translationSelection, translationCapture, translationCheck, translationProjection } from "./pluginTranslationFixture";
import { translationRequest } from "../translationCommands";
import type { TranslationImportChoice } from "../TranslationImportSession";
import { fixtureIdentity } from "./executionFixture";

/** Complete synthetic wire objects; execution units deliberately differ from source units. */
export function translationRowFixture(ordinal = 0, overrides: Partial<TranslationPreviewRow> = {}): TranslationPreviewRow {
  if (!validateResponsePreview(translation.preview)) throw new Error("Invalid canonical translation preview");
  const row = translation.preview.rows[0];
  return { ...row, entry: { ...row.entry, ordinal, nativeKey: `key-${ordinal}`, text: `Translation ${ordinal}`,
    keyByteRange: row.entry.keyByteRange ? [row.entry.keyByteRange[0], row.entry.keyByteRange[1]] : null, valueByteRange: [row.entry.valueByteRange[0], row.entry.valueByteRange[1]] },
    itemId: fixtureIdentity(1000 + ordinal), resultId: fixtureIdentity(2000 + ordinal), unitId: fixtureIdentity(3000 + ordinal),
    status: "unique", currentSelection: null, currentText: null, ...overrides };
}
export function translationPreviewFixture(rows = [translationRowFixture()], overrides: Partial<TranslationPreview> = {}): TranslationPreview {
  const count = (status: TranslationPreviewRow["status"]) => rows.filter(row => row.status === status).length;
  return { ...translation.preview, rows, total: rows.length, unique: count("unique"), unmatched: count("unmatched"),
    ambiguous: count("ambiguous"), selectedConflicts: count("selected-conflict"), sourceChanged: count("source-changed"), applied: count("applied"),
    nextOrdinal: null, ...overrides };
}
export function translationRecoveryUnit(row: TranslationPreviewRow) { return fixtureIdentity(4000 + row.entry.ordinal); }
export function translationAttemptFixture(preview: TranslationPreview, rows = preview.rows, nextOffset: number | null = null): AttemptDetail {
  const scope = (row: TranslationPreviewRow) => ({ kind: "translation-entry", id: `${preview.bundleId}:${row.entry.ordinal}`, locale: preview.targetLocale });
  return { ...execution.detail, attemptId: preview.attemptId, operation: "translation-import", nextOffset,
    progress: { ...execution.detail.progress, total: preview.total, succeeded: preview.total, unknown: 0 },
    items: rows.map(row => ({ resultId: row.resultId, scope: scope(row), status: { ...execution.detail.items[0].status,
      itemId: row.itemId, execution: "succeeded", validation: "valid", adoption: "unapplied", cancellationRequested: false, diagnostic: null } })),
    recovery: { attemptId: preview.attemptId, units: rows.map(row => ({ ...execution.detail.recovery.units[0], unitId: translationRecoveryUnit(row),
      itemIds: [row.itemId], remainingItemIds: [], resultIds: [row.resultId], scopes: [scope(row)], receiptId: null,
      actions: ["adopt-result"], blockedReason: null })) } };
}
export function translationActionFixture(request: TranslationAdoptRequest, recoveryUnitId: string): AdoptionAction {
  return { ...execution.action, projectId: request.projectId, attemptId: request.attemptId, actionId: request.actionId,
    unitId: recoveryUnitId, operation: "translation-import", resultIds: [request.resultId],
    parameters: { ...request.confirmation, expectedSelectionId: request.confirmation.expectedSelectionId ?? null } };
}
export function translationReceiptFixture(request: TranslationAdoptRequest, recoveryUnitId: string, previousSelectionSequence: string | null = null): Receipt {
  return { ...execution.receipt, projectId: request.projectId, attemptId: request.attemptId, actionId: request.actionId, unitId: recoveryUnitId,
    requestDigest: "a".repeat(64), changes: [{ kind: "translation-revision", id: fixtureIdentity(5000), revision: "7" },
      ...(request.confirmation.decision === "candidate-only" ? [] : [{ kind: "translation-selection", id: fixtureIdentity(6000),
        revision: (BigInt(previousSelectionSequence ?? "0") + 1n).toString() }])] };
}

const selectedTranslationFolder = (() => {
  const selected = translationSelection;
  if (selected === null) throw new Error("Expected the canonical selected translation folder");
  return selected;
})();

/** Current Plugin capture fixtures keep the immutable context separate from the UI projection. */
export function translationImportChoice(snapshotId = selectedTranslationFolder.source.sourceSnapshotId, targetLocale = selectedTranslationFolder.targetLocale): TranslationImportChoice {
  return { translation: translationRequest(translationCapture.translation), source: { ...selectedTranslationFolder.source, sourceSnapshotId: snapshotId }, nativeScope: selectedTranslationFolder.nativeScope };
}
export function translationSelectionFixture(snapshotId: string, targetLocale = "zh-CN") {
  return { ...selectedTranslationFolder, source: { ...selectedTranslationFolder.source, sourceSnapshotId: snapshotId }, targetLocale };
}
export function translationCaptureFixture(attemptId: string, snapshotId: string, targetLocale = "zh-CN", fileName = "zh.json") {
  return { ...translationCapture, attemptId, source: { ...translationCapture.source, sourceSnapshotId: snapshotId }, targetLocale,
    file: { ...translationCapture.file, logicalPath: `${translationCapture.translation.declaration.material.logicalDirectory}/${fileName}` } };
}
export function translationCheckerFixture(attemptId: string, producerAttemptId: string, resultId: string, snapshotId: string) {
  return { ...translationCheck, attemptId, translationAttemptId: producerAttemptId, translationResultId: resultId, source: { ...translationCheck.source, sourceSnapshotId: snapshotId } };
}
export function translationProjectionFixture(attemptId: string, producerAttemptId: string, resultId: string, snapshotId: string) {
  return { ...translationProjection, attemptId, translationAttemptId: producerAttemptId, translationResultId: resultId, source: { ...translationProjection.source, sourceSnapshotId: snapshotId } };
}
export function translationStageAttempt(attemptId: string, operation: "translation-extract" | "translation-semantic-check", validation: "valid" | "pending" = "pending"): AttemptDetail {
  return { ...execution.detail, attemptId, operation, nextOffset: null,
    progress: { ...execution.detail.progress, total: 1, succeeded: 1, queued: 0, running: 0, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
    items: [{ ...execution.detail.items[0], resultId: fixtureIdentity(800), scope: { kind: "translation-file", id: "i18n/zh.json", locale: "zh-CN" },
      status: { ...execution.detail.items[0].status, execution: "succeeded", validation, cancellationRequested: false, adoption: "unapplied", diagnostic: null } }],
    recovery: { attemptId, units: [] } };
}

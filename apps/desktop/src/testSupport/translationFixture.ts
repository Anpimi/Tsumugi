import translation from "../../test/fixtures/translation-commands.json";
import execution from "../../test/fixtures/executionCommands.contract.json";
import type { AdoptionAction, AttemptDetail, Receipt } from "../executionCommands";
import type { TranslationAdoptRequest, TranslationPreview, TranslationPreviewRow } from "../translationCommands";
import { fixtureIdentity } from "./executionFixture";

/** Complete synthetic wire objects; execution units deliberately differ from source units. */
export function translationRowFixture(ordinal = 0, overrides: Partial<TranslationPreviewRow> = {}): TranslationPreviewRow {
  const row = translation.preview.rows[0];
  return { ...row, entry: { ...row.entry, ordinal, nativeKey: `key-${ordinal}`, text: `Translation ${ordinal}`,
    keyByteRange: [row.entry.keyByteRange[0], row.entry.keyByteRange[1]], valueByteRange: [row.entry.valueByteRange[0], row.entry.valueByteRange[1]] },
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

import fixture from "../../test/fixtures/sourceCommands.contract.json";
import executionFixture from "../../test/fixtures/executionCommands.contract.json";
import type { ContentPage, ContentRow, ContentScope, IntegrationDescriptor, SourceAdoptRequest, SourceOccurrence, SourceHistory, SourceImpactPage, SourceImpactRow } from "../sourceCommands";
import type { AdoptionAction, AttemptDetail, Receipt } from "../executionCommands";
import { fixtureIdentity } from "./executionFixture";

/** Complete synthetic wire data shared with Rust; override identities explicitly. */
function sourceOccurrenceFixture(occurrence: typeof fixture.page.rows[0]["occurrence"]): SourceOccurrence {
  return { ...occurrence, keyByteRange: [occurrence.keyByteRange[0], occurrence.keyByteRange[1]],
    valueByteRange: [occurrence.valueByteRange[0], occurrence.valueByteRange[1]] };
}
export function sourceRowFixture(row: Partial<ContentRow> = {}, occurrence: Partial<SourceOccurrence> = {}): ContentRow {
  const base = fixture.page.rows[0];
  return { ...base, ...row, occurrence: { ...sourceOccurrenceFixture(base.occurrence),
    ...occurrence } };
}

export function sourcePageFixture(overrides: Partial<ContentPage> = {}): ContentPage {
  return { ...fixture.page, rows: [sourceRowFixture()], ...overrides };
}

export const sourceIntegrationFixture: IntegrationDescriptor = fixture.integration;
export const captionIntegrationFixture: IntegrationDescriptor = { ...fixture.integration,
  id: "webvtt", capabilityId: "webvtt.extract", formatProfiles: ["webvtt-captions"],
  requiredFiles: ["source.vtt"], permissions: ["captured-input-only"] };

export function sourceContentFixture(snapshotId = fixture.content.snapshotId, scope: ContentScope = { revision: fixture.page.scope.revision, currentSnapshot: snapshotId }): ContentPage {
  return sourcePageFixture({ snapshotId, scope, confirmation: { ...fixture.page.confirmation,
    expectedContentRevision: scope.revision, expectedCurrentSnapshot: scope.currentSnapshot }, rows: [sourceRowFixture({
      occurrenceId: fixtureIdentity(8), unitId: fixtureIdentity(9), sourceRevisionId: fixtureIdentity(10) })] });
}
export function sourceHistoryFixture(overrides: Partial<SourceHistory> = {}): SourceHistory { return { ...fixture.history, ...overrides }; }
export function sourceImpactFixture(overrides: Partial<SourceImpactPage> = {}): SourceImpactPage {
  return { ...fixture.impact, rows: fixture.impact.rows.map<SourceImpactRow>(row => ({ ...row, status: "unresolved",
    current: { ...row.current, occurrence: sourceOccurrenceFixture(row.current.occurrence) },
    lineage: row.lineage.map(evidence => ({ ...evidence, old: { ...evidence.old, occurrence: sourceOccurrenceFixture(evidence.old.occurrence) } })) })), ...overrides };
}

export function sourceAttemptFixture(attemptId = fixture.start.attemptId, resultId = fixture.preview.resultId): AttemptDetail {
  const item = executionFixture.detail.items[0], unit = executionFixture.detail.recovery.units[0];
  const scope = { kind: "source", id: fixtureIdentity(301), locale: null };
  return { ...executionFixture.detail, attemptId, operation: "source-import",
    progress: { ...executionFixture.detail.progress, succeeded: 1, unknown: 0 },
    items: [{ ...item, scope, resultId, status: { ...item.status, execution: "succeeded", validation: "valid", adoption: "unapplied", cancellationRequested: false, diagnostic: null } }],
    recovery: { attemptId, units: [{ ...unit, scopes: [scope], resultIds: [resultId], actions: ["adopt-result"], blockedReason: null }] } };
}

/** Source preparation returns the normalized confirmation for its frozen adoption unit. */
export function sourceActionFixture(request: SourceAdoptRequest = fixture.prepare, unitId = executionFixture.prepare.unitId): AdoptionAction {
  return { ...executionFixture.action, projectId: request.projectId, attemptId: request.attemptId, actionId: request.actionId,
    unitId, operation: "source-import", resultIds: [request.resultId], parameters: structuredClone({ ...request.confirmation,
      expectedCurrentSnapshot: request.confirmation.expectedCurrentSnapshot ?? null,
      lineageBaseSnapshot: request.confirmation.lineageBaseSnapshot ?? null, lineage: request.confirmation.lineage ?? [], actor: request.confirmation.actor ?? null }) };
}

export function sourceReceiptFixture(request: SourceAdoptRequest = fixture.prepare, unitId = executionFixture.prepare.unitId, snapshotId = fixtureIdentity(100)): Receipt {
  return { ...executionFixture.receipt, projectId: request.projectId, attemptId: request.attemptId, actionId: request.actionId, unitId,
    changes: [{ kind: "source-snapshot", id: snapshotId, revision: (BigInt(request.confirmation.expectedContentRevision) + 1n).toString() }] };
}

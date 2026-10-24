import fixture from "../../test/fixtures/sourceCommands.contract.json";
import executionFixture from "../../test/fixtures/executionCommands.contract.json";
import type { ContentPage, ContentRow, ContentScope, SourceAdoptRequest, SourceOccurrence, SourceHistory, SourceImpactPage, SourceImpactRow } from "../sourceCommands";
import type { AdoptionAction, AttemptDetail, Receipt } from "../executionCommands";
import { fixtureIdentity } from "./executionFixture";
import { validateResponsePage, validateResponseHistory, validateResponseImpact } from "../generated/source.validators";

function contractPage(): ContentPage {
  if (!validateResponsePage(fixture.page)) throw new Error("Invalid canonical source page");
  return structuredClone(fixture.page);
}

/** Complete synthetic wire data shared with Rust; override identities explicitly. */
function sourceOccurrenceFixture(occurrence: SourceOccurrence): SourceOccurrence { return structuredClone(occurrence); }

export function sourceRowFixture(row: Partial<ContentRow> = {}, occurrence: Partial<SourceOccurrence> = {}): ContentRow {
  const base = contractPage().rows[0];
  const source = occurrence.source ?? { ...base.occurrence.source, artifactId: occurrence.artifactId ?? base.occurrence.source.artifactId };
  const nativeIdentity = occurrence.nativeIdentity === undefined && base.occurrence.nativeIdentity
    ? { ...base.occurrence.nativeIdentity, display: { ...base.occurrence.nativeIdentity.display,
      value: occurrence.key ?? base.occurrence.nativeIdentity.display.value,
      source: base.occurrence.nativeIdentity.display.source ? { ...base.occurrence.nativeIdentity.display.source, artifactId: occurrence.artifactId ?? base.occurrence.nativeIdentity.display.source.artifactId } : null } }
    : occurrence.nativeIdentity === undefined ? base.occurrence.nativeIdentity : occurrence.nativeIdentity;
  return { ...base, ...row, occurrence: { ...base.occurrence, ...occurrence, source, nativeIdentity } };
}

export function sourcePageFixture(overrides: Partial<ContentPage> = {}): ContentPage {
  return { ...contractPage(), rows: [sourceRowFixture()], ...overrides };
}


export function sourceContentFixture(snapshotId = fixture.content.snapshotId, scope: ContentScope = { revision: fixture.page.scope.revision, currentSnapshot: snapshotId }): ContentPage {
  return sourcePageFixture({ snapshotId, scope, confirmation: { ...fixture.page.confirmation,
    expectedContentRevision: scope.revision, expectedCurrentSnapshot: scope.currentSnapshot }, rows: [sourceRowFixture({
      occurrenceId: fixtureIdentity(8), unitId: fixtureIdentity(9), sourceRevisionId: fixtureIdentity(10) })] });
}
export function sourceHistoryFixture(overrides: Partial<SourceHistory> = {}): SourceHistory {
  if (!validateResponseHistory(fixture.history)) throw new Error("Invalid canonical source history");
  return { ...structuredClone(fixture.history), ...overrides };
}
export function sourceImpactFixture(overrides: Partial<SourceImpactPage> = {}): SourceImpactPage {
  if (!validateResponseImpact(fixture.impact)) throw new Error("Invalid canonical source impact");
  const impact: SourceImpactPage = structuredClone(fixture.impact);
  return { ...impact, rows: impact.rows.map<SourceImpactRow>(row => ({ ...row, status: "unresolved",
    current: { ...row.current, occurrence: sourceOccurrenceFixture(row.current.occurrence) },
    lineage: row.lineage.map(evidence => ({ ...evidence, old: { ...evidence.old, occurrence: sourceOccurrenceFixture(evidence.old.occurrence) } })) })), ...overrides };
}

export function sourceAttemptFixture(attemptId = fixture.preview.attemptId, resultId = fixture.preview.resultId): AttemptDetail {
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

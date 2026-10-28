import { expect, it, vi } from "vitest";
import type { DecisionAction, DecisionItem } from "../../../generated/decisions.responses";
import { validateResponseAttempt } from "../../../generated/execution.validators";
import { validateResponsePreview } from "../../../generated/resource.validators";
import { validateResponsePage } from "../../../generated/source.validators";
import { validateResponseEligibility } from "../../../generated/review.validators";
import type { DeliveryRecordView } from "../../../generated/release.responses";
import executionFixture from "../../../../test/fixtures/executionCommands.contract.json";
import resourceFixture from "../../../../test/fixtures/resourceCommands.contract.json";
import sourceFixture from "../../../../test/fixtures/sourceCommands.contract.json";
import reviewFixture from "../../../../test/fixtures/reviewCommands.contract.json";
import { decisionTargetKey, readDecisionTarget, type DecisionTargetReadPorts } from "./decisionTargetReads";

const context = executionFixture.session;
function item<A extends DecisionAction>(action: A): Omit<DecisionItem, "action"> & { action: A } {
  return { decisionId: "synthetic-decision", basis: "original-observation", source: "execution-unknown", state: "awaiting-recheck",
    action, locale: "zh-CN", targets: [{ kind: "project" }], targetsComplete: true, sourceActionId: null, evidence: null };
}
function resourcePreview() {
  const value: unknown = structuredClone(resourceFixture.responses.preview);
  if (!validateResponsePreview(value)) throw new Error("Invalid resource fixture");
  return value;
}
function sourcePage() {
  const value: unknown = structuredClone(sourceFixture.page);
  if (!validateResponsePage(value)) throw new Error("Invalid source fixture");
  return value;
}
function attempt() {
  const value: unknown = structuredClone(executionFixture.detail);
  if (!validateResponseAttempt(value)) throw new Error("Invalid execution fixture");
  return value;
}
const unexpected = async (): Promise<never> => { throw new Error("Unexpected read"); };
function ports(overrides: Partial<DecisionTargetReadPorts> = {}): DecisionTargetReadPorts {
  return { preview: unexpected, historyContent: unexpected, lineage: unexpected, attempt: unexpected,
    output: unexpected, eligibility: unexpected, deliveryRecord: unexpected, ...overrides };
}

it("keys the original full action, language and observation separately", () => {
  const first = item({ kind: "review-resource", captureId: "capture", entryId: "first" });
  expect(decisionTargetKey(first)).toContainEqual(first.action);
  expect(decisionTargetKey(first)).not.toEqual(decisionTargetKey({ ...first, locale: "fr-FR" }));
  expect(decisionTargetKey(first)).not.toEqual(decisionTargetKey({ ...first, basis: "new-observation" }));
  expect(decisionTargetKey(first)).not.toEqual(decisionTargetKey({ ...first, action: { ...first.action, entryId: "second" } }));
});

it("reads the exact removed term rather than the first proposal", async () => {
  const preview = resourcePreview(), removed = preview.removed[0];
  if (!removed?.externalEntryId) throw new Error("Missing removed fixture");
  const target = item({ kind: "review-resource", captureId: preview.capture.captureId, entryId: removed.externalEntryId });
  const read = vi.fn(async () => preview);
  const value = await readDecisionTarget(context, target, () => true, ports({ preview: read }));
  expect(read).toHaveBeenCalledWith({ ...context, captureId: preview.capture.captureId });
  expect(value).toMatchObject({ kind: "resource", proposal: { kind: "removed", term: { source: removed.source } } });
  await expect(readDecisionTarget(context, { ...target, action: { ...target.action, captureId: "other-capture" } }, () => true, ports({ preview: read })))
    .rejects.toMatchObject({ reason: "mismatch" });
});

it("discards a late original-record response after the target or project is no longer current", async () => {
  const preview = resourcePreview();
  const target = item({ kind: "review-resource", captureId: preview.capture.captureId, entryId: preview.rows[0]?.entry.id ?? "missing" });
  let current = true, finish: ((value: ReturnType<typeof resourcePreview>) => void) | undefined;
  const waiting = readDecisionTarget(context, target, () => current, ports({ preview: () => new Promise(resolve => { finish = resolve; }) }));
  current = false;
  if (!finish) throw new Error("Read did not start");
  finish(preview);
  await expect(waiting).rejects.toMatchObject({ reason: "changed" });
});

it("checks the exact occurrence before requesting its lineage", async () => {
  const page = sourcePage(), row = page.rows[0];
  if (!row) throw new Error("Missing source fixture");
  page.snapshotId = "snapshot"; row.occurrenceId = "occurrence";
  const target = item({ kind: "resolve-source-mapping", snapshotId: "snapshot", occurrenceId: "occurrence", ordinal: row.occurrence.ordinal });
  const historyContent = vi.fn(async () => page), lineage = vi.fn(async () => []);
  const value = await readDecisionTarget(context, target, () => true, ports({ historyContent, lineage }));
  expect(historyContent).toHaveBeenCalledWith({ ...context, snapshotId: "snapshot", query: "", after: row.occurrence.ordinal, limit: 1 });
  expect(lineage).toHaveBeenCalledWith({ ...context, snapshotId: "snapshot", ordinal: row.occurrence.ordinal });
  expect(value).toMatchObject({ kind: "mapping", row: { occurrenceId: "occurrence" } });
  lineage.mockClear(); row.occurrenceId = "another-occurrence";
  await expect(readDecisionTarget(context, target, () => true, ports({ historyContent, lineage }))).rejects.toMatchObject({ reason: "mismatch" });
  expect(lineage).not.toHaveBeenCalled();
});

it("follows bounded execution pages to the requested item and binds its saved output", async () => {
  const detail = attempt(), original = detail.items[0];
  if (!original) throw new Error("Missing item fixture");
  const targetId = original.status.itemId, wanted = { ...original, resultId: executionFixture.output.resultId };
  const first = { ...detail, progress: { ...detail.progress, total: 101, unknown: 101 }, nextOffset: 100,
    items: Array.from({ length: 100 }, (_, index) => ({ ...original, status: { ...original.status, itemId: `other-${index}` } })) };
  const last = { ...detail, progress: first.progress, items: [wanted] };
  const readAttempt = vi.fn<DecisionTargetReadPorts["attempt"]>().mockResolvedValueOnce(first).mockResolvedValueOnce(last);
  const output = vi.fn<DecisionTargetReadPorts["output"]>().mockResolvedValue({ ...executionFixture.output, outcome: "unknown" });
  const value = await readDecisionTarget(context, item({ kind: "inspect-execution", taskId: detail.taskId, attemptId: detail.attemptId, itemId: targetId }),
    () => true, ports({ attempt: readAttempt, output }));
  expect(readAttempt.mock.calls.map(([request]) => request.offset)).toEqual([0, 100]);
  expect(output).toHaveBeenCalledWith({ ...context, attemptId: detail.attemptId, resultId: wanted.resultId });
  expect(value).toMatchObject({ kind: "execution", item: { status: { itemId: targetId } }, output: { itemId: targetId } });
});

it("rejects a mismatched task and a repeated execution cursor without continuing", async () => {
  const detail = attempt();
  const target = item({ kind: "inspect-execution", taskId: "other-task", attemptId: detail.attemptId, itemId: "not-found" });
  const read = vi.fn(async () => detail);
  await expect(readDecisionTarget(context, target, () => true, ports({ attempt: read }))).rejects.toMatchObject({ reason: "mismatch" });
  const invalid = { ...detail, progress: { ...detail.progress, total: 2, unknown: 2 }, nextOffset: 0 };
  await expect(readDecisionTarget(context, { ...target, action: { ...target.action, taskId: detail.taskId } }, () => true,
    ports({ attempt: async () => invalid }))).rejects.toMatchObject({ reason: "mismatch" });
});

it("retains a missing delivery record and rejects another action's record", async () => {
  const target = item({ kind: "inspect-delivery-outcome", releaseId: "release", deliveryId: "delivery", actionId: "action" });
  const read = vi.fn<DecisionTargetReadPorts["deliveryRecord"]>().mockResolvedValueOnce(null);
  expect(await readDecisionTarget(context, target, () => true, ports({ deliveryRecord: read }))).toEqual({ kind: "delivery-outcome", record: null });
  expect(read).toHaveBeenCalledWith({ ...context, releaseId: "release", deliveryId: "delivery", actionId: "action" });
  const wrong: DeliveryRecordView = { releaseId: "release", deliveryId: "delivery", actionId: "other-action", state: "unknown", files: [], createdAt: "2026-01-01T00:00:00Z" };
  await expect(readDecisionTarget(context, target, () => true, ports({ deliveryRecord: async () => wrong }))).rejects.toMatchObject({ reason: "mismatch" });
});

it("reads only the requested delivery language and preserves the true blocker total", async () => {
  const eligibility: unknown = structuredClone(reviewFixture.responses.eligibility);
  if (!validateResponseEligibility(eligibility)) throw new Error("Invalid eligibility fixture");
  const locale = eligibility.locales[0];
  if (!locale) throw new Error("Missing language fixture");
  eligibility.locales = [locale]; locale.blockerCount = 120; locale.ready = false;
  const read = vi.fn(async () => eligibility);
  const target = { ...item({ kind: "inspect-delivery", locale: locale.locale }), locale: locale.locale };
  const value = await readDecisionTarget(context, target, () => true, ports({ eligibility: read }));
  expect(read).toHaveBeenCalledWith({ ...context, locales: [locale.locale] });
  expect(value).toMatchObject({ kind: "delivery", locale: { blockerCount: 120, blockers: locale.blockers } });
});

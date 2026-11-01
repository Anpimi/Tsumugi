import { expect, it, vi } from "vitest";
import resourceWire from "../../../../test/fixtures/resourceCommands.contract.json";
import executionWire from "../../../../test/fixtures/executionCommands.contract.json";
import { validateResponsePreview } from "../../../generated/resource.validators";
import { validateResponseAttempt } from "../../../generated/execution.validators";
import type { DecisionItem } from "../../../decisionCommands";
import { DecisionNavigationChanged, resolveDecisionNavigation, type DecisionNavigationPorts } from "./decisionNavigation";
import { readDecisionTarget, type DecisionTargetReadPorts } from "./decisionTargetReads";
import { executionRecoveryDestination } from "./executionRecoveryNavigation";

const context = executionWire.session;
function ports(targetPorts: Partial<DecisionTargetReadPorts>): DecisionNavigationPorts {
  const unexpected = vi.fn(async (): Promise<never> => { throw new Error("Unexpected decision command"); });
  return { revision: unexpected, target: unexpected, findings: unexpected, draft: unexpected, conversationDraft: unexpected,
    resourceDraft: unexpected, sourceDraft: unexpected, strategyDraft: unexpected, proposal: unexpected, knowledgeDecision: unexpected,
    teamQuestion: unexpected, proposalWorkPlan: unexpected, sourceTarget: (ctx, item, current) => readDecisionTarget(ctx, item, current,
      { preview: unexpected, historyContent: unexpected, lineage: unexpected, compare: unexpected, attempt: unexpected, output: unexpected,
        eligibility: unexpected, deliveryRecord: unexpected, proposal: unexpected, knowledgeDecision: unexpected, teamQuestion: unexpected, ...targetPorts }) };
}
function item(action: DecisionItem["action"], targets: DecisionItem["targets"]): DecisionItem {
  return { decisionId: "original-record", source: action.kind === "review-resource" ? "resource-proposal" : "execution-unknown",
    state: "pending", basis: "b".repeat(64), targets, targetsComplete: true, locale: "zh-CN", action, sourceActionId: null, evidence: null };
}

it("locates the exact resource entry without listing captures or writing a decision", async () => {
  const raw: unknown = structuredClone(resourceWire.responses.preview);
  if (!validateResponsePreview(raw)) throw new Error("Expected resource comparison");
  const removed = raw.removed[0];
  if (!removed?.externalEntryId) throw new Error("Expected removed term");
  const action = { kind: "review-resource" as const, captureId: raw.capture.captureId, entryId: removed.externalEntryId };
  const row = item(action, [{ kind: "resource", captureId: action.captureId, entryId: action.entryId }]);
  const preview = vi.fn(async () => raw);
  expect(await resolveDecisionNavigation(context, row, () => true, ports({ preview }))).toEqual({ kind: "resource-proposal", capture: raw.capture, entryId: action.entryId });
  expect(preview).toHaveBeenCalledWith({ ...context, captureId: action.captureId });
  await expect(resolveDecisionNavigation(context, { ...row, targets: [{ kind: "resource", captureId: "other", entryId: action.entryId }] }, () => true, ports({ preview })))
    .rejects.toBeInstanceOf(DecisionNavigationChanged);
  await expect(resolveDecisionNavigation(context, { ...row, action: { ...action, entryId: "missing" }, targets: [{ kind: "resource", captureId: action.captureId, entryId: "missing" }] }, () => true, ports({ preview })))
    .rejects.toMatchObject({ reason: "missing" });
  let current = true;
  await expect(resolveDecisionNavigation(context, row, () => current, ports({ preview: async () => { current = false; return raw; } })))
    .rejects.toMatchObject({ reason: "changed" });
});

it("verifies the original task, attempt and item before offering an execution owner", async () => {
  const raw: unknown = structuredClone(executionWire.detail);
  if (!validateResponseAttempt(raw) || !raw.items[0]) throw new Error("Expected execution detail");
  const original = raw.items[0]; original.resultId = null;
  const action = { kind: "inspect-execution" as const, taskId: raw.taskId, attemptId: raw.attemptId, itemId: original.status.itemId };
  const row = item(action, [{ kind: "project" }]);
  const attempt = vi.fn(async () => raw);
  expect(await resolveDecisionNavigation(context, row, () => true, ports({ attempt }))).toEqual({ kind: "execution", taskId: action.taskId,
    attemptId: action.attemptId, itemId: action.itemId, operation: raw.operation });
  await expect(resolveDecisionNavigation(context, { ...row, action: { ...action, taskId: "wrong-task" } }, () => true, ports({ attempt }))).rejects.toMatchObject({ reason: "mismatch" });
  let current = true;
  await expect(resolveDecisionNavigation(context, row, () => current, ports({ attempt: async () => { current = false; return raw; } }))).rejects.toMatchObject({ reason: "changed" });
});

it("does not infer a recovery owner from an operation, plan label or another attempt", () => {
  const target = { taskId: "original-task", attemptId: "original-attempt", itemId: "original-item", operation: "source-import" };
  const owners = { source: ["another-attempt"], delivery: [target.attemptId], review: [target.attemptId] };
  expect(executionRecoveryDestination(target, owners)).toBeNull();
  expect(executionRecoveryDestination(target, { ...owners, source: [target.attemptId] })).toBe("source");
  expect(executionRecoveryDestination({ ...target, operation: "locale-build" }, owners)).toBe("delivery");
  expect(executionRecoveryDestination({ ...target, operation: "ai-semantic-review" }, owners)).toBe("review");
  expect(executionRecoveryDestination({ ...target, operation: "translation" }, owners)).toBeNull();
});

import { teamStatusFixture, teamPostFixture } from "./teamDiscussionFixture";
import { fixtureIdentity } from "./executionFixture";
import * as validators from "../generated/ai.validators";
import type { WorkPlanStatusView, TeamExecutionView } from "../workPlanCommands";
import type { ValidationState } from "../generated/ai.responses";

/** Synthetic captures with genuinely different selected material per destination. */
export function teamExecutionStatusFixture(): WorkPlanStatusView {
  const status = teamStatusFixture(), preview = status.plan.preview!;
  const first = { memberId: fixtureIdentity(9300), roleVersionId: fixtureIdentity(9301), displayName: "Translator A", role: "Translate and revisit rejected candidates.",
    config: structuredClone(preview.config), unitIds: status.plan.scope.map(unit => unit.unitId), toolHandles: [], kinds: ["translation"] };
  const second = { ...structuredClone(first), memberId: fixtureIdentity(9302), roleVersionId: fixtureIdentity(9303), displayName: "Reviewer B", role: "Read original reasons and challenge incomplete evidence.",
    config: { ...structuredClone(preview.config), endpoint: "http://127.0.0.1:4001/v1/chat/completions", model: "synthetic-review-model", shareTerms: false, shareContext: false,
      contextStrategy: null, sourceContext: { ...preview.config.sourceContext, extracted: false, inferred: false, neighbors: false } }, kinds: ["review", "evidence"] };
  const value: unknown = { ...status, effects: [...status.effects, "dispatch-team-work", "send-team-message"], plan: { ...status.plan,
    options: { ...status.plan.options, teamExecution: { profile: "bounded-team-1", initialMemberId: first.memberId, initialUnitId: first.unitIds[0],
      members: [first, second], limits: { maxActivations: 12, maxConcurrency: 1, maxNoProgress: 3 } } },
    memberPreviews: [{ memberId: first.memberId, preview: structuredClone(preview) }, { memberId: second.memberId, preview: {
      ...structuredClone(preview), config: second.config, digest: "b".repeat(64), items: preview.items.map(item => ({ ...structuredClone(item), terms: [], context: null,
        sourceContext: { kind: "not-selected" }, projectContext: { kind: "not-selected" }, omissions: ["terms-not-shared", "context-not-shared"] })) } }],
  } };
  if (!validators.validateResponseWorkPlanStatus(value)) throw new Error("Invalid synthetic team status");
  return value;
}

export function teamExecutionViewFixture(validation: ValidationState = "valid"): TeamExecutionView {
  const status = teamExecutionStatusFixture(), policy = status.plan.options.teamExecution!, [first, second] = policy.members;
  const unit = status.plan.scope[0], target = { unitId: unit.unitId, locale: status.plan.locale, sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId };
  const receipt = { intentId: fixtureIdentity(9310), planId: status.plan.planId, memberId: second.memberId, roleVersionId: second.roleVersionId,
    taskId: fixtureIdentity(9311), attemptId: fixtureIdentity(9312), inputDigest: "c".repeat(64) };
  const post = teamPostFixture(), original = post.author;
  if (original.kind !== "member") throw new Error("Expected synthetic member author");
  const sender = { ...original.author, memberId: first.memberId, roleVersionId: first.roleVersionId,
    binding: { ...original.author.binding, lease: status.lease } };
  const messageId = fixtureIdentity(9313);
  const roles = policy.members.map(member => ({ planId: status.plan.planId, version: "1", generation: status.lease.generation, request: {
    memberId: member.memberId, roleVersionId: member.roleVersionId, expectedRoleVersionId: null, displayName: member.displayName, role: member.role }, config: member.config }));
  const value: unknown = { planId: status.plan.planId, effectiveVersion: { actionId: fixtureIdentity(9315), lease: status.lease, digest: status.plan.digest },
    roster: structuredClone(policy.members), retiredMemberIds: [], roleVersions: structuredClone(roles),
    messageLimits: { maxMessages: 256, maxBodyBytes: 8192, maxRequestMessages: 16, maxRequestBytes: 32768 },
    members: policy.members.map(member => ({ planId: status.plan.planId, version: "1", generation: status.lease.generation, request: {
      memberId: member.memberId, roleVersionId: member.roleVersionId, expectedRoleVersionId: null, displayName: member.displayName, role: member.role }, config: member.config })),
    works: [{ origin: { kind: "member" }, sequence: "1", receipt, target, author: sender, request: { intentId: receipt.intentId, recipientMemberId: second.memberId, target, kind: "review",
      instructions: "Read the complete original objection before deciding.", postIds: [post.publication.postId], causeMessageId: messageId }, execution: "succeeded", validation, candidateRevisionId: null,
      output: validation === "valid" ? { outcome: { kind: "review", reviewed: { kind: "post", postId: post.publication.postId }, postIds: [post.publication.postId], verdict: "revise" }, usage: null, requests: 1, usageIncomplete: true } : null }],
    messages: [{ messageId, sequence: "1", planId: status.plan.planId, sender: { kind: "member", author: sender }, recipientMemberId: second.memberId, recipientRoleVersionId: second.roleVersionId, target,
      body: "The earlier rejection remains unresolved. Read its original reason.", postIds: [post.publication.postId], causeMessageId: null }],
    consumptions: [{ messageId, taskId: receipt.taskId, providerRequestId: fixtureIdentity(9314) }],
    budget: { limit: 20, dispatched: 2, legacyHeld: 0, unresolved: 1, usageUnknown: 1, promptTokens: "17", completionTokens: "5" },
    stopReason: "needs-reconciliation", nextWorkAfter: null, nextMessageAfter: null };
  if (!validators.validateResponseWorkPlanTeamExecution(value)) throw new Error("Invalid synthetic team execution view");
  return value;
}

import { teamExecutionStatusFixture, teamExecutionViewFixture } from "./teamExecutionFixture";
import { teamPostFixture, teamContext } from "./teamDiscussionFixture";
import { fixtureIdentity } from "./executionFixture";
import * as validators from "../generated/ai.validators";
import type { WorkPlanTeamRecoveryPrepareRequest, WorkPlanTeamRecoveryAuthorizeRequest } from "../generated/ai.requests";
import type { WorkPlanTeamRecoveryPreviewView, WorkPlanTeamRecoveryStateView, TeamRecoveryReceipt } from "../generated/ai.responses";

export function teamRecoveryFixture() {
  const status = teamExecutionStatusFixture(), view = teamExecutionViewFixture();
  status.state = "paused"; status.lease = { ...status.lease, generation: "2" };
  const state: WorkPlanTeamRecoveryStateView = { state: { projectId: teamContext.projectId, planId: status.plan.planId, lease: status.lease,
    state: "paused", effectiveVersion: view.effectiveVersion, rootTaskId: fixtureIdentity(9600), expiresAtMs: (BigInt(status.expiresAt) * 1000n).toString(),
    budget: structuredClone(view.budget!), activations: 2, unconfirmedCompletions: 1, unresolvedWork: [] },
    runtime: { originalDeadlineAvailable: true, producersDrained: true }, hostCallbacksDrained: true };
  return { status, view, state };
}
/** Synthetic bridge capture; no provider, authorization ledger or native runtime. */
export function teamRecoveryPreviewFixture(request: WorkPlanTeamRecoveryPrepareRequest, source = teamRecoveryFixture()): WorkPlanTeamRecoveryPreviewView {
  const original = source.status.plan.preview!, recovery = request.recovery;
  const value: unknown = { preparationId: request.preparationId, tools: source.status.plan.tools, checkers: source.status.plan.checkers, preview: {
    projectId: request.projectId, planId: recovery.planId, baseLease: recovery.expectedLease, baseEffectiveVersion: recovery.expectedEffectiveVersion,
    digest: "d".repeat(64), members: recovery.members, retiredMemberIds: [...source.view.retiredMemberIds, ...source.view.roster.filter(member => !recovery.members.some(value => value.memberId === member.memberId)).map(member => member.memberId)],
    memberPreviews: recovery.members.map(member => ({ memberId: member.memberId, preview: { ...structuredClone(original), config: structuredClone(member.config),
      items: original.items.filter(item => member.unitIds.includes(item.unitId)).map(item => ({ ...structuredClone(item),
        terms: member.config.shareTerms ? item.terms : [], context: member.config.shareContext ? item.context : null,
        sourceContext: { kind: "not-selected" }, projectContext: { kind: "not-selected" } })) } })),
    discussionPreviews: recovery.members.flatMap(member => member.unitIds.map(unitId => {
      const unit = source.status.plan.scope.find(unit => unit.unitId === unitId)!;
      const target = { unitId, locale: source.status.plan.locale, sourceRevisionId: unit.sourceRevisionId, sourceSnapshotId: unit.sourceSnapshotId };
      const post = teamPostFixture(); post.publication.target = target;
      return { memberId: member.memberId, target, throughSequence: post.sequence, posts: [post], artifacts: [] };
    })), work: recovery.work, taskId: fixtureIdentity(9601), attemptId: fixtureIdentity(9602), inputDigest: "9".repeat(64), rootTaskId: source.state.state.rootTaskId,
    expiresAtMs: source.state.state.expiresAtMs, limits: source.status.plan.options.teamExecution!.limits, budget: source.state.state.budget,
    activations: source.state.state.activations, unconfirmedCompletions: source.state.state.unconfirmedCompletions } };
  if (!validators.validateResponseWorkPlanTeamRecoveryPreview(value)) throw new Error("Invalid synthetic team recovery preview");
  return value;
}
export function teamRecoveryReceiptFixture(request: WorkPlanTeamRecoveryAuthorizeRequest, capture: WorkPlanTeamRecoveryPreviewView): TeamRecoveryReceipt {
  const preview = capture.preview;
  return { actionId: request.recovery.actionId, baseLease: preview.baseLease, effectiveVersion: { actionId: request.recovery.actionId, digest: preview.digest,
    lease: { ...preview.baseLease, generation: (BigInt(preview.baseLease.generation) + 1n).toString() } }, state: "active", cancellationRevision: "3",
    workId: preview.work.workId, taskId: preview.taskId, attemptId: preview.attemptId, inputDigest: preview.inputDigest };
}

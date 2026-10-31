import { conversationCommands } from "../../../conversationCommands";
import { executionCommands, type SessionRequest } from "../../../executionCommands";
import type { TeamMemberAuthor, TeamMemberRole, TeamWorkView } from "../../../generated/ai.responses";
import { jsonIdentity } from "../../../pluginToolChoices";
import { translationCommands, type TranslationRevision } from "../../../translationCommands";
import { checkedTeamToolHistoryTask, workPlanCommands, type TeamDiscussionPost, type TeamExecutionView, type TeamHistoryPage, type WorkPlanStatusView } from "../../../workPlanCommands";
import { runMatchesLink, type ConversationPlanLink } from "./conversationRun";

const pageSize = 16;
type TeamTarget = TeamWorkView["target"];

/** A captured read association, never permission to run, select or adopt. */
export interface TeamRunCandidateTarget {
  projectId: string; conversationId: string; planId: string; planDigest: string;
  unitId: string; locale: string; sourceSnapshotId: string; sourceRevisionId: string; revisionId: string;
  link: ConversationPlanLink;
  effectiveVersion: TeamExecutionView["effectiveVersion"];
  work: TeamWorkView;
}
export type OpenConversationTeamCandidate = (target: TeamRunCandidateTarget, current: () => boolean) => Promise<boolean>;

function match(condition: unknown): asserts condition {
  if (!condition) throw new Error("Conversation team read identity changed");
}
function generation(value: string, maximum: string) { return BigInt(value) > 0n && BigInt(value) <= BigInt(maximum); }
function checkScope(context: Pick<SessionRequest, "projectId">, link: ConversationPlanLink, status: WorkPlanStatusView) {
  const plan = status.plan, team = plan.options.teamExecution;
  match(context.projectId === link.projectId && runMatchesLink(status, link) && BigInt(status.lease.generation) > 0n
    && team && plan.options.teamDiscussions && plan.preview && plan.scope.length > 0 && plan.scope.length <= 100
    && new Set(plan.scope.map(unit => unit.unitId)).size === plan.scope.length);
  match(team.members.length > 0 && new Set(team.members.map(member => member.memberId)).size === team.members.length
    && new Set(team.members.map(member => member.roleVersionId)).size === team.members.length
    && team.members.every(member => member.unitIds.length > 0 && member.unitIds.every(id => plan.scope.some(unit => unit.unitId === id))));
}
function checkTarget(status: WorkPlanStatusView, target: TeamTarget) {
  match(target.locale === status.plan.locale && status.plan.scope.some(unit => unit.unitId === target.unitId
    && unit.sourceRevisionId === target.sourceRevisionId && unit.sourceSnapshotId === target.sourceSnapshotId));
}
function checkRole(status: WorkPlanStatusView, role: TeamMemberRole) {
  match(role.planId === status.plan.planId && generation(role.generation, status.lease.generation));
}
function hasRole(roles: readonly TeamMemberRole[], memberId: string, roleVersionId: string) {
  return roles.some(role => role.request.memberId === memberId && role.request.roleVersionId === roleVersionId);
}
function checkAuthor(status: WorkPlanStatusView, roles: readonly TeamMemberRole[], author: TeamMemberAuthor) {
  match(author.binding.lease.planId === status.plan.planId && generation(author.binding.lease.generation, status.lease.generation)
    && hasRole(roles, author.memberId, author.roleVersionId));
}
function checkExecution(link: ConversationPlanLink, status: WorkPlanStatusView, page: TeamExecutionView) {
  const version = page.effectiveVersion, plan = status.plan;
  match(page.planId === plan.planId && version.lease.planId === plan.planId && generation(version.lease.generation, status.lease.generation)
    && /^[a-f0-9]{64}$/.test(version.digest));
  // A recovery has its own digest and roster. The status still describes the
  // immutable base plan; pausing need not change the effective roster's lease.
  if (version.lease.generation === "1") match(version.digest === link.planDigest && version.actionId === link.actionId
    && jsonIdentity(page.roster) === jsonIdentity(plan.options.teamExecution?.members));
  for (const role of [...page.members, ...page.roleVersions]) checkRole(status, role);
  match(new Set(page.roleVersions.map(role => role.request.roleVersionId)).size === page.roleVersions.length
    && new Set(page.roster.map(member => member.memberId)).size === page.roster.length);
  for (const member of page.roster) {
    match(!page.retiredMemberIds.includes(member.memberId) && member.unitIds.length > 0
      && member.unitIds.every(id => plan.scope.some(unit => unit.unitId === id)));
    const role = page.members.find(value => value.request.memberId === member.memberId && value.request.roleVersionId === member.roleVersionId);
    // Before the first admission a declared member may not have a saved role.
    if (role) match(role.request.displayName === member.displayName && role.request.role === member.role && jsonIdentity(role.config) === jsonIdentity(member.config));
  }
  for (const work of page.works) {
    checkTarget(status, work.target);
    match(work.receipt.planId === plan.planId && hasRole(page.roleVersions, work.receipt.memberId, work.receipt.roleVersionId));
    if (work.author) checkAuthor(status, page.roleVersions, work.author);
    if (work.request) checkTarget(status, work.request.target);
    if (work.origin.kind === "human-continuation") checkTarget(status, work.origin.work.target);
    const completed = work.execution === "succeeded" && work.validation === "valid";
    match(completed === (work.output !== null) && (work.candidateRevisionId === null || work.output?.outcome.kind === "translation"));
    if (work.output?.outcome.kind === "translation") match(work.output.outcome.unitId === work.target.unitId && work.output.outcome.targetLocale === work.target.locale);
  }
  for (const message of page.messages) {
    checkTarget(status, message.target);
    match(hasRole(page.roleVersions, message.recipientMemberId, message.recipientRoleVersionId));
    if (message.sender.kind === "member") checkAuthor(status, page.roleVersions, message.sender.author);
    else if (message.sender.kind === "human") match(message.sender.binding.lease.planId === plan.planId && generation(message.sender.binding.lease.generation, status.lease.generation));
  }
  match(page.consumptions.every(consumption => page.messages.some(message => message.messageId === consumption.messageId)));
}
function checkPost(status: WorkPlanStatusView, post: TeamDiscussionPost, roles: readonly TeamMemberRole[]) {
  match(post.planId === status.plan.planId); checkTarget(status, post.publication.target);
  if (post.author.kind === "member") checkAuthor(status, roles, post.author.author);
  else if (post.author.kind === "local-human") match(post.author.actor === "local-user" && post.publication.kind === "human-question"
    && post.publication.question != null && post.publication.question.kind !== "open");
  else match(post.author.binding.lease.planId === status.plan.planId && generation(post.author.binding.lease.generation, status.lease.generation));
}

/** One bounded page. Work and message cursors advance independently; no total is inferred. */
export async function readConversationTeamExecution(context: SessionRequest, link: ConversationPlanLink, status: WorkPlanStatusView,
  afterWork: string | null, afterMessage: string | null): Promise<TeamExecutionView> {
  const fixed = structuredClone({ context, link, status });
  checkScope(fixed.context, fixed.link, fixed.status);
  const page = await workPlanCommands.teamExecution({ ...fixed.context, planId: fixed.link.planId, afterWork, afterMessage, limit: pageSize });
  checkExecution(fixed.link, fixed.status, page); return page;
}
export async function readConversationTeamHistory(context: SessionRequest, link: ConversationPlanLink, status: WorkPlanStatusView,
  after: string | null): Promise<TeamHistoryPage> {
  const fixed = structuredClone({ context, link, status });
  checkScope(fixed.context, fixed.link, fixed.status);
  const page = await workPlanCommands.teamHistory({ ...fixed.context, planId: fixed.link.planId, after, limit: pageSize });
  match(page.planId === fixed.link.planId);
  for (const role of [...page.authorRoles, ...page.members]) checkRole(fixed.status, role);
  for (const post of page.posts) checkPost(fixed.status, post, page.authorRoles);
  return page;
}
export async function readConversationTeamPost(context: SessionRequest, link: ConversationPlanLink, status: WorkPlanStatusView,
  postId: string): Promise<{ post: TeamDiscussionPost; roles: TeamHistoryPage["authorRoles"] }> {
  const fixed = structuredClone({ context, link, status });
  checkScope(fixed.context, fixed.link, fixed.status);
  const post = await workPlanCommands.teamPost({ ...fixed.context, planId: fixed.link.planId, postId });
  const after = BigInt(post.sequence) > 1n ? (BigInt(post.sequence) - 1n).toString() : null;
  const page = await readConversationTeamHistory(fixed.context, fixed.link, fixed.status, after);
  match(post.publication.postId === postId && page.posts.some(value => jsonIdentity(value) === jsonIdentity(post)));
  checkPost(fixed.status, post, page.authorRoles); return { post, roles: page.authorRoles };
}

export function conversationTeamCandidateTarget(link: ConversationPlanLink, status: WorkPlanStatusView, page: TeamExecutionView,
  work: TeamWorkView): TeamRunCandidateTarget | null {
  try { checkScope(link, link, status); checkExecution(link, status, page); } catch { return null; }
  if (!page.works.includes(work) || !work.candidateRevisionId || work.execution !== "succeeded" || work.validation !== "valid"
    || work.output?.outcome.kind !== "translation") return null;
  return structuredClone({ projectId: link.projectId, conversationId: link.conversationId, planId: link.planId, planDigest: link.planDigest,
    unitId: work.target.unitId, locale: work.target.locale, sourceSnapshotId: work.target.sourceSnapshotId, sourceRevisionId: work.target.sourceRevisionId,
    revisionId: work.candidateRevisionId, link, effectiveVersion: page.effectiveVersion, work });
}

/** Re-read the saved work and its original ledger output before opening a candidate. */
export async function resolveConversationTeamCandidate(context: SessionRequest, target: TeamRunCandidateTarget): Promise<TranslationRevision> {
  const fixed = structuredClone({ context, target }), request = fixed.context, captured = fixed.target, receipt = captured.work.receipt;
  match(captured.projectId === request.projectId && captured.projectId === captured.link.projectId && captured.conversationId === captured.link.conversationId
    && captured.planId === captured.link.planId && captured.planDigest === captured.link.planDigest && captured.revisionId === captured.work.candidateRevisionId
    && captured.unitId === captured.work.target.unitId && captured.locale === captured.work.target.locale
    && captured.sourceSnapshotId === captured.work.target.sourceSnapshotId && captured.sourceRevisionId === captured.work.target.sourceRevisionId);
  const link = await conversationCommands.readProposalWorkPlan({ ...request, conversationId: captured.conversationId, planId: captured.planId });
  match(jsonIdentity(link) === jsonIdentity(captured.link));
  const status = await workPlanCommands.status({ ...request, planId: captured.planId });
  const after = BigInt(captured.work.sequence) > 1n ? (BigInt(captured.work.sequence) - 1n).toString() : null;
  const page = await readConversationTeamExecution(request, link, status, after, null);
  const work = page.works.find(value => value.sequence === captured.work.sequence);
  match(work && jsonIdentity(work) === jsonIdentity(captured.work) && jsonIdentity(page.effectiveVersion) === jsonIdentity(captured.effectiveVersion)
    && conversationTeamCandidateTarget(link, status, page, work));
  // This existing pure reader verifies the work's fixed input digest and plan
  // binding in Core, including when the work has no delegated tool children.
  await workPlanCommands.teamWorkTools({ ...request, planId: captured.planId,
    work: { taskId: receipt.taskId, attemptId: receipt.attemptId, inputDigest: receipt.inputDigest }, after: null, limit: pageSize });
  const revision = await translationCommands.revision({ ...request, unitId: captured.unitId, locale: captured.locale, revisionId: captured.revisionId });
  match(revision.unitId === captured.unitId && revision.locale === captured.locale && revision.revisionId === captured.revisionId && revision.originKind === "ai"
    && revision.sourceSnapshotId === captured.sourceSnapshotId && revision.sourceRevisionId === captured.sourceRevisionId && revision.attemptId === receipt.attemptId
    && revision.itemId && revision.resultId && BigInt(revision.ordinal) > 0n && work.output?.outcome.kind === "translation" && revision.text === work.output.outcome.text);
  const detail = await executionCommands.attempt({ ...request, attemptId: receipt.attemptId, offset: 0, limit: 1 }), item = detail.items[0];
  match(detail.taskId === receipt.taskId && detail.attemptId === receipt.attemptId && detail.recovery.attemptId === receipt.attemptId
    && detail.operation === "ai-team-work" && detail.nextOffset === null && detail.progress.total === 1 && detail.items.length === 1
    && detail.progress.succeeded === 1 && detail.progress.queued + detail.progress.running + detail.progress.failed + detail.progress.unknown + detail.progress.cancelled === 0
    && detail.progress.adopted <= detail.progress.total
    && item && item.status.itemId === revision.itemId && item.resultId === revision.resultId && item.status.execution === "succeeded" && item.status.validation === "valid"
    && item.scope.kind === "translation" && item.scope.id === captured.unitId && item.scope.locale === captured.locale);
  const output = await executionCommands.output({ ...request, attemptId: receipt.attemptId, resultId: revision.resultId });
  match(output.projectId === request.projectId && output.attemptId === receipt.attemptId && output.itemId === revision.itemId && output.resultId === revision.resultId
    && output.outcome === "succeeded" && output.capabilityId === "tsumugi.ai.team-work" && output.capabilityVersion === "1" && jsonIdentity(output.output) === jsonIdentity(work.output));
  return revision;
}

/** Inspect one page of an original recorded tool task. No scope or permit is recreated. */
export async function readConversationTeamToolResults(context: SessionRequest, planId: string, work: import("../../../workPlanCommands").TeamWorkReference,
  row: import("../../../workPlanCommands").TeamToolHistoryAttempt, locale: string, offset: number, current: () => boolean) {
  const check = () => match(current() && checkedTeamToolHistoryTask(context, planId, work, row));
  check();
  match(Number.isInteger(offset) && offset >= 0 && offset < row.unitIds.length && row.unitIds.length <= 100);
  const original = structuredClone(row), limit = 16;
  // Core verifies the fixed input digest. The decoded history row binds that
  // digest to the original work and tool handle, rather than a caller-made ID.
  const proof = await executionCommands.pluginStartAction({ ...context, attemptId: original.reference.attemptId, inputDigest: original.reference.inputDigest, operation: "plugin-tool-query" });
  check();
  match(proof && proof.projectId === context.projectId && proof.taskId === original.reference.taskId && proof.attemptId === original.reference.attemptId
    && proof.inputDigest === original.reference.inputDigest);
  const detail = await executionCommands.attempt({ ...context, attemptId: original.reference.attemptId, offset, limit });
  check();
  const count = Math.min(limit, original.unitIds.length - offset), next = offset + count;
  match(detail.taskId === original.reference.taskId && detail.attemptId === original.reference.attemptId && detail.operation === "plugin-tool-query"
    && detail.recovery.attemptId === original.reference.attemptId && detail.progress.total === original.unitIds.length && detail.items.length === count
    && detail.nextOffset === (next < original.unitIds.length ? next : null)
    && new Set(detail.items.map(item => item.status.itemId)).size === count && new Set(detail.items.map(item => item.scope.id)).size === count
    && detail.items.every(item => item.scope.kind === "translation-unit" && original.unitIds.includes(item.scope.id) && item.scope.locale === locale));
  const outputs = await Promise.all(detail.items.filter(item => item.resultId !== null).map(async item => {
    check();
    const output = await executionCommands.output({ ...context, attemptId: original.reference.attemptId, resultId: item.resultId! });
    check();
    match(output.projectId === context.projectId && output.attemptId === original.reference.attemptId && output.itemId === item.status.itemId
      && output.resultId === item.resultId && output.plugin);
    const plugin = output.plugin, invocation = plugin.result;
    match(invocation.context.projectId === context.projectId && invocation.context.attemptId === original.reference.attemptId
      && invocation.context.itemId === item.status.itemId && invocation.context.dispatchId === output.dispatchToken
      && invocation.context.inputDigest === original.reference.inputDigest && invocation.resultId === output.resultId
      && jsonIdentity(invocation.provider) === jsonIdentity(plugin.channel));
    return output;
  }));
  check(); return { detail, outputs };
}

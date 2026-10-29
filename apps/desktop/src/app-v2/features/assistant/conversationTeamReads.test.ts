import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import executionFixture from "../../../../test/fixtures/executionCommands.contract.json";
import translationFixture from "../../../../test/fixtures/translation-commands.json";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamExecutionStatusFixture, teamExecutionViewFixture } from "../../../testSupport/teamExecutionFixture";
import { teamContext, teamHistoryFixture, teamPostFixture } from "../../../testSupport/teamDiscussionFixture";
import { validateResponseWorkPlanTeamExecution, validateResponseWorkPlanTeamHistory, validateResponseWorkPlanTeamPost } from "../../../generated/ai.validators";
import { validateResponseProposalWorkPlanLink } from "../../../generated/conversations.validators";
import { validateResponseAttempt, validateResponseOutput } from "../../../generated/execution.validators";
import { validateResponseRevision } from "../../../generated/translation.validators";
import { conversationTeamCandidateTarget, readConversationTeamExecution, readConversationTeamHistory, readConversationTeamPost, resolveConversationTeamCandidate } from "./conversationTeamReads";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
function checked<T>(value: unknown, validate: (value: unknown) => value is T): T {
  if (!validate(value)) throw new Error("Invalid synthetic team read fixture"); return value;
}
function fixture() {
  const context = { ...teamContext }, status = teamExecutionStatusFixture(), page = teamExecutionViewFixture(), unit = status.plan.scope[0];
  const policy = status.plan.options.teamExecution;
  if (!policy) throw new Error("Synthetic team declaration required");
  status.lease.generation = "1"; page.effectiveVersion.lease = structuredClone(status.lease);
  for (const role of [...page.members, ...page.roleVersions]) role.generation = "1";
  for (const message of page.messages) {
    const binding = message.sender.kind === "member" ? message.sender.author.binding : message.sender.binding;
    binding.lease = structuredClone(status.lease);
  }
  const original = page.works[0], member = policy.members[0];
  page.works = [{ ...original, origin: { kind: "start", actionId: original.receipt.intentId }, author: null, request: null,
    receipt: { ...original.receipt, memberId: member.memberId, roleVersionId: member.roleVersionId }, candidateRevisionId: id(61000),
    output: { outcome: { kind: "translation", unitId: unit.unitId, targetLocale: status.plan.locale, text: "" }, requests: 1, usage: null, usageIncomplete: true } }];
  const link = checked({ projectId: context.projectId, conversationId: id(61001), planId: status.plan.planId, planDigest: status.plan.digest,
    actionId: page.effectiveVersion.actionId, proposalId: id(61002), revisionId: id(61003), ordinal: "1" }, validateResponseProposalWorkPlanLink);
  const post = teamPostFixture(), rawHistory = teamHistoryFixture();
  post.planId = status.plan.planId; post.publication.target = structuredClone(page.works[0].target);
  const postBinding = post.author.kind === "member" ? post.author.author.binding : post.author.binding;
  postBinding.lease = structuredClone(status.lease);
  const history = checked({ ...rawHistory, planId: status.plan.planId, posts: [post], nextAfter: null,
    authorRoles: rawHistory.authorRoles.map(role => ({ ...role, planId: status.plan.planId, generation: "1" })),
    members: rawHistory.members.map(role => ({ ...role, planId: status.plan.planId, generation: "1" })) }, validateResponseWorkPlanTeamHistory);
  const work = page.works[0], receipt = work.receipt, itemId = id(61004), resultId = id(61005);
  const revision = checked({ ...structuredClone(translationFixture.revisionResponse), originKind: "ai", unitId: work.target.unitId, locale: work.target.locale,
    sourceSnapshotId: work.target.sourceSnapshotId, sourceRevisionId: work.target.sourceRevisionId, revisionId: work.candidateRevisionId,
    attemptId: receipt.attemptId, itemId, resultId, text: "", nativeKey: unit.nativeKey, candidateDecision: null }, validateResponseRevision);
  const item = executionFixture.detail.items[0];
  const scope = { kind: "translation", id: work.target.unitId, locale: work.target.locale };
  const detail = checked({ ...structuredClone(executionFixture.detail), taskId: receipt.taskId, attemptId: receipt.attemptId, operation: "ai-team-work", nextOffset: null,
    items: [{ ...item, resultId, scope, status: { ...item.status, itemId, execution: "succeeded", validation: "valid", cancellationRequested: false, diagnostic: null } }],
    recovery: { attemptId: receipt.attemptId, units: [{ ...executionFixture.detail.recovery.units[0], unitId: work.target.unitId,
      itemIds: [itemId], remainingItemIds: [], resultIds: [resultId], scopes: [scope], actions: [], blockedReason: null, receiptId: null }] },
    progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, unknown: 0, cancelled: 0, adopted: 0 } }, validateResponseAttempt);
  const output = checked({ ...structuredClone(executionFixture.output), projectId: context.projectId, attemptId: receipt.attemptId, itemId, resultId,
    capabilityId: "tsumugi.ai.team-work", capabilityVersion: "1", outcome: "succeeded", diagnostic: null, output: work.output }, validateResponseOutput);
  return { context, status, link, page: checked(page, validateResponseWorkPlanTeamExecution), post: checked(post, validateResponseWorkPlanTeamPost), history, revision, detail, output };
}
type Fixture = ReturnType<typeof fixture>;
function targetOf(h: Fixture) {
  const target = conversationTeamCandidateTarget(h.link, h.status, h.page, h.page.works[0]);
  if (!target) throw new Error("Synthetic saved team candidate required"); return target;
}
function serve(h: Fixture) {
  invoke.mockImplementation(async (command: string, { request }: { request: Record<string, unknown> }) => {
    switch (command) {
      case "read_conversation_proposal_work_plan": return structuredClone(h.link);
      case "read_work_plan_status": return structuredClone(h.status);
      case "read_work_plan_team_execution": return structuredClone(h.page);
      case "read_work_plan_team_history": return structuredClone(h.history);
      case "read_work_plan_team_post": return structuredClone(h.post);
      case "read_work_plan_team_work_tools": return { projectId: request.projectId, planId: request.planId, work: request.work, attempts: [], nextAfter: null };
      case "read_translation_revision": return structuredClone(h.revision);
      case "read_execution_attempt": return structuredClone(h.detail);
      case "read_execution_output": return structuredClone(h.output);
      default: throw new Error(`Unexpected mutation or external request: ${command}`);
    }
  });
}
const allowedReads = new Set(["read_conversation_proposal_work_plan", "read_work_plan_status", "read_work_plan_team_execution", "read_work_plan_team_history",
  "read_work_plan_team_post", "read_work_plan_team_work_tools", "read_translation_revision", "read_execution_attempt", "read_execution_output"]);
beforeEach(() => { invoke.mockReset(); });
afterEach(() => { expect(invoke.mock.calls.every(([command]) => allowedReads.has(command))).toBe(true); });

describe("conversation team observation", () => {
  it("reads independent bounded work/message pages and retains unknown work without inventing totals", async () => {
    const h = fixture(), unknown = structuredClone(h.page.works[0]);
    unknown.sequence = "8"; unknown.receipt.intentId = id(61006); unknown.execution = "unknown"; unknown.validation = "absent"; unknown.output = null; unknown.candidateRevisionId = null;
    unknown.origin = { kind: "start", actionId: unknown.receipt.intentId };
    h.page.works = [unknown]; h.page.nextWorkAfter = "8"; h.page.messages[0].sequence = "5"; h.page.nextMessageAfter = "5";
    serve(h);
    const value = await readConversationTeamExecution(h.context, h.link, h.status, "7", "4");
    expect(value).toEqual(h.page); expect(value.works[0].output).toBeNull();
    expect(conversationTeamCandidateTarget(h.link, h.status, value, value.works[0])).toBeNull();
    expect(value).not.toHaveProperty("total");
    expect(invoke).toHaveBeenCalledWith("read_work_plan_team_execution", { request: { ...h.context, planId: h.link.planId, afterWork: "7", afterMessage: "4", limit: 16 } });
  });

  it("captures scope before the await and leaves caller current/late-response handling to the presentation", async () => {
    const h = fixture(), original = structuredClone(h); let answer!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const reading = readConversationTeamExecution(h.context, h.link, h.status, null, null);
    h.context.projectId = id(61007); h.link.planDigest = "a".repeat(64); h.status.plan.scope[0].sourceRevisionId = id(61008);
    answer(original.page); expect(await reading).toEqual(original.page);
    expect(invoke).toHaveBeenCalledWith("read_work_plan_team_execution", { request: { ...original.context, planId: original.link.planId, afterWork: null, afterMessage: null, limit: 16 } });
  });

  it("rejects another project, plan, digest or a non-team declaration before IPC", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.context.projectId = id(61007); }, h => { h.link.planId = id(61009); },
      h => { h.link.planDigest = "a".repeat(64); }, h => { delete h.status.plan.options.teamExecution; }, h => { h.status.plan.scope = []; }];
    for (const change of changes) {
      const h = fixture(); change(h); await expect(readConversationTeamExecution(h.context, h.link, h.status, null, null)).rejects.toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts a paused lease and recovered roster without treating the base digest as a recovery digest", async () => {
    const h = fixture(); h.status.lease.generation = "4"; h.status.state = "paused";
    h.page.effectiveVersion = { actionId: id(61010), digest: "d".repeat(64), lease: { planId: h.link.planId, generation: "3" } };
    h.page.roster[0].role = "Revisit only the original captured entry."; h.page.members[0].request.role = h.page.roster[0].role;
    serve(h);
    expect(await readConversationTeamExecution(h.context, h.link, h.status, null, null)).toEqual(h.page);
  });

  it("rejects wrong source/locale, future effective versions, original digest and role identities", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.page.works[0].target.sourceRevisionId = id(61008); },
      h => { h.page.messages[0].target.locale = "ja-JP"; }, h => { h.page.effectiveVersion.lease.generation = "9"; },
      h => { h.page.effectiveVersion.digest = "d".repeat(64); }, h => { h.page.effectiveVersion.actionId = id(61010); },
      h => { h.page.works[0].receipt.roleVersionId = id(61011); }, h => { h.page.roleVersions[0].generation = "9"; },
      h => { h.page.members[0].config.model = "Different captured model"; }, h => { h.page.messages[0].recipientRoleVersionId = id(61011); }];
    for (const change of changes) {
      const h = fixture(); change(h); serve(h);
      await expect(readConversationTeamExecution(h.context, h.link, h.status, null, null)).rejects.toThrow();
    }
  });

  it("reads an exact original discussion post with its author roles, beyond the first page", async () => {
    const h = fixture(); h.post.sequence = "35"; h.history.posts = [h.post]; serve(h);
    expect(await readConversationTeamPost(h.context, h.link, h.status, h.post.publication.postId)).toEqual({ post: h.post, roles: h.history.authorRoles });
    expect(invoke).toHaveBeenCalledWith("read_work_plan_team_history", { request: { ...h.context, planId: h.link.planId, after: "34", limit: 16 } });
  });

  it("rejects a discussion with changed content, source or author version instead of substituting a first-page post", async () => {
    const h = fixture(); h.post.sequence = "35"; h.history.posts = [{ ...h.post, publication: { ...h.post.publication, body: "Different original reason" } }]; serve(h);
    await expect(readConversationTeamPost(h.context, h.link, h.status, h.post.publication.postId)).rejects.toThrow();
    h.history.posts = [h.post]; h.post.publication.target.sourceSnapshotId = id(61012);
    await expect(readConversationTeamHistory(h.context, h.link, h.status, null)).rejects.toThrow();
    h.post.publication.target = structuredClone(h.page.works[0].target);
    if (h.post.author.kind !== "member") throw new Error("Synthetic member publication required");
    h.post.author.author.roleVersionId = id(61011);
    await expect(readConversationTeamHistory(h.context, h.link, h.status, null)).rejects.toThrow();
  });
});

describe("original team candidate navigation", () => {
  it("resolves an explicitly saved empty translation through its work/input, revision, item and result", async () => {
    const h = fixture(); serve(h); const target = targetOf(h), receipt = target.work.receipt;
    expect(target).not.toHaveProperty("itemId"); expect(await resolveConversationTeamCandidate(h.context, target)).toEqual(h.revision);
    expect(invoke).toHaveBeenCalledWith("read_work_plan_team_work_tools", { request: { ...h.context, planId: h.link.planId,
      work: { taskId: receipt.taskId, attemptId: receipt.attemptId, inputDigest: receipt.inputDigest }, after: null, limit: 16 } });
    expect(invoke).toHaveBeenCalledWith("read_execution_attempt", { request: { ...h.context, attemptId: receipt.attemptId, offset: 0, limit: 1 } });
    expect(invoke).toHaveBeenCalledWith("read_execution_output", { request: { ...h.context, attemptId: receipt.attemptId, resultId: h.revision.resultId } });
  });

  it("does not offer navigation for copied rows, unsaved or partial/unknown/invalid output", () => {
    const h = fixture(); expect(conversationTeamCandidateTarget(h.link, h.status, h.page, structuredClone(h.page.works[0]))).toBeNull();
    const changes: ((h: Fixture) => void)[] = [h => { h.page.works[0].candidateRevisionId = null; }, h => { h.page.works[0].output = null; },
      h => { h.page.works[0].execution = "unknown"; }, h => { h.page.works[0].validation = "invalid"; }];
    for (const change of changes) { const h = fixture(); change(h); expect(conversationTeamCandidateTarget(h.link, h.status, h.page, h.page.works[0])).toBeNull(); }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects another saved link, work tuple, role/input or effective version before reading a candidate", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.link.revisionId = id(61013); }, h => { h.page.works[0].receipt.memberId = id(61014); },
      h => { h.page.works[0].receipt.inputDigest = "e".repeat(64); }, h => { h.page.works[0].receipt.taskId = id(61015); },
      h => { h.page.works[0].receipt.attemptId = id(61016); }, h => { h.page.works[0].receipt.roleVersionId = id(61011); },
      h => { h.page.effectiveVersion = { actionId: id(61017), lease: h.status.lease, digest: "d".repeat(64) }; }];
    for (const change of changes) {
      const h = fixture(), target = targetOf(h); change(h); serve(h);
      await expect(resolveConversationTeamCandidate(h.context, target)).rejects.toThrow();
    }
    expect(invoke.mock.calls.some(([command]) => command === "read_translation_revision")).toBe(false);
  });

  it("rejects a digest proof failure without falling back to revision-only navigation", async () => {
    const h = fixture(); serve(h); const serving = invoke.getMockImplementation();
    if (!serving) throw new Error("Synthetic read transport required");
    invoke.mockImplementation((command, input) => command === "read_work_plan_team_work_tools"
      ? Promise.reject({ code: "unauthorized", outcome: "unchanged", reason: "synthetic-work-input-mismatch" }) : serving(command, input));
    await expect(resolveConversationTeamCandidate(h.context, targetOf(h))).rejects.toBeDefined();
    expect(invoke.mock.calls.some(([command]) => command === "read_translation_revision")).toBe(false);
  });

  it("rejects a revision from a different unit, source, task result, text or origin", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.revision.unitId = id(61018); }, h => { h.revision.locale = "ja-JP"; },
      h => { h.revision.sourceRevisionId = id(61008); }, h => { h.revision.sourceSnapshotId = id(61012); },
      h => { h.revision.attemptId = id(61016); }, h => { h.revision.resultId = null; }, h => { h.revision.itemId = null; },
      h => { h.revision.text = "Another returned translation"; }, h => { h.revision.originKind = "manual"; }];
    for (const change of changes) { const h = fixture(); change(h); serve(h); await expect(resolveConversationTeamCandidate(h.context, targetOf(h))).rejects.toThrow(); }
  });

  it("requires the unique team execution item and exact validated result payload", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.detail.taskId = id(61015); }, h => { h.detail.operation = "ai-translation"; },
      h => { h.detail.items[0].status.itemId = id(61019); }, h => { h.detail.items[0].resultId = id(61020); },
      h => { h.detail.items[0].scope.id = id(61018); }, h => { h.detail.items[0].status.validation = "invalid"; },
      h => { h.detail.nextOffset = 1; }, h => { h.output.itemId = id(61019); }, h => { h.output.capabilityId = "tsumugi.ai.translate"; },
      h => { h.output.output = { outcome: { kind: "translation", unitId: h.revision.unitId, targetLocale: h.revision.locale, text: "Unrelated result" } }; }];
    for (const change of changes) { const h = fixture(); change(h); serve(h); await expect(resolveConversationTeamCandidate(h.context, targetOf(h))).rejects.toThrow(); }
  });

  it("freezes the navigation target before asynchronous reads", async () => {
    const h = fixture(); serve(h); const serving = invoke.getMockImplementation(), target = targetOf(h); let answer!: (value: unknown) => void;
    if (!serving) throw new Error("Synthetic read transport required");
    invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const reading = resolveConversationTeamCandidate(h.context, target);
    target.work.receipt.inputDigest = "e".repeat(64); target.unitId = id(61018); h.context.sessionToken = "another-session";
    answer(h.link); invoke.mockImplementation(serving);
    expect(await reading).toEqual(h.revision);
    expect(invoke.mock.calls.every(([, input]) => input.request.sessionToken === teamContext.sessionToken)).toBe(true);
  });
});

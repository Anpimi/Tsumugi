import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationSession } from "./ConversationSession";
import { canonicalConversationDraft, type ConversationDraftHead, type conversationDraftCommands } from "../../../conversationDraftCommands";
import { teamQuestionCommands } from "../../../teamQuestionCommands";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import type { TeamDiscussionPost } from "../../../generated/ai.responses";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamQuestionNavigationFixture } from "../../../testSupport/teamQuestionNavigationFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type Ports = NonNullable<ConstructorParameters<typeof ConversationSession>[3]>;
type Port<K extends keyof Ports> = NonNullable<Ports[K]>;
type Write = Parameters<typeof conversationDraftCommands.write>[0]["write"];
type ResolveTarget = Parameters<typeof conversationDraftCommands.resolve>[0]["resolve"]["target"];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const retire: (() => void)[] = [];
beforeEach(() => { invoke.mockReset(); });
afterEach(() => { retire.splice(0).forEach(dispose => dispose()); });
function checkedHead(value: unknown): ConversationDraftHead {
  if (!validateResponseConversationWritten(value)) throw new Error("Invalid synthetic question journal head"); return value;
}
async function harness() {
  const h = teamQuestionNavigationFixture(), conversationId = h.link.conversationId;
  let head = checkedHead({ key: { projectId: h.context.projectId, conversationId }, revision: "1", writerId: id(68701),
    value: { text: "", editSeq: "0", pending: null } });
  let identity = 68710;
  const acknowledge = vi.fn<(kind: "write" | "resolve", write: Write) => Promise<void>>(async () => {});
  const commit = async (kind: "write" | "resolve", write: Write, target?: ResolveTarget) => {
    expect(write.expectedRevision).toBe(head.revision);
    if (kind === "write" && head.value?.pending) expect(write.value.pending).toEqual(head.value.pending);
    if (target?.kind === "pending") expect(head.value?.pending).toEqual(target.pending);
    head = checkedHead({ key: write.key, revision: String(BigInt(head.revision) + 1n), writerId: write.writerId,
      value: canonicalConversationDraft(structuredClone(write.value)) });
    const saved = structuredClone(head); await acknowledge(kind, write); return saved;
  };
  const receipt = (request: Parameters<Port<"respondTeamQuestion">>[0]): TeamDiscussionPost => ({
    planId: request.planId, sequence: String(BigInt(h.question.question.sequence) + 1n), author: { kind: "local-human", actor: "local-user" },
    publication: { postId: request.response.postId, target: h.question.question.publication.target, kind: "human-question",
      body: request.response.response.kind === "text" ? request.response.response.body : "No answer needed.", references: [],
      replyTo: request.response.questionPostId, supersedes: null,
      question: request.response.response.kind === "dismiss" ? { kind: "dismiss", questionPostId: request.response.questionPostId }
        : { kind: "resolve", questionPostId: request.response.questionPostId, answer: { kind: "text" } } } });
  const ports = {
    identity: () => id(identity++),
    read: vi.fn<Port<"read">>(async () => structuredClone(head)),
    write: vi.fn<Port<"write">>(async request => commit("write", request.write)),
    resolve: vi.fn<Port<"resolve">>(async request => commit("resolve", request.resolve.write, request.resolve.target)),
    readProposalWorkPlan: vi.fn<Port<"readProposalWorkPlan">>(async () => structuredClone(h.link)),
    readTeamQuestion: vi.fn<Port<"readTeamQuestion">>(async () => structuredClone(h.question)),
    respondTeamQuestion: vi.fn<Port<"respondTeamQuestion">>(async request => receipt(request)),
    teamQuestionSettlement: vi.fn<Port<"teamQuestionSettlement">>(teamQuestionCommands.settlement),
  };
  const recorded = vi.fn(), make = (sessionToken = h.context.sessionToken) => {
    const owner = new ConversationSession({ ...h.context, sessionToken }, recorded, vi.fn(), ports);
    retire.push(() => owner.retire()); return owner;
  };
  const owner = make(); expect(await owner.open(conversationId)).toBe(true);
  const input = (session = owner) => { const value = session.getSnapshot().inputs.get(conversationId); if (!value) throw new Error("Missing synthetic conversation input"); return value; };
  const answer = (session = owner) => session.teamDraft(conversationId, h.link.planId)?.questions?.find(draft => draft.questionPostId === h.question.question.publication.postId);
  const pending = (session = owner) => { const value = input(session).value.pending; if (value?.kind !== "team-question-response") throw new Error("Missing original response"); return value; };
  const edit = (body = "Original A {{name}} 中文") => owner.editTeamQuestion(h.link, h.question.question.publication.postId, { mode: "text", body });
  const send = () => owner.respondTeamQuestion(h.link, h.question, answer()!.editSeq, false, () => true);
  return { ...h, owner, make, ports, acknowledge, recorded, receipt, input, answer, pending, edit, send, head: () => head };
}

describe("durable local member question answers", () => {
  it("waits for the original pending journal acknowledgement before recording the answer", async () => {
    const h = await harness(); h.edit(); await h.owner.flush();
    const entered = deferred<void>(), release = deferred<void>();
    h.acknowledge.mockImplementation(async (kind, write) => {
      if (kind === "write" && write.value.pending?.kind === "team-question-response") { entered.resolve(); await release.promise; }
    });
    const sending = h.send(); await entered.promise;
    expect(h.ports.respondTeamQuestion).not.toHaveBeenCalled();
    const pending = structuredClone(h.pending()); expect(h.head().value?.pending).toEqual(pending);
    expect(pending.request).not.toHaveProperty("sessionToken"); expect(pending.question).toEqual(h.question.question);
    release.resolve(); await sending;
    expect(h.ports.respondTeamQuestion).toHaveBeenCalledWith({ ...pending.request, sessionToken: h.context.sessionToken }, pending.question);
    expect(h.input().value.pending).toBeNull(); expect(h.answer()).toBeUndefined(); expect(h.input().notice).toBe("teamQuestionResponded");
    expect(h.head().value).toEqual(canonicalConversationDraft(h.input().value));
  });

  it("preserves answer B, another question and the composer when the saved answer A returns", async () => {
    const h = await harness(); h.edit();
    h.owner.editTeamQuestion(h.link, id(68790), { body: "Independent unanswered question" });
    h.owner.edit(h.link.conversationId, "Independent composer"); await h.owner.flush();
    const entered = deferred<void>(), release = deferred<void>();
    h.ports.respondTeamQuestion.mockImplementationOnce(async request => { entered.resolve(); await release.promise; return h.receipt(request); });
    const sending = h.send(); await entered.promise; const original = structuredClone(h.pending());
    h.edit("Newer answer B"); h.owner.edit(h.link.conversationId, "Newer composer B");
    await vi.waitFor(() => expect(h.head().value?.text).toBe("Newer composer B"));
    expect(h.head().value?.pending).toEqual(original);
    const newer = structuredClone(h.answer()); release.resolve(); await sending; expect(await h.owner.flush()).toBe(true);
    expect(h.answer()).toEqual(newer); expect(h.answer()?.body).toBe("Newer answer B");
    expect(h.owner.teamDraft(h.link.conversationId, h.link.planId)?.questions).toContainEqual(expect.objectContaining({ questionPostId: id(68790), body: "Independent unanswered question" }));
    expect(h.input().value.text).toBe("Newer composer B"); expect(h.input().value.pending).toBeNull();
    expect(h.ports.respondTeamQuestion).toHaveBeenCalledOnce();
    expect(h.head().value).toEqual(canonicalConversationDraft(h.input().value));
  });

  it.each(["recorded", "closed-by-other"] as const)("reopens and checks an exact %s outcome without resending", async kind => {
    const h = await harness(); h.edit(); await h.owner.flush();
    h.ports.respondTeamQuestion.mockRejectedValueOnce({ code: "storage-failed", outcome: "unknown", reason: "synthetic-answer-acknowledgement-lost" });
    await h.send(); const original = structuredClone(h.pending()), draft = structuredClone(h.answer());
    h.owner.retire(); const reopened = h.make("reopened-question-session"); expect(await reopened.open(h.link.conversationId)).toBe(true);
    expect(h.pending(reopened)).toEqual(original); expect(h.ports.teamQuestionSettlement).not.toHaveBeenCalled();
    const request = { ...original.request, sessionToken: "reopened-question-session" };
    const proof = { projectId: h.context.projectId, planId: h.link.planId, request: original.request.response };
    invoke.mockResolvedValueOnce({ ...proof, outcome: { kind: "pending" } });
    await reopened.check(h.link.conversationId);
    expect(h.pending(reopened)).toEqual(original); expect(reopened.canRetryQuestion(h.link.conversationId)).toBe(true);
    const saved = h.receipt(kind === "recorded" ? request : { ...request, response: { ...request.response, postId: id(68791), response: { kind: "dismiss", reason: "No answer needed." } } });
    invoke.mockResolvedValueOnce({ ...proof, outcome: { kind, receipt: saved } });
    await reopened.check(h.link.conversationId);
    expect(h.input(reopened).value.pending).toBeNull();
    expect(h.answer(reopened)).toEqual(kind === "recorded" ? undefined : draft);
    expect(h.input(reopened).notice).toBe(kind === "recorded" ? "teamQuestionResponded" : "teamQuestionClosed");
    expect(h.ports.resolve.mock.lastCall?.[0].resolve.disposition).toBe(kind === "recorded" ? "recorded" : "fenced-not-applied");
    expect(h.ports.respondTeamQuestion).toHaveBeenCalledOnce();
    expect(invoke.mock.calls).toEqual(Array.from({ length: 2 }, () => ["read_work_plan_team_question_response_settlement", { request }]));
  });
});

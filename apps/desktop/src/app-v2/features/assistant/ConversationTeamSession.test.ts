import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationSession } from "./ConversationSession";
import { canonicalConversationDraft, type ConversationDraftHead, type ConversationDraftResolveTarget, type conversationDraftCommands } from "../../../conversationDraftCommands";
import { workPlanCommands } from "../../../workPlanCommands";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { validateResponseProposalWorkPlanLink } from "../../../generated/conversations.validators";
import { validateResponseWorkPlanReceipt, validateResponseWorkPlanTeamMessageSettlement, validateResponseWorkPlanTeamPublicationSettlement } from "../../../generated/ai.validators";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamGuidanceFixture, humanTeamMessageFixture } from "../../../testSupport/teamGuidanceFixture";
import { teamContext, publishedTeamFixture } from "../../../testSupport/teamDiscussionFixture";
import { jsonIdentity } from "../../../pluginToolChoices";

const invoke = vi.hoisted(() => vi.fn<(command: string, args: unknown) => Promise<unknown>>(async () => { throw new Error("Unexpected native or external request"); }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type Ports = NonNullable<ConstructorParameters<typeof ConversationSession>[3]>;
type Port<K extends keyof Ports> = NonNullable<Ports[K]>;
type Write = Parameters<typeof conversationDraftCommands.write>[0]["write"];
type MessageProof = Awaited<ReturnType<Port<"teamMessageSettlement">>>;
type PublicationProof = Awaited<ReturnType<Port<"teamPublicationSettlement">>>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function checked<T>(value: unknown, validate: (value: unknown) => value is T): T {
  if (!validate(value)) throw new Error("Invalid synthetic team session fixture"); return value;
}
function messageProof(request: Parameters<Port<"teamMessageSettlement">>[0], outcome: MessageProof["settlement"]["outcome"], generation = request.lease.generation): MessageProof {
  const { sessionToken: _token, ...original } = request;
  return checked({ request: original, settlement: { projectId: request.projectId, planId: request.lease.planId,
    lease: { ...request.lease, generation }, state: outcome.kind === "fenced-not-applied" ? "paused" : "active", outcome } }, validateResponseWorkPlanTeamMessageSettlement);
}
function publicationProof(request: Parameters<Port<"teamPublicationSettlement">>[0], outcome: PublicationProof["settlement"]["outcome"], generation = request.lease.generation): PublicationProof {
  const { sessionToken: _token, ...original } = request;
  return checked({ request: original, settlement: { projectId: request.projectId, planId: request.lease.planId,
    lease: { ...request.lease, generation }, state: outcome.kind === "fenced-not-applied" ? "paused" : "active", outcome } }, validateResponseWorkPlanTeamPublicationSettlement);
}
const unknown = { code: "storage-failed", outcome: "unknown", reason: "synthetic-team-acknowledgement-lost" };

async function harness() {
  const context = { ...teamContext }, { status, view } = teamGuidanceFixture();
  const conversationId = id(63000), link = checked({ projectId: context.projectId, conversationId, planId: status.plan.planId,
    planDigest: status.plan.digest, actionId: view.effectiveVersion.actionId, proposalId: id(63001), revisionId: id(63002), ordinal: "1" }, validateResponseProposalWorkPlanLink);
  const initial = checked({ key: { projectId: context.projectId, conversationId }, revision: "1", writerId: id(63003),
    value: { text: "", editSeq: "0", pending: null } }, validateResponseConversationWritten);
  const heads = new Map<string, ConversationDraftHead>([[conversationId, initial]]), acknowledgements = new Map<string, ConversationDraftHead>();
  let identity = 63100, active = 0;
  const journal = { maximum: 0, acknowledge: vi.fn<(kind: "write" | "resolve", write: Write, target?: ConversationDraftResolveTarget) => Promise<void>>(async () => {}) };
  const commit = async (kind: "write" | "resolve", write: Write, target?: ConversationDraftResolveTarget) => {
    active++; journal.maximum = Math.max(journal.maximum, active);
    try {
      expect(active, "Only one journal frame may be acknowledged at a time").toBe(1);
      const operation = jsonIdentity({ kind, write, target });
      if (!operation) throw new Error("Synthetic journal operation required");
      const acknowledged = acknowledgements.get(operation);
      if (acknowledged) { await journal.acknowledge(kind, write, target); return structuredClone(acknowledged); }
      const previous = heads.get(write.key.conversationId);
      expect(write.expectedRevision).toBe(previous?.revision ?? "0");
      if (kind === "write" && previous?.value?.pending) expect(write.value.pending).toEqual(previous.value.pending);
      if (target?.kind === "pending") { expect(previous?.value?.pending).toEqual(target.pending); expect(write.value.pending).toBeNull(); }
      if (target?.kind === "revocation") {
        expect(previous?.value?.revocations).toContainEqual(target.revocation);
        expect(write.value.pending).toEqual(previous?.value?.pending);
        expect(write.value.revocations ?? []).not.toContainEqual(target.revocation);
      }
      const result = checked({ key: structuredClone(write.key), revision: String(BigInt(previous?.revision ?? "0") + 1n),
        writerId: write.writerId, value: canonicalConversationDraft(structuredClone(write.value)) }, validateResponseConversationWritten);
      heads.set(write.key.conversationId, result); acknowledgements.set(operation, structuredClone(result));
      await journal.acknowledge(kind, write, target); return structuredClone(result);
    } finally { active--; }
  };
  const ports = {
    now: () => Date.now(), identity: () => id(identity++),
    list: vi.fn<Port<"list">>(async () => ({ items: [...heads.values()].flatMap(head => head.value ? [{ key: head.key, revision: head.revision,
      editSeq: head.value.editSeq, hasPending: !!head.value.pending || !!head.value.revocations?.length }] : []), next: null })),
    read: vi.fn<Port<"read">>(async request => structuredClone(heads.get(request.key.conversationId) ?? { key: request.key, revision: "0", writerId: null, value: null })),
    write: vi.fn<Port<"write">>(async request => commit("write", request.write)),
    resolve: vi.fn<Port<"resolve">>(async request => {
      const target = request.resolve.target;
      if (target.kind === "revocation") return commit("resolve", request.resolve.write, target);
      const decoded = checked({ key: request.resolve.write.key, revision: "1", writerId: request.resolve.write.writerId,
        value: { ...request.resolve.write.value, pending: target.pending } }, validateResponseConversationWritten);
      if (!decoded.value?.pending) throw new Error("Decoded original team request required");
      return commit("resolve", request.resolve.write, { kind: "pending", pending: decoded.value.pending });
    }),
    readProposalWorkPlan: vi.fn<Port<"readProposalWorkPlan">>(async () => structuredClone(link)),
    planStatus: vi.fn<Port<"planStatus">>(async () => structuredClone(status)),
    readTeamExecution: vi.fn<Port<"readTeamExecution">>(async () => structuredClone(view)),
    sendTeamMessage: vi.fn<Port<"sendTeamMessage">>(async request => humanTeamMessageFixture(request)),
    publishTeam: vi.fn<Port<"publishTeam">>(async request => publishedTeamFixture(request)),
    teamMessageSettlement: vi.fn<Port<"teamMessageSettlement">>(async request => messageProof(request, { kind: "pending" })),
    teamPublicationSettlement: vi.fn<Port<"teamPublicationSettlement">>(async request => publicationProof(request, { kind: "pending" })),
    append: vi.fn<Port<"append">>(), startPlan: vi.fn<Port<"startPlan">>(),
    controlPlan: vi.fn<Port<"controlPlan">>(async request => checked({ actionId: request.actionId,
      lease: { planId: request.planId, generation: String(BigInt(request.expectedGeneration) + 1n) },
      state: request.command === "pause" ? "paused" : request.command === "stop" ? "stopped" : "taken-over", attemptId: null, parentTask: null }, validateResponseWorkPlanReceipt)),
  };
  const recorded = vi.fn(), reveal = vi.fn(), make = (sessionToken = context.sessionToken) => new ConversationSession({ ...context, sessionToken }, recorded, reveal, ports);
  const owner = make(); await owner.initialize(); expect(await owner.open(conversationId)).toBe(true);
  const input = (session = owner) => { const value = session.getSnapshot().inputs.get(conversationId); if (!value) throw new Error("Synthetic conversation input required"); return value; };
  const guidance = (session = owner) => { const value = session.teamDraft(conversationId, link.planId)?.guidance; if (!value) throw new Error("Synthetic guidance draft required"); return value; };
  const publication = (session = owner) => { const value = session.teamDraft(conversationId, link.planId)?.publication; if (!value) throw new Error("Synthetic publication draft required"); return value; };
  const pending = (session = owner) => { const value = input(session).value.pending; if (value?.kind !== "team-message" && value?.kind !== "team-publication") throw new Error("Original team request required"); return value; };
  const editGuidance = (body = "Guidance A") => owner.editTeamGuidance(link, { memberId: view.roster[0].memberId, unitId: status.plan.scope[0].unitId, body });
  const editPublication = (body = "Discussion A") => owner.editTeamPublication(link, { unitId: status.plan.scope[0].unitId, body, replyTo: null });
  return { context, status, view, link, conversationId, owner, make, ports, heads, journal, recorded, reveal, input, guidance, publication, pending, editGuidance, editPublication };
}
beforeEach(() => { invoke.mockClear(); });
afterEach(() => { expect(invoke.mock.calls.every(([command]) => command === "read_work_plan_team_message_settlement")).toBe(true); });

describe("durable conversation team actions", () => {
  it("does not dispatch either business action when the original request cannot be journaled", async () => {
    for (const kind of ["guidance", "publication"] as const) {
      const h = await harness(); if (kind === "guidance") h.editGuidance(); else h.editPublication(); await h.owner.flush();
      h.ports.write.mockRejectedValueOnce({ code: "storage-failed", outcome: "unchanged", reason: "synthetic-journal-unavailable" });
      if (kind === "guidance") await h.owner.sendTeamGuidance(h.link, h.status, h.view, h.guidance().editSeq, () => true);
      else await h.owner.publishTeamDiscussion(h.link, h.status, h.publication().editSeq, () => true);
      expect(h.ports.sendTeamMessage).not.toHaveBeenCalled(); expect(h.ports.publishTeam).not.toHaveBeenCalled();
      expect(h.input().failure?.kind).toBe("journal"); expect(h.pending().request).not.toHaveProperty("sessionToken");
      expect(h.heads.get(h.conversationId)?.value?.pending).toBeNull(); expect(h.owner.canSendTeam(h.conversationId)).toBe(false);
    }
  });

  it("records only the matching guidance/publication sub-sequence and preserves the other input and composer", async () => {
    const h = await harness(); h.editGuidance(); h.editPublication(); h.owner.edit(h.conversationId, "Unsent conversation input"); await h.owner.flush();
    const guidance = structuredClone(h.guidance()), publication = structuredClone(h.publication());
    h.ports.sendTeamMessage.mockImplementationOnce(async request => {
      const saved = h.heads.get(h.conversationId)?.value?.pending;
      if (saved?.kind !== "team-message") throw new Error("Guidance must be durable before dispatch");
      expect(saved.request).not.toHaveProperty("sessionToken"); expect(request).toEqual({ ...saved.request, sessionToken: h.context.sessionToken });
      expect(saved.targetName).toBe(h.status.plan.scope[0].nativeKey);
      expect(saved.destination).toEqual({ name: h.view.roster[0].displayName, role: h.view.roster[0].role, endpoint: h.view.roster[0].config.endpoint, model: h.view.roster[0].config.model });
      return humanTeamMessageFixture(request);
    });
    await h.owner.sendTeamGuidance(h.link, h.status, h.view, guidance.editSeq, () => true);
    expect(h.input().value.pending).toBeNull(); expect(h.guidance().body).toBe("");
    expect(BigInt(h.guidance().editSeq)).toBeGreaterThan(BigInt(guidance.editSeq));
    expect(h.guidance().editSeq).toBe(h.input().value.editSeq); expect(h.guidance().memberId).toBe(guidance.memberId);
    expect(h.publication()).toEqual(publication); expect(h.input().value.text).toBe("Unsent conversation input");
    const clearedGuidance = structuredClone(h.guidance());
    h.ports.publishTeam.mockImplementationOnce(async request => {
      const saved = h.heads.get(h.conversationId)?.value?.pending;
      if (saved?.kind !== "team-publication") throw new Error("Publication must be durable before dispatch");
      expect(saved.targetName).toBe(h.status.plan.scope[0].nativeKey);
      expect(request).toEqual({ ...saved.request, sessionToken: h.context.sessionToken }); return publishedTeamFixture(request);
    });
    await h.owner.publishTeamDiscussion(h.link, h.status, publication.editSeq, () => true);
    expect(h.publication().body).toBe(""); expect(h.publication().unitId).toBe(publication.unitId);
    expect(h.publication().editSeq).toBe(h.input().value.editSeq); expect(h.guidance()).toEqual(clearedGuidance);
    expect(h.heads.get(h.conversationId)?.value).toEqual(canonicalConversationDraft(h.input().value)); expect(h.journal.maximum).toBe(1);
  });

  it("keeps newer B and C guidance across both the business acknowledgement and the journal resolution", async () => {
    const h = await harness(); h.editGuidance(); await h.owner.flush();
    const entered = deferred<void>(), business = deferred<void>(), resolving = deferred<void>(), resolution = deferred<void>();
    h.ports.sendTeamMessage.mockImplementationOnce(async request => { entered.resolve(); await business.promise; return humanTeamMessageFixture(request); });
    h.journal.acknowledge.mockImplementation(async kind => { if (kind === "resolve") { resolving.resolve(); await resolution.promise; } });
    const sending = h.owner.sendTeamGuidance(h.link, h.status, h.view, h.guidance().editSeq, () => true); await entered.promise;
    const original = structuredClone(h.pending());
    h.editGuidance("Guidance B"); h.editPublication("Other discussion B"); h.owner.edit(h.conversationId, "Composer B");
    await vi.waitFor(() => expect(h.heads.get(h.conversationId)?.value?.teamDrafts?.find(draft => draft.planId === h.link.planId))
      .toMatchObject({ guidance: { body: "Guidance B" }, publication: { body: "Other discussion B" } }));
    expect(h.heads.get(h.conversationId)?.value).toMatchObject({ text: "Composer B", pending: original });
    business.resolve(); await resolving.promise; h.editGuidance("Guidance C"); const latest = structuredClone(h.guidance());
    resolution.resolve(); await sending; expect(await h.owner.flush()).toBe(true);
    expect(h.guidance()).toEqual(latest); expect(h.guidance().body).toBe("Guidance C"); expect(h.publication().body).toBe("Other discussion B");
    expect(h.input().value.text).toBe("Composer B"); expect(h.input().value.pending).toBeNull(); expect(h.ports.sendTeamMessage).toHaveBeenCalledOnce();
    expect(h.heads.get(h.conversationId)?.value).toEqual(canonicalConversationDraft(h.input().value)); expect(h.journal.maximum).toBe(1);
  });

  it("reopens an original unknown request without dispatch and preserves its identity for null or Pending observations", async () => {
    const h = await harness(); h.editGuidance(); await h.owner.flush(); h.ports.sendTeamMessage.mockRejectedValueOnce(unknown);
    await h.owner.sendTeamGuidance(h.link, h.status, h.view, h.guidance().editSeq, () => true);
    const original = structuredClone(h.pending()); h.owner.retire(); const reopened = h.make("reopened-team-session");
    await reopened.initialize(); expect(await reopened.open(h.conversationId)).toBe(true);
    expect(h.ports.sendTeamMessage).toHaveBeenCalledOnce(); expect(h.ports.teamMessageSettlement).not.toHaveBeenCalled(); expect(h.pending(reopened)).toEqual(original);
    h.ports.teamMessageSettlement.mockImplementationOnce(workPlanCommands.teamMessageSettlement); invoke.mockResolvedValueOnce(null);
    await reopened.check(h.conversationId);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("read_work_plan_team_message_settlement", { request: { ...original.request, sessionToken: "reopened-team-session" } });
    expect(h.pending(reopened)).toEqual(original); expect(h.input(reopened).outcome).toBe("unknown"); expect(h.ports.resolve).not.toHaveBeenCalled();
    await reopened.check(h.conversationId);
    expect(h.pending(reopened)).toEqual(original); expect(reopened.canRetryTeam(h.conversationId)).toBe(true);
    expect(reopened.clearTeamPreparationFailure(h.conversationId)).toBe(false); expect(h.pending(reopened)).toEqual(original);
    expect(h.ports.sendTeamMessage).toHaveBeenCalledOnce(); expect(h.ports.resolve).not.toHaveBeenCalled();
    expect(h.ports.teamMessageSettlement).toHaveBeenLastCalledWith({ ...original.request, sessionToken: "reopened-team-session" });
  });

  it("distinguishes a recorded guidance receipt from a fenced publication and keeps every fenced input", async () => {
    const sent = await harness(); sent.editGuidance(); await sent.owner.flush(); sent.ports.sendTeamMessage.mockRejectedValueOnce(unknown);
    await sent.owner.sendTeamGuidance(sent.link, sent.status, sent.view, sent.guidance().editSeq, () => true);
    sent.ports.teamMessageSettlement.mockImplementationOnce(async request => messageProof(request, { kind: "recorded", receipt: humanTeamMessageFixture(request) }));
    await sent.owner.check(sent.conversationId); expect(sent.input().value.pending).toBeNull(); expect(sent.guidance().body).toBe("");
    expect(sent.ports.resolve.mock.lastCall?.[0].resolve.disposition).toBe("recorded");

    const fenced = await harness(); fenced.editPublication(); fenced.editGuidance("Separate guidance"); fenced.owner.edit(fenced.conversationId, "Separate conversation"); await fenced.owner.flush();
    const publication = structuredClone(fenced.publication()), guidance = structuredClone(fenced.guidance());
    fenced.ports.publishTeam.mockRejectedValueOnce(unknown);
    await fenced.owner.publishTeamDiscussion(fenced.link, fenced.status, publication.editSeq, () => true);
    fenced.ports.teamPublicationSettlement.mockImplementationOnce(async request => publicationProof(request, { kind: "fenced-not-applied" }, String(BigInt(request.lease.generation) + 1n)));
    await fenced.owner.check(fenced.conversationId);
    expect(fenced.input().value.pending).toBeNull(); expect(fenced.publication()).toEqual(publication); expect(fenced.guidance()).toEqual(guidance);
    expect(fenced.input().value.text).toBe("Separate conversation"); expect(fenced.ports.resolve.mock.lastCall?.[0].resolve.disposition).toBe("fenced-not-applied");
    expect(fenced.ports.publishTeam).toHaveBeenCalledOnce();
  });

  it("retries an explicitly observed absent publication with the same post identity and original A body", async () => {
    const h = await harness(); h.editPublication(); await h.owner.flush(); h.ports.publishTeam.mockRejectedValueOnce(unknown);
    await h.owner.publishTeamDiscussion(h.link, h.status, h.publication().editSeq, () => true); const original = structuredClone(h.pending());
    await h.owner.retry(h.conversationId); expect(h.ports.publishTeam).toHaveBeenCalledOnce();
    await h.owner.check(h.conversationId); expect(h.owner.canRetryTeam(h.conversationId)).toBe(true);
    h.editPublication("Discussion B"); await h.owner.flush(); const latest = structuredClone(h.publication());
    await h.owner.retry(h.conversationId);
    expect(h.ports.publishTeam).toHaveBeenCalledTimes(2);
    expect(h.ports.publishTeam.mock.calls[1][0]).toEqual(h.ports.publishTeam.mock.calls[0][0]);
    expect(h.ports.publishTeam.mock.calls[1][0]).toEqual({ ...original.request, sessionToken: h.context.sessionToken });
    expect(h.input().value.pending).toBeNull(); expect(h.publication()).toEqual(latest); expect(h.publication().body).toBe("Discussion B");
  });

  it("does not dispatch when a view proof expires during reads or the plan deadline has passed", async () => {
    const h = await harness(); h.editGuidance(); await h.owner.flush(); const entered = deferred<void>(), read = deferred<typeof h.view>(); let current = true;
    h.ports.readTeamExecution.mockImplementationOnce(async () => { entered.resolve(); return read.promise; });
    const sending = h.owner.sendTeamGuidance(h.link, h.status, h.view, h.guidance().editSeq, () => current);
    await entered.promise; current = false; read.resolve(structuredClone(h.view)); await sending;
    expect(h.ports.sendTeamMessage).not.toHaveBeenCalled(); expect(h.input().value.pending).toBeNull(); expect(h.guidance().body).toBe("Guidance A");
    const expired = await harness(); expired.editPublication(); await expired.owner.flush(); expired.status.expiresAt = "1";
    await expired.owner.publishTeamDiscussion(expired.link, expired.status, expired.publication().editSeq, () => true);
    expect(expired.ports.publishTeam).not.toHaveBeenCalled(); expect(expired.input().value.pending).toBeNull(); expect(expired.publication().body).toBe("Discussion A");
  });

  it("blocks incompatible mutations while the original request is in flight but keeps its independent pause reachable", async () => {
    const h = await harness(); h.editGuidance(); h.editPublication(); h.owner.edit(h.conversationId, "Unsent composer"); await h.owner.flush();
    const entered = deferred<void>(), business = deferred<void>();
    h.ports.sendTeamMessage.mockImplementationOnce(async request => { entered.resolve(); await business.promise; return humanTeamMessageFixture(request); });
    const sending = h.owner.sendTeamGuidance(h.link, h.status, h.view, h.guidance().editSeq, () => true); await entered.promise;
    const original = structuredClone(h.pending()); expect(h.owner.canSendTeam(h.conversationId)).toBe(false);
    expect(h.owner.discardTeamDraft(h.link, "guidance")).toBe(false);
    await h.owner.publishTeamDiscussion(h.link, h.status, h.publication().editSeq, () => true); await h.owner.append(h.conversationId);
    expect(h.ports.publishTeam).not.toHaveBeenCalled(); expect(h.ports.append).not.toHaveBeenCalled();
    expect(h.owner.canRevokeRun(h.conversationId, h.status, "pause")).toBe(true);
    await h.owner.controlRun(h.link, h.status, "pause", null, () => true);
    expect(h.ports.controlPlan).toHaveBeenCalledOnce(); expect(h.pending()).toEqual(original);
    expect(h.input().value.revocations ?? []).toHaveLength(0); expect(h.heads.get(h.conversationId)?.value?.pending).toEqual(original);
    business.reject(unknown); await sending; expect(h.pending()).toEqual(original);
    h.ports.teamMessageSettlement.mockImplementationOnce(async request => messageProof(request, { kind: "fenced-not-applied" }, String(BigInt(request.lease.generation) + 1n)));
    await h.owner.check(h.conversationId);
    expect(h.input().value.pending).toBeNull(); expect(h.guidance().body).toBe("Guidance A"); expect(h.input().value.text).toBe("Unsent composer");
    expect(h.ports.sendTeamMessage).toHaveBeenCalledOnce(); expect(h.journal.maximum).toBe(1);
  });
});

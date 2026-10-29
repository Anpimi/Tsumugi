import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationSession } from "./ConversationSession";
import { canonicalConversationDraft, conversationPendingActionId, type ConversationDraftHead } from "../../../conversationDraftCommands";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamContext } from "../../../testSupport/teamDiscussionFixture";
import { teamRecoveryFixture, teamRecoveryPreviewFixture, teamRecoveryReceiptFixture } from "../../../testSupport/teamRecoveryFixture";
import type { WorkPlanTeamRecoveryPreviewView } from "../../../generated/ai.responses";
import type { ConversationPlanLink } from "./conversationRun";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { jsonIdentity } from "../../../pluginToolChoices";

const invoke = vi.hoisted(() => vi.fn(async () => { throw new Error("Unexpected native or external request"); }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type Ports = NonNullable<ConstructorParameters<typeof ConversationSession>[3]>;
type Port<K extends keyof Ports> = NonNullable<Ports[K]>;
const owners: ConversationSession[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.retire()); expect(invoke).not.toHaveBeenCalled(); });
const same = (a: unknown, b: unknown) => jsonIdentity(a) === jsonIdentity(b);
const permission = { checkerExecutions: [], toolExecution: false, applicationToolExecutions: [] };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function harness() {
  const source = teamRecoveryFixture();
  const pausedLease = { ...source.status.lease, generation: String(BigInt(source.view.effectiveVersion.lease.generation) + 1n) };
  source.status.lease = structuredClone(pausedLease); source.state.state.lease = structuredClone(pausedLease);
  const key = { projectId: teamContext.projectId, conversationId: id(67100) };
  const link: ConversationPlanLink = { ...key, planId: source.status.plan.planId, planDigest: source.status.plan.digest,
    actionId: source.view.effectiveVersion.actionId, proposalId: id(67101), revisionId: id(67102), ordinal: "1" };
  let head: ConversationDraftHead = { key, revision: "0", writerId: null, value: null }, serial = 67200, active = 0, capture: WorkPlanTeamRecoveryPreviewView | null = null;
  const resolved: Parameters<Port<"resolve">>[0][] = [];
  const save = async (write: Parameters<Port<"write">>[0]["write"]) => {
    active++; expect(active).toBe(1);
    try { expect(write.expectedRevision).toBe(head.revision); const candidate = { key, revision: String(BigInt(head.revision) + 1n), writerId: write.writerId,
      value: canonicalConversationDraft(structuredClone(write.value)) };
      if (!validateResponseConversationWritten(candidate)) throw new Error("Invalid synthetic recovery journal acknowledgement");
      head = candidate; return structuredClone(head); }
    finally { active--; }
  };
  const ports = {
    identity: () => id(serial++), list: vi.fn<Port<"list">>(async () => ({ items: [], next: null })),
    read: vi.fn<Port<"read">>(async () => structuredClone(head)), write: vi.fn<Port<"write">>(async request => save(request.write)),
    resolve: vi.fn<Port<"resolve">>(async request => { expect(same(head.value?.pending, request.resolve.target.kind === "pending" ? request.resolve.target.pending : null)).toBe(true);
      resolved.push(structuredClone(request)); return save(request.resolve.write); }),
    readProposalWorkPlan: vi.fn<Port<"readProposalWorkPlan">>(async () => structuredClone(link)),
    planStatus: vi.fn<Port<"planStatus">>(async () => structuredClone(source.status)),
    readTeamExecution: vi.fn<Port<"readTeamExecution">>(async () => structuredClone(source.view)),
    teamRecoveryState: vi.fn<Port<"teamRecoveryState">>(async () => structuredClone(source.state)),
    prepareTeamRecovery: vi.fn<Port<"prepareTeamRecovery">>(async request => { expect(head.value?.pending?.kind).toBe("team-recovery");
      expect(conversationPendingActionId(head.value!.pending!)).toBe(request.preparationId); capture = teamRecoveryPreviewFixture(request, source); return structuredClone(capture); }),
    authorizeTeamRecovery: vi.fn<Port<"authorizeTeamRecovery">>(async (request, value) => { const pending = head.value?.pending;
      expect(pending?.kind === "team-recovery" && pending.authorization?.recovery.actionId).toBe(request.recovery.actionId);
      return teamRecoveryReceiptFixture(request, value); }),
    readTeamRecoveryPreparation: vi.fn<Port<"readTeamRecoveryPreparation">>(async request => { const { sessionToken: _token, ...original } = request;
      return { request: original, lease: structuredClone(source.state.state.lease), state: source.state.state.state,
        hostCallbacksDrained: source.state.hostCallbacksDrained, outcome: { kind: "pending" } }; }),
    closeTeamRecoveryPreparation: vi.fn<Port<"closeTeamRecoveryPreparation">>(async request => { const { sessionToken: _token, ...original } = request;
      return { request: original, lease: structuredClone(source.state.state.lease), state: source.state.state.state, hostCallbacksDrained: true, outcome: { kind: "closed" } }; }),
    teamRecoverySettlement: vi.fn<Port<"teamRecoverySettlement">>(async request => { const { sessionToken: _token, ...original } = request;
      return { request: original, settlement: { projectId: request.projectId, planId: request.planId, lease: request.baseLease, state: "paused", outcome: { kind: "pending" } } }; }),
    startPlan: vi.fn<Port<"startPlan">>(async () => id(9601)),
  };
  const owner = new ConversationSession(teamContext, vi.fn(), vi.fn(), ports); owners.push(owner);
  await owner.initialize(); expect(await owner.open(key.conversationId)).toBe(true);
  const input = () => { const value = owner.getSnapshot().inputs.get(key.conversationId); if (!value) throw new Error("Missing synthetic conversation"); return value; };
  const draft = () => owner.teamDraft(key.conversationId, link.planId)?.recovery;
  const prepare = async () => { owner.beginTeamRecovery(link, source.status, source.view); owner.editTeamRecovery(link, { instructions: "Original human work A {{literal}} 中文" });
    expect(await owner.flush()).toBe(true); await owner.prepareTeamRecovery(link, source.status, source.view, source.state, () => true); };
  return { source, link, owner, ports, input, draft, prepare, resolved, head: () => structuredClone(head), capture: () => capture! };
}

describe("durable conversation team recovery", () => {
  it("keeps incomplete input, stable tool identities and unrelated text across reopening without restoring permission", async () => {
    const h = await harness(); h.owner.beginTeamRecovery(h.link, h.source.status, h.source.view);
    h.owner.editTeamRecovery(h.link, { instructions: "", recipientKey: null, unitId: null, members: [] });
    h.owner.edit(h.link.conversationId, "Unsubmitted message B"); expect(await h.owner.flush()).toBe(true);
    const restored = new ConversationSession(teamContext, vi.fn(), vi.fn(), h.ports); owners.push(restored);
    await restored.initialize(); await restored.open(h.link.conversationId);
    expect(restored.teamDraft(h.link.conversationId, h.link.planId)?.recovery).toMatchObject({ instructions: "", recipientKey: null, unitId: null, members: [] });
    expect(restored.getSnapshot().inputs.get(h.link.conversationId)?.value.text).toBe("Unsubmitted message B");
    expect(restored.getSnapshot().inputs.get(h.link.conversationId)?.recoveryStates.size).toBe(0);
    expect(h.ports.prepareTeamRecovery).not.toHaveBeenCalled(); expect(h.ports.startPlan).not.toHaveBeenCalled();
  });
  it("acknowledges the exact preparation and authorization before dispatch and retains a non-authoritative receipt", async () => {
    const h = await harness(); await h.prepare(); expect(h.ports.prepareTeamRecovery).toHaveBeenCalledOnce();
    const state = h.input().recoveryStates.get(h.link.planId)!; h.owner.setTeamRecoveryConsent(h.link, true);
    await h.owner.authorizeTeamRecovery(h.link, h.source.status, state.preparedSeq!, () => true, permission);
    expect(h.ports.authorizeTeamRecovery).toHaveBeenCalledOnce(); expect(h.head().value?.pending).toBeNull();
    const recorded = h.head().value?.teamDrafts?.[0].recoveryRecorded; expect(recorded?.request.recovery.work.instructions).toBe(h.draft()?.instructions);
    expect(recorded?.authorization.recovery.actionId).toBe(recorded?.receipt.actionId);
    const readyStatus = structuredClone(h.source.status); readyStatus.state = "active"; readyStatus.lease = recorded!.receipt.effectiveVersion.lease;
    h.ports.planStatus.mockResolvedValue(readyStatus);
    expect(h.owner.canStartTeamRecovery(h.link.conversationId, readyStatus)).toBe(true);
    await h.owner.startTeamRecovery(h.link, readyStatus);
    expect(h.ports.startPlan).toHaveBeenCalledWith(expect.objectContaining({ actionId: recorded!.receipt.actionId, expectedGeneration: recorded!.receipt.effectiveVersion.lease.generation }), recorded!.receipt.attemptId);
    expect(h.owner.canStartTeamRecovery(h.link.conversationId, readyStatus)).toBe(false);
    const restored = new ConversationSession(teamContext, vi.fn(), vi.fn(), h.ports); owners.push(restored); await restored.open(h.link.conversationId);
    expect(restored.canStartTeamRecovery(h.link.conversationId, readyStatus)).toBe(false);
  });
  it("persists newer recovery and composer input while preparation is still waiting", async () => {
    const h = await harness(), pending = deferred<WorkPlanTeamRecoveryPreviewView>();
    h.ports.prepareTeamRecovery.mockImplementation(async request => pending.promise.then(() => teamRecoveryPreviewFixture(request, h.source)));
    const preparing = h.prepare(); await vi.waitFor(() => expect(h.ports.prepareTeamRecovery).toHaveBeenCalledOnce());
    h.owner.editTeamRecovery(h.link, { instructions: "Human B while A waits" }); h.owner.edit(h.link.conversationId, "Independent message C");
    await vi.waitFor(() => { expect(h.head().value?.teamDrafts?.[0].recovery?.instructions).toBe("Human B while A waits"); expect(h.head().value?.text).toBe("Independent message C"); });
    const request = h.ports.prepareTeamRecovery.mock.calls[0][0]; pending.resolve(teamRecoveryPreviewFixture(request, h.source)); await preparing;
    h.owner.setTeamRecoveryConsent(h.link, true); await h.owner.authorizeTeamRecovery(h.link, h.source.status, h.draft()!.editSeq, () => true, permission);
    expect(h.ports.authorizeTeamRecovery).not.toHaveBeenCalled(); expect(h.draft()?.instructions).toBe("Human B while A waits");
    expect(h.input().value.pending?.kind).toBe("team-recovery");
  });
  it("retains newer B during authorization and does not establish a fresh start permission for it", async () => {
    const h = await harness(); await h.prepare(); const capture = h.capture(), received = deferred<Awaited<ReturnType<Port<"authorizeTeamRecovery">>>>();
    h.ports.authorizeTeamRecovery.mockImplementation(async () => received.promise);
    const seq = h.draft()!.editSeq; h.owner.setTeamRecoveryConsent(h.link, true);
    const authorizing = h.owner.authorizeTeamRecovery(h.link, h.source.status, seq, () => true, permission);
    await vi.waitFor(() => expect(h.ports.authorizeTeamRecovery).toHaveBeenCalledOnce()); h.owner.editTeamRecovery(h.link, { instructions: "Later human B" });
    await vi.waitFor(() => expect(h.head().value?.teamDrafts?.[0].recovery?.instructions).toBe("Later human B"));
    received.resolve(teamRecoveryReceiptFixture(h.ports.authorizeTeamRecovery.mock.calls[0][0], capture)); await authorizing;
    expect(h.head().value?.pending).toBeNull(); expect(h.head().value?.teamDrafts?.[0].recovery?.instructions).toBe("Later human B");
    expect(h.input().recoveryStates.get(h.link.planId)?.receipt).toBeNull();
  });
  it("does not settle a lost preparation from closed or absent alone and requires the permanent fence plus drain", async () => {
    const h = await harness(); h.ports.prepareTeamRecovery.mockRejectedValue({ outcome: "unknown", reason: "synthetic-preparation-response-lost" });
    await h.prepare(); const original = structuredClone(h.input().value.pending);
    await h.owner.closeTeamRecovery(h.link); expect(h.input().value.pending).toEqual(original); expect(h.resolved).toHaveLength(0);
    h.source.state.state.lease.generation = String(BigInt(h.source.state.state.lease.generation) + 1n); h.source.state.hostCallbacksDrained = false;
    await h.owner.check(h.link.conversationId); expect(h.input().value.pending).toEqual(original);
    h.source.state.hostCallbacksDrained = true; await h.owner.check(h.link.conversationId);
    expect(h.input().value.pending).toBeNull(); expect(h.resolved[0].resolve.disposition).toBe("fenced-not-applied");
    expect(h.draft()?.instructions).toBe("Original human work A {{literal}} 中文"); expect(h.ports.prepareTeamRecovery).toHaveBeenCalledOnce();
  });
  it("keeps unknown authorization after reopening without resending or granting start permission", async () => {
    const h = await harness(); await h.prepare(); h.owner.setTeamRecoveryConsent(h.link, true);
    h.ports.authorizeTeamRecovery.mockRejectedValue({ outcome: "unknown", reason: "synthetic-authorization-response-lost" });
    await h.owner.authorizeTeamRecovery(h.link, h.source.status, h.draft()!.editSeq, () => true, permission);
    const original = structuredClone(h.input().value.pending); expect(original?.kind === "team-recovery" && original.authorization).toBeTruthy();
    const restored = new ConversationSession(teamContext, vi.fn(), vi.fn(), h.ports); owners.push(restored); await restored.open(h.link.conversationId);
    await restored.check(h.link.conversationId); await restored.retry(h.link.conversationId);
    expect(restored.getSnapshot().inputs.get(h.link.conversationId)?.value.pending).toEqual(original);
    expect(h.ports.authorizeTeamRecovery).toHaveBeenCalledOnce(); expect(h.ports.startPlan).not.toHaveBeenCalled();
  });
  it("rebases recorded role identities without replacing newer human input", async () => {
    const h = await harness(); h.owner.beginTeamRecovery(h.link, h.source.status, h.source.view);
    const member = h.draft()!.members[0]; h.owner.editTeamRecoveryMember(h.link, member.key, { role: "Revised human role A" });
    await h.prepare(); const captured = h.capture(), received = deferred<Awaited<ReturnType<Port<"authorizeTeamRecovery">>>>();
    h.ports.authorizeTeamRecovery.mockImplementation(async () => received.promise); h.owner.setTeamRecoveryConsent(h.link, true);
    const authorizing = h.owner.authorizeTeamRecovery(h.link, h.source.status, h.draft()!.editSeq, () => true, permission);
    await vi.waitFor(() => expect(h.ports.authorizeTeamRecovery).toHaveBeenCalledOnce());
    h.owner.editTeamRecoveryMember(h.link, member.key, { role: "Newer human role B" });
    received.resolve(teamRecoveryReceiptFixture(h.ports.authorizeTeamRecovery.mock.calls[0][0], captured)); await authorizing;
    const retained = h.draft()!.members.find(value => value.key === member.key)!;
    expect(retained.role).toBe("Newer human role B"); expect(retained.original?.role).toBe("Revised human role A");
    expect(retained.original?.roleVersionId).toBe(captured.preview.members[0].roleVersionId);
    expect(h.head().value?.teamDrafts?.[0].recovery?.members[0].role).toBe("Newer human role B");
  });

});

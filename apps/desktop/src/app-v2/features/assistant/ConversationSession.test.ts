import { describe, expect, it, vi } from "vitest";
import { ConversationSession } from "./ConversationSession";
import { canonicalConversationDraft, type ConversationDraftHead, type ConversationDraftPending } from "../../../conversationDraftCommands";
import type { PreparedConversationPlanning, ProjectConversation, ProjectConversationMessage } from "../../../conversationCommands";
import type { conversationCommands } from "../../../conversationCommands";
import type { conversationDraftCommands } from "../../../conversationDraftCommands";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import type { reviewCommands } from "../../../reviewCommands";
import type { WorkspaceSelection } from "../../workspace/workspaceSelection";
import { conversationProposalFixture } from "../../../testSupport/conversationProposalFixture";
import { validateResponseProposal } from "../../../generated/conversations.validators";
import { isCommandError } from "../../../projectCommands";
import { conversationWorkPlanFixture } from "../../../testSupport/conversationWorkPlanFixture";
import { validateResponseProposalWorkPlanReceipt } from "../../../generated/conversations.validators";
import type { ProposalWorkPlanConfirmation } from "./proposalWorkPlan";
import type { workPlanCommands, WorkPlanStatusView } from "../../../workPlanCommands";
import { validateResponseIdentity, validateResponseWorkPlanReceipt, validateResponseWorkPlanStatus, validateResponseWorkPlanStartAction, validateResponseWorkPlanControlAction, validateRequestWorkPlanControl } from "../../../generated/ai.validators";
import type { ConversationRunConfirmation } from "./conversationRun";

const context = { projectId: "10000000-0000-4000-8000-000000000001", sessionToken: "session" };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  let sequence = 1;
  const heads = new Map<string, ConversationDraftHead>();
  const created = new Map<string, ProjectConversation>(), appended = new Map<string, ProjectConversationMessage>();
  const recorded = vi.fn(), reveal = vi.fn();
  const ports = {
    now: vi.fn(() => 100000),
    identity: () => `20000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    read: vi.fn(async (request: { key: ConversationDraftHead["key"] }) => structuredClone(heads.get(request.key.conversationId) ?? { key: request.key, revision: "0", value: null, writerId: null })),
    list: vi.fn(async () => ({ items: [...heads.values()].filter(head => head.value).map(head => ({ key: head.key, revision: head.revision, editSeq: head.value!.editSeq, hasPending: !!head.value!.pending })), next: null })),
  };
  // The fixture journal records acknowledgements independently from the controller's input.
  const write = vi.fn(async (request: Parameters<typeof conversationDraftCommands.write>[0]) => {
    const previous = heads.get(request.write.key.conversationId);
    const head = { ...structuredClone(request.write), revision: String(BigInt(previous?.revision ?? "0") + 1n) };
    const result: unknown = { key: head.key, revision: head.revision, writerId: head.writerId,
      value: canonicalConversationDraft(head.value) };
    if (!validateResponseConversationWritten(result)) throw new Error("Invalid synthetic journal response");
    heads.set(head.key.conversationId, result); return structuredClone(result);
  });
  const resolve = vi.fn(async (request: Parameters<typeof conversationDraftCommands.resolve>[0]) => write({ sessionToken: request.sessionToken, write: request.resolve.write }));
  const create = vi.fn(async (request: Parameters<typeof conversationCommands.create>[0]): Promise<ProjectConversation> => {
    const result = { projectId: request.projectId, conversationId: request.conversationId, title: request.title, ordinal: String(created.size + 1) };
    created.set(request.actionId, result); return result;
  });
  const append = vi.fn(async (request: Parameters<typeof conversationCommands.append>[0]): Promise<ProjectConversationMessage> => {
    const result = { projectId: request.projectId, conversationId: request.conversationId, messageId: request.messageId, body: request.body, author: "human" as const, ordinal: String(appended.size + 1) };
    appended.set(request.actionId, result); return result;
  });
  const recoverCreate = vi.fn(async (request: Parameters<typeof conversationCommands.recoverCreate>[0]) => {
    const { sessionToken: _, ...original } = request, receipt = created.get(request.actionId);
    return { request: original, outcome: receipt ? { kind: "recorded" as const, receipt } : { kind: "pending" as const, replay: "explicit-same-request" as const } };
  });
  const recoverMessage = vi.fn(async (request: Parameters<typeof conversationCommands.recoverMessage>[0]) => {
    const { sessionToken: _, ...original } = request, receipt = appended.get(request.actionId);
    return { request: original, outcome: receipt ? { kind: "recorded" as const, receipt } : { kind: "pending" as const, replay: "explicit-same-request" as const } };
  });
  const recoverPlanning = vi.fn<typeof conversationCommands.recoverPlanning>(), recoverProposalCapture = vi.fn<typeof conversationCommands.recoverProposalCapture>();
  const recoverProposalRevision = vi.fn<typeof conversationCommands.recoverProposalRevision>(), recoverProposalWorkPlan = vi.fn<typeof conversationCommands.recoverProposalWorkPlan>();
  const preparePlanning = vi.fn<typeof conversationCommands.preparePlanning>();
  const validatePlanning = vi.fn<typeof conversationCommands.validatePlanning>(async (_request, expected) => expected);
  const startPlanning = vi.fn<typeof conversationCommands.startPlanning>(async request => ({ projectId: request.projectId, conversationId: request.conversationId, consent: request.consent, inputDigest: "c".repeat(64) }));
  const captureSelection = vi.fn<typeof reviewCommands.captureScope>();
  const captureProposal = vi.fn<typeof conversationCommands.captureProposal>(), reviseProposal = vi.fn<typeof conversationCommands.reviseProposal>();
  const validateProposal = vi.fn<typeof conversationCommands.validateProposal>(), readPlanning = vi.fn<typeof conversationCommands.readPlanning>();
  const prepareProposalWorkPlan = vi.fn<typeof conversationCommands.prepareProposalWorkPlan>(), authorizeProposalWorkPlan = vi.fn<typeof conversationCommands.authorizeProposalWorkPlan>();
  const planStatus = vi.fn<typeof workPlanCommands.status>();
  const startPlan = vi.fn<typeof workPlanCommands.start>(async (_request, expectedAttemptId) => {
    if (!validateResponseIdentity(expectedAttemptId)) throw new Error("Invalid synthetic start identity"); return expectedAttemptId;
  });
  const readPlanStart = vi.fn<typeof workPlanCommands.startAction>(async () => null);
  const controlPlan = vi.fn<typeof workPlanCommands.control>(async request => {
    if (!validateRequestWorkPlanControl(request)) throw new Error("Invalid synthetic control request");
    const state = { pause: "paused", stop: "stopped", "take-over": "taken-over", continue: "active" }[request.command];
    const result: unknown = { actionId: request.actionId, lease: { planId: request.planId, generation: String(BigInt(request.expectedGeneration) + 1n) },
      state, attemptId: request.command === "continue" ? ports.identity() : null, parentTask: null };
    if (!validateResponseWorkPlanReceipt(result)) throw new Error("Invalid synthetic control receipt"); return result;
  });
  const readPlanControl = vi.fn<typeof workPlanCommands.controlAction>(async () => null);
  const all = { ...ports, write, resolve, create, append, recoverCreate, recoverMessage, preparePlanning, validatePlanning, startPlanning, recoverPlanning, recoverProposalCapture, recoverProposalRevision, recoverProposalWorkPlan, captureSelection,
    captureProposal, reviseProposal, validateProposal, readPlanning, prepareProposalWorkPlan, authorizeProposalWorkPlan, planStatus, startPlan, readPlanStart, controlPlan, readPlanControl };
  const make = () => new ConversationSession(context, recorded, reveal, all);
  const owner = make();
  return { owner, make, ports: all, heads, created, appended, recorded, reveal, current: () => {
    const state = owner.getSnapshot(), input = state.activeId ? state.inputs.get(state.activeId) : undefined;
    if (!input) throw new Error("No current conversation input"); return input;
  } };
}

describe("ConversationSession", () => {
  const confirmation: ProposalWorkPlanConfirmation = { effects: ["save-candidate"], checkerExecutions: [], toolExecution: false, applicationToolExecutions: [] };
  async function readyWorkPlan(prepare = true) {
    const h = harness(); await h.owner.initialize(); await h.owner.create();
    const conversationId = h.current().key.conversationId, fixture = conversationWorkPlanFixture({ ...context, conversationId });
    h.ports.validateProposal.mockResolvedValue(fixture.revision); h.ports.readPlanning.mockResolvedValue(fixture.run);
    h.ports.prepareProposalWorkPlan.mockResolvedValue(fixture.prepared);
    const receipt = (request: Parameters<typeof conversationCommands.authorizeProposalWorkPlan>[0]) => {
      const value: unknown = { link: { ...request.authorization.proposal, planId: request.authorization.planId,
        planDigest: request.authorization.planDigest, actionId: request.authorization.actionId, ordinal: "1" },
      receipt: { actionId: request.authorization.actionId, lease: { planId: request.authorization.planId, generation: "1" },
        state: "active", attemptId: fixture.prepared.plan.attemptId, parentTask: null } };
      if (!validateResponseProposalWorkPlanReceipt(value)) throw new Error("Invalid synthetic work-plan receipt"); return value;
    };
    h.ports.authorizeProposalWorkPlan.mockImplementation(async request => receipt(request));
    h.owner.beginWorkPlan(fixture.revision); h.owner.setWorkPlanConfig(conversationId, fixture.config);
    if (prepare) await h.owner.prepareWorkPlan(conversationId);
    return { ...h, ...fixture, conversationId, receipt };
  }
  function checkedStatus(value: unknown): WorkPlanStatusView {
    if (!validateResponseWorkPlanStatus(value)) throw new Error("Invalid synthetic work-plan status"); return value;
  }
  async function readyRun() {
    const h = await readyWorkPlan(); h.owner.setWorkPlanConsent(h.conversationId, true);
    await h.owner.authorizeWorkPlan(h.conversationId, confirmation);
    const authorization = h.ports.authorizeProposalWorkPlan.mock.calls[0][0], authorized = h.receipt(authorization);
    const status = checkedStatus({ plan: h.prepared.plan, lease: authorized.receipt.lease, state: authorized.receipt.state,
      expiresAt: authorization.authorization.expiresAt, effects: authorization.authorization.effects,
      toolInvocations: h.prepared.plan.tools ? { limit: h.prepared.plan.tools.maxInvocations, reserved: 0 } : null });
    h.ports.planStatus.mockResolvedValue(status);
    return { ...h, status, link: authorized.link, authorized: authorized.receipt };
  }
  const runConfirmation = (): ConversationRunConfirmation => ({ minutes: 7, confirmed: true, toolExecution: true,
    checkerExecutions: [{ profile: { id: "example.text-review", schemaVersion: 1, behaviorVersion: 1 },
      provider: { plugin: { publisher: "example", id: "text-review", version: "0.1.0" }, packageDigest: "c".repeat(64), componentId: "worker", contributionId: "text-review-check" } }],
    applicationToolExecutions: [{ instanceId: "30000000-0000-4000-8000-000000000001", activationGeneration: 2 }] });
  function startReceipt(pending: Extract<ConversationDraftPending, { kind: "work-plan-start" }>, taskId: string, attemptId = pending.expectedAttemptId) {
    const result: unknown = { ...pending.request, attemptId, taskId };
    if (!validateResponseWorkPlanStartAction(result) || result === null) throw new Error("Invalid synthetic recorded start"); return result;
  }
  it("uses the direct authorization receipt for a durable start and retains message B and unfinished proposals", async () => {
    const h = await readyRun(), originalWrite = h.ports.write.getMockImplementation()!, ack = deferred<void>();
    for (let index = 0; index < 2; index++) {
      const proposalId = h.ports.identity(); h.owner.beginProposalEdit({ ...h.revision, proposalId });
      h.owner.editProposal(h.conversationId, proposalId, content => ({ ...content, summary: "", questions: [""], unitIds: [] }));
    }
    await h.owner.flush(); const proposals = structuredClone(h.current().value.proposalEdits);
    expect(h.owner.canStartRun(h.conversationId, h.status)).toBe(true);
    h.ports.write.mockImplementationOnce(async request => { const head = await originalWrite(request); await ack.promise; return head; });
    const starting = h.owner.startRun(h.link, h.status);
    await vi.waitFor(() => expect(h.heads.get(h.conversationId)?.value?.pending?.kind).toBe("work-plan-start"));
    expect(h.ports.startPlan).not.toHaveBeenCalled();
    const pending = h.current().value.pending; if (pending?.kind !== "work-plan-start") throw new Error("Missing original start");
    expect(pending).toMatchObject({ conversationId: h.conversationId, expectedAttemptId: h.authorized.attemptId,
      request: { projectId: context.projectId, planId: h.link.planId, actionId: h.authorized.actionId, expectedGeneration: h.authorized.lease.generation } });
    expect(h.heads.get(h.conversationId)?.value?.pending).toEqual(pending);
    expect(JSON.stringify(pending)).not.toContain(context.sessionToken);
    h.owner.edit(h.conversationId, "Message B while starting"); ack.resolve(); await starting; await h.owner.flush();
    expect(h.ports.startPlan).toHaveBeenCalledExactlyOnceWith({ ...context, ...pending.request }, pending.expectedAttemptId);
    expect(h.current().value).toMatchObject({ text: "Message B while starting", pending: null, proposalEdits: proposals });
    expect(h.current().notice).toBe("runStarted"); expect(h.current().readyRuns.size).toBe(0);
    expect(h.ports.controlPlan).not.toHaveBeenCalled();
  });
  it("never restores a start ticket from authorized history after reopening", async () => {
    const h = await readyRun(); expect(h.owner.canStartRun(h.conversationId, h.status)).toBe(true); h.owner.retire();
    const reopened = h.make(); await reopened.initialize(); await reopened.open(h.conversationId);
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.readyRuns.size).toBe(0);
    expect(reopened.canStartRun(h.conversationId, h.status)).toBe(false);
    await reopened.startRun(h.link, h.status);
    expect(h.ports.startPlan).not.toHaveBeenCalled(); expect(h.ports.planStatus).not.toHaveBeenCalled(); reopened.retire();
  });
  it("checks an uncertain start through its exact recorded attempt without redispatching or clearing newer input", async () => {
    const h = await readyRun(); h.ports.startPlan.mockRejectedValueOnce(new Error("Lost start acknowledgement"));
    await h.owner.startRun(h.link, h.status);
    const pending = h.current().value.pending; if (pending?.kind !== "work-plan-start") throw new Error("Missing original start");
    expect(h.current().outcome).toBe("unknown"); h.owner.edit(h.conversationId, "B retained after start check"); await h.owner.flush();
    h.ports.readPlanStart.mockResolvedValueOnce(startReceipt(pending, h.ports.identity()));
    await h.owner.check(h.conversationId); await h.owner.retry(h.conversationId);
    expect(h.ports.readPlanStart).toHaveBeenCalledExactlyOnceWith({ ...context, ...pending.request });
    expect(h.ports.startPlan).toHaveBeenCalledOnce(); expect(h.current().readyRuns.size).toBe(0);
    expect(h.current().value).toMatchObject({ text: "B retained after start check", pending: null });
    expect(h.current().notice).toBe("runStarted");
  });
  it("retries an absent start only explicitly in the same session with the original action, generation and attempt", async () => {
    const h = await readyRun(); h.ports.startPlan.mockRejectedValueOnce(new Error("Lost start acknowledgement"));
    await h.owner.startRun(h.link, h.status);
    const pending = h.current().value.pending; if (pending?.kind !== "work-plan-start") throw new Error("Missing original start");
    await h.owner.check(h.conversationId);
    expect(h.current().outcome).toBe("absent"); expect(h.owner.canRetryRun(h.conversationId)).toBe(true);
    expect(h.ports.startPlan).toHaveBeenCalledOnce();
    await h.owner.retry(h.conversationId);
    expect(h.ports.readPlanStart).toHaveBeenCalledTimes(2);
    expect(h.ports.startPlan.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ ...context, ...pending.request }, pending.expectedAttemptId]));
    expect(h.current().value.pending).toBeNull(); expect(h.current().readyRuns.size).toBe(0);
  });
  it("blocks an absent start after reopening while preserving the original request and message input", async () => {
    const h = await readyRun(); h.ports.startPlan.mockRejectedValueOnce(new Error("Lost start acknowledgement"));
    await h.owner.startRun(h.link, h.status);
    const pending = structuredClone(h.current().value.pending); h.owner.edit(h.conversationId, "B after uncertain start"); await h.owner.flush(); h.owner.retire();
    h.ports.planStatus.mockClear(); const reopened = h.make(); await reopened.initialize(); await reopened.open(h.conversationId);
    expect(h.ports.readPlanStart).not.toHaveBeenCalled();
    await reopened.check(h.conversationId); await reopened.retry(h.conversationId);
    expect(reopened.getSnapshot().inputs.get(h.conversationId)).toMatchObject({ outcome: "blocked", value: { text: "B after uncertain start", pending } });
    expect(reopened.canRetryRun(h.conversationId)).toBe(false); expect(h.ports.startPlan).toHaveBeenCalledOnce();
    expect(h.ports.planStatus).not.toHaveBeenCalled(); reopened.retire();
  });
  it("keeps an uncertain start unresolved when the recorded attempt does not match", async () => {
    const h = await readyRun(); h.ports.startPlan.mockRejectedValueOnce(new Error("Lost start acknowledgement"));
    await h.owner.startRun(h.link, h.status);
    const pending = h.current().value.pending; if (pending?.kind !== "work-plan-start") throw new Error("Missing original start");
    h.ports.readPlanStart.mockResolvedValueOnce(startReceipt(pending, h.ports.identity(), h.ports.identity()));
    await h.owner.check(h.conversationId); await h.owner.retry(h.conversationId);
    expect(h.current().outcome).toBe("mismatch"); expect(h.current().value.pending).toEqual(pending);
    expect(h.ports.startPlan).toHaveBeenCalledOnce(); expect(h.owner.canRetryRun(h.conversationId)).toBe(false);
  });
  it.each(["pause", "stop", "take-over"] as const)("journals %s at the exact generation without connection consent or a new expiry", async command => {
    const h = await readyRun(); h.owner.retire(); const reopened = h.make(); await reopened.initialize(); await reopened.open(h.conversationId);
    const status = checkedStatus({ ...h.status, lease: { ...h.status.lease, generation: "9007199254740993" }, expiresAt: "0" });
    h.ports.planStatus.mockResolvedValue(status); await reopened.controlRun(h.link, status, command);
    expect(h.ports.controlPlan).toHaveBeenCalledOnce();
    const request = h.ports.controlPlan.mock.calls[0][0];
    expect(request).toEqual({ ...context, planId: h.link.planId, actionId: expect.any(String), expectedGeneration: "9007199254740993", command,
      confirmed: false, checkerExecutions: [], toolExecution: false, applicationToolExecutions: [], expiresAt: null });
    const pendingWrite = h.ports.write.mock.calls.map(([request]) => request.write.value.pending).find(pending => pending?.kind === "work-plan-control");
    expect(pendingWrite).toMatchObject({ conversationId: h.conversationId, request: { actionId: request.actionId, expectedGeneration: request.expectedGeneration } });
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.value.pending).toBeNull();
    expect(h.ports.startPlan).not.toHaveBeenCalled(); expect(h.ports.prepareProposalWorkPlan).toHaveBeenCalledOnce(); reopened.retire();
  });
  it.each(["paused", "taken-over"] as const)("continues a %s ordinary plan only with fresh complete confirmation and leaves a ticket without starting", async state => {
    const h = await readyRun(), status = checkedStatus({ ...h.status, state, lease: { ...h.status.lease, generation: "8" }, expiresAt: "1" });
    h.ports.planStatus.mockResolvedValue(status);
    await h.owner.controlRun(h.link, status, "continue");
    await h.owner.controlRun(h.link, status, "continue", { ...runConfirmation(), confirmed: false });
    await h.owner.controlRun(h.link, status, "continue", { ...runConfirmation(), minutes: 0 });
    for (const invalidState of ["active", "stopped"] as const) await h.owner.controlRun(h.link, checkedStatus({ ...status, state: invalidState }), "continue", runConfirmation());
    expect(h.ports.controlPlan).not.toHaveBeenCalled(); expect(h.ports.planStatus).not.toHaveBeenCalled();
    const originalWrite = h.ports.write.getMockImplementation()!, ack = deferred<void>(), confirmation = runConfirmation(), frozen = structuredClone(confirmation);
    h.ports.write.mockImplementationOnce(async request => { const head = await originalWrite(request); await ack.promise; return head; });
    const continuing = h.owner.controlRun(h.link, status, "continue", confirmation);
    await vi.waitFor(() => expect(h.heads.get(h.conversationId)?.value?.pending?.kind).toBe("work-plan-control"));
    const pending = h.current().value.pending; if (pending?.kind !== "work-plan-control") throw new Error("Missing original continuation");
    expect(h.ports.controlPlan).not.toHaveBeenCalled();
    expect(pending.request).toMatchObject({ command: "continue", expectedGeneration: "8", confirmed: true, checkerExecutions: frozen.checkerExecutions,
      toolExecution: frozen.toolExecution, applicationToolExecutions: frozen.applicationToolExecutions, expiresAt: "520" });
    confirmation.minutes = 30; confirmation.checkerExecutions[0].profile.behaviorVersion = 2; confirmation.applicationToolExecutions[0].activationGeneration = 3;
    h.ports.now.mockReturnValue(200000); h.owner.edit(h.conversationId, "B while continuing"); ack.resolve(); await continuing; await h.owner.flush();
    expect(h.ports.controlPlan).toHaveBeenCalledExactlyOnceWith({ ...context, ...pending.request });
    expect(h.ports.startPlan).not.toHaveBeenCalled(); expect(h.current().value).toMatchObject({ text: "B while continuing", pending: null });
    const receipt = await h.ports.controlPlan.mock.results[0].value;
    expect(h.current().readyRuns.get(h.link.planId)?.receipt).toEqual(receipt);
    const active = checkedStatus({ ...status, state: "active", lease: receipt.lease, expiresAt: pending.request.expiresAt });
    expect(h.owner.canStartRun(h.conversationId, active)).toBe(true); expect(h.current().notice).toBe("runContinued");
  });
  it("blocks an uncertain continuation with no receipt across reopening without renewing its fixed expiry", async () => {
    const h = await readyRun(), status = checkedStatus({ ...h.status, state: "paused" });
    h.ports.planStatus.mockResolvedValue(status); h.ports.controlPlan.mockRejectedValueOnce(new Error("Lost continuation acknowledgement"));
    await h.owner.controlRun(h.link, status, "continue", runConfirmation());
    const pending = h.current().value.pending; if (pending?.kind !== "work-plan-control") throw new Error("Missing original continuation");
    h.ports.now.mockReturnValue(200000); await h.owner.check(h.conversationId); await h.owner.retry(h.conversationId);
    expect(h.current().outcome).toBe("blocked"); expect(h.owner.canRetryRun(h.conversationId)).toBe(false); h.owner.retire();
    const reopened = h.make(); await reopened.initialize(); await reopened.open(h.conversationId); await reopened.check(h.conversationId); await reopened.retry(h.conversationId);
    expect(reopened.getSnapshot().inputs.get(h.conversationId)).toMatchObject({ outcome: "blocked", value: { pending } });
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.readyRuns.size).toBe(0);
    expect(h.ports.readPlanControl.mock.calls.map(([request]) => request)).toEqual(Array.from({ length: 2 }, () => ({ ...context, ...pending.request })));
    expect(pending.request.expiresAt).toBe("520"); expect(h.ports.controlPlan).toHaveBeenCalledOnce(); expect(h.ports.startPlan).not.toHaveBeenCalled(); reopened.retire();
  });
  it("settles a recorded continuation through its Core transition without restoring a fresh start ticket", async () => {
    const h = await readyRun(), status = checkedStatus({ ...h.status, state: "paused" });
    h.ports.planStatus.mockResolvedValue(status); h.ports.controlPlan.mockRejectedValueOnce(new Error("Lost continuation acknowledgement"));
    await h.owner.controlRun(h.link, status, "continue", runConfirmation());
    const pending = h.current().value.pending; if (pending?.kind !== "work-plan-control") throw new Error("Missing original continuation");
    const value: unknown = { projectId: context.projectId, request: { kind: "control", planId: pending.request.planId, actionId: pending.request.actionId,
      expectedGeneration: pending.request.expectedGeneration, command: pending.request.command, confirmed: pending.request.confirmed, expiresAt: pending.request.expiresAt },
    receipt: { actionId: pending.request.actionId, lease: { planId: pending.request.planId, generation: String(BigInt(pending.request.expectedGeneration) + 1n) },
      state: "active", attemptId: h.ports.identity(), parentTask: null } };
    if (!validateResponseWorkPlanControlAction(value) || value === null) throw new Error("Invalid synthetic recorded continuation");
    h.ports.readPlanControl.mockResolvedValueOnce(value); await h.owner.check(h.conversationId);
    expect(h.current().value.pending).toBeNull(); expect(h.current().readyRuns.size).toBe(0);
    expect(h.ports.controlPlan).toHaveBeenCalledOnce(); expect(h.ports.startPlan).not.toHaveBeenCalled();
  });
  it("retains the original start when its fresh ticket expires while waiting for the journal acknowledgement", async () => {
    const h = await readyRun(), originalWrite = h.ports.write.getMockImplementation()!, ack = deferred<void>();
    h.ports.write.mockImplementationOnce(async request => { const head = await originalWrite(request); await ack.promise; return head; });
    const starting = h.owner.startRun(h.link, h.status);
    await vi.waitFor(() => expect(h.heads.get(h.conversationId)?.value?.pending?.kind).toBe("work-plan-start"));
    const pending = structuredClone(h.current().value.pending);
    h.ports.now.mockReturnValue(Number(BigInt(h.status.expiresAt) * 1000n)); ack.resolve(); await starting;
    expect(h.ports.startPlan).not.toHaveBeenCalled(); expect(h.current().value.pending).toEqual(pending);
    expect(h.heads.get(h.conversationId)?.value?.pending).toEqual(pending);
  });
  describe.each(["start", "continue"] as const)("%s dispatch guard", action => {
    it.each(["hide", "retire"] as const)("retains the durable original request when the owner is %s before journal acknowledgement", async guard => {
      const h = await readyRun(), status = checkedStatus({ ...h.status, state: action === "continue" ? "paused" : "active" });
      h.ports.planStatus.mockResolvedValue(status);
      const originalWrite = h.ports.write.getMockImplementation()!, ack = deferred<void>();
      h.ports.write.mockImplementationOnce(async request => { const head = await originalWrite(request); await ack.promise; return head; });
      let visible = true;
      const running = action === "start" ? h.owner.startRun(h.link, status, () => visible) : h.owner.controlRun(h.link, status, "continue", runConfirmation(), () => visible);
      await vi.waitFor(() => expect(h.heads.get(h.conversationId)?.value?.pending?.kind).toBe(action === "start" ? "work-plan-start" : "work-plan-control"));
      const pending = structuredClone(h.current().value.pending);
      if (guard === "hide") visible = false; else h.owner.retire();
      ack.resolve(); await running;
      expect(h.ports.startPlan).not.toHaveBeenCalled(); expect(h.ports.controlPlan).not.toHaveBeenCalled();
      expect(h.current().value.pending).toEqual(pending); expect(h.heads.get(h.conversationId)?.value?.pending).toEqual(pending);
    });
    it("rejects a changed current status before journaling or dispatching and retains local input", async () => {
      const h = await readyRun(), status = checkedStatus({ ...h.status, state: action === "continue" ? "paused" : "active" });
      h.owner.edit(h.conversationId, "B retained after status changed"); await h.owner.flush();
      h.ports.planStatus.mockResolvedValue(checkedStatus({ ...status, lease: { ...status.lease, generation: "2" } }));
      const writes = h.ports.write.mock.calls.length;
      if (action === "start") await h.owner.startRun(h.link, status); else await h.owner.controlRun(h.link, status, "continue", runConfirmation());
      expect(h.ports.startPlan).not.toHaveBeenCalled(); expect(h.ports.controlPlan).not.toHaveBeenCalled();
      expect(h.ports.write).toHaveBeenCalledTimes(writes); expect(h.current().runFailure?.planId).toBe(h.link.planId);
      expect(h.current().value).toMatchObject({ text: "B retained after status changed", pending: null });
    });
  });
  it("prepares the exact saved proposal and keeps incomplete questions or a local edit out of confirmation", async () => {
    const h = await readyWorkPlan(false);
    h.owner.beginWorkPlan({ ...h.revision, revisionId: h.ports.identity(), content: { ...h.revision.content, questions: ["Which voice?"] } });
    h.owner.setWorkPlanConfig(h.conversationId, h.config);
    await h.owner.prepareWorkPlan(h.conversationId); expect(h.ports.prepareProposalWorkPlan).not.toHaveBeenCalled();
    h.owner.setWorkPlanOpen(h.conversationId, false); h.owner.beginWorkPlan(h.revision);
    h.owner.setWorkPlanConfig(h.conversationId, h.config);
    h.owner.beginProposalEdit(h.revision); await h.owner.flush();
    await h.owner.prepareWorkPlan(h.conversationId); expect(h.ports.prepareProposalWorkPlan).not.toHaveBeenCalled();
    const edit = h.current().value.proposalEdits![0]; h.owner.discardProposalEdit(h.conversationId, edit.proposalId, edit.editSeq); await h.owner.flush();
    await h.owner.prepareWorkPlan(h.conversationId);
    expect(h.ports.prepareProposalWorkPlan).toHaveBeenCalledOnce();
    expect(h.ports.prepareProposalWorkPlan.mock.calls[0][0]).toMatchObject({ proposal: { proposalId: h.revision.proposalId, revisionId: h.current().workPlan.revision?.revisionId }, toolSelection: null, advisoryChecks: [] });
    expect(h.ports.authorizeProposalWorkPlan).not.toHaveBeenCalled(); expect(h.ports.startPlanning).not.toHaveBeenCalled();
  });
  it("drops late plan preparations after edits or closing without restoring consent", async () => {
    const h = await readyWorkPlan(false), response = deferred<typeof h.prepared>();
    h.ports.prepareProposalWorkPlan.mockReturnValueOnce(response.promise);
    const prepare = h.owner.prepareWorkPlan(h.conversationId);
    await vi.waitFor(() => expect(h.ports.prepareProposalWorkPlan).toHaveBeenCalledOnce());
    h.owner.setWorkPlanConfig(h.conversationId, before => ({ ...before, maxRequests: before.maxRequests + 1 }));
    response.resolve(h.prepared); await prepare;
    expect(h.current().workPlan.prepared).toBeNull(); expect(h.current().workPlan.consent).toBe(false);
    await h.owner.prepareWorkPlan(h.conversationId); h.owner.setWorkPlanConsent(h.conversationId, true);
    h.owner.setWorkPlanOpen(h.conversationId, false);
    expect(h.current().workPlan).toMatchObject({ open: false, prepared: null, consent: false, executionConsent: { checkers: [], tools: null, applications: [] } });
  });
  it("coordinates the single Host preparation slot across conversations", async () => {
    const h = await readyWorkPlan(), firstId = h.conversationId, secondId = h.ports.identity();
    await h.owner.open(secondId);
    const second = conversationWorkPlanFixture({ ...context, conversationId: secondId });
    h.owner.beginWorkPlan(second.revision); h.owner.setWorkPlanConfig(secondId, second.config);
    h.ports.validateProposal.mockResolvedValue(second.revision); h.ports.readPlanning.mockResolvedValue(second.run);
    const response = deferred<typeof second.prepared>(); h.ports.prepareProposalWorkPlan.mockReturnValueOnce(response.promise);
    const preparing = h.owner.prepareWorkPlan(secondId);
    await vi.waitFor(() => expect(h.ports.prepareProposalWorkPlan).toHaveBeenCalledTimes(2));
    expect(h.owner.getSnapshot().inputs.get(firstId)?.workPlan.prepared).toBeNull();
    await h.owner.prepareWorkPlan(firstId); expect(h.ports.prepareProposalWorkPlan).toHaveBeenCalledTimes(2);
    response.resolve(second.prepared); await preparing;
    expect(h.owner.getSnapshot().inputs.get(secondId)?.workPlan.prepared?.proposal.conversationId).toBe(secondId);
  });
  it("journals complete work-plan confirmation before authorization and preserves concurrent message input", async () => {
    const h = await readyWorkPlan(), originalWrite = h.ports.write.getMockImplementation()!, ack = deferred<ConversationDraftHead>();
    h.owner.setWorkPlanMinutes(h.conversationId, 7); h.owner.setWorkPlanConsent(h.conversationId, true);
    h.ports.write.mockImplementationOnce(async request => { const head = await originalWrite(request); await ack.promise; return head; });
    const authorization = h.owner.authorizeWorkPlan(h.conversationId, confirmation);
    await vi.waitFor(() => expect(h.current().value.pending?.kind).toBe("proposal-work-plan"));
    expect(h.ports.authorizeProposalWorkPlan).not.toHaveBeenCalled();
    const pending = h.current().value.pending; if (pending?.kind !== "proposal-work-plan") throw new Error("Missing plan confirmation");
    expect(pending.request).toMatchObject({ ...confirmation, proposal: h.prepared.proposal, planId: h.prepared.plan.planId,
      planDigest: h.prepared.plan.digest, expiresAt: "520", confirmed: true });
    expect(JSON.stringify(pending)).not.toContain(context.sessionToken);
    h.owner.edit(h.conversationId, "Message B while confirming the plan");
    ack.resolve(h.heads.get(h.conversationId)!); await authorization; await h.owner.flush();
    expect(h.ports.authorizeProposalWorkPlan.mock.calls.map(([request]) => request)).toEqual([{ ...context, authorization: pending.request }]);
    expect(h.current().value).toMatchObject({ text: "Message B while confirming the plan", pending: null });
    expect(h.current().workPlan.prepared).toBeNull(); expect(h.current().notice).toBe("workPlanRecorded");
    expect(h.ports.startPlanning).not.toHaveBeenCalled();
  });
  it("retains a journaled plan when presentation changes before dispatch and never replays it after reopening", async () => {
    const h = await readyWorkPlan(), originalWrite = h.ports.write.getMockImplementation()!, ack = deferred<ConversationDraftHead>();
    h.owner.setWorkPlanConsent(h.conversationId, true);
    h.ports.write.mockImplementationOnce(async request => { const head = await originalWrite(request); await ack.promise; return head; });
    let visible = true; const authorization = h.owner.authorizeWorkPlan(h.conversationId, confirmation, () => visible);
    await vi.waitFor(() => expect(h.current().value.pending?.kind).toBe("proposal-work-plan")); visible = false;
    ack.resolve(h.heads.get(h.conversationId)!); await authorization;
    expect(h.ports.authorizeProposalWorkPlan).not.toHaveBeenCalled();
    const pending = h.current().value.pending; if (pending?.kind !== "proposal-work-plan") throw new Error("Missing plan confirmation");
    const reopened = h.make(); await reopened.initialize(); await reopened.open(h.conversationId);
    h.ports.recoverProposalWorkPlan.mockResolvedValueOnce({ request: pending.request, outcome: { kind: "pending", replay: "blocked" } });
    await reopened.check(h.conversationId); await reopened.retry(h.conversationId);
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.outcome).toBe("blocked");
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.value.pending).toEqual(pending);
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.workPlan.prepared).toBeNull();
    expect(h.ports.authorizeProposalWorkPlan).not.toHaveBeenCalled(); reopened.retire();
  });
  it("settles an uncertain authorization only through its exact recorded link without renewing preparation", async () => {
    const h = await readyWorkPlan(); h.owner.setWorkPlanConsent(h.conversationId, true);
    h.ports.authorizeProposalWorkPlan.mockRejectedValueOnce(new Error("Lost authorization acknowledgement"));
    await h.owner.authorizeWorkPlan(h.conversationId, confirmation);
    const pending = h.current().value.pending; if (pending?.kind !== "proposal-work-plan") throw new Error("Missing plan confirmation");
    h.owner.edit(h.conversationId, "Keep this message after checking"); await h.owner.flush();
    h.ports.recoverProposalWorkPlan.mockResolvedValueOnce({ request: pending.request, outcome: { kind: "recorded", receipt: h.receipt({ ...context, authorization: pending.request }).link } });
    await h.owner.check(h.conversationId);
    expect(h.current().value).toMatchObject({ text: "Keep this message after checking", pending: null });
    expect(h.current().workPlan).toMatchObject({ prepared: null, consent: false });
    await h.owner.retry(h.conversationId); expect(h.ports.authorizeProposalWorkPlan).toHaveBeenCalledOnce();
  });
  async function readyProposal() {
    const h = harness(); await h.owner.initialize(); await h.owner.create();
    const conversationId = h.current().key.conversationId, fixture = conversationProposalFixture({ projectId: context.projectId, conversationId });
    h.ports.validateProposal.mockResolvedValue(fixture.revision); h.ports.readPlanning.mockResolvedValue(fixture.run);
    const revisionReceipt = (request: Parameters<typeof conversationCommands.reviseProposal>[0]) => {
      const value: unknown = { ...fixture.revision, revisionId: request.revisionId, previousRevisionId: request.expectedRevisionId, revision: "2", ordinal: "2", content: request.content };
      if (!validateResponseProposal(value)) throw new Error("Invalid synthetic proposal receipt"); return value;
    };
    h.ports.reviseProposal.mockImplementation(async request => revisionReceipt(request));
    h.ports.captureProposal.mockImplementation(async request => ({ ...fixture.revision, proposalId: request.proposalId, revisionId: request.revisionId }));
    h.owner.beginProposalEdit(fixture.revision); await h.owner.flush();
    return { ...h, ...fixture, conversationId, revisionReceipt };
  }
  it("journals unfinished proposal fields and separate message input across reopening without saving a project revision", async () => {
    const h = await readyProposal();
    h.owner.editProposal(h.conversationId, h.revision.proposalId, value => ({ ...value, summary: "", questions: [""], unitIds: [] }));
    h.owner.edit(h.conversationId, "独立的消息输入"); await h.owner.flush();
    const reopened = h.make(); await reopened.initialize(); await reopened.open(h.conversationId);
    const value = reopened.getSnapshot().inputs.get(h.conversationId)?.value;
    expect(value?.text).toBe("独立的消息输入"); expect(value?.proposalEdits?.[0].content).toMatchObject({ summary: "", questions: [""], unitIds: [] });
    expect(h.ports.reviseProposal).not.toHaveBeenCalled(); expect(h.ports.startPlanning).not.toHaveBeenCalled(); reopened.retire();
  });
  it("keeps B, another proposal and message input through A's business and journal acknowledgements", async () => {
    const h = await readyProposal(), business = deferred<Awaited<ReturnType<typeof conversationCommands.reviseProposal>>>();
    h.owner.editProposal(h.conversationId, h.revision.proposalId, value => ({ ...value, summary: "Version A" })); await h.owner.flush();
    h.ports.reviseProposal.mockReturnValueOnce(business.promise);
    const originalResolve = h.ports.resolve.getMockImplementation()!, resolvedFrame = deferred<ConversationDraftHead>(), localAck = deferred<ConversationDraftHead>();
    h.ports.resolve.mockImplementationOnce(async request => { const head = await originalResolve(request); resolvedFrame.resolve(head); return localAck.promise; });
    const saving = h.owner.saveProposal(h.conversationId, h.revision.proposalId);
    await vi.waitFor(() => expect(h.ports.reviseProposal).toHaveBeenCalledOnce());
    const request = h.ports.reviseProposal.mock.calls[0][0];
    expect(h.heads.get(h.conversationId)?.value?.pending).toMatchObject({ kind: "proposal-revision", request: { content: { summary: "Version A" } } });
    h.owner.editProposal(h.conversationId, h.revision.proposalId, value => ({ ...value, summary: "Newer B" }));
    h.owner.edit(h.conversationId, "Message B");
    const other = { ...h.revision, proposalId: h.ports.identity(), revisionId: h.ports.identity() }; h.owner.beginProposalEdit(other);
    business.resolve(h.revisionReceipt(request));
    const frame = await resolvedFrame.promise;
    h.owner.editProposal(h.conversationId, h.revision.proposalId, value => ({ ...value, summary: "Newest B while journal ack waits" }));
    localAck.resolve(frame); await saving; await h.owner.flush();
    expect(h.current().value.text).toBe("Message B");
    expect(h.current().value.proposalEdits?.find(edit => edit.proposalId === h.revision.proposalId)).toMatchObject({ expectedRevisionId: request.revisionId, content: { summary: "Newest B while journal ack waits" } });
    expect(h.current().value.proposalEdits?.find(edit => edit.proposalId === other.proposalId)?.expectedRevisionId).toBe(other.revisionId);
    expect(h.heads.get(h.conversationId)?.value).toEqual(h.current().value); expect(h.ports.reviseProposal).toHaveBeenCalledOnce();
  });
  it.each(["proposal-only", "message-edited-back"] as const)("settles message A independently of %s changes without dropping proposal input", async kind => {
    const h = await readyProposal(), response = deferred<ProjectConversationMessage>();
    h.owner.edit(h.conversationId, "Message A"); await h.owner.flush();
    const append = h.ports.append.getMockImplementation()!; h.ports.append.mockReturnValueOnce(response.promise);
    const sending = h.owner.append(h.conversationId); await vi.waitFor(() => expect(h.ports.append).toHaveBeenCalledOnce());
    h.owner.editProposal(h.conversationId, h.revision.proposalId, value => ({ ...value, summary: "Proposal B" }));
    if (kind === "message-edited-back") { h.owner.edit(h.conversationId, "Message B"); h.owner.edit(h.conversationId, "Message A"); }
    response.resolve(await append(h.ports.append.mock.calls[0][0])); await sending; await h.owner.flush();
    expect(h.current().value.text).toBe(kind === "proposal-only" ? "" : "Message A");
    expect(h.current().value.proposalEdits?.[0].content.summary).toBe("Proposal B");
  });
  it("does not create a request for stale or newly edited proposal input, and explicitly rebases without replacing it", async () => {
    const h = await readyProposal(), validation = deferred<Awaited<ReturnType<typeof conversationCommands.validateProposal>>>();
    h.ports.validateProposal.mockReturnValueOnce(validation.promise);
    const saving = h.owner.saveProposal(h.conversationId, h.revision.proposalId);
    h.owner.editProposal(h.conversationId, h.revision.proposalId, value => ({ ...value, summary: "Newer draft" })); validation.resolve(h.revision); await saving;
    expect(h.ports.readPlanning).not.toHaveBeenCalled(); expect(h.current().value.pending).toBeNull();
    await h.owner.flush();
    h.ports.validateProposal.mockRejectedValueOnce(new Error("The proposal head changed")); await h.owner.saveProposal(h.conversationId, h.revision.proposalId);
    expect(h.current().proposalFailure?.proposalId).toBe(h.revision.proposalId); expect(h.ports.reviseProposal).not.toHaveBeenCalled();
    const latest = { ...h.revision, revisionId: h.ports.identity(), revision: "2", ordinal: "2", previousRevisionId: h.revision.revisionId };
    expect(h.owner.acceptProposalBase(latest, "0")).toBe(false);
    const edit = h.current().value.proposalEdits![0]; expect(h.owner.acceptProposalBase(latest, edit.editSeq)).toBe(true);
    expect(h.current().value.proposalEdits?.[0]).toMatchObject({ expectedRevisionId: latest.revisionId, content: { summary: "Newer draft" } });
  });
  it("recovers an uncertain original revision after reopening and retains newer edits without replay", async () => {
    const h = await readyProposal(); h.ports.reviseProposal.mockRejectedValueOnce(new Error("Lost acknowledgement"));
    await h.owner.saveProposal(h.conversationId, h.revision.proposalId);
    const pending = h.current().value.pending; if (pending?.kind !== "proposal-revision") throw new Error("Missing revision request");
    h.owner.editProposal(h.conversationId, h.revision.proposalId, value => ({ ...value, summary: "Keep newer input" })); await h.owner.flush();
    const reopened = h.make(); await reopened.initialize(); await reopened.open(h.conversationId); await reopened.retry(h.conversationId);
    h.ports.recoverProposalRevision.mockResolvedValueOnce({ request: pending.request, outcome: { kind: "recorded", receipt: h.revisionReceipt({ ...pending.request, sessionToken: context.sessionToken }) } });
    await reopened.check(h.conversationId);
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.value.proposalEdits?.[0]).toMatchObject({ expectedRevisionId: pending.request.revisionId, content: { summary: "Keep newer input" } });
    expect(h.ports.reviseProposal).toHaveBeenCalledOnce(); expect(h.ports.startPlanning).not.toHaveBeenCalled(); reopened.retire();
  });
  it("retries a local revision only after explicit original-request recovery allows it", async () => {
    const h = await readyProposal(); h.ports.reviseProposal.mockRejectedValueOnce(new Error("No acknowledgement"));
    await h.owner.saveProposal(h.conversationId, h.revision.proposalId);
    const pending = h.current().value.pending; if (pending?.kind !== "proposal-revision") throw new Error("Missing revision request");
    await h.owner.retry(h.conversationId); expect(h.ports.reviseProposal).toHaveBeenCalledOnce();
    h.ports.recoverProposalRevision.mockResolvedValueOnce({ request: pending.request, outcome: { kind: "pending", replay: "explicit-same-request" } });
    await h.owner.check(h.conversationId); await h.owner.retry(h.conversationId);
    expect(h.ports.reviseProposal.mock.calls.map(call => call[0])).toEqual([{ sessionToken: context.sessionToken, ...pending.request }, { sessionToken: context.sessionToken, ...pending.request }]);
    expect(h.current().value.pending).toBeNull();
  });
  it("captures a proposal once, preserves drafts, and never sends it before its journal acknowledgement", async () => {
    const h = await readyProposal(), written = h.ports.write.getMockImplementation()!, hold = deferred<ConversationDraftHead>();
    h.ports.write.mockImplementationOnce(async request => { const value = await written(request); await hold.promise; return value; });
    const capture = h.owner.captureProposal(h.run);
    await vi.waitFor(() => expect(h.current().value.pending?.kind).toBe("proposal-capture"));
    expect(h.ports.captureProposal).not.toHaveBeenCalled(); hold.resolve(h.heads.get(h.conversationId)!); await capture;
    await h.owner.captureProposal(h.run); expect(h.ports.captureProposal).toHaveBeenCalledOnce();
    expect(h.current().value.proposalEdits).toHaveLength(1); expect(h.current().capturedResultIds).toContain(h.run.resultId);
    expect(h.ports.startPlanning).not.toHaveBeenCalled();
  });
  it("lets reduced input replace a journal frame rejected for size but keeps uncertain frames for exact retry", async () => {
    const h = await readyProposal();
    const failure = { code: "limit-exceeded", stage: "draft-storage", outcome: "rejected", recoveryRequired: false, reason: "drafts-record-size" };
    expect(isCommandError(failure)).toBe(true);
    h.ports.write.mockRejectedValueOnce(failure); h.owner.editProposal(h.conversationId, h.revision.proposalId, value => ({ ...value, summary: "Too large draft input" }));
    await vi.waitFor(() => expect(h.current().failure?.kind).toBe("journal"));
    h.owner.editProposal(h.conversationId, h.revision.proposalId, value => ({ ...value, summary: "Reduced input" })); await h.owner.retryJournal(h.conversationId);
    expect(h.current().failure).toBeNull(); expect(h.heads.get(h.conversationId)?.value?.proposalEdits?.[0].content.summary).toBe("Reduced input");
  });
  async function readyToPlan() {
    const h = harness(); await h.owner.initialize(); await h.owner.create();
    const conversationId = h.current().key.conversationId, messageId = h.ports.identity();
    h.owner.setPlanningOpen(conversationId, true);
    h.owner.setPlanningMessages(conversationId, [messageId]);
    h.owner.setPlanningConfig(conversationId, before => ({ ...before, endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "fixture", maxRequests: 50, maxRetries: 2 }));
    const config = h.current().planning.config;
    const prepared: PreparedConversationPlanning = { preparationId: h.ports.identity(), previewDigest: "d".repeat(64), preview: {
      version: 2, projectId: context.projectId, conversationId, config, scope: { kind: "conversation-only" }, units: [],
      selectedMessages: [{ projectId: context.projectId, conversationId, messageId, author: "human", ordinal: "1", body: "Discuss this message" }],
      system: "Synthetic instructions", input: "Synthetic message", byteLength: 100,
      brief: { messages: 1, units: 0, sourceTexts: 0, terms: 0, manualContexts: 0, manualContextFacts: 0, sourceContextFacts: 0, sourceContextNeighbors: 0 },
    } };
    h.ports.preparePlanning.mockResolvedValue(prepared);
    return { ...h, conversationId, messageId, prepared };
  }
  async function readyWithUnits() {
    const h = await readyToPlan(), id = h.ports.identity;
    const scope: Extract<WorkspaceSelection, { kind: "scope" }> = { kind: "scope", query: { text: "fixed query", selection: "all", status: "all" }, selection: {
      ...context, excluded: [id()], capture: { scopeId: id(), sourceSnapshotId: id(), locale: "zh-CN", query: "fixed query", readVersion: "a".repeat(64),
        units: [0, 1, 2].map(() => ({ unitId: id(), expectedBasis: "b".repeat(64), expectedDecisionId: null })) },
    } };
    scope.selection.excluded = [scope.selection.capture.units[1].unitId];
    const members = scope.selection.capture.units.filter(unit => !scope.selection.excluded.includes(unit.unitId));
    h.owner.setPlanningSelection(h.conversationId, scope);
    h.owner.setPlanningConfig(h.conversationId, before => ({ ...before, shareTerms: true, shareContext: true }));
    const prepared: PreparedConversationPlanning = { ...h.prepared, preview: { ...h.prepared.preview, config: h.current().planning.config,
      scope: { kind: "units", locale: "zh-CN", unitIds: members.map(unit => unit.unitId) },
      units: members.map(unit => ({ unitId: unit.unitId, sourceSnapshotId: scope.selection.capture.sourceSnapshotId, sourceRevisionId: id(), selectionId: null, translationRevisionId: null,
        protection: { unitId: unit.unitId, locale: "zh-CN", revision: "0", protected: false }, sharedTermRevisionIds: [], sharedContextRevisionId: null })),
      brief: { ...h.prepared.preview.brief, units: members.length, sourceTexts: members.length },
    } };
    h.ports.preparePlanning.mockResolvedValue(prepared);
    h.ports.captureSelection.mockResolvedValue({ ...scope.selection.capture, units: members });
    return { ...h, prepared, scope, members };
  }
  it("plans against the original scope and exclusions with a precise units consent", async () => {
    const h = await readyWithUnits(), originalIds = h.members.map(unit => unit.unitId);
    h.scope.query.text = "a later filter"; h.scope.selection.excluded = [];
    await h.owner.preparePlanning(h.conversationId);
    expect(h.ports.captureSelection).toHaveBeenCalledTimes(2);
    expect(h.ports.captureSelection).toHaveBeenLastCalledWith({ ...context, locale: "zh-CN", scopeId: h.scope.selection.capture.scopeId, excluded: [h.scope.selection.capture.units[1].unitId] });
    expect(h.ports.preparePlanning).toHaveBeenCalledExactlyOnceWith({ ...context, conversationId: h.conversationId, config: expect.objectContaining({ maxItems: 2, maxRequests: 1, shareTerms: true, shareContext: true }),
      selectedMessageIds: [h.messageId], scope: { kind: "units", locale: "zh-CN", unitIds: originalIds } });
    h.owner.setPlanningConsent(h.conversationId, true); await h.owner.startPlanning(h.conversationId);
    expect(h.ports.startPlanning).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ consent: expect.objectContaining({ shareMessages: true, shareUnits: true }) }));
    expect(h.current().value.pending).toBeNull();
  });
  it("refuses a changed source snapshot or scope basis while preparing without submitting", async () => {
    const h = await readyWithUnits();
    h.ports.preparePlanning.mockResolvedValueOnce({ ...h.prepared, preview: { ...h.prepared.preview, units: h.prepared.preview.units.map(unit => ({ ...unit, sourceSnapshotId: h.ports.identity() })) } });
    await h.owner.preparePlanning(h.conversationId);
    expect(h.current().planning.failure?.kind).toBe("selection"); expect(h.current().planning.prepared).toBeNull();
    h.ports.captureSelection.mockResolvedValueOnce({ ...h.scope.selection.capture, units: h.members });
    h.ports.captureSelection.mockResolvedValueOnce({ ...h.scope.selection.capture, units: h.members.map(unit => ({ ...unit, expectedBasis: "e".repeat(64) })) });
    await h.owner.preparePlanning(h.conversationId);
    expect(h.current().planning.failure?.kind).toBe("selection"); expect(h.current().planning.prepared).toBeNull();
    await h.owner.startPlanning(h.conversationId); expect(h.ports.startPlanning).not.toHaveBeenCalled(); expect(h.current().value.pending).toBeNull();
  });
  it("invalidates consent when removing entries and resets sharing to message-only", async () => {
    const h = await readyWithUnits(); await h.owner.preparePlanning(h.conversationId); h.owner.setPlanningConsent(h.conversationId, true);
    expect(h.owner.setPlanningSelection(h.conversationId, null)).toBe(true);
    expect(h.current().planning).toMatchObject({ selection: null, prepared: null, consent: false, config: { maxItems: 1, shareTerms: false, shareContext: false } });
    await h.owner.startPlanning(h.conversationId); expect(h.ports.startPlanning).not.toHaveBeenCalled();
    expect(h.owner.setPlanningSelection(h.conversationId, { kind: "ids", locale: "zh-CN", sourceSnapshotId: h.ports.identity(), unitIds: Array.from({ length: 101 }, () => h.ports.identity()) })).toBe(false);
    expect(h.current().planning.selection).toBeNull();
  });
  it("prepares only on request and requires fresh consent for exactly one message-only request", async () => {
    const h = await readyToPlan();
    expect(h.ports.preparePlanning).not.toHaveBeenCalled(); expect(h.ports.startPlanning).not.toHaveBeenCalled();
    await h.owner.preparePlanning(h.conversationId);
    expect(h.ports.preparePlanning).toHaveBeenCalledExactlyOnceWith({ ...context, conversationId: h.conversationId,
      config: expect.objectContaining({ maxRequests: 1, maxRetries: 0, concurrency: 1, shareTerms: false, shareContext: false }),
      selectedMessageIds: [h.messageId], scope: { kind: "conversation-only" } });
    await h.owner.startPlanning(h.conversationId); expect(h.ports.startPlanning).not.toHaveBeenCalled();
    h.owner.setPlanningConsent(h.conversationId, true);
    h.owner.setPlanningConfig(h.conversationId, before => ({ ...before, timeoutSeconds: 30 }));
    expect(h.current().planning.consent).toBe(false); expect(h.current().planning.prepared).toBeNull();
    await h.owner.startPlanning(h.conversationId); expect(h.ports.validatePlanning).not.toHaveBeenCalled();
  });
  it("ignores an outdated preview and saves newer composer input after preparation", async () => {
    const h = await readyToPlan(), response = deferred<PreparedConversationPlanning>(); h.ports.preparePlanning.mockReturnValueOnce(response.promise);
    const prepare = h.owner.preparePlanning(h.conversationId);
    h.owner.edit(h.conversationId, "Newer B");
    h.owner.setPlanningMessages(h.conversationId, []); response.resolve(h.prepared); await prepare; await h.owner.flush();
    expect(h.current().planning.prepared).toBeNull(); expect(h.current().planning.consent).toBe(false);
    expect(h.heads.get(h.conversationId)?.value?.text).toBe("Newer B"); expect(h.ports.startPlanning).not.toHaveBeenCalled();
  });
  it("persists the exact finite consent before sending and keeps text entered while its acknowledgement is delayed", async () => {
    const h = await readyToPlan(); await h.owner.preparePlanning(h.conversationId); h.owner.setPlanningConsent(h.conversationId, true);
    const saved = h.ports.write.getMockImplementation()!, acknowledgement = deferred<ConversationDraftHead>();
    let original: Parameters<typeof conversationDraftCommands.write>[0] | null = null;
    h.ports.write.mockImplementationOnce(async request => { original = request; const head = await saved(request); await acknowledgement.promise; return head; });
    const sending = h.owner.startPlanning(h.conversationId);
    await vi.waitFor(() => expect(original).not.toBeNull());
    expect(h.ports.startPlanning).not.toHaveBeenCalled(); expect(h.ports.validatePlanning).toHaveBeenCalledExactlyOnceWith({ ...context, preparationId: h.prepared.preparationId }, h.prepared);
    const pending = h.current().value.pending; if (pending?.kind !== "planning") throw new Error("Missing original planning request");
    expect(pending.request.consent).toEqual({ actionId: expect.any(String), attemptId: pending.request.consent.actionId, taskId: expect.any(String), previewDigest: h.prepared.previewDigest,
      expiresAtMs: "160000", shareMessages: true, shareUnits: false });
    h.owner.edit(h.conversationId, "Continue B"); await h.owner.startPlanning(h.conversationId);
    acknowledgement.resolve(h.heads.get(h.conversationId)!); await sending; await h.owner.flush();
    expect(h.ports.startPlanning).toHaveBeenCalledExactlyOnceWith({ ...context, conversationId: h.conversationId, preparationId: h.prepared.preparationId, consent: pending.request.consent });
    expect(h.current().value.text).toBe("Continue B"); expect(h.current().value.pending).toBeNull();
    expect(h.heads.get(h.conversationId)?.value?.text).toBe("Continue B"); expect(h.current().planning.consent).toBe(false);
  });
  it("keeps an uncertain planning request without replaying it after retry or reopen", async () => {
    const h = await readyToPlan(); await h.owner.preparePlanning(h.conversationId); h.owner.setPlanningConsent(h.conversationId, true);
    h.ports.startPlanning.mockRejectedValueOnce(new Error("Lost acknowledgement")); await h.owner.startPlanning(h.conversationId);
    const pending = h.current().value.pending; if (pending?.kind !== "planning") throw new Error("Missing request");
    expect(h.current().outcome).toBe("unknown");
    await h.owner.retry(h.conversationId);
    const reopened = h.make(); await reopened.initialize(); await reopened.open(h.conversationId);
    h.ports.recoverPlanning.mockResolvedValueOnce({ request: pending.request, outcome: { kind: "pending", replay: "blocked" } });
    await reopened.check(h.conversationId); await reopened.retry(h.conversationId);
    expect(h.ports.startPlanning).toHaveBeenCalledOnce(); expect(h.ports.preparePlanning).toHaveBeenCalledOnce();
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.value.pending).toEqual(pending);
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.outcome).toBe("blocked");
    expect(reopened.getSnapshot().inputs.get(h.conversationId)?.planning).toMatchObject({ prepared: null, consent: false });
    reopened.retire();
  });
  it("does not send after a journal failure or turn its journal retry into permission", async () => {
    const h = await readyToPlan(); await h.owner.preparePlanning(h.conversationId); h.owner.setPlanningConsent(h.conversationId, true);
    h.ports.write.mockRejectedValueOnce(new Error("Journal unavailable")); await h.owner.startPlanning(h.conversationId);
    expect(h.current().failure?.kind).toBe("journal"); expect(h.ports.startPlanning).not.toHaveBeenCalled();
    await h.owner.retryJournal(h.conversationId); await h.owner.retry(h.conversationId);
    expect(h.current().value.pending?.kind).toBe("planning"); expect(h.ports.startPlanning).not.toHaveBeenCalled();
  });
  it("does not journal or send after failed validation or a changed confirmation context", async () => {
    const h = await readyToPlan(); await h.owner.preparePlanning(h.conversationId); h.owner.setPlanningConsent(h.conversationId, true);
    const validated = deferred<PreparedConversationPlanning>(); h.ports.validatePlanning.mockReturnValueOnce(validated.promise);
    let current = true; const sending = h.owner.startPlanning(h.conversationId, () => current); current = false; validated.resolve(h.prepared); await sending;
    expect(h.current().value.pending).toBeNull(); expect(h.current().planning.consent).toBe(false); expect(h.ports.startPlanning).not.toHaveBeenCalled();
    await h.owner.preparePlanning(h.conversationId); h.owner.setPlanningConsent(h.conversationId, true);
    h.ports.validatePlanning.mockRejectedValueOnce(new Error("Capture changed")); await h.owner.startPlanning(h.conversationId);
    expect(h.current().planning.failure).not.toBeNull(); expect(h.current().value.pending).toBeNull(); expect(h.ports.startPlanning).not.toHaveBeenCalled();
  });
  function savedActions(h: ReturnType<typeof harness>, conversationId: string): ConversationDraftPending[] {
    const key = { projectId: context.projectId, conversationId }, id = h.ports.identity;
    const consent = { actionId: id(), attemptId: "", taskId: id(), previewDigest: "a".repeat(64), expiresAtMs: "1", shareMessages: true, shareUnits: false };
    consent.attemptId = consent.actionId;
    return [
      { kind: "planning", preparationId: id(), submittedSeq: "1", request: { ...key, consent } },
      { kind: "proposal-capture", submittedSeq: "1", request: { ...key, actionId: id(), proposalId: id(), revisionId: id(), attemptId: id(), resultId: id() } },
      { kind: "proposal-revision", submittedSeq: "1", request: { ...key, actionId: id(), proposalId: id(), revisionId: id(), expectedRevisionId: id(), content: { kind: "reply", summary: "Unrecorded change", questions: [] } } },
      { kind: "proposal-work-plan", submittedSeq: "1", request: { actionId: id(), proposal: { ...key, proposalId: id(), revisionId: id() }, planId: id(), planDigest: "b".repeat(64), confirmed: true, effects: [], expiresAt: "1", checkerExecutions: [], toolExecution: false, applicationToolExecutions: [] } },
    ];
  }
  it("recovers each saved action through its original reader without resubmitting or resolving a missing receipt", async () => {
    const h = harness(), conversationId = h.ports.identity(), key = { projectId: context.projectId, conversationId };
    for (const pending of savedActions(h, conversationId)) {
      h.heads.set(conversationId, { key, revision: "1", writerId: h.ports.identity(), value: { text: "Kept input", editSeq: "1", pending } });
      const reopened = h.make(); await reopened.initialize(); await reopened.open(conversationId);
      const missing = { request: pending.request, outcome: { kind: "pending" as const, replay: "blocked" as const } };
      switch (pending.kind) {
        case "planning": h.ports.recoverPlanning.mockResolvedValueOnce(missing as Awaited<ReturnType<typeof conversationCommands.recoverPlanning>>); break;
        case "proposal-capture": h.ports.recoverProposalCapture.mockResolvedValueOnce(missing as Awaited<ReturnType<typeof conversationCommands.recoverProposalCapture>>); break;
        case "proposal-revision": h.ports.recoverProposalRevision.mockResolvedValueOnce(missing as Awaited<ReturnType<typeof conversationCommands.recoverProposalRevision>>); break;
        case "proposal-work-plan": h.ports.recoverProposalWorkPlan.mockResolvedValueOnce(missing as Awaited<ReturnType<typeof conversationCommands.recoverProposalWorkPlan>>); break;
        default: throw new Error("Unexpected action fixture");
      }
      await reopened.check(conversationId); await reopened.retry(conversationId);
      const read = pending.kind === "planning" ? h.ports.recoverPlanning : pending.kind === "proposal-capture" ? h.ports.recoverProposalCapture
        : pending.kind === "proposal-revision" ? h.ports.recoverProposalRevision : h.ports.recoverProposalWorkPlan;
      expect(read).toHaveBeenLastCalledWith(pending.kind === "proposal-work-plan"
        ? { sessionToken: context.sessionToken, projectId: context.projectId, authorization: pending.request }
        : { sessionToken: context.sessionToken, ...pending.request });
      expect(reopened.getSnapshot().inputs.get(conversationId)?.value.pending).toEqual(pending);
      reopened.retire();
    }
    expect(h.ports.create).not.toHaveBeenCalled(); expect(h.ports.append).not.toHaveBeenCalled(); expect(h.ports.resolve).not.toHaveBeenCalled();
    for (const read of [h.ports.recoverPlanning, h.ports.recoverProposalCapture, h.ports.recoverProposalRevision, h.ports.recoverProposalWorkPlan]) expect(read).toHaveBeenCalledOnce();
  });
  it("uses the new session only for historical planning recovery and preserves the original expiry and newer input", async () => {
    const h = harness(), conversationId = h.ports.identity(), key = { projectId: context.projectId, conversationId };
    const pending = savedActions(h, conversationId)[0]; if (pending.kind !== "planning") throw new Error("Expected planning fixture");
    h.heads.set(conversationId, { key, revision: "1", writerId: h.ports.identity(), value: { text: "Earlier input", editSeq: "1", pending } });
    const owner = new ConversationSession({ ...context, sessionToken: "new-session" }, h.recorded, h.reveal, h.ports);
    await owner.initialize(); await owner.open(conversationId); expect(h.ports.recoverPlanning).not.toHaveBeenCalled();
    h.ports.recoverPlanning.mockResolvedValueOnce({ request: pending.request, outcome: { kind: "recorded", receipt: { ...key, consent: pending.request.consent, inputDigest: "c".repeat(64) } } });
    const check = owner.check(conversationId); owner.edit(conversationId, "Newer B"); await check;
    expect(h.ports.recoverPlanning).toHaveBeenCalledExactlyOnceWith({ sessionToken: "new-session", ...pending.request });
    expect(owner.getSnapshot().inputs.get(conversationId)?.value).toMatchObject({ text: "Newer B", pending: null });
    expect(owner.getSnapshot().inputs.get(conversationId)?.notice).toBe("planningRecorded");
    expect(h.ports.create).not.toHaveBeenCalled(); expect(h.ports.append).not.toHaveBeenCalled();
  });
  it("does not let an earlier thread read hide the current thread's recovery action", async () => {
    const h = harness(); await h.owner.initialize();
    const first = h.ports.identity(), second = h.ports.identity(), a = deferred<ConversationDraftHead>(), b = deferred<ConversationDraftHead>();
    h.ports.read.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const openingA = h.owner.open(first), openingB = h.owner.open(second);
    b.reject(new Error("B read failed")); expect(await openingB).toBe(false);
    a.resolve({ key: { projectId: context.projectId, conversationId: first }, revision: "0", value: null, writerId: null }); expect(await openingA).toBe(true);
    expect(h.owner.getSnapshot().activeId).toBe(second); expect(h.owner.getSnapshot().inputFailure?.conversationId).toBe(second);
    expect(await h.owner.open(second)).toBe(true); expect(h.owner.getSnapshot().inputFailure).toBeNull();
  });
  it("keeps newer input while the original message is saved and resolved", async () => {
    const h = harness(); await h.owner.initialize(); await h.owner.create();
    const id = h.current().key.conversationId;
    h.owner.edit(id, "A\n原文  "); expect(await h.owner.flush()).toBe(true);
    const reply = deferred<ProjectConversationMessage>(), submitted = deferred<void>();
    const original = h.ports.append.getMockImplementation()!;
    h.ports.append.mockImplementationOnce(async request => { submitted.resolve(); await reply.promise; return original(request); });
    const saving = h.owner.append(id); await submitted.promise;
    const request = h.ports.append.mock.calls[0][0];
    expect(h.heads.get(id)?.value?.pending).toMatchObject({ kind: "append", request: { actionId: request.actionId } });
    h.owner.edit(id, "B 新输入"); reply.resolve({} as ProjectConversationMessage); await saving;
    expect(h.current().value.text).toBe("B 新输入"); expect(h.current().value.pending).toBeNull();
    expect(h.heads.get(id)?.value?.text).toBe("B 新输入"); expect(request.body).toBe("A\n原文  "); expect(h.ports.append).toHaveBeenCalledOnce();
  });

  it("clears only unchanged submitted input after the journal resolves", async () => {
    const h = harness(); await h.owner.initialize(); await h.owner.create(); const id = h.current().key.conversationId;
    h.owner.edit(id, "  保留空白 🙂\n"); await h.owner.flush(); await h.owner.append(id);
    expect(h.ports.append.mock.calls[0][0].body).toBe("  保留空白 🙂\n");
    expect(h.current().value).toMatchObject({ text: "", pending: null });
    expect(h.heads.get(id)?.value?.text).toBe("");
  });

  it("never submits before its original request is durable or automatically replays it after journal retry", async () => {
    const h = harness(); await h.owner.initialize(); h.ports.write.mockRejectedValueOnce(new Error("disk unavailable"));
    await h.owner.create(); const id = h.current().key.conversationId, pending = structuredClone(h.current().value.pending);
    if (pending?.kind !== "create") throw new Error("Expected a retained create request");
    expect(h.ports.create).not.toHaveBeenCalled(); expect(h.current().failure?.kind).toBe("journal");
    await h.owner.retryJournal(id); expect(h.ports.create).not.toHaveBeenCalled();
    await h.owner.check(id); expect(h.current().outcome).toBe("absent"); expect(h.ports.create).not.toHaveBeenCalled();
    await h.owner.retry(id); expect(h.ports.create).toHaveBeenCalledOnce();
    expect(h.ports.create.mock.calls[0][0].actionId).toBe(pending.request.actionId);
  });

  it("reopens a lost business acknowledgement without restoring or replaying the request", async () => {
    const h = harness(); await h.owner.initialize(); const original = h.ports.create.getMockImplementation()!;
    h.ports.create.mockImplementationOnce(async request => { await original(request); throw new Error("lost ACK"); });
    await h.owner.create(); const id = h.current().key.conversationId;
    h.owner.edit(id, "还在写"); await h.owner.flush(); h.owner.retire();
    const reopened = h.make(); await reopened.initialize(); await reopened.open(id);
    expect(h.ports.create).toHaveBeenCalledOnce(); expect(h.ports.recoverCreate).not.toHaveBeenCalled();
    await reopened.check(id);
    expect(h.ports.create).toHaveBeenCalledOnce(); expect(reopened.getSnapshot().inputs.get(id)?.value).toMatchObject({ text: "还在写", pending: null });
  });

  it("retries the exact failed resolution and keeps text entered after the lost journal acknowledgement", async () => {
    const h = harness(); await h.owner.initialize(); await h.owner.create(); const id = h.current().key.conversationId;
    h.owner.edit(id, "A"); await h.owner.flush(); const original = h.ports.resolve.getMockImplementation()!;
    h.ports.resolve.mockImplementationOnce(async request => { await original(request); throw new Error("lost resolve ACK"); });
    await h.owner.append(id); const first = structuredClone(h.ports.resolve.mock.calls.at(-1)?.[0]);
    expect(h.current().failure?.kind).toBe("journal"); h.owner.edit(id, "B");
    await h.owner.retryJournal(id);
    expect(h.ports.resolve.mock.calls.at(-1)?.[0]).toEqual(first);
    expect(h.current().value).toMatchObject({ text: "B", pending: null }); expect(h.ports.append).toHaveBeenCalledOnce();
    expect(h.heads.get(id)?.value?.text).toBe("B");
  });

  it("retains inputs across thread changes and blocks exit when local saving fails", async () => {
    const h = harness(); await h.owner.initialize(); await h.owner.create(); const first = h.current().key.conversationId;
    h.owner.edit(first, "第一条"); await h.owner.flush(); await h.owner.create(); const second = h.current().key.conversationId;
    h.owner.edit(second, "第二条"); await h.owner.flush(); await h.owner.open(first);
    expect(h.current().value.text).toBe("第一条"); expect(h.owner.getSnapshot().inputs.get(second)?.value.text).toBe("第二条");
    h.ports.write.mockRejectedValueOnce(new Error("another writer changed the head")); h.owner.edit(first, "第三条"); await h.owner.flush();
    const participant = h.owner.lifecycleParticipant();
    expect(participant.inspect({ kind: "navigate" }).status).toBe("ready");
    expect(participant.inspect({ kind: "close-project" }).status).toBe("dirty");
    expect(await participant.prepareLeave({ kind: "close-project" }, () => true, () => true)).toBe(false);
    expect(h.current().value.text).toBe("第三条");
  });
});

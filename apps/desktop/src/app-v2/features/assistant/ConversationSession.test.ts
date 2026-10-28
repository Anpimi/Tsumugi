import { describe, expect, it, vi } from "vitest";
import { ConversationSession } from "./ConversationSession";
import type { ConversationDraftHead, ConversationDraftPending } from "../../../conversationDraftCommands";
import type { PreparedConversationPlanning, ProjectConversation, ProjectConversationMessage } from "../../../conversationCommands";
import type { conversationCommands } from "../../../conversationCommands";
import type { conversationDraftCommands } from "../../../conversationDraftCommands";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";

const context = { projectId: "10000000-0000-4000-8000-000000000001", sessionToken: "session" };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  let sequence = 1;
  const heads = new Map<string, ConversationDraftHead>();
  const created = new Map<string, ProjectConversation>(), appended = new Map<string, ProjectConversationMessage>();
  const recorded = vi.fn(), reveal = vi.fn();
  const ports = {
    now: () => 100000,
    identity: () => `20000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    read: vi.fn(async (request: { key: ConversationDraftHead["key"] }) => structuredClone(heads.get(request.key.conversationId) ?? { key: request.key, revision: "0", value: null, writerId: null })),
    list: vi.fn(async () => ({ items: [...heads.values()].filter(head => head.value).map(head => ({ key: head.key, revision: head.revision, editSeq: head.value!.editSeq, hasPending: !!head.value!.pending })), next: null })),
  };
  // The fixture journal records acknowledgements independently from the controller's input.
  const write = vi.fn(async (request: Parameters<typeof conversationDraftCommands.write>[0]) => {
    const previous = heads.get(request.write.key.conversationId);
    const head = { ...structuredClone(request.write), revision: String(BigInt(previous?.revision ?? "0") + 1n) };
    const result: unknown = { key: head.key, revision: head.revision, writerId: head.writerId,
      value: { editSeq: head.value.editSeq, pending: head.value.pending ?? null, text: head.value.text } };
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
  const all = { ...ports, write, resolve, create, append, recoverCreate, recoverMessage, preparePlanning, validatePlanning, startPlanning, recoverPlanning, recoverProposalCapture, recoverProposalRevision, recoverProposalWorkPlan };
  const make = () => new ConversationSession(context, recorded, reveal, all);
  const owner = make();
  return { owner, make, ports: all, heads, created, appended, recorded, reveal, current: () => {
    const state = owner.getSnapshot(), input = state.activeId ? state.inputs.get(state.activeId) : undefined;
    if (!input) throw new Error("No current conversation input"); return input;
  } };
}

describe("ConversationSession", () => {
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

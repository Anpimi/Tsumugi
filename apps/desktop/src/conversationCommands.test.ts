import { beforeEach, expect, it, vi } from "vitest";
import { conversationCommands } from "./conversationCommands";
import { validateRequestCreate, validateResponseCreateRecovery } from "./generated/conversations.validators";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: fixtureIdentity(16000), sessionToken: "conversation-port-session" };
const create = { ...context, actionId: fixtureIdentity(16001), conversationId: fixtureIdentity(16002), title: null };
const originalCreate = { projectId: create.projectId, actionId: create.actionId, conversationId: create.conversationId, title: create.title };
const thread = { projectId: create.projectId, conversationId: create.conversationId, title: null, ordinal: "9007199254740993" };
const append = { ...context, actionId: fixtureIdentity(16003), conversationId: create.conversationId, messageId: fixtureIdentity(16004), body: "  Keep {name} é 👩🏽‍💻\r\nالعربية\n  " };
const originalAppend = { projectId: append.projectId, actionId: append.actionId, conversationId: append.conversationId, messageId: append.messageId, body: append.body };
const message = { projectId: append.projectId, conversationId: append.conversationId, messageId: append.messageId, ordinal: "1", author: "human", body: append.body };
beforeEach(() => { invoke.mockReset(); });

it("keeps human text, null titles and large decimal cursors in the original typed calls", async () => {
  invoke.mockResolvedValueOnce(thread).mockResolvedValueOnce(message)
    .mockResolvedValueOnce({ projectId: context.projectId, rows: [thread], nextAfter: thread.ordinal })
    .mockResolvedValueOnce({ projectId: context.projectId, conversationId: create.conversationId, rows: [message], nextAfter: null });
  await expect(conversationCommands.create(create)).resolves.toEqual(thread);
  await expect(conversationCommands.append(append)).resolves.toEqual(message);
  const list = { ...context, after: "9007199254740992", limit: 1 };
  await expect(conversationCommands.list(list)).resolves.toMatchObject({ nextAfter: "9007199254740993" });
  await expect(conversationCommands.messages({ ...context, conversationId: create.conversationId, after: null, limit: 50 })).resolves.toMatchObject({ rows: [message] });
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["create_project_conversation", "append_project_conversation_message", "list_project_conversations", "read_project_conversation_messages"]);
  expect(invoke.mock.calls[0][1]).toEqual({ request: create }); expect(invoke.mock.calls[1][1]).toEqual({ request: append });
});

it("requires an explicit nullable title and rejects malformed recovery classifications", () => {
  expect(validateRequestCreate(create)).toBe(true);
  const { title: _title, ...missing } = create;
  expect(validateRequestCreate(missing)).toBe(false);
  expect(validateRequestCreate({ ...create, title: "项目对话" })).toBe(true);
  expect(validateResponseCreateRecovery({ request: originalCreate, outcome: { kind: "mismatch", receipt: thread } })).toBe(false);
  expect(validateResponseCreateRecovery({ request: originalCreate, outcome: { kind: "pending" } })).toBe(false);
  expect(validateResponseCreateRecovery({ request: originalCreate, outcome: { kind: "pending", replay: "automatic" } })).toBe(false);
});

it("preserves saved byte order mark text without applying JavaScript whitespace rules", async () => {
  const title = "\ufeff", body = "\ufeff";
  invoke.mockResolvedValueOnce({ ...thread, title }).mockResolvedValueOnce({ ...message, body });
  await expect(conversationCommands.create({ ...create, title })).resolves.toMatchObject({ title });
  await expect(conversationCommands.append({ ...append, body })).resolves.toMatchObject({ body });
});

it.each([
  { ...thread, projectId: fixtureIdentity(16900) }, { ...thread, conversationId: fixtureIdentity(16901) },
  { ...thread, title: "Unexpected title" }, { ...thread, ordinal: "0" },
])("rejects a create acknowledgement for a different original request %#", async value => {
  invoke.mockResolvedValue(value); await expect(conversationCommands.create(create)).rejects.toThrow("Invalid IPC response");
  expect(invoke).toHaveBeenCalledOnce();
});

it.each([
  { ...message, body: append.body.trim() }, { ...message, messageId: fixtureIdentity(16901) },
  { ...message, conversationId: fixtureIdentity(16902) }, { ...message, author: "assistant" },
])("rejects a changed message acknowledgement without replaying the write %#", async value => {
  invoke.mockResolvedValue(value); await expect(conversationCommands.append(append)).rejects.toThrow("Invalid IPC response");
  expect(invoke).toHaveBeenCalledOnce();
});

it("recovers only the complete original request and leaves pending distinct from recorded", async () => {
  for (const outcome of [{ kind: "recorded", receipt: thread }, { kind: "pending", replay: "explicit-same-request" }, { kind: "pending", replay: "blocked" }, { kind: "mismatch" }]) {
    invoke.mockResolvedValueOnce({ request: originalCreate, outcome });
    await expect(conversationCommands.recoverCreate(create)).resolves.toEqual({ request: originalCreate, outcome });
  }
  invoke.mockResolvedValueOnce({ request: originalAppend, outcome: { kind: "recorded", receipt: message } });
  await expect(conversationCommands.recoverMessage(append)).resolves.toMatchObject({ outcome: { kind: "recorded", receipt: message } });
  invoke.mockResolvedValueOnce({ request: { ...originalAppend, body: "Input B" }, outcome: { kind: "pending", replay: "explicit-same-request" } });
  await expect(conversationCommands.recoverMessage(append)).rejects.toThrow("Invalid IPC response");
  invoke.mockResolvedValueOnce({ request: originalAppend, outcome: { kind: "recorded", receipt: { ...message, body: "Other saved text" } } });
  await expect(conversationCommands.recoverMessage(append)).rejects.toThrow("Invalid IPC response");
  expect(invoke.mock.calls.every(([name]) => name.startsWith("recover_project_conversation_"))).toBe(true);
});

it("rejects foreign, unordered, duplicate and oversized message pages", async () => {
  const request = { ...context, conversationId: create.conversationId, after: "1", limit: 50 };
  const next = { ...message, ordinal: "2" };
  const valid = { projectId: context.projectId, conversationId: create.conversationId, rows: [next], nextAfter: "2" };
  for (const value of [
    { ...valid, projectId: fixtureIdentity(16900) }, { ...valid, conversationId: fixtureIdentity(16900) },
    { ...valid, nextAfter: "3" }, { ...valid, rows: [message] }, { ...valid, rows: [next, { ...next, ordinal: "3" }], nextAfter: "3" },
    { ...valid, rows: Array.from({ length: 50 }, (_, index) => ({ ...next, messageId: fixtureIdentity(17000 + index), ordinal: String(index + 2), body: `x${"\u0001".repeat(8000)}` })), nextAfter: null },
  ]) {
    invoke.mockResolvedValueOnce(value); await expect(conversationCommands.messages(request)).rejects.toThrow("Invalid IPC response");
  }
  invoke.mockResolvedValueOnce(valid); await expect(conversationCommands.messages(request)).resolves.toEqual(valid);
});

it("retains read failures instead of translating them into absent messages or pending actions", async () => {
  const failure = Object.assign(new Error("Synthetic read unavailable"), { code: "storage-failed" });
  invoke.mockRejectedValue(failure);
  await expect(conversationCommands.read({ ...context, conversationId: create.conversationId })).rejects.toBe(failure);
  await expect(conversationCommands.recoverMessage(append)).rejects.toBe(failure);
  expect(invoke).toHaveBeenCalledTimes(2);
});

const planningConfig = {
  endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "synthetic-planning", credentialEnv: "",
  tokenField: "max_tokens", maxItems: 20, concurrency: 1, maxRequests: 1, maxOutputTokens: 2000,
  maxRetries: 0, timeoutSeconds: 60, shareTerms: false, shareContext: false, contextStrategy: null,
  sourceContext: { extracted: false, inferred: false, neighbors: false, maxBytes: 16384, maxItems: 128 },
};
const planningRequest = { ...context, conversationId: create.conversationId, selectedMessageIds: [message.messageId], scope: { kind: "conversation-only" as const }, config: planningConfig };
function planningView() {
  const system = "Synthetic planning instructions";
  const input = JSON.stringify({ purpose: "conversation-planning", scope: { kind: "conversation-only" }, messages: [{ author: "human", body: append.body }], units: [] });
  return { preparationId: fixtureIdentity(18000), previewDigest: "d".repeat(64), preview: {
    version: 2, projectId: context.projectId, conversationId: create.conversationId, config: planningConfig,
    scope: planningRequest.scope, selectedMessages: [message], units: [], system, input,
    byteLength: new TextEncoder().encode(JSON.stringify({ system, input })).length,
    brief: { messages: 1, units: 0, sourceTexts: 0, terms: 0, manualContexts: 0, manualContextFacts: 0, sourceContextFacts: 0, sourceContextNeighbors: 0 },
  } };
}

it("prepares the exact selected planning materials and validates the unchanged original capture", async () => {
  const prepared = planningView();
  invoke.mockResolvedValueOnce(prepared).mockResolvedValueOnce(prepared);
  const captured = await conversationCommands.preparePlanning(planningRequest);
  await expect(conversationCommands.validatePlanning({ ...context, preparationId: captured.preparationId }, captured)).resolves.toEqual(prepared);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["prepare_conversation_planning", "validate_conversation_planning"]);
  expect(invoke.mock.calls[0][1]).toEqual({ request: planningRequest });
  expect(invoke.mock.calls[1][1]).toEqual({ request: { ...context, preparationId: captured.preparationId } });
});

it.each([
  (value: ReturnType<typeof planningView>) => ({ ...value, preview: { ...value.preview, projectId: fixtureIdentity(18900) } }),
  (value: ReturnType<typeof planningView>) => ({ ...value, preview: { ...value.preview, conversationId: fixtureIdentity(18900) } }),
  (value: ReturnType<typeof planningView>) => ({ ...value, preview: { ...value.preview, config: { ...value.preview.config, model: "Changed destination" } } }),
  (value: ReturnType<typeof planningView>) => ({ ...value, preview: { ...value.preview, selectedMessages: [{ ...message, messageId: fixtureIdentity(18900) }] } }),
  (value: ReturnType<typeof planningView>) => ({ ...value, preview: { ...value.preview, byteLength: value.preview.byteLength + 1 } }),
  (value: ReturnType<typeof planningView>) => ({ ...value, preview: { ...value.preview, brief: { ...value.preview.brief, messages: 2 } } }),
  (value: ReturnType<typeof planningView>) => ({ ...value, preview: { ...value.preview, scope: { kind: "units", locale: "zh-CN", unitIds: [fixtureIdentity(18900)] } } }),
])("rejects a planning preview for different materials or limits %#", async change => {
  invoke.mockResolvedValueOnce(change(planningView()));
  await expect(conversationCommands.preparePlanning(planningRequest)).rejects.toThrow("Invalid IPC response");
  expect(invoke).toHaveBeenCalledOnce();
});

it("keeps an old planning capture distinct from a replacement or refreshed preview", async () => {
  const prepared = planningView();
  const captured = { ...prepared, preview: { ...prepared.preview, selectedMessages: [{ ...message, author: "human" as const }] } };
  const request = { ...context, preparationId: prepared.preparationId };
  invoke.mockResolvedValueOnce({ ...prepared, preparationId: fixtureIdentity(18900) });
  await expect(conversationCommands.validatePlanning(request, captured)).rejects.toThrow("Invalid IPC response");
  invoke.mockResolvedValueOnce({ ...prepared, preview: { ...prepared.preview, input: "A replacement input" } });
  await expect(conversationCommands.validatePlanning(request, captured)).rejects.toThrow("Invalid IPC response");
  const unavailable = Object.assign(new Error("Original capture unavailable"), { code: "session-invalid" });
  invoke.mockRejectedValueOnce(unavailable);
  await expect(conversationCommands.validatePlanning(request, captured)).rejects.toBe(unavailable);
  expect(invoke).toHaveBeenCalledTimes(3);
});

const planningConsent = { actionId: fixtureIdentity(18100), attemptId: fixtureIdentity(18100), taskId: fixtureIdentity(18101), previewDigest: "d".repeat(64), expiresAtMs: "1893456000000", shareMessages: true, shareUnits: false };
const planningStart = { ...context, preparationId: fixtureIdentity(18000), conversationId: create.conversationId, consent: planningConsent };
const planningReceipt = { projectId: context.projectId, conversationId: create.conversationId, consent: planningConsent, inputDigest: "c".repeat(64) };
function planningRunView() {
  const resultId = fixtureIdentity(18102);
  const scope = { kind: "project-conversation", id: create.conversationId, locale: null };
  const unknownTokens = { tokens: "0", unknownRequests: 1 };
  return {
    receipt: planningReceipt, preview: planningView().preview,
    detail: { attemptId: planningConsent.attemptId, taskId: planningConsent.taskId, operation: "conversation-planning", nextOffset: null,
      progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
      items: [{ scope, resultId, status: { itemId: planningConsent.actionId, execution: "succeeded", validation: "valid", adoption: "unapplied", cancellationRequested: false, retrySafe: false, diagnostic: null } }],
      recovery: { attemptId: planningConsent.attemptId, units: [{ unitId: planningConsent.actionId, itemIds: [planningConsent.actionId], scopes: [scope], remainingItemIds: [], resultIds: [resultId], actions: [], receiptId: null, blockedReason: "conversation-planning-read-only" }] },
    },
    budget: { limit: 1, dispatched: 1, legacyHeld: 0, unresolved: 0, usageUnknown: 0, promptTokens: "7", completionTokens: "3", cacheRead: unknownTokens, cacheWrite: unknownTokens, reasoning: unknownTokens },
    resultId, output: { model: { kind: "reply", summary: "先确认要处理哪些条目。", questions: [] }, usage: { promptTokens: "7", completionTokens: "3", cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null }, requests: 1, usageIncomplete: false },
  };
}

it("binds planning starts and recovery to the complete original consent without retrying", async () => {
  const recover = { ...context, conversationId: create.conversationId, consent: planningConsent };
  const original = { projectId: context.projectId, conversationId: create.conversationId, consent: planningConsent };
  invoke.mockResolvedValueOnce(planningReceipt);
  await expect(conversationCommands.startPlanning(planningStart)).resolves.toEqual(planningReceipt);
  for (const outcome of [{ kind: "recorded", receipt: planningReceipt }, { kind: "pending", replay: "blocked" }, { kind: "mismatch" }]) {
    invoke.mockResolvedValueOnce({ request: original, outcome });
    await expect(conversationCommands.recoverPlanning(recover)).resolves.toEqual({ request: original, outcome });
  }
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["start_conversation_planning", "recover_conversation_planning", "recover_conversation_planning", "recover_conversation_planning"]);
  expect(invoke.mock.calls[0][1]).toEqual({ request: planningStart });
  invoke.mockResolvedValueOnce({ ...planningReceipt, consent: { ...planningConsent, expiresAtMs: "1893456000001" } });
  await expect(conversationCommands.startPlanning(planningStart)).rejects.toThrow("Invalid IPC response");
  invoke.mockResolvedValueOnce({ request: original, outcome: { kind: "pending", replay: "explicit-same-request" } });
  await expect(conversationCommands.recoverPlanning(recover)).rejects.toThrow("Invalid IPC response");
  invoke.mockResolvedValueOnce({ request: { ...original, consent: { ...planningConsent, taskId: fixtureIdentity(18900) } }, outcome: { kind: "recorded", receipt: planningReceipt } });
  await expect(conversationCommands.recoverPlanning(recover)).rejects.toThrow("Invalid IPC response");
});

it("reads typed planning history with its original task, result and one-request budget", async () => {
  const read = { ...context, conversationId: create.conversationId, attemptId: planningConsent.attemptId };
  const view = planningRunView();
  invoke.mockResolvedValueOnce(view).mockResolvedValueOnce(null);
  await expect(conversationCommands.readPlanning(read)).resolves.toEqual(view);
  await expect(conversationCommands.readPlanning(read)).resolves.toBeNull();
  expect(invoke.mock.calls.every(([name]) => name === "read_conversation_planning")).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each([
  (value: ReturnType<typeof planningRunView>) => ({ ...value, receipt: { ...value.receipt, conversationId: fixtureIdentity(18900) } }),
  (value: ReturnType<typeof planningRunView>) => ({ ...value, receipt: { ...value.receipt, consent: { ...value.receipt.consent, attemptId: fixtureIdentity(18900) } } }),
  (value: ReturnType<typeof planningRunView>) => ({ ...value, detail: { ...value.detail, taskId: fixtureIdentity(18900) } }),
  (value: ReturnType<typeof planningRunView>) => ({ ...value, resultId: fixtureIdentity(18900) }),
  (value: ReturnType<typeof planningRunView>) => ({ ...value, budget: { ...value.budget, limit: 2 } }),
  (value: ReturnType<typeof planningRunView>) => ({ ...value, output: { ...value.output, requests: 2 } }),
  (value: ReturnType<typeof planningRunView>) => ({ ...value, output: { ...value.output, model: { kind: "proposal", summary: "Wrong scope", unitIds: [fixtureIdentity(18900)], options: { stages: [{ stage: "generation", mode: "assisted" }], selectionPolicy: "candidates-only", advisoryChecks: [], adoptResources: false, deliver: false }, questions: [] } } }),
])("rejects planning history for another request or an executable scope %#", async change => {
  invoke.mockResolvedValueOnce(change(planningRunView()));
  await expect(conversationCommands.readPlanning({ ...context, conversationId: create.conversationId, attemptId: planningConsent.attemptId })).rejects.toThrow("Invalid IPC response");
  expect(invoke).toHaveBeenCalledOnce();
});

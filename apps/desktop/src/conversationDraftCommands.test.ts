import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationDraftCommands } from "./conversationDraftCommands";
import { conversationCommands, isConversationMessageText } from "./conversationCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const key = { projectId: fixtureIdentity(900), conversationId: fixtureIdentity(901) }, sessionToken = "session";
const pending = { kind: "append" as const, submittedSeq: "1", request: { ...key, actionId: fixtureIdentity(902), messageId: fixtureIdentity(903), body: "  A\n🙂  " } };
const write = { key, expectedRevision: "0", writerId: fixtureIdentity(904), value: { text: pending.request.body, editSeq: "1", pending } };
const head = () => ({ key, revision: "1", writerId: write.writerId, value: structuredClone(write.value) });
beforeEach(() => { invoke.mockReset(); });

describe("conversation journal command boundary", () => {
  it("preserves the exact frozen request and rejects a different journal acknowledgement", async () => {
    const request = { sessionToken, write: structuredClone(write) };
    let answer!: (value: unknown) => void; invoke.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const result = conversationDraftCommands.write(request);
    request.write.value.text = "newer input"; answer(head());
    expect((await result).value?.text).toBe(pending.request.body);
    expect(invoke.mock.calls[0][1].request.write.value.text).toBe(pending.request.body);
    for (const bad of [{ ...head(), key: { ...key, conversationId: fixtureIdentity(905) } }, { ...head(), writerId: fixtureIdentity(906) },
      { ...head(), value: { ...write.value, pending: { ...pending, request: { ...pending.request, actionId: fixtureIdentity(907) } } } }]) {
      invoke.mockResolvedValueOnce(bad); await expect(conversationDraftCommands.write({ sessionToken, write })).rejects.toThrow();
    }
  });

  it("accepts omitted nullable pending as Core does and validates resolution and tombstone cursors", async () => {
    const value = { text: "B", editSeq: "2" };
    invoke.mockResolvedValueOnce({ ...head(), value: { ...value, pending: null } });
    expect((await conversationDraftCommands.write({ sessionToken, write: { ...write, value } })).value?.pending).toBeNull();
    invoke.mockResolvedValueOnce(head());
    await expect(conversationDraftCommands.resolve({ sessionToken, resolve: { write: { ...write, value: { ...value, pending: null } }, pending } })).rejects.toThrow();
    invoke.mockResolvedValueOnce({ items: [], next: key });
    expect((await conversationDraftCommands.list({ sessionToken, projectId: key.projectId, after: null, limit: 50 })).next).toEqual(key);
    invoke.mockResolvedValueOnce({ items: [], next: key });
    await expect(conversationDraftCommands.list({ sessionToken, projectId: key.projectId, after: key, limit: 50 })).rejects.toThrow();
  });

  it("rejects mismatched or unordered planning discovery pages without querying details or replaying", async () => {
    const request = { sessionToken, ...key, after: "0", limit: 50 };
    const row = { sequence: "1", taskId: fixtureIdentity(908), attemptId: fixtureIdentity(909) };
    invoke.mockResolvedValueOnce({ ...key, rows: [row], nextAfter: null }); expect((await conversationCommands.planningAttempts(request)).rows).toEqual([row]);
    for (const response of [{ ...key, rows: [row, row], nextAfter: null }, { ...key, rows: [row], nextAfter: "2" },
      { ...key, conversationId: fixtureIdentity(910), rows: [row], nextAfter: null }]) {
      invoke.mockResolvedValueOnce(response); await expect(conversationCommands.planningAttempts(request)).rejects.toThrow();
    }
    expect(invoke.mock.calls.every(([command]) => command === "read_conversation_planning_attempts")).toBe(true);
  });

  it("matches Core whitespace and byte limits while retaining original text", () => {
    expect(isConversationMessageText("\uFEFF")).toBe(true);
    expect(isConversationMessageText("\u0085\u2003\n")).toBe(false);
    expect(isConversationMessageText("🙂".repeat(2048))).toBe(true);
    expect(isConversationMessageText("🙂".repeat(2049))).toBe(false);
  });
  it("reads a complete confirmation larger than a translation draft and checks its nested conversation identity", async () => {
    const authorization = { actionId: fixtureIdentity(920), proposal: { ...key, proposalId: fixtureIdentity(921), revisionId: fixtureIdentity(922) },
      planId: fixtureIdentity(923), planDigest: "a".repeat(64), confirmed: true, effects: ["save-candidate"], expiresAt: "1", checkerExecutions: [], toolExecution: true,
      applicationToolExecutions: Array.from({ length: 5000 }, (_, index) => ({ instanceId: fixtureIdentity(index + 10000), activationGeneration: 1 })) };
    const value = { text: "Newer input", editSeq: "2", pending: { kind: "proposal-work-plan", submittedSeq: "1", request: authorization } };
    const original = { ...head(), value };
    expect(new TextEncoder().encode(JSON.stringify(original)).length).toBeGreaterThan(256 * 1024);
    invoke.mockResolvedValueOnce(original);
    expect((await conversationDraftCommands.read({ sessionToken, key })).value?.pending).toEqual(value.pending);
    invoke.mockResolvedValueOnce({ ...original, value: { ...value, pending: { ...value.pending, request: { ...authorization, proposal: { ...authorization.proposal, conversationId: fixtureIdentity(924) } } } } });
    await expect(conversationDraftCommands.read({ sessionToken, key })).rejects.toThrow();
  });
});

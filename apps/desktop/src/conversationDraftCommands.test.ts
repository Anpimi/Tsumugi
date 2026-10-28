import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationDraftCommands, type ConversationDraftPending, type ConversationProposalDraft } from "./conversationDraftCommands";
import { conversationCommands, isConversationMessageText } from "./conversationCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const key = { projectId: fixtureIdentity(900), conversationId: fixtureIdentity(901) }, sessionToken = "session";
const pending = { kind: "append" as const, submittedSeq: "1", request: { ...key, actionId: fixtureIdentity(902), messageId: fixtureIdentity(903), body: "  A\n🙂  " } };
const write = { key, expectedRevision: "0", writerId: fixtureIdentity(904), value: { text: pending.request.body, editSeq: "1", pending } };
const head = () => ({ key, revision: "1", writerId: write.writerId, value: structuredClone(write.value) });
const proposalEdit = (proposalId = fixtureIdentity(930), editSeq = "2"): ConversationProposalDraft => ({
  proposalId, expectedRevisionId: fixtureIdentity(931), editSeq,
  content: { kind: "proposal", summary: "", unitIds: [], options: { stages: [], selectionPolicy: "candidates-only", advisoryChecks: [], adoptResources: false, deliver: false }, questions: [] },
});
const proposalPending = (draft: ConversationProposalDraft): Extract<ConversationDraftPending, { kind: "proposal-revision" }> => ({
  kind: "proposal-revision", submittedSeq: draft.editSeq,
  request: { ...key, actionId: fixtureIdentity(932), revisionId: fixtureIdentity(933), proposalId: draft.proposalId, expectedRevisionId: draft.expectedRevisionId, content: structuredClone(draft.content) },
});
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

  it("preserves multiple unfinished proposal inputs without applying proposal submission requirements", async () => {
    const first = proposalEdit(); first.content.questions = [" ", "unfinished".repeat(8000)];
    const value = { text: "  Unfinished message\n🙂  ", editSeq: "3", messageEditSeq: "1", pending: null,
      proposalEdits: [first, proposalEdit(fixtureIdentity(934), "3")] };
    const response = { ...head(), value };
    invoke.mockResolvedValueOnce(response);
    expect((await conversationDraftCommands.read({ sessionToken, key })).value).toEqual(value);
    invoke.mockResolvedValueOnce(response);
    expect((await conversationDraftCommands.write({ sessionToken, write: { ...write, value } })).value).toEqual(value);
    expect(invoke.mock.calls[1][1].request.write.value).toEqual(value);
  });

  it("accepts Core omission of empty proposal edits and null message sequence in write and resolve acknowledgements", async () => {
    const value = { text: "B", editSeq: "2", proposalEdits: [], messageEditSeq: null };
    const canonical = { text: value.text, editSeq: value.editSeq, pending: null };
    invoke.mockResolvedValueOnce({ ...head(), value: canonical });
    expect((await conversationDraftCommands.write({ sessionToken, write: { ...write, value } })).value).toEqual(canonical);
    expect(invoke.mock.calls[0][1].request.write.value).toEqual(value);
    invoke.mockResolvedValueOnce({ ...head(), value: canonical });
    expect((await conversationDraftCommands.resolve({ sessionToken, resolve: { write: { ...write, value }, pending } })).value).toEqual(canonical);
  });

  it("keeps the append body bound to the message sequence when only proposal edits advance", async () => {
    const value = { ...write.value, editSeq: "3", messageEditSeq: "1", proposalEdits: [proposalEdit(fixtureIdentity(934), "3")] };
    invoke.mockResolvedValueOnce({ ...head(), value });
    expect((await conversationDraftCommands.read({ sessionToken, key })).value).toEqual(value);
    for (const bad of [{ ...value, text: "Changed without a new message sequence" },
      { ...value, pending: { ...pending, request: { ...pending.request, body: "Changed frozen body" } } },
      { ...value, messageEditSeq: "0" }, { ...value, messageEditSeq: "4" },
      { ...value, pending: { ...pending, submittedSeq: "2" } },
      { ...value, pending: { ...pending, request: { ...pending.request, body: "\u0085\u2003\n" } } }]) {
      invoke.mockResolvedValueOnce({ ...head(), value: bad });
      await expect(conversationDraftCommands.read({ sessionToken, key })).rejects.toThrow();
    }
    const newerMessage = { ...value, text: "Newer message", messageEditSeq: "2" };
    invoke.mockResolvedValueOnce({ ...head(), value: newerMessage });
    expect((await conversationDraftCommands.read({ sessionToken, key })).value).toEqual(newerMessage);
  });

  it("rejects duplicate proposal identities, future edit sequences and non-proposal bodies", async () => {
    const first = proposalEdit(), second = proposalEdit(fixtureIdentity(934), "3");
    const value = { text: "B", editSeq: "3", pending: null, proposalEdits: [first, second] };
    for (const bad of [[first, { ...second, proposalId: first.proposalId }], [{ ...first, editSeq: "4" }],
      [{ ...first, content: { kind: "reply", summary: "A reply is not a proposal draft", questions: [] } }],
      [{ ...first, proposalId: "invalid-identity" }], [{ ...first, editSeq: "02" }],
      [{ ...first, content: { ...first.content, summary: 7 } }]]) {
      invoke.mockResolvedValueOnce({ ...head(), value: { ...value, proposalEdits: bad } });
      await expect(conversationDraftCommands.read({ sessionToken, key })).rejects.toThrow();
    }
  });

  it("binds a pending proposal revision to the exact baseline and content at its submitted sequence", async () => {
    const draft = proposalEdit();
    const value = { text: "Message", editSeq: "2", messageEditSeq: "1", proposalEdits: [draft], pending: proposalPending(draft) };
    invoke.mockResolvedValueOnce({ ...head(), value });
    expect((await conversationDraftCommands.read({ sessionToken, key })).value).toEqual(value);
    for (const bad of [{ ...draft, expectedRevisionId: fixtureIdentity(935) },
      { ...draft, content: { ...draft.content, summary: "Changed at the same sequence" } }]) {
      invoke.mockResolvedValueOnce({ ...head(), value: { ...value, proposalEdits: [bad] } });
      await expect(conversationDraftCommands.read({ sessionToken, key })).rejects.toThrow();
    }
  });

  it("retains newer proposal edits and other proposal identities while an older revision remains pending", async () => {
    const draft = proposalEdit(), original = proposalPending(draft);
    const newer = { ...draft, editSeq: "3", content: { ...draft.content, summary: "Newer proposal input" } };
    const other = { ...proposalEdit(fixtureIdentity(934)), expectedRevisionId: fixtureIdentity(935), content: { ...draft.content, summary: "Another proposal" } };
    const value = { text: "Message", editSeq: "3", messageEditSeq: "1", proposalEdits: [newer, other], pending: original };
    const response = { ...head(), value: structuredClone(value) };
    const request = { sessionToken, write: { ...write, value: structuredClone(value) } };
    let answer!: (value: unknown) => void; invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const result = conversationDraftCommands.write(request);
    request.write.value.proposalEdits[0].content.summary = "Edited again after writing";
    request.write.value.pending.request.content.summary = "Changed after freezing";
    answer(response);
    expect((await result).value).toEqual(value);
    expect(invoke.mock.calls[0][1].request.write.value).toEqual(value);
  });

  it("rejects acknowledgements that omit or change nonempty proposal edits or an explicit message sequence", async () => {
    const draft = proposalEdit();
    const value = { text: "Message", editSeq: "3", messageEditSeq: "0", pending: null, proposalEdits: [draft] };
    for (const bad of [{ ...value, proposalEdits: [] }, { ...value, messageEditSeq: null },
      { ...value, messageEditSeq: "1" }, { ...value, proposalEdits: [{ ...draft, editSeq: "3" }] },
      { ...value, proposalEdits: [{ ...draft, expectedRevisionId: fixtureIdentity(935) }] },
      { ...value, proposalEdits: [{ ...draft, content: { ...draft.content, summary: "Changed acknowledgement" } }] }]) {
      invoke.mockResolvedValueOnce({ ...head(), value: bad });
      await expect(conversationDraftCommands.write({ sessionToken, write: { ...write, value } })).rejects.toThrow();
    }
    invoke.mockResolvedValueOnce({ ...head(), value });
    expect((await conversationDraftCommands.write({ sessionToken, write: { ...write, value } })).value).toEqual(value);
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

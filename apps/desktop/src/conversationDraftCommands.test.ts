import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationDraftCommands, locallyReplayableConversationRequest, type ConversationDraftPending, type ConversationProposalDraft } from "./conversationDraftCommands";
import { conversationCommands, isConversationMessageText } from "./conversationCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ConversationDraftRevocation } from "./generated/draft.responses";
import { validateRequestConversationResolve, validateResponseConversationWritten } from "./generated/draft.validators";

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
type RunPending = Extract<ConversationDraftPending, { kind: "work-plan-start" | "work-plan-control" }>;
const runningPending = (kind: RunPending["kind"]): RunPending => {
  const request = { projectId: key.projectId, planId: fixtureIdentity(940), actionId: fixtureIdentity(941), expectedGeneration: "0" };
  return kind === "work-plan-start"
    ? { kind, conversationId: key.conversationId, request, expectedAttemptId: fixtureIdentity(942), submittedSeq: "1" }
    : { kind, conversationId: key.conversationId, submittedSeq: "1", request: { ...request, command: "continue", confirmed: true,
      checkerExecutions: [{ profile: { id: "example.text-review", schemaVersion: 1, behaviorVersion: 1 },
        provider: { plugin: { publisher: "example", id: "text-review", version: "0.1.0" }, packageDigest: "c".repeat(64), componentId: "worker", contributionId: "text-review-check" } }],
      toolExecution: true, applicationToolExecutions: [{ instanceId: fixtureIdentity(943), activationGeneration: 1 }, { instanceId: fixtureIdentity(944), activationGeneration: 2 }], expiresAt: "42" } };
};
const runningValue = (original: RunPending) => ({
  text: "  Newer message B\n🙂  ", editSeq: "3", messageEditSeq: "2", pending: original,
  proposalEdits: [proposalEdit(fixtureIdentity(945), "2"), proposalEdit(fixtureIdentity(946), "3")],
});
const revocation = (command: ConversationDraftRevocation["request"]["command"] = "pause", actionId = fixtureIdentity(960)): ConversationDraftRevocation => ({
  submittedSeq: "3", request: { projectId: key.projectId, planId: fixtureIdentity(940), actionId,
    expectedGeneration: "9007199254740993", command },
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
    await expect(conversationDraftCommands.resolve({ sessionToken, resolve: { write: { ...write, value: { ...value, pending: null } }, target: { kind: "pending", pending }, disposition: "recorded" } })).rejects.toThrow();
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
    expect((await conversationDraftCommands.resolve({ sessionToken, resolve: { write: { ...write, value }, target: { kind: "pending", pending }, disposition: "recorded" } })).value).toEqual(canonical);
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

  describe.each(["work-plan-start", "work-plan-control"] as const)("%s original request", kind => {
    it("reads the token-free request with its outer conversation identity and retains newer message and proposal input", async () => {
      const value = runningValue(runningPending(kind));
      invoke.mockResolvedValueOnce({ ...head(), value });
      expect((await conversationDraftCommands.read({ sessionToken, key })).value).toEqual(value);
      expect(invoke.mock.calls).toEqual([["read_local_conversation_draft", { request: { sessionToken, key } }]]);
    });

    it("freezes the complete original request and input before accepting an exact write acknowledgement", async () => {
      const value = runningValue(runningPending(kind));
      const request = { sessionToken, write: { ...write, value: structuredClone(value) } };
      const response = { ...head(), value: structuredClone(value) };
      let answer!: (value: unknown) => void; invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
      const result = conversationDraftCommands.write(request);
      request.write.value.pending.request.actionId = fixtureIdentity(947);
      request.write.value.pending.request.expectedGeneration = "1";
      request.write.value.text = "Message C entered while writing";
      request.write.value.proposalEdits[0].content.summary = "Newer proposal C";
      if (request.write.value.pending.kind === "work-plan-start") request.write.value.pending.expectedAttemptId = fixtureIdentity(948);
      else {
        request.write.value.pending.request.checkerExecutions[0].provider.packageDigest = "d".repeat(64);
        request.write.value.pending.request.applicationToolExecutions[0].activationGeneration = 3;
        request.write.value.pending.request.toolExecution = false;
        request.write.value.pending.request.expiresAt = "43";
      }
      answer(response);
      expect((await result).value).toEqual(value);
      expect(invoke.mock.calls).toEqual([["write_local_conversation_draft", { request: { sessionToken, write: { ...write, value } } }]]);
    });

    it("freezes resolution input and accepts only an acknowledgement preserving newer input with pending cleared", async () => {
      const original = runningPending(kind), value = { ...runningValue(original), pending: null };
      const input = { sessionToken, resolve: { write: { ...write, value: structuredClone(value) }, target: { kind: "pending" as const, pending: structuredClone(original) }, disposition: "recorded" as const } };
      const response = { ...head(), value: structuredClone(value) };
      let answer!: (value: unknown) => void; invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
      const result = conversationDraftCommands.resolve(input);
      input.resolve.target.pending.request.actionId = fixtureIdentity(947);
      input.resolve.write.value.text = "Message C entered while resolving";
      input.resolve.write.value.proposalEdits[0].content.summary = "Newer proposal C";
      if (input.resolve.target.pending.kind === "work-plan-start") input.resolve.target.pending.expectedAttemptId = fixtureIdentity(948);
      else {
        input.resolve.target.pending.request.checkerExecutions[0].profile.behaviorVersion = 2;
        input.resolve.target.pending.request.applicationToolExecutions[0].activationGeneration = 3;
      }
      answer(response);
      expect((await result).value).toEqual(value);
      expect(invoke.mock.calls[0]).toEqual(["resolve_local_conversation_draft", { request: { sessionToken, resolve: { write: { ...write, value }, target: { kind: "pending", pending: original }, disposition: "recorded" } } }]);
      for (const bad of [{ ...value, text: "" }, { ...value, proposalEdits: [] }, { ...value, pending: original }]) {
        invoke.mockResolvedValueOnce({ ...head(), value: bad });
        await expect(conversationDraftCommands.resolve({ sessionToken, resolve: { write: { ...write, value }, target: { kind: "pending", pending: original }, disposition: "recorded" } })).rejects.toThrow();
      }
    });

    it("rejects wrong scope, future pending sequences, embedded tokens and unknown wire fields", async () => {
      const original = runningPending(kind), value = runningValue(original);
      const badPending: unknown[] = [{ ...original, conversationId: fixtureIdentity(949) },
        { ...original, request: { ...original.request, projectId: fixtureIdentity(950) } },
        { ...original, submittedSeq: "4" }, { ...original, conversationId: undefined },
        { ...original, request: { ...original.request, sessionToken: "not-storable" } },
        { ...original, request: { ...original.request, conversationId: key.conversationId } },
        { ...original, permit: "not-storable" }];
      if (original.kind === "work-plan-start") badPending.push({ ...original, expectedAttemptId: undefined });
      for (const bad of badPending) {
        invoke.mockResolvedValueOnce({ ...head(), value: { ...value, pending: bad } });
        await expect(conversationDraftCommands.read({ sessionToken, key })).rejects.toThrow();
      }
    });

    it("rejects write acknowledgements changing scope, action, generation, attempt or Host consent inputs", async () => {
      const original = runningPending(kind), value = runningValue(original);
      const changed = [{ ...original, conversationId: fixtureIdentity(949) },
        { ...original, request: { ...original.request, projectId: fixtureIdentity(950) } },
        { ...original, request: { ...original.request, actionId: fixtureIdentity(947) } },
        { ...original, request: { ...original.request, planId: fixtureIdentity(951) } },
        { ...original, request: { ...original.request, expectedGeneration: "1" } },
        ...(original.kind === "work-plan-start" ? [{ ...original, expectedAttemptId: fixtureIdentity(948) }] : [
          { ...original, request: { ...original.request, checkerExecutions: [] } },
          { ...original, request: { ...original.request, checkerExecutions: [{ ...original.request.checkerExecutions[0], profile: { ...original.request.checkerExecutions[0].profile, behaviorVersion: 2 } }] } },
          { ...original, request: { ...original.request, toolExecution: false } },
          { ...original, request: { ...original.request, applicationToolExecutions: [] } },
          { ...original, request: { ...original.request, applicationToolExecutions: [...original.request.applicationToolExecutions].reverse() } },
          { ...original, request: { ...original.request, applicationToolExecutions: [{ ...original.request.applicationToolExecutions[0], activationGeneration: 3 }, original.request.applicationToolExecutions[1]] } },
          { ...original, request: { ...original.request, expiresAt: "43" } },
          { ...original, request: { ...original.request, command: "pause" } },
          { ...original, request: { ...original.request, confirmed: false } },
        ])];
      for (const bad of changed) {
        invoke.mockResolvedValueOnce({ ...head(), value: { ...value, pending: bad } });
        await expect(conversationDraftCommands.write({ sessionToken, write: { ...write, value } })).rejects.toThrow();
      }
    });

    it("keeps journal structure separate from execution eligibility and never admits static local replay", async () => {
      const original = runningPending(kind);
      expect(original.request.expectedGeneration).toBe("0");
      expect(locallyReplayableConversationRequest(original)).toBe(false);
      if (original.kind === "work-plan-control") {
        for (const command of ["pause", "stop", "take-over", "continue"] as const) {
          const unconfirmed = { ...original, request: { ...original.request, command, confirmed: false, checkerExecutions: [], toolExecution: false, applicationToolExecutions: [], expiresAt: null } };
          const value = runningValue(unconfirmed);
          invoke.mockResolvedValueOnce({ ...head(), value });
          expect((await conversationDraftCommands.read({ sessionToken, key })).value).toEqual(value);
          expect(locallyReplayableConversationRequest(unconfirmed)).toBe(false);
        }
      }
    });
  });

  it("requires the complete Host control request in journal responses without restoring execution authority", async () => {
    const original = runningPending("work-plan-control");
    if (original.kind !== "work-plan-control") throw new Error("Control fixture required");
    const value = runningValue(original);
    for (const field of ["checkerExecutions", "toolExecution", "applicationToolExecutions", "expiresAt"] as const) {
      const incomplete = Object.fromEntries(Object.entries(original.request).filter(([name]) => name !== field));
      invoke.mockResolvedValueOnce({ ...head(), value: { ...value, pending: { ...original, request: incomplete } } });
      await expect(conversationDraftCommands.read({ sessionToken, key })).rejects.toThrow();
    }
  });

  describe("independent revocation journal slots", () => {
    it("reads all withdrawing controls beside the unresolved primary and unfinished input", async () => {
      const value = { ...runningValue(runningPending("work-plan-start")),
        revocations: [revocation(), revocation("stop", fixtureIdentity(961)), revocation("take-over", fixtureIdentity(962))] };
      const response = { ...head(), value };
      expect(validateResponseConversationWritten(response)).toBe(true);
      invoke.mockResolvedValueOnce(response);
      expect((await conversationDraftCommands.read({ sessionToken, key })).value).toEqual(value);
      expect(invoke.mock.calls).toEqual([["read_local_conversation_draft", { request: { sessionToken, key } }]]);
    });

    it("freezes revocation requests and accepts omission of the canonical empty vector", async () => {
      const value = { ...runningValue(runningPending("work-plan-start")), revocations: [revocation()] };
      const input = { sessionToken, write: { ...write, value: structuredClone(value) } };
      let answer!: (value: unknown) => void; invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
      const writing = conversationDraftCommands.write(input);
      input.write.value.revocations[0].request.actionId = fixtureIdentity(963);
      input.write.value.revocations[0].request.expectedGeneration = "9007199254740994";
      input.write.value.text = "Newer C";
      answer({ ...head(), value });
      expect((await writing).value).toEqual(value);
      expect(invoke.mock.calls[0]).toEqual(["write_local_conversation_draft", { request: { sessionToken, write: { ...write, value } } }]);
      const { revocations: _slots, ...canonical } = value;
      invoke.mockResolvedValueOnce({ ...head(), value: canonical });
      expect((await conversationDraftCommands.write({ sessionToken, write: { ...write, value: { ...canonical, revocations: [] } } })).value).toEqual(canonical);
    });

    it.each(["recorded", "fenced-not-applied"] as const)("resolves only the exact revocation with %s while preserving primary and other slots", async disposition => {
      const original = revocation(), other = revocation("stop", fixtureIdentity(961));
      const value = { ...runningValue(runningPending("work-plan-start")), revocations: [other] };
      const input = { sessionToken, resolve: { write: { ...write, value: structuredClone(value) },
        target: { kind: "revocation" as const, revocation: structuredClone(original) }, disposition } };
      expect(validateRequestConversationResolve(input)).toBe(true);
      let answer!: (value: unknown) => void; invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
      const resolving = conversationDraftCommands.resolve(input);
      input.resolve.target.revocation.request.command = "take-over";
      input.resolve.target.revocation.submittedSeq = "2";
      input.resolve.write.value.text = "Message C";
      input.resolve.write.value.revocations[0].request.actionId = fixtureIdentity(963);
      answer({ ...head(), value });
      expect((await resolving).value).toEqual(value);
      expect(invoke.mock.calls[0]).toEqual(["resolve_local_conversation_draft", { request: { sessionToken, resolve: {
        write: { ...write, value }, target: { kind: "revocation", revocation: original }, disposition,
      } } }]);
      for (const changed of [{ ...value, pending: null }, { ...value, revocations: [] },
        { ...value, revocations: [other, original] }, { ...value, proposalEdits: [] },
        { ...value, revocations: [{ ...other, request: { ...other.request, command: "pause" } }] }]) {
        invoke.mockResolvedValueOnce({ ...head(), value: changed });
        await expect(conversationDraftCommands.resolve({ sessionToken, resolve: { write: { ...write, value },
          target: { kind: "revocation", revocation: original }, disposition } })).rejects.toThrow();
      }
    });

    it("retains revocations when settling the primary and canonicalizes the final removed slot", async () => {
      const primary = runningPending("work-plan-start"), original = revocation();
      primary.request.expectedGeneration = "1";
      const value = { ...runningValue(primary), pending: null, revocations: [original] };
      invoke.mockResolvedValueOnce({ ...head(), value });
      expect((await conversationDraftCommands.resolve({ sessionToken, resolve: { write: { ...write, value },
        target: { kind: "pending", pending: primary }, disposition: "fenced-not-applied" } })).value).toEqual(value);
      const { revocations: _slots, ...canonical } = value;
      invoke.mockResolvedValueOnce({ ...head(), value: canonical });
      expect((await conversationDraftCommands.resolve({ sessionToken, resolve: { write: { ...write, value: { ...canonical, revocations: [] } },
        target: { kind: "revocation", revocation: original }, disposition: "recorded" } })).value).toEqual(canonical);
    });

    it("rejects foreign scope, reused action identities, future sequences and authority-bearing slot material", async () => {
      const primary = runningPending("work-plan-start"), slot = revocation(), value = runningValue(primary);
      const invalid: unknown[] = [
        [{ ...slot, request: { ...slot.request, projectId: fixtureIdentity(964) } }],
        [slot, slot], [{ ...slot, request: { ...slot.request, actionId: primary.request.actionId } }],
        [{ ...slot, submittedSeq: "4" }], [{ ...slot, request: { ...slot.request, expectedGeneration: "0" } }],
        [{ ...slot, request: { ...slot.request, command: "continue" } }],
        [{ ...slot, request: { ...slot.request, confirmed: false } }],
        [{ ...slot, request: { ...slot.request, sessionToken: "not-storable" } }],
        [{ ...slot, request: { ...slot.request, expiresAt: null } }],
        [{ ...slot, unknown: true }], Array.from({ length: 33 }, (_, index) => revocation("pause", fixtureIdentity(970 + index))),
      ];
      for (const revocations of invalid) {
        invoke.mockResolvedValueOnce({ ...head(), value: { ...value, revocations } });
        await expect(conversationDraftCommands.read({ sessionToken, key })).rejects.toThrow();
      }
      expect(invoke.mock.calls.every(([command]) => command === "read_local_conversation_draft")).toBe(true);
    });
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

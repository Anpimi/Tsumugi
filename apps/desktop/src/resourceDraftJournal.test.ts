import { expect, it, vi } from "vitest";
import wire from "../test/fixtures/resourceDraftCommands.contract.json";
import resources from "../test/fixtures/resourceCommands.contract.json";
import { initialResourceDraftState, type ResourceDraftState, type ResourcePending } from "./ResourceDraftSession";
import { ResourceDraftJournal, resourceDraftValue, resourcePendingValue, restoreResourceDraft } from "./resourceDraftJournal";
import { canonicalResourceDraft, type ResourceDraftHead } from "./resourceDraftCommands";
import { validateRequestResourceWrite } from "./generated/draft.validators";
import { createResourceDraftPortsFixture } from "./testSupport/resourceDraftFixture";
import { contextResourceFixture } from "./testSupport/contextResourceFixture";
import type { SourceFactBasis } from "./resourceCommands";

const session = { projectId: wire.requests.read.key.projectId, sessionToken: "original-resource-session" };
const rawWrite: unknown = structuredClone(wire.requests.write);
if (!validateRequestResourceWrite(rawWrite)) throw new Error("Expected the generated resource journal fixture");
const retained = canonicalResourceDraft(rawWrite.write.value);
const id = (index: number) => `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function input(): ResourceDraftState {
  const state = restoreResourceDraft(initialResourceDraftState("ja"), structuredClone(retained), session);
  state.pending = null; state.pendingUncertain = false;
  const source = resources.responses.correctionBasis;
  state.correctionDraft = { evidence: source, source: "Barrel", target: "木桶", protected: true, reason: "Retained correction B", editSeq: 2 };
  const basis: SourceFactBasis = { scope: { projectId: session.projectId, unitId: id(2), locale: "zh-CN", sourceSnapshotId: id(30), sourceRevisionId: id(31) }, sourceResultId: id(41), sourceResultDigest: "a".repeat(64),
    fact: { blockIndex: 0, factIndex: 0, target: { kind: "occurrence", id: "source-occurrence" }, schema: { id: "synthetic.source-fact", schemaVersion: 1, behaviorVersion: 1 }, handling: "preserve", inRevisionBasis: true,
      fact: { id: "speaker", kind: "speaker", text: "Mara", origin: { kind: "extracted", sources: [{ artifactId: "dialogue", range: { encoding: "utf8-byte", start: 0, end: 4 } }] } } } };
  state.factDraft = { basis, key: "dialogue.hello", expectedDecisionId: null, disposition: { kind: "replace", text: "Human context B" }, actor: "Recorder", reason: "Keep B reason", editSeq: 3 };
  state.selectedUnit = { unitId: id(2), sourceRevisionId: id(31), occurrence: { key: "dialogue.hello", text: "Barrel" } };
  state.contextDraft = "Entry context B 👩🏽‍💻\r\né"; state.contextReason = "Context reason"; state.contextSeq = 3;
  for (const [index, kind] of (["character", "style", "background"] as const).entries()) {
    const base = contextResourceFixture({ projectId: session.projectId, kind, contextId: id(100 + index), subjectId: id(110 + index) });
    state.typedDrafts[base.contextId] = { key: base.contextId, contextId: base.contextId, subjectId: base.subjectId, kind, locale: base.locale, base, sourceBasis: base.sourceBasis, scope: base.scope,
      name: base.name, text: `Retained ${kind} B`, actor: "Recorder", reason: "Human reason", editSeq: 2, restoring: false, notice: null, failure: null };
  }
  state.typedActiveKey = id(100);
  state.knowledgeDrafts.review = { key: "review", proposal: { projectId: session.projectId, conversationId: id(200), proposalId: id(201), revisionId: id(202) },
    entryIndex: 0, entry: { kind: "character", name: "Mara", text: "Original model content", unitIds: [id(2)] }, locale: "zh-CN", destination: "new", target: null, scope: { kind: "project" },
    name: "Mara", text: "Human B after the proposal", actor: "Reviewer", reason: "Original evidence", preview: null, confirmWiderScope: true, editSeq: 4, receipt: null, recordedFields: null, failure: null };
  state.knowledgeActiveKey = "review"; state.pickerUnknown = true; state.previewCaptureId = id(6); state.fixedContextId = id(15);
  return state;
}
function pending(kind: ResourcePending["kind"], state: ResourceDraftState): ResourcePending {
  if (kind === "typed-context") { const draft = state.typedDrafts[id(100)]; return { kind, operation: "save", session, draftKey: draft.key, submittedSeq: 1,
    request: { projectId: session.projectId, actionId: id(301), contextId: draft.contextId, subjectId: draft.subjectId, expectedRevisionId: draft.base?.revisionId ?? null, sourceBasis: draft.sourceBasis,
      locale: draft.locale, kind: draft.kind, scope: draft.scope, name: draft.name, text: "Submitted typed A", actor: draft.actor, reason: draft.reason } }; }
  if (kind === "knowledge-decision") return { kind, session, request: { actionId: id(302), proposal: state.knowledgeDrafts.review.proposal, entryIndex: 0, decision: "keep", actor: "Reviewer", reason: "Original reason", adoption: null }, draftKey: "review", submittedSeq: 1, submittedFields: "original submitted fields" };
  if (kind === "correction") return { kind, session, request: resources.requests.correctionCapture.capture, submittedSeq: 1 };
  if (kind === "term") return { kind, session, request: resources.requests.term.term, submittedSeq: 1, aliasInput: "Cask, Drum, " };
  if (kind === "context") return { kind, session, request: resources.requests.context.context, submittedSeq: 1 };
  if (kind === "decision") return { kind, session, request: { ...resources.requests.decision.decision, decision: "keep" }, locale: "zh-CN", submittedSeq: "1" };
  return { kind, session, request: resources.requests.contextCapture.capture, submittedSeq: "1" };
}

it.each(["typed-context", "knowledge-decision", "correction", "term", "context", "decision", "capture"] as const)("restores all human input with the exact %s request but without old execution authority", kind => {
  const state = input(); state.pending = pending(kind, state); state.pendingCheckedMissing = true; state.pendingRecorded = true;
  const value = resourceDraftValue(state, "100"), reopened = restoreResourceDraft(initialResourceDraftState("ja"), value, { ...session, sessionToken: "new-resource-session" });
  expect(reopened.pending?.session.sessionToken).toBe("new-resource-session");
  expect(reopened.pending && resourcePendingValue(reopened.pending)).toEqual(value.pending);
  expect(reopened.termDraft).toEqual(state.termDraft); expect(reopened.aliasInput).toBe(state.aliasInput);
  expect(reopened.contextDraft).toBe(state.contextDraft); expect(reopened.contextReason).toBe(state.contextReason);
  expect(reopened.factDraft).toEqual(state.factDraft); expect(reopened.correctionDraft?.target).toBe("木桶"); expect(reopened.correctionDraft?.evidence.current).toBe(false);
  expect(Object.values(reopened.typedDrafts).map(draft => draft.text)).toEqual(Object.values(state.typedDrafts).map(draft => draft.text));
  expect(reopened.knowledgeDrafts.review.text).toBe("Human B after the proposal"); expect(reopened.knowledgeDrafts.review.preview).toBeNull(); expect(reopened.knowledgeDrafts.review.confirmWiderScope).toBe(false);
  expect(reopened).toMatchObject({ pendingUncertain: true, pendingCheckedMissing: false, pendingRecorded: false, busyMutation: false, pickerUnknown: true });
  expect(JSON.stringify(value)).not.toContain(session.sessionToken); expect(value.knowledgeDrafts[0]).not.toHaveProperty("preview"); expect(value.knowledgeDrafts[0]).not.toHaveProperty("confirmWiderScope");
});
it("restores an exact withdrawal and the independent fact slot without inventing retry permission", () => {
  const state = input(), draft = state.typedDrafts[id(100)];
  if (!draft.contextId || !draft.base) throw new Error("Expected the saved synthetic context");
  state.pending = { kind: "typed-context", operation: "withdraw", session, draftKey: draft.key, submittedSeq: 1, request: { projectId: session.projectId, actionId: id(310), contextId: draft.contextId, expectedRevisionId: draft.base.revisionId, actor: draft.actor, reason: draft.reason } };
  const withdrawal = resourceDraftValue(state, "100"); expect(withdrawal.pending?.kind).toBe("typed-context-withdraw");
  state.pending = null; const fact = state.factDraft; if (!fact) throw new Error("Expected synthetic fact input");
  state.factPending = { request: { actionId: id(311), basis: fact.basis, expectedDecisionId: null, disposition: fact.disposition, actor: fact.actor, reason: fact.reason }, submittedSeq: 1 };
  const reopened = restoreResourceDraft(initialResourceDraftState("ja"), resourceDraftValue(state, "100"), session);
  expect(reopened.factPending).toEqual(state.factPending); expect(reopened.factCheckedMissing).toBe(false); expect(reopened.pending).toBeNull();
});

function harness(ports = createResourceDraftPortsFixture()) {
  let state = initialResourceDraftState("zh-CN");
  const journal = new ResourceDraftJournal(session, { current: () => state, apply: change => { state = change(state); }, hydrate: value => { state = restoreResourceDraft(state, value, session); }, publish: vi.fn(), persisted: vi.fn(), live: () => true }, ports);
  return { journal, ports, get state() { return state; }, edit: (text: string) => { state = { ...state, termDraft: { ...state.termDraft, source: "Barrel", target: text, reason: "Human reason" }, termSeq: state.termSeq + 1 }; journal.observe(); },
    setPending: () => { state = { ...state, pending: pending("term", state) }; journal.observe(); } };
}

it("keeps B after A's delayed journal acknowledgement and can reopen the latest input", async () => {
  const ports = createResourceDraftPortsFixture(), ack = deferred<ResourceDraftHead>(), write = vi.fn(ports.write);
  let captured: ResourceDraftHead | undefined;
  write.mockImplementationOnce(async request => { captured = await ports.write(request); return ack.promise; });
  const h = harness({ ...ports, write }); await h.journal.initialize(); h.edit("A");
  const saving = h.journal.flush(); await vi.waitFor(() => expect(captured).toBeDefined());
  h.edit("New B 👩🏽‍💻\r\né"); if (!captured) throw new Error("Expected the A acknowledgement"); ack.resolve(captured);
  expect(await saving).toBe(true); expect(h.state.termDraft.target).toBe("New B 👩🏽‍💻\r\né");
  const head = await ports.read(wire.requests.read); expect(head.value?.termDraft.target).toBe(h.state.termDraft.target);
  const reopened = harness(ports); await reopened.journal.initialize(); expect(reopened.state.termDraft.target).toBe(h.state.termDraft.target);
});
it("keeps the pending slot after a failed resolution and retries only the journal frame while saving B", async () => {
  const ports = createResourceDraftPortsFixture(), resolve = vi.fn(ports.resolve);
  resolve.mockRejectedValueOnce(new Error("Synthetic journal failure"));
  const h = harness({ ...ports, resolve }); await h.journal.initialize(); h.edit("A"); h.setPending(); await h.journal.flush();
  const original = h.state.pending; if (!original) throw new Error("Expected the original request");
  const target = { kind: "primary" as const, pending: resourcePendingValue(original) };
  const settle = (state: ResourceDraftState) => ({ ...state, pending: null, newerTerm: true });
  expect(await h.journal.resolve(target, "recorded", settle)).toBe(false); expect(h.state.pending).toBe(original);
  h.edit("B after the failed local acknowledgement"); expect(await h.journal.retry()).toBe(true);
  expect(h.state.pending).toBeNull(); expect((await ports.read(wire.requests.read)).value?.termDraft.target).toBe("B after the failed local acknowledgement");
  expect(resolve).toHaveBeenCalledTimes(2); expect(resolve.mock.calls[1][0]).toEqual(resolve.mock.calls[0][0]);
});
it("fences late hydration after retirement and keeps a different window's pending separate from local B", async () => {
  const ports = createResourceDraftPortsFixture(), h = harness(ports); await h.journal.initialize(); h.edit("A"); await h.journal.flush();
  const before = await ports.read(wire.requests.read); if (!before.value) throw new Error("Expected retained input");
  await ports.write({ ...wire.requests.write, write: { key: before.key, expectedRevision: before.revision, writerId: id(901), value: { ...before.value, editSeq: "100", pending: retained.pending } } });
  h.edit("Local B"); expect(await h.journal.flush()).toBe(false); await h.journal.retry();
  const conflict = h.journal.getSnapshot().conflict; expect(conflict).not.toBeNull();
  if (!conflict) throw new Error("Expected a conflicting journal head");
  expect(await h.journal.keepLocal(h.state, conflict)).toBe(false); expect(h.state.termDraft.target).toBe("Local B");
  const late = deferred<ResourceDraftHead>(), second = harness({ ...ports, read: () => late.promise });
  const loading = second.journal.initialize(); second.journal.retire(); late.resolve(before); await loading;
  expect(second.state.termDraft.target).toBe(""); expect(second.journal.getSnapshot().retired).toBe(true);
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { conversationProposalFixture } from "../../../testSupport/conversationProposalFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import type { ConversationEntryReference } from "./ConversationEntryReferences";
import { resolveConversationEntryReference } from "./conversationEntryNavigation";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: id(900), sessionToken: "synthetic-conversation-reference" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const { run } = conversationProposalFixture({ projectId: context.projectId, conversationId: id(901) });
  const unit = run.preview.units[0];
  const reference: ConversationEntryReference = { projectId: context.projectId, conversationId: run.preview.conversationId, attemptId: run.detail.attemptId,
    unitId: unit.unitId, locale: "zh-CN", sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId };
  const target = reviewTargetFixture({ unitId: unit.unitId, locale: reference.locale, sourceSnapshotId: unit.sourceSnapshotId,
    sourceRevisionId: unit.sourceRevisionId, nativeKey: "dialogue.1", sourceText: "Hello, {name}!", translationText: "Retained current translation" });
  let snapshot = unit.sourceSnapshotId;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_conversation_planning") return structuredClone(run);
    if (command === "read_review_target") return structuredClone(target);
    if (command === "read_content_scope") return { currentSnapshot: snapshot, revision: "1" };
    throw new Error(`Unexpected reference operation: ${command}`);
  });
  return { run, target, reference, setSnapshot(value: string) { snapshot = value; } };
}
beforeEach(() => { invoke.mockReset(); });
afterEach(() => {
  expect(invoke.mock.calls.every(([command]) => ["read_conversation_planning", "read_review_target", "read_content_scope"].includes(command))).toBe(true);
});

it("re-reads the original planning tuple and current source before returning an exact anchored details destination", async () => {
  const h = fixture(), original = structuredClone({ run: h.run, target: h.target, reference: h.reference });
  const patch = await resolveConversationEntryReference(context, h.reference, () => true);
  expect(invoke).toHaveBeenCalledWith("read_conversation_planning", { request: { ...context, conversationId: h.reference.conversationId, attemptId: h.reference.attemptId } });
  expect(invoke).toHaveBeenCalledWith("read_review_target", { request: { ...context, unitId: h.reference.unitId, locale: h.reference.locale } });
  expect(patch).toMatchObject({ locale: "zh-CN", focus: h.reference.unitId, dock: "details", detailTab: "detail",
    preset: "all", query: "", searchInput: "", queueActive: true, queueAnchor: h.reference.unitId, queueScopeId: null,
    editing: false, focusMode: false, cursor: null });
  expect(h.run).toEqual(original.run); expect(h.target).toEqual(original.target); expect(h.reference).toEqual(original.reference);
});

it.each(["projectId", "conversationId", "attemptId", "unitId", "locale", "sourceSnapshotId", "sourceRevisionId"] as const)("refuses a changed %s in the clicked reference without admitting a destination", async field => {
  const h = fixture();
  h.reference[field] = field === "locale" ? "ja-JP" : id(990);
  await expect(resolveConversationEntryReference(context, h.reference, () => true)).rejects.toThrow();
  expect(invoke.mock.calls.some(([command]) => command === "read_review_target")).toBe(false);
});

it.each(["snapshot", "revision", "basis"] as const)("refuses a changed current source %s despite unchanged saved material", async change => {
  const h = fixture();
  if (change === "snapshot") h.setSnapshot(id(991));
  if (change === "revision") h.target.sourceRevisionId = id(992);
  if (change === "basis") h.target.basisEvidence.sourceRevisionId = id(993);
  await expect(resolveConversationEntryReference(context, h.reference, () => true)).rejects.toThrow();
});

it("stops before current entry reads when the caller changed focus or draft input during the original material read", async () => {
  const h = fixture(), pending = deferred<typeof h.run>();
  let current = true;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, request) => command === "read_conversation_planning" ? pending.promise : original(command, request));
  const read = resolveConversationEntryReference(context, h.reference, () => current);
  const rejected = expect(read).rejects.toThrow();
  current = false; pending.resolve(h.run); await rejected;
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_conversation_planning"]);
});

it("does not admit late current source reads after the caller proof was revoked", async () => {
  const h = fixture(), pending = deferred<typeof h.target>();
  let current = true;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, request) => command === "read_review_target" ? pending.promise : original(command, request));
  const read = resolveConversationEntryReference(context, h.reference, () => current);
  const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("read_review_target", { request: { ...context, unitId: h.reference.unitId, locale: "zh-CN" } }));
  current = false; pending.resolve(h.target); await rejected;
});

it("opens material references on the context tab after validating the same exact source evidence", async () => {
  const h = fixture();
  h.reference.detailTab = "context";
  const patch = await resolveConversationEntryReference(context, h.reference, () => true);
  expect(patch).toMatchObject({ focus: h.reference.unitId, dock: "details", detailTab: "context", editing: false });
  h.setSnapshot(id(994));
  await expect(resolveConversationEntryReference(context, h.reference, () => true)).rejects.toThrow();
});

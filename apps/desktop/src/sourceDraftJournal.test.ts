import { beforeEach, expect, it, vi } from "vitest";
import { SourceDraftJournal, restoreSourceDraft, sourceDraftValue, sourcePendingValue } from "./sourceDraftJournal";
import { sourceDraftCommands, canonicalSourceDraft, type SourceDraftPending, type SourceDraftHead } from "./sourceDraftCommands";
import { sourceDraftStateFixture } from "./testSupport/sourceDraftStateFixture";
import { installSourceDraftPortsFixture } from "./testSupport/sourceDraftFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { pluginSourceRequest, pluginSourceWorkflow } from "./testSupport/pluginSourceFixture";
import { hookActivation } from "./testSupport/sourceMaintenanceHookFixture";
import wire from "../test/fixtures/sourceCommands.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const session = wire.session, key = { projectId: session.projectId };
const capture = { projectId: session.projectId, selectionId: id(701), sourceLanguage: "en", attemptId: id(702) };
const sequences = { submittedSeq: "2", submittedMappingSeq: "1" };
const start = { projectId: session.projectId, attemptId: id(702), inputDigest: "a".repeat(64), grantId: id(703), expiresAtMs: "100000", unsandboxedExecution: true,
  startMetadata: { taskId: id(710), generation: id(711) } };
function pendingVariants(): SourceDraftPending[] {
  const { sessionToken: _token, ...adoption } = wire.prepare;
  return [
    { kind: "capture", request: capture, ...sequences },
    { kind: "start", request: start, ...sequences },
    { kind: "prepare-check", request: { projectId: session.projectId, sourceAttemptId: id(702), sourceResultId: id(704), attemptId: id(705), source: pluginSourceRequest }, ...sequences },
    { kind: "start-check", request: { ...start, attemptId: id(705) }, ...sequences },
    { kind: "finish-check", request: { projectId: session.projectId, attemptId: id(705), resultId: id(706) }, ...sequences },
    { kind: "adopt", request: adoption, unitId: id(707), ...sequences },
  ];
}
beforeEach(() => { invoke.mockReset(); installSourceDraftPortsFixture(); });

it.each(["capture", "start", "prepare-check", "start-check", "finish-check", "adopt"])("restores exact %s identity and human input without a live lease or permission", kind => {
  const pending = pendingVariants().find(value => value.kind === kind); if (!pending) throw new Error("Expected a source request");
  const initial = sourceDraftStateFixture();
  const value = canonicalSourceDraft({ ...sourceDraftValue(initial, "3"), mappingSeq: "2", pending,
    actor: "Newer B 👩🏽‍💻\r\né", selectionLabel: "Original folder", lineage: [{ newOrdinal: 3, oldOccurrenceId: id(708), decision: "continue", reason: "Human B\n理由" }],
    hook: { locale: "zh-CN", enabledIntent: true, sourceActionId: id(709) }, pickerUncertain: true });
  const restored = restoreSourceDraft(initial, value, { ...session, sessionToken: "reopened-session" });
  expect(sourcePendingValue(restored.source)).toEqual(pending);
  expect(restored.source.actor).toBe("Newer B 👩🏽‍💻\r\né"); expect(restored.source.lineage[3].reason).toBe("Human B\n理由");
  expect(restored.source).toMatchObject({ pendingUncertain: true, recoveredPending: true, selection: null, preflight: null, checkReview: null,
    estimate: null, confirmed: false, producerConsent: null, checkerConsent: null, preparedAction: null, pendingObserved: null, pickerUncertain: true });
  expect(restored.hook).toMatchObject({ enabled: true, activation: null, originalActivation: null, originalRequest: null });
  const original = restored.source.pendingStart ?? restored.source.pendingApply ?? restored.source.pendingPlugin?.request;
  expect(original?.sessionToken).toBe("reopened-session");
  expect(JSON.stringify(sourceDraftValue(restored, "3"))).not.toContain("sessionToken");
});

function journal() {
  let inputs = sourceDraftStateFixture(); let live = true;
  const owner = new SourceDraftJournal(session, { live: () => live, current: () => inputs,
    hydrate: value => { inputs = restoreSourceDraft(inputs, value, session); }, apply: change => { inputs = change(inputs); },
    publish: () => {}, persisted: () => {} });
  return { owner, get inputs() { return inputs; }, edit: (actor: string) => { inputs = { ...inputs, source: { ...inputs.source, actor } }; owner.observe(); },
    retire: () => { live = false; owner.retire(); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }

it("serializes A before B and keeps the later input after the first local acknowledgement", async () => {
  const h = journal(); await h.owner.initialize();
  const actual = vi.mocked(sourceDraftCommands.write).getMockImplementation(), reply = deferred<SourceDraftHead>();
  if (!actual) throw new Error("Source journal write fixture is not installed");
  const write = vi.spyOn(sourceDraftCommands, "write").mockImplementationOnce(async request => { const result = await actual(request); return reply.promise.then(() => result); }).mockImplementation(actual);
  h.edit("Submitted A"); const flushing = h.owner.flush();
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce()); h.edit("Newer B\n👩🏽‍💻 é"); reply.resolve({ key, revision: "0", writerId: null, value: null });
  expect(await flushing).toBe(true); expect(h.inputs.source.actor).toBe("Newer B\n👩🏽‍💻 é");
  expect((await sourceDraftCommands.read({ sessionToken: session.sessionToken, key })).value?.actor).toBe("Newer B\n👩🏽‍💻 é");
  expect(write).toHaveBeenCalledTimes(2);
});

it("preserves both windows on CAS conflict and rejects an old keep-local choice after new input", async () => {
  const left = journal(), right = journal(); await left.owner.initialize(); await right.owner.initialize();
  left.edit("Window A"); expect(await left.owner.flush()).toBe(true); right.edit("Window B"); expect(await right.owner.flush()).toBe(false);
  expect(await right.owner.retry()).toBe(false); const stored = right.owner.getSnapshot().conflict;
  if (!stored) throw new Error("Expected another window's saved head");
  const old = sourceDraftValue(right.inputs, right.owner.sequence()); right.edit("Newer B after comparison");
  expect(await right.owner.keepLocal(old, stored)).toBe(false);
  expect(right.inputs.source.actor).toBe("Newer B after comparison"); expect(stored.value?.actor).toBe("Window A");
  const current = sourceDraftValue(right.inputs, right.owner.sequence()); expect(await right.owner.keepLocal(current, stored)).toBe(true);
  expect((await sourceDraftCommands.read({ sessionToken: session.sessionToken, key })).value?.actor).toBe("Newer B after comparison");
});

it("does not persist cached preparation, consent or business proof", () => {
  const input = sourceDraftStateFixture(); input.source.selection = pluginSourceWorkflow.selection; input.source.preflight = pluginSourceWorkflow.preflight;
  input.source.producerConsent = pluginSourceWorkflow.preflight.inputDigest; input.source.confirmed = true;
  const value = sourceDraftValue(input, "1");
  expect(value.selectionLabel).toBe(pluginSourceWorkflow.selection.folderName);
  expect(value).not.toHaveProperty("selection"); expect(value).not.toHaveProperty("preflight"); expect(value).not.toHaveProperty("producerConsent");
  expect(value).not.toHaveProperty("confirmed"); expect(value).not.toHaveProperty("preparedAction");
});

it("retains an independent hook stop beside the original source action without its old adoption authority", () => {
  const input = sourceDraftStateFixture(), pending = pendingVariants()[0];
  const stop = { request: { projectId: session.projectId, stop: { projectId: session.projectId, sourceActionId: id(709), actionId: id(710), activation: hookActivation() } }, submittedSeq: "2" };
  const value = canonicalSourceDraft({ ...sourceDraftValue(input, "3"), pending, hookStop: stop,
    hook: { locale: "zh-CN", enabledIntent: true, sourceActionId: id(709) }, mappingSeq: "2" });
  const restored = restoreSourceDraft(input, value, { ...session, sessionToken: "new-hook-session" });
  expect(sourceDraftValue(restored, "3").hookStop).toEqual(stop); expect(sourcePendingValue(restored.source)).toEqual(pending);
  expect(restored.hook.stop).toMatchObject({ submittedSeq: "2", unknown: true, pending: false, request: { sessionToken: "new-hook-session" } });
  expect(restored.hook.originalRequest).toBeNull(); expect(restored.hook.activation).toBeNull();
});

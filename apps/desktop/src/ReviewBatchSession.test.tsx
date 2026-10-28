import { useLayoutEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { ExecutionTaskProvider, type MutationCoordinator } from "./ExecutionTaskSession";
import { executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { REVIEW_BATCH_PREPARE_LIMIT, ReviewDraftProvider, useReviewDraftSession, type ReviewBatchPreparation, type ReviewSession } from "./ReviewDraftSession";
import type { ReviewTarget, ReviewWrite } from "./reviewCommands";
import { SessionReadProvider } from "./SessionReadProvider";
import { SessionReads } from "./sessionReads";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewDecisionFixture, reviewSummaryFor, reviewTargetFixture } from "./testSupport/reviewFixture";
import wire from "../test/fixtures/reviewCommands.contract.json";
import errorWire from "../test/fixtures/commandErrors.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "fixed-review-batch", locator: "/synthetic/review-batch", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(6700), displayName: "Review batch", sourceLocale: "en", targetLocales: ["zh-CN", "ja"], metadataRevision: "1" } };
const targets = [reviewTargetFixture(), reviewTargetFixture({ unitId: fixtureIdentity(6701), nativeKey: "second", basis: "basis-second" }),
  reviewTargetFixture({ unitId: fixtureIdentity(6702), nativeKey: "third", basis: "basis-third" })];
type Args = { request: { projectId: string; sessionToken: string; decision?: ReviewWrite; actionId?: string; expectedBasis?: string; unitId?: string; locale?: string } };
let owner!: ReviewSession, sequence = 6800;
function Probe() {
  const review = useReviewDraftSession();
  useLayoutEffect(() => { owner = review; });
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function decision(request: ReviewWrite) {
  const target = targets.find(value => value.unitId === request.unitId && value.locale === request.locale);
  if (!target) throw new Error("Unexpected review target");
  return { ...reviewDecisionFixture(request, target), decisionId: fixtureIdentity(++sequence) };
}
function actionRead(request: ReviewWrite) {
  return { request: { ...request, expectedDecisionId: request.expectedDecisionId ?? null }, receipt: decision(request) };
}
function harness() {
  const reads = new SessionReads(executionContext(project));
  let held: symbol | null = null;
  const mutations = {
    reserveMutation: vi.fn(() => { if (held) return null; held = Symbol("review-batch"); return held; }),
    releaseMutation: vi.fn((token: symbol) => { if (token !== held) throw new Error("Foreign mutation token"); held = null; }),
  } satisfies MutationCoordinator;
  const content = (visible = true, current = project) => <ApplicationReadProvider><SessionReadProvider context={reads.context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={current} mutations={mutations}><ReviewDraftProvider project={current} mutations={mutations}>
      {visible ? <Probe/> : null}
    </ReviewDraftProvider></ExecutionTaskProvider>
  </SessionReadProvider></ApplicationReadProvider>;
  const view = render(content());
  act(() => { owner.setSelected(targets[0]); owner.setActor(" Reviewer A "); owner.editReason(targets[0], "Reason A 👩🏽‍💻"); });
  return { reads, mutations, view, content };
}
function preparation(values: readonly ReviewTarget[] = targets.slice(0, 2)): ReviewBatchPreparation {
  return { ...executionContext(project), targets: values, expectedChosen: owner.current().chosen };
}
function prepare(values: readonly ReviewTarget[] = targets.slice(0, 2)) {
  let prepared = false;
  act(() => { prepared = owner.prepareBatch(preparation(values), () => true); });
  expect(prepared).toBe(true);
  return { chosen: owner.current().chosen, actor: owner.current().actor.trim() };
}
beforeEach(() => {
  invoke.mockReset(); sequence = 6800;
  invoke.mockImplementation(async (name: string, { request }: Args) => {
    if (name === "create_execution_identity") return fixtureIdentity(++sequence);
    if (name === "write_review_decision" && request.decision) return decision(request.decision);
    if (name === "prepare_review_checks") return { kind: "plugin", view: { ...wire.responses.prepareCheck.view,
      actionId: request.actionId, unitId: request.unitId, locale: request.locale, basis: request.expectedBasis } };
    throw new Error(`Unexpected command ${name}`);
  });
});
afterEach(cleanup);

it("prepares only bounded summaries atomically, accepts selected empty text, and preserves all other owner inputs", async () => {
  harness();
  act(() => { owner.semantic.setRules(["style"]); owner.semantic.setPresetName("retained-preset"); });
  await act(async () => { await owner.prepareCheck(() => true); });
  const check = owner.current().checkReview;
  if (!check) throw new Error("Missing checker preparation");
  act(() => { for (const slot of check.view.checkers) owner.setCheckerConsent(slot.attemptId, slot.inputDigest, true); });
  const before = owner.current(), semantic = owner.semantic.current(), count = invoke.mock.calls.length;
  const empty = reviewTargetFixture({ ...targets[1], translationText: "", sourceText: "👩".repeat(300) });
  prepare([targets[0], empty]);
  const state = owner.current();
  expect(state.actor).toBe(before.actor); expect(state.drafts).toBe(before.drafts); expect(state.editSeq).toBe(before.editSeq);
  expect(state.draftTargets).toBe(before.draftTargets); expect(state.selected).toBe(before.selected); expect(state.projection).toBe(before.projection);
  expect(state.checkReview).toBe(check); expect(state.checkConsent).toBe(before.checkConsent); expect(state.advisoryChecks).toBe(before.advisoryChecks);
  expect(owner.semantic.current().rules).toEqual(semantic.rules); expect(owner.semantic.current().config).toBe(semantic.config);
  expect(owner.semantic.current().presetName).toBe("retained-preset");
  expect(state.batchItems.map(item => item.status)).toEqual(["not-started", "not-started"]);
  expect(state.batchItems[1].target.translationPreview).toBe(""); expect(state.batchItems[1].target.sourcePreview).toBe("👩".repeat(256));
  expect(state.batchItems[0].target).toBe(state.chosen[`${targets[0].locale}:${targets[0].unitId}`]);
  expect(state.batchStatus).toBeNull(); expect(state.batchEnded).toBe(false); expect(invoke.mock.calls).toHaveLength(count);
  act(() => { expect(owner.endBatch(state.chosen)).toBe(true); });
  expect(owner.current().checkReview).toBe(check); expect(owner.current().checkConsent).toBe(state.checkConsent);
  expect(owner.current().advisoryChecks).toBe(state.advisoryChecks); expect(owner.current().draftTargets).toBe(state.draftTargets);
  expect(owner.semantic.current().config).toBe(semantic.config); expect(invoke.mock.calls).toHaveLength(count);
});

it.each(["project", "session", "chosen", "proof", "duplicate", "unselected", "locale", "snapshot", "evidence", "limit"] as const)(
  "rejects an invalid %s preparation without altering any retained state", invalid => {
    harness();
    const input = preparation(), before = owner.current(), semantic = owner.semantic.current();
    if (invalid === "project") input.projectId = fixtureIdentity(6799);
    if (invalid === "session") input.sessionToken = "other-session";
    if (invalid === "chosen") input.expectedChosen = {};
    if (invalid === "duplicate") input.targets = [targets[0], targets[0]];
    if (invalid === "unselected") input.targets = [reviewTargetFixture({ selectionId: null, revisionId: null, translationText: null })];
    if (invalid === "locale") input.targets = [targets[0], reviewTargetFixture({ ...targets[1], locale: "ja" })];
    if (invalid === "snapshot") input.targets = [targets[0], reviewTargetFixture({ ...targets[1], sourceSnapshotId: fixtureIdentity(6798) })];
    if (invalid === "evidence") input.targets = [{ ...targets[0], basisEvidence: { ...targets[0].basisEvidence, revisionId: fixtureIdentity(6798) } }];
    if (invalid === "limit") input.targets = Array.from({ length: REVIEW_BATCH_PREPARE_LIMIT + 1 }, (_, index) => reviewTargetFixture({ unitId: fixtureIdentity(7000 + index) }));
    act(() => { expect(owner.prepareBatch(input, () => invalid !== "proof")).toBe(false); });
    expect(owner.current()).toBe(before); expect(owner.semantic.current()).toBe(semantic); expect(invoke).not.toHaveBeenCalled();
  });

it("requires ending an existing batch or legacy chosen intent before another atomic preparation", () => {
  harness();
  act(() => { owner.toggleChosen(reviewSummaryFor(targets[0]), true); });
  const legacy = owner.current();
  act(() => { expect(owner.prepareBatch(preparation([targets[1]]), () => true)).toBe(false); });
  expect(owner.current()).toBe(legacy);
  act(() => { expect(owner.endBatch(legacy.chosen)).toBe(true); });
  prepare();
  const prepared = owner.current();
  act(() => { expect(owner.prepareBatch(preparation([targets[2]]), () => true)).toBe(false); });
  expect(owner.current()).toBe(prepared);
  act(() => { expect(owner.endBatch(prepared.chosen)).toBe(true); });
  expect(owner.current().batchItems).toBe(prepared.batchItems); expect(owner.current().drafts).toBe(prepared.drafts);
  prepare([targets[2]]); expect(owner.current().batchItems.map(item => item.target.unitId)).toEqual([targets[2].unitId]);
  expect(invoke).not.toHaveBeenCalled();
});

it("rejects old confirmation captures and a stale initial read before allocating an identity", async () => {
  harness(); const capture = prepare(), before = owner.current();
  await act(async () => {
    await owner.approveBatch({ ...capture, chosen: { ...capture.chosen } }, () => true);
    await owner.approveBatch({ ...capture, actor: "Reviewer B" }, () => true);
    await owner.approveBatch(capture, () => false);
  });
  expect(owner.current()).toBe(before); expect(invoke).not.toHaveBeenCalled();
});

it.each(["read", "chosen"] as const)("does not write when the first identity outlives its %s proof", async changed => {
  const h = harness(), capture = prepare(), identity = deferred<string>(); let fresh = true, job!: Promise<void>;
  invoke.mockImplementation(async () => identity.promise);
  act(() => { job = owner.approveBatch(capture, () => fresh); });
  expect(owner.current().batchRunning).toBe(true);
  act(() => { if (changed === "read") fresh = false; else owner.toggleChosen(reviewSummaryFor(targets[2]), true); owner.editReason(targets[0], "Reason B"); });
  await act(async () => { identity.resolve(fixtureIdentity(6810)); await job; });
  expect(calls("write_review_decision")).toHaveLength(0); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(owner.current().batchStatus).toEqual({ applied: 0, conflicted: 0, failed: 0, pending: 0, notStarted: 2 });
  expect(owner.current().drafts[`${targets[0].locale}:${targets[0].unitId}`]).toBe("Reason B");
  expect(h.mutations.releaseMutation).toHaveBeenCalledOnce();
});

it("keeps confirmed actor A through identity, retains B, and stops consulting the dialog proof after the first write", async () => {
  const h = harness(), capture = prepare(), identity = deferred<string>(), writing = deferred<unknown>();
  const native = invoke.getMockImplementation()!; let fresh = true, job!: Promise<void>;
  invoke.mockImplementation((name: string, args: Args) => name === "create_execution_identity" && !calls("write_review_decision").length
    ? identity.promise : name === "write_review_decision" && args.request.decision?.unitId === targets[0].unitId ? writing.promise : native(name, args));
  act(() => { job = owner.approveBatch(capture, () => fresh); });
  act(() => { owner.setActor("Reviewer B"); owner.editReason(targets[0], "Reason B"); });
  await act(async () => { identity.resolve(fixtureIdentity(6811)); });
  await waitFor(() => expect(calls("write_review_decision")).toHaveLength(1));
  const request = owner.current().batchItems[0].request;
  if (!request) throw new Error("Missing original batch request");
  act(() => { fresh = false; h.reads.invalidate(["review"]); owner.toggleChosen(reviewSummaryFor(targets[2]), true); });
  h.view.rerender(h.content(false));
  await act(async () => { writing.resolve(decision(request)); await job; });
  expect(calls("write_review_decision").map(([, args]) => args.request.decision)).toMatchObject([
    { actor: "Reviewer A", reason: "", unitId: targets[0].unitId }, { actor: "Reviewer A", reason: "", unitId: targets[1].unitId },
  ]);
  expect(owner.current().batchStatus).toEqual({ applied: 2, conflicted: 0, failed: 0, pending: 0, notStarted: 0 });
  expect(Object.values(owner.current().chosen).map(target => target.unitId)).toEqual([targets[2].unitId]);
  expect(owner.current().actor).toBe("Reviewer B"); expect(owner.current().drafts[`${targets[0].locale}:${targets[0].unitId}`]).toBe("Reason B");
  expect(h.mutations.reserveMutation).toHaveBeenCalledOnce(); expect(h.mutations.releaseMutation).toHaveBeenCalledOnce();
});

it("reports each conflict, definite failure and committed receipt without treating all remaining choices alike", async () => {
  harness(); const capture = prepare(targets), native = invoke.getMockImplementation()!;
  const denied = errorWire.errors.find(error => error.code === "permission-denied");
  if (!denied) throw new Error("Missing rejected permission fixture");
  invoke.mockImplementation(async (name: string, args: Args) => {
    if (name === "write_review_decision" && args.request.decision?.unitId === targets[0].unitId) throw errorWire.errors[2];
    if (name === "write_review_decision" && args.request.decision?.unitId === targets[1].unitId) throw denied;
    return native(name, args);
  });
  await act(async () => { await owner.approveBatch(capture, () => true); });
  expect(owner.current().batchItems.map(item => item.status)).toEqual(["conflicted", "failed", "recorded"]);
  expect(owner.current().batchItems[0].failure).toMatchObject({ code: "dependency-conflict" });
  expect(owner.current().batchItems[1].failure).toMatchObject({ code: "permission-denied" });
  expect(owner.current().batchItems[2].receipt?.actionId).toBe(owner.current().batchItems[2].request?.actionId);
  expect(owner.current().batchStatus).toEqual({ applied: 1, conflicted: 1, failed: 1, pending: 0, notStarted: 0 });
  expect(Object.values(owner.current().chosen).map(target => target.unitId)).toEqual(targets.slice(0, 2).map(target => target.unitId));
  expect(calls("read_review_decision_action")).toHaveLength(0);
});

it("stops after the current write, retains results on explicit resume, and ends only its own selection intent", async () => {
  const h = harness(), capture = prepare(), writing = deferred<unknown>(), native = invoke.getMockImplementation()!; let job!: Promise<void>;
  invoke.mockImplementation((name: string, args: Args) => name === "write_review_decision" && args.request.decision?.unitId === targets[0].unitId ? writing.promise : native(name, args));
  act(() => { job = owner.approveBatch(capture, () => true); });
  await waitFor(() => expect(calls("write_review_decision")).toHaveLength(1));
  act(() => { expect(owner.endBatch(owner.current().chosen)).toBe(false); owner.stopBatch(); });
  const first = owner.current().batchItems[0].request;
  if (!first) throw new Error("Missing first request");
  await act(async () => { writing.resolve(decision(first)); await job; });
  expect(owner.current().batchItems.map(item => item.status)).toEqual(["recorded", "not-started"]);
  const remaining = owner.current().chosen;
  await act(async () => { await owner.approveBatch({ chosen: remaining, actor: "Reviewer A" }, () => true); });
  expect(owner.current().batchItems.map(item => item.status)).toEqual(["recorded", "recorded"]);
  expect(owner.current().batchItems[0].request).toBe(first);
  expect(owner.current().batchStatus).toEqual({ applied: 2, conflicted: 0, failed: 0, pending: 0, notStarted: 0 });
  act(() => { owner.semantic.setRules(["style"]); owner.semantic.setPresetName("keep-me"); });
  const before = owner.current(), semantic = owner.semantic.current(), token = h.mutations.reserveMutation();
  if (!token) throw new Error("Missing external reservation");
  act(() => { expect(owner.endBatch(before.chosen)).toBe(false); });
  expect(owner.current()).toBe(before); h.mutations.releaseMutation(token);
  act(() => { expect(owner.endBatch({ ...before.chosen })).toBe(false); expect(owner.endBatch(before.chosen)).toBe(true); });
  expect(owner.current().batchEnded).toBe(true); expect(owner.current().chosen).toEqual({});
  expect(owner.current().batchItems).toBe(before.batchItems); expect(owner.current().batchStatus).toBe(before.batchStatus);
  expect(owner.current().drafts).toBe(before.drafts); expect(owner.current().checkReview).toBe(before.checkReview);
  expect(owner.semantic.current().rules).toEqual(semantic.rules); expect(owner.semantic.current().presetName).toBe("keep-me");
  expect(calls("write_review_decision")).toHaveLength(2); expect(calls("create_execution_identity")).toHaveLength(2);
});

it.each([false, true])("settles only the original unknown item without resuming later choices (late check: %s)", async late => {
  const h = harness(), capture = prepare(), native = invoke.getMockImplementation()!; let original: ReviewWrite | null = null, lookups = 0;
  invoke.mockImplementation(async (name: string, args: Args) => {
    if (name === "write_review_decision" && args.request.decision) { original = args.request.decision; throw new Error("Lost batch ACK"); }
    if (name === "read_review_decision_action" && original) { if (late && ++lookups === 1) throw new Error("Read unavailable"); return actionRead(original); }
    return native(name, args);
  });
  await act(async () => { await owner.approveBatch(capture, () => true); });
  if (late) {
    expect(owner.current().batchStatus).toEqual({ applied: 0, conflicted: 0, failed: 0, pending: 1, notStarted: 1 });
    expect(owner.current().batchItems[0].status).toBe("pending");
    act(() => { expect(owner.endBatch(owner.current().chosen)).toBe(false); owner.setActor("Reviewer B"); owner.editReason(targets[0], "Reason B"); });
    h.view.rerender(h.content(false, { ...project, metadata: { ...project.metadata, targetLocales: ["ja"], metadataRevision: "2" } }));
    await act(async () => { await owner.checkPending(); });
  }
  expect(owner.current().pending).toBeNull();
  expect(owner.current().batchItems.map(item => item.status)).toEqual(["recorded", "not-started"]);
  expect(owner.current().batchItems[0].request).toBe(original);
  expect(owner.current().batchStatus).toEqual({ applied: 1, conflicted: 0, failed: 0, pending: 0, notStarted: 1 });
  const status = owner.current().batchStatus;
  await act(async () => { await owner.checkPending(); await owner.retryPending(); });
  expect(owner.current().batchStatus).toBe(status);
  expect(calls("write_review_decision")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(h.mutations.releaseMutation).toHaveBeenCalledOnce();
  if (late) { expect(owner.current().actor).toBe("Reviewer B"); expect(owner.current().drafts[`${targets[0].locale}:${targets[0].unitId}`]).toBe("Reason B"); }
});

it("keeps unknown retries tied to the exact request and token, including a definite rejection after uncertainty", async () => {
  const h = harness(), capture = prepare(), native = invoke.getMockImplementation()!; let writes = 0;
  invoke.mockImplementation(async (name: string, args: Args) => {
    if (name === "write_review_decision") { if (++writes === 1) throw new Error("Lost ACK"); if (writes === 2) throw errorWire.errors[2]; }
    if (name === "read_review_decision_action") return null;
    return native(name, args);
  });
  await act(async () => { await owner.approveBatch(capture, () => true); });
  const pending = owner.current().pending, request = owner.current().batchItems[0].request;
  expect(pending).not.toBeNull(); expect(owner.current().retryAllowed).toBe(true);
  act(() => { owner.setActor("Reviewer B"); owner.editReason(targets[0], "Reason B"); });
  await act(async () => { await owner.retryPending(); });
  expect(owner.current().pending).toBe(pending); expect(owner.current().retryAllowed).toBe(false);
  expect(owner.current().batchItems[0]).toMatchObject({ status: "pending", request });
  expect(owner.current().batchStatus).toEqual({ applied: 0, conflicted: 0, failed: 0, pending: 1, notStarted: 1 });
  await act(async () => { await owner.retryPending(); }); expect(writes).toBe(2);
  await act(async () => { await owner.checkPending(); await owner.retryPending(); });
  expect(owner.current().batchItems.map(item => item.status)).toEqual(["recorded", "not-started"]);
  expect(owner.current().batchItems[0].request).toBe(request);
  expect(owner.current().batchStatus).toEqual({ applied: 1, conflicted: 0, failed: 0, pending: 0, notStarted: 1 });
  expect(calls("write_review_decision").map(([, args]) => args.request.decision)).toEqual([request, request, request]);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(h.mutations.reserveMutation).toHaveBeenCalledOnce(); expect(h.mutations.releaseMutation).toHaveBeenCalledOnce();
  expect(owner.current().actor).toBe("Reviewer B"); expect(owner.current().drafts[`${targets[0].locale}:${targets[0].unitId}`]).toBe("Reason B");
});

it("preserves the default legacy batch path without imposing the new preparation limit on it", async () => {
  harness(); const identity = deferred<string>(); let job!: Promise<void>;
  act(() => { for (let index = 0; index <= REVIEW_BATCH_PREPARE_LIMIT; index++) owner.toggleChosen(reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(7200 + index) })), true); });
  invoke.mockImplementation(async () => identity.promise);
  act(() => { job = owner.approveBatch(); });
  expect(calls("create_execution_identity")).toHaveLength(1); expect(owner.current().batchRunning).toBe(true);
  act(() => { owner.stopBatch(); });
  await act(async () => { identity.resolve(fixtureIdentity(6812)); await job; });
  expect(calls("write_review_decision")).toHaveLength(0);
  expect(owner.current().batchStatus).toEqual({ applied: 0, conflicted: 0, failed: 0, pending: 0, notStarted: 101 });
});

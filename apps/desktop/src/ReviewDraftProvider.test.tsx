import { useLayoutEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { ExecutionTaskProvider, type MutationCoordinator } from "./ExecutionTaskSession";
import { executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { ReviewDraftProvider, useReviewDraftSession, type ReviewSession } from "./ReviewDraftSession";
import type { ReviewCheckRequest, ReviewWrite } from "./reviewCommands";
import { SessionReadProvider } from "./SessionReadProvider";
import { SessionReads } from "./sessionReads";
import { TranslationDrafts } from "./app-v2/features/editor/translationDrafts";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewCheckFixture, reviewDecisionFixture, reviewSummaryFor, reviewTargetFixture } from "./testSupport/reviewFixture";
import wire from "../test/fixtures/reviewCommands.contract.json";
import errorWire from "../test/fixtures/commandErrors.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "shared-review-session", locator: "/synthetic/shared-review", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(3370), displayName: "Shared review", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const target = reviewTargetFixture(), reasonKey = `${target.locale}:${target.unitId}`;
type Args = { request: ReviewCheckRequest & { decision: ReviewWrite; check: ReviewCheckRequest } };
let owner!: ReviewSession;
function Probe() {
  const review = useReviewDraftSession();
  useLayoutEffect(() => { owner = review; });
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
async function harness() {
  const reads = new SessionReads(executionContext(project));
  const drafts = new TranslationDrafts({ context: reads.context, reads,
    ports: { list: async () => ({ items: [], next: null }), writerId: () => fixtureIdentity(3371) } });
  expect(await drafts.initialize()).toBe(true);
  const mutations = {
    reserveMutation: vi.fn(() => drafts.reserveMutation("retained-for-navigation")),
    releaseMutation: vi.fn((token: symbol) => drafts.releaseMutation(token)),
  };
  const content = (reviewMutations: MutationCoordinator = mutations, visible = true) => <ApplicationReadProvider>
    <SessionReadProvider context={reads.context} reads={reads} bridge={false}>
      <ExecutionTaskProvider project={project} mutations={mutations}>
        <ReviewDraftProvider project={project} mutations={reviewMutations}>{visible ? <Probe/> : null}</ReviewDraftProvider>
      </ExecutionTaskProvider>
    </SessionReadProvider>
  </ApplicationReadProvider>;
  const view = render(content());
  act(() => { owner.setSelected(target); owner.setActor("Reviewer A"); owner.editReason(target, "Reason A"); });
  return { reads, drafts, mutations, view, content };
}
async function readyCheck() {
  await act(async () => { await owner.prepareCheck(() => true); });
  const capture = owner.current().checkReview;
  if (!capture) throw new Error("Checker preparation is missing");
  act(() => { for (const slot of capture.view.checkers) owner.setCheckerConsent(slot.attemptId, slot.inputDigest, true); });
  return capture;
}
function checkRead(request: ReviewCheckRequest) {
  return { request: { projectId: request.projectId, actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    expectedBasis: request.expectedBasis, advisoryChecks: request.advisoryChecks.map(choice => ({ plugin: choice.package.plugin,
      packageDigest: choice.package.packageDigest, resourceId: choice.resourceId, environmentDigest: choice.environmentDigest, rules: choice.rules })) },
    receipt: reviewCheckFixture(target, request.actionId) };
}
beforeEach(() => {
  invoke.mockReset();
  let identity = 3380;
  invoke.mockImplementation(async (command: string, { request }: Args) => {
    if (command === "create_execution_identity") return fixtureIdentity(++identity);
    if (command === "write_review_decision") return reviewDecisionFixture(request.decision, target);
    if (command === "prepare_review_checks") return { kind: "plugin", view: { ...wire.responses.prepareCheck.view,
      actionId: request.actionId, unitId: request.unitId, locale: request.locale, basis: request.expectedBasis } };
    if (command === "run_review_checks") return reviewCheckFixture(target, request.check.actionId);
    if (command === "cancel_review_checks") return true;
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(cleanup);

it.each(["decision", "prepare-check", "check", "batch"] as const)("refuses %s before allocating an identity when the shared draft slot is occupied", async kind => {
  const h = await harness();
  if (kind === "check") await readyCheck();
  if (kind === "batch") act(() => { owner.toggleChosen(reviewSummaryFor(target), true); });
  const identityCount = calls("create_execution_identity").length, writeCount = invoke.mock.calls.length;
  const token = h.drafts.reserveMutation();
  expect(token).not.toBeNull();
  await act(async () => {
    if (kind === "decision") await owner.decide("approve", () => true);
    else if (kind === "prepare-check") await owner.prepareCheck(() => true);
    else if (kind === "check") await owner.check(() => true);
    else await owner.approveBatch();
  });
  expect(calls("create_execution_identity")).toHaveLength(identityCount);
  expect(invoke.mock.calls).toHaveLength(writeCount);
  expect(owner.current()).toMatchObject({ pending: null, busyMutation: false, actor: "Reviewer A", drafts: { [reasonKey]: "Reason A" } });
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  if (token) h.drafts.releaseMutation(token);
});

it("retains the original token through missing reads and rejected replay, preserving B until a pure read confirms A", async () => {
  const h = await harness(), writing = deferred<unknown>();
  const native = invoke.getMockImplementation()!;
  let original: ReviewWrite | null = null, found = false;
  invoke.mockImplementation(async (command: string, args: Args) => {
    if (command === "write_review_decision") {
      original ??= structuredClone(args.request.decision);
      if (calls(command).length === 1) return writing.promise;
      throw errorWire.errors[1];
    }
    if (command === "read_review_decision_action") return found && original
      ? { request: original, receipt: reviewDecisionFixture(original, target) } : null;
    return native(command, args);
  });
  let job!: Promise<void>;
  act(() => { job = owner.decide("approve", () => true); });
  await waitFor(() => expect(calls("write_review_decision")).toHaveLength(1));
  expect(h.drafts.reserveMutation()).toBeNull();
  act(() => { owner.setActor("Reviewer B"); owner.editReason(target, "Reason B 👩🏽‍💻"); });
  await act(async () => { writing.reject(new Error("Lost acknowledgement")); await job; });
  const pending = owner.current().pending;
  expect(pending).not.toBeNull(); expect(owner.current().retryAllowed).toBe(true);
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  expect(h.mutations.reserveMutation).toHaveBeenCalledOnce(); expect(h.mutations.releaseMutation).not.toHaveBeenCalled();
  h.view.rerender(h.content(h.mutations, false));
  await act(async () => { await owner.checkPending(); await owner.retryPending(); });
  expect(owner.current().pending).toBe(pending); expect(owner.current().retryAllowed).toBe(false);
  expect(h.mutations.reserveMutation).toHaveBeenCalledOnce(); expect(h.mutations.releaseMutation).not.toHaveBeenCalled();
  expect(calls("write_review_decision").map(([, args]) => args.request.decision)).toEqual([original, original]);
  expect(calls("create_execution_identity")).toHaveLength(1);
  const replacement = { reserveMutation: vi.fn(() => null), releaseMutation: vi.fn() };
  h.view.rerender(h.content(replacement, false));
  found = true;
  await act(async () => { await owner.checkPending(); });
  expect(owner.current()).toMatchObject({ pending: null, busyMutation: false, actor: "Reviewer B", drafts: { [reasonKey]: "Reason B 👩🏽‍💻" } });
  expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
  expect(h.mutations.releaseMutation).toHaveBeenCalledOnce();
  expect(replacement.reserveMutation).not.toHaveBeenCalled(); expect(replacement.releaseMutation).not.toHaveBeenCalled();
  expect(calls("write_review_decision")).toHaveLength(2); expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["prepare-check", "check"] as const)("keeps unknown %s reserved for the original retry and read without another grant or lock", async kind => {
  const h = await harness();
  if (kind === "check") await readyCheck();
  const native = invoke.getMockImplementation()!, beforeReserves = h.mutations.reserveMutation.mock.calls.length;
  const command = kind === "check" ? "run_review_checks" : "prepare_review_checks";
  let found = false, original: ReviewCheckRequest | null = null;
  invoke.mockImplementation(async (name: string, args: Args) => {
    if (name === command) { original ??= structuredClone(kind === "check" ? args.request.check : args.request); throw new Error("Lost check acknowledgement"); }
    if (name === "read_review_check_action") return found && original ? checkRead(original) : null;
    return native(name, args);
  });
  await act(async () => { if (kind === "check") await owner.check(() => true); else await owner.prepareCheck(() => true); });
  const pending = owner.current().pending, identities = calls("create_execution_identity").length;
  expect(pending).not.toBeNull(); expect(owner.current().retryAllowed).toBe(true);
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  const releases = h.mutations.releaseMutation.mock.calls.length;
  if (kind === "check") {
    await act(async () => { await owner.cancelCheck(); });
    expect(calls("cancel_review_checks")[0][1].request.actionId).toBe(pending?.request.actionId);
    expect(owner.current().pending).toBe(pending); expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  }
  await act(async () => { await owner.checkPending(); await owner.retryPending(); });
  expect(owner.current().pending).toBe(pending);
  expect(h.mutations.reserveMutation).toHaveBeenCalledTimes(beforeReserves + 1);
  expect(h.mutations.releaseMutation).toHaveBeenCalledTimes(releases);
  const writes = calls(command).map(([, args]) => args.request);
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(calls("create_execution_identity")).toHaveLength(identities);
  found = true;
  await act(async () => { await owner.checkPending(); });
  expect(owner.current().pending).toBeNull(); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
  expect(h.mutations.releaseMutation).toHaveBeenCalledTimes(releases + 1);
  expect(calls("create_execution_identity")).toHaveLength(identities);
});

it("releases an identified but stale action without writing or losing newer input", async () => {
  const h = await harness(), identifying = deferred<string>();
  invoke.mockImplementation(async () => identifying.promise);
  let currentRead = true, job!: Promise<void>;
  act(() => { job = owner.decide("approve", () => currentRead); });
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  act(() => { owner.editReason(target, "Reason B"); currentRead = false; });
  await act(async () => { identifying.resolve(fixtureIdentity(3390)); await job; });
  expect(calls("write_review_decision")).toHaveLength(0);
  expect(owner.current()).toMatchObject({ pending: null, busyMutation: false, drafts: { [reasonKey]: "Reason B" } });
  expect(h.drafts.getSnapshot().mutationReserved).toBe(false); expect(h.mutations.releaseMutation).toHaveBeenCalledOnce();
});

it("holds a batch reservation across its identities and releases only after the outer batch finishes", async () => {
  const h = await harness(), secondWrite = deferred<unknown>();
  const second = reviewTargetFixture({ unitId: fixtureIdentity(3391), nativeKey: "second" });
  act(() => { owner.toggleChosen(reviewSummaryFor(target), true); owner.toggleChosen(reviewSummaryFor(second), true); });
  const native = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: Args) => {
    if (command === "write_review_decision" && args.request.decision.unitId === second.unitId) return secondWrite.promise;
    return native(command, args);
  });
  let job!: Promise<void>;
  act(() => { job = owner.approveBatch(); });
  await waitFor(() => expect(calls("write_review_decision")).toHaveLength(2));
  expect(h.mutations.reserveMutation).toHaveBeenCalledOnce(); expect(h.mutations.releaseMutation).not.toHaveBeenCalled();
  expect(h.drafts.reserveMutation()).toBeNull(); expect(owner.current().batchRunning).toBe(true);
  const request: ReviewWrite = calls("write_review_decision")[1][1].request.decision;
  await act(async () => { secondWrite.resolve(reviewDecisionFixture(request, second)); await job; });
  expect(owner.current().batchStatus).toEqual({ applied: 2, conflicted: 0, failed: 0, pending: 0, notStarted: 0 });
  expect(h.mutations.releaseMutation).toHaveBeenCalledOnce(); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
});

it("releases the held coordinator on owner disposal without settling or replaying its uncertain request", async () => {
  const h = await harness();
  const native = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: Args) => {
    if (command === "write_review_decision") throw new Error("Lost acknowledgement");
    if (command === "read_review_decision_action") return null;
    return native(command, args);
  });
  await act(async () => { await owner.decide("approve", () => true); });
  const retained = owner, pending = retained.current().pending;
  expect(pending).not.toBeNull(); expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  h.view.unmount();
  expect(h.mutations.releaseMutation).toHaveBeenCalledOnce(); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
  await act(async () => { await retained.checkPending(); await retained.retryPending(); });
  expect(retained.current().pending).toBe(pending);
  expect(calls("write_review_decision")).toHaveLength(1); expect(calls("read_review_decision_action")).toHaveLength(1);
});

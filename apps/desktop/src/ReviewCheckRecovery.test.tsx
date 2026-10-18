import { useLayoutEffect } from "react";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReviewDraftSession } from "./ReviewDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewCheckFixture, reviewTargetFixture } from "./testSupport/reviewFixture";
import type { ProjectView } from "./projectCommands";
import type { ReviewCheckRequest } from "./reviewCommands";
import wire from "../test/fixtures/reviewCommands.contract.json";
import { i18n } from "./i18n";
import errorWire from "../test/fixtures/commandErrors.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "original-check-session", locator: "/synthetic/check", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(3500), displayName: "Review", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let owner!: ReturnType<typeof useReviewDraftSession>, reads!: ReturnType<typeof useSessionReads>;
function Probe() {
  const review = useReviewDraftSession(), session = useSessionReads();
  useLayoutEffect(() => { owner = review; reads = session; });
  return null;
}
const kinds = ["prepare-check", "check"] as const;
type Kind = typeof kinds[number];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function calls(name: string) { return invoke.mock.calls.filter(([command]) => command === name); }
function command(kind: Kind) { return kind === "check" ? "run_review_checks" : "prepare_review_checks"; }
function savedRequest(request: ReviewCheckRequest) {
  return { projectId: request.projectId, actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    expectedBasis: request.expectedBasis, advisoryChecks: request.advisoryChecks.map(choice => ({ plugin: choice.package.plugin,
      packageDigest: choice.package.packageDigest, resourceId: choice.resourceId, environmentDigest: choice.environmentDigest, rules: choice.rules })) };
}
function setup() {
  const target = reviewTargetFixture(), view = render(<Probe />, project);
  act(() => { owner.setSelected(target); owner.setActor("Reviewer A"); owner.editReason(target, "Reason A"); });
  let identity = 3510;
  invoke.mockImplementation(async (name: string, args: { request: ReviewCheckRequest }) => {
    if (name === "create_execution_identity") return fixtureIdentity(++identity);
    if (name === "prepare_review_checks") return { kind: "plugin", view: { ...wire.responses.prepareCheck.view,
      actionId: args.request.actionId, unitId: args.request.unitId, locale: args.request.locale, basis: args.request.expectedBasis } };
    throw new Error(`Unexpected ${name}`);
  });
  return { target, view };
}
async function ready(kind: Kind) {
  if (kind === "prepare-check") return;
  await act(async () => { await owner.prepareCheck(() => true); });
  const capture = owner.current().checkReview!;
  act(() => { for (const slot of capture.view.checkers) owner.setCheckerConsent(slot.attemptId, slot.inputDigest, true); });
}
function perform(kind: Kind) { return kind === "check" ? owner.check(() => true) : owner.prepareCheck(() => true); }
function install(kind: Kind, write: (request: ReviewCheckRequest) => unknown, read: (request: ReviewCheckRequest) => unknown) {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name: string, args: { request: ReviewCheckRequest & { check: ReviewCheckRequest } }) => {
    if (name === command(kind)) return write(kind === "check" ? args.request.check : args.request);
    if (name === "read_review_check_action") return read(args.request);
    return original(name, args);
  });
}
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

it.each(kinds.flatMap(kind => (["lost", "invalid"] as const).map(ack => ({kind,ack}))))("confirms $kind after one $ack ACK pure read without another preparation, run, grant or identity", async ({kind,ack}) => {
  const { target } = setup(); await ready(kind);
  let original!: ReviewCheckRequest;
  install(kind, request => { original = structuredClone(request); if (ack === "invalid") return {}; throw new Error("Lost response"); },
    request => ({ request: savedRequest(request), receipt: reviewCheckFixture(target, request.actionId) }));
  await act(async () => { await perform(kind); });
  expect(owner.current().pending).toBeNull(); expect(owner.current().notice).toBe("saved");
  expect(owner.current().drafts[`${target.locale}:${target.unitId}`]).toBe("Reason A");
  expect(owner.current().selected?.currentCheck?.actionId).toBe(original.actionId);
  expect(calls("read_review_check_action")).toHaveLength(1); expect(calls("read_review_check_action")[0][1].request).toEqual(original);
  expect(calls(command(kind))).toHaveLength(1); expect(calls("run_review_checks")).toHaveLength(kind === "check" ? 1 : 0);
  expect(calls("prepare_review_checks")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(kind === "check" ? 2 : 1);
  expect(owner.current().checkReview).toBeNull(); expect(owner.current().checkConsent).toEqual([]);
});

it.each(kinds.flatMap(kind => (["failed", "cancelled", "unknown"] as const).map(outcome => ({kind,outcome}))))("preserves the original $outcome QA outcome recovered from $kind", async ({kind,outcome}) => {
  const { target } = setup(); await ready(kind);
  install(kind, () => { throw new Error("Lost response"); }, request => ({ request: savedRequest(request), receipt: reviewCheckFixture(target, request.actionId, outcome) }));
  await act(async () => { await perform(kind); });
  expect(owner.current().pending).toBeNull(); expect(owner.current().notice).toBe(outcome === "failed" ? "checkFailed" : outcome === "cancelled" ? "checkCancelled" : "checkUnknown");
  expect(owner.current().selected?.currentCheck?.outcome).toBe(outcome); expect(owner.current().retryAllowed).toBe(false);
});

it.each(kinds)("allows only explicit exact retry after missing final %s evidence and preserves a later rejection as unresolved", async kind => {
  setup(); await ready(kind); let writes = 0;
  const rejection = errorWire.errors[1];
  install(kind, () => { if (++writes === 1) throw new Error("Lost response"); throw rejection; }, () => null);
  await act(async () => { await perform(kind); });
  const pending = owner.current().pending;
  expect(pending).not.toBeNull(); expect(owner.current().retryAllowed).toBe(true);
  expect(owner.current().notice).toBe("unknown");
  await act(async () => { await owner.retryPending(); });
  expect(owner.current().pending).toBe(pending); expect(owner.current().pendingUncertain).toBe(true); expect(owner.current().retryAllowed).toBe(false);
  const requests = calls(command(kind)).map(([,args]) => args.request);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(calls("read_review_check_action")).toHaveLength(1);
  await act(async () => { await owner.retryPending(); }); expect(writes).toBe(2);
});

it.each(kinds)("does not query or retain a fresh formally rejected %s", async kind => {
  setup(); await ready(kind);
  install(kind, () => { throw errorWire.errors[1]; }, () => { throw new Error("Must not read"); });
  await act(async () => { await perform(kind); });
  expect(owner.current().pending).toBeNull(); expect(owner.current().notice).toBe("conflict"); expect(calls("read_review_check_action")).toHaveLength(0);
});

it.each(kinds.flatMap(kind => (["error", "echo", "basis"] as const).map(proof => ({kind,proof}))))("keeps $kind unresolved on $proof and uses the same manual read without automatic replay", async ({kind,proof}) => {
  const { target } = setup(); await ready(kind); let checking = 0;
  install(kind, () => { throw new Error("Lost response"); }, request => {
    const result = { request: savedRequest(request), receipt: reviewCheckFixture(target, request.actionId, "completed", { basisEvidence: structuredClone(target.basisEvidence) }) };
    if (++checking === 1) {
      if (proof === "error") throw new Error("Read failed");
      if (proof === "echo") result.request.expectedBasis = "another basis";
      else result.receipt.basisEvidence.sourceSnapshotId = fixtureIdentity(3590);
    }
    return result;
  });
  await act(async () => { await perform(kind); });
  expect(owner.current().pending).not.toBeNull(); expect(owner.current().retryAllowed).toBe(false);
  await act(async () => { await owner.retryPending(); }); expect(calls(command(kind))).toHaveLength(1);
  await act(async () => { await owner.checkPending(); });
  expect(owner.current().pending).toBeNull(); expect(owner.current().notice).toBe("saved");
  expect(calls("read_review_check_action")).toHaveLength(2); expect(calls("read_review_check_action")[1][1]).toEqual(calls("read_review_check_action")[0][1]);
  expect(calls(command(kind))).toHaveLength(1);
});

it.each(kinds)("holds one %s recovery flight, preserves B and a newer observed run after consumers disappear", async kind => {
  const { target, view } = setup(); await ready(kind); const checking = deferred<unknown>();
  let original!: ReviewCheckRequest;
  install(kind, request => { original = structuredClone(request); throw new Error("Lost response"); }, () => checking.promise);
  let job!: Promise<void>;
  await act(async () => { job = perform(kind); });
  expect(owner.current().checkingAction).toBe(true); expect(owner.inFlight()).toBe(true);
  await act(async () => { await owner.checkPending(); await owner.retryPending(); });
  expect(calls("read_review_check_action")).toHaveLength(1);
  const newer = reviewCheckFixture(target, fixtureIdentity(3591), "completed", { runId: fixtureIdentity(3592) });
  act(() => { owner.setActor("Reviewer B"); owner.editReason(target, "Reason B"); owner.observeProjection({ ...target, currentCheck: newer }, { unitId: target.unitId, locale: target.locale, basis: target.basis,
    editSeq: owner.current().editSeq[`${target.locale}:${target.unitId}`] ?? 0 }); });
  view.rerender(<></>);
  await act(async () => { checking.resolve({ request: savedRequest(original), receipt: reviewCheckFixture(target, original.actionId, "failed") }); await job; });
  expect(owner.current().pending).toBeNull(); expect(owner.current().notice).toBe("checkFailed");
  expect(owner.current().projection?.currentCheck).toEqual(newer);
  expect(owner.current().selected?.currentCheck?.actionId).toBe(original.actionId);
  expect(owner.current().drafts[`${target.locale}:${target.unitId}`]).toBe("Reason B"); expect(owner.current().actor).toBe("Reviewer B");
  expect(calls(command(kind))).toHaveLength(1);
});

it.each(kinds)("does not settle a retired %s owner from a late read", async kind => {
  const { target } = setup(); await ready(kind); const checking = deferred<unknown>(); let original!: ReviewCheckRequest;
  install(kind, request => { original = request; throw new Error("Lost response"); }, () => checking.promise);
  let job!: Promise<void>; await act(async () => { job = perform(kind); });
  const pending = owner.current().pending;
  act(() => { reads.retire(); });
  await act(async () => { checking.resolve({ request: savedRequest(original), receipt: reviewCheckFixture(target, original.actionId) }); await job; });
  expect(owner.current().pending).toBe(pending); expect(owner.current().selected?.currentCheck).toBeNull();
  await act(async () => { await owner.checkPending(); await owner.retryPending(); });
  expect(calls("read_review_check_action")).toHaveLength(1); expect(calls(command(kind))).toHaveLength(1);
});


it("clears an earlier preparation and its local permissions when the new preparation resolves to a saved result", async () => {
  const { target } = setup(); await ready("check");
  expect(owner.current().checkReview).not.toBeNull(); expect(owner.current().checkConsent.length).toBeGreaterThan(0);
  install("prepare-check", () => { throw new Error("Lost preparation response"); }, request => ({
    request: savedRequest(request), receipt: reviewCheckFixture(target, request.actionId),
  }));
  await act(async () => { await owner.prepareCheck(() => true); });
  expect(owner.current().pending).toBeNull(); expect(owner.current().checkReview).toBeNull(); expect(owner.current().checkConsent).toEqual([]);
  await act(async () => { await owner.check(() => true); });
  expect(calls("run_review_checks")).toHaveLength(0);
});

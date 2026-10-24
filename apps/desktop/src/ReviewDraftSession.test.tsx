import { useLayoutEffect } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReviewDraftSession } from "./ReviewDraftSession";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { pluginRuleKeyFixture } from "./testSupport/textReviewFixture";
import { reviewDecisionFixture, reviewSummaryFor, reviewTargetFixture } from "./testSupport/reviewFixture";
import type { ProjectView } from "./projectCommands";
import type { ReviewWrite, WaiverWrite, FallbackWrite, ReviewFindingWrite, ReviewTarget } from "./reviewCommands";
import errorWire from "../test/fixtures/commandErrors.contract.json";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "human-review-session", locator: "/synthetic/review", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(3300), displayName: "Review", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const kinds = ["decision", "waiver", "fallback", "finding"] as const;
type Kind = typeof kinds[number];
type Business = ReviewWrite | WaiverWrite | FallbackWrite | ReviewFindingWrite;
const names = {
  decision: { write: "write_review_decision", read: "read_review_decision_action", body: "decision" },
  waiver: { write: "waive_review_issue", read: "read_review_waiver_action", body: "waiver" },
  fallback: { write: "allow_source_fallback", read: "read_review_fallback_action", body: "fallback" },
  finding: { write: "write_review_finding", read: "read_review_finding_action", body: "finding" },
};
const issue = "a".repeat(64), runId = fixtureIdentity(3301);
const evidence = { runId, purpose: "qa" as const, aiOrigin: null,
  requirement: { key: pluginRuleKeyFixture("synthetic.review"), inputDigest: "b".repeat(64), scopeDigest: "c".repeat(64),
    targets: [fixtureIdentity(601)], mandatory: false, waivable: false, notApplicable: null },
  finding: { issueId: issue, rule: "plugin:synthetic.review", code: "advice", detail: "Original evidence", severity: "warning", waivable: false } };
let owner!: ReturnType<typeof useReviewDraftSession>, manual!: ReturnType<typeof useTranslationDraftSession>, reads!: ReturnType<typeof useSessionReads>;
function Probe() {
  const review = useReviewDraftSession(), translation = useTranslationDraftSession(), sessionReads = useSessionReads();
  useLayoutEffect(() => { owner = review; manual = translation; reads = sessionReads; });
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function receipt(kind: Kind, request: Business, target: ReviewTarget) {
  if (kind === "decision") return reviewDecisionFixture(request as ReviewWrite, target);
  const common = { actionId: request.actionId, unitId: request.unitId, locale: request.locale, actor: request.actor, reason: request.reason,
    createdAt: "2026-10-18T00:00:00Z", policyVersion: "balanced-1" };
  if (kind === "waiver") {
    const original = request as WaiverWrite;
    return { ...common, waiverId: fixtureIdentity(3310), basis: original.expectedBasis, issueId: original.issueId,
      grant: original.grant, previousWaiverId: original.expectedWaiverId };
  }
  if (kind === "fallback") {
    const original = request as FallbackWrite;
    return { ...common, fallbackId: fixtureIdentity(3311), sourceRevisionId: target.sourceRevisionId,
      allow: original.allow, previousFallbackId: original.expectedFallbackId };
  }
  return { decisionId: fixtureIdentity(3312), request, basisEvidence: target.basisEvidence, purpose: evidence.purpose,
    aiOrigin: evidence.aiOrigin, requirement: evidence.requirement, finding: evidence.finding, createdAt: common.createdAt };
}
function actionRead(kind: Kind, request: Business, target: ReviewTarget) {
  const saved = receipt(kind, request, target);
  return kind === "finding" ? saved : { request: structuredClone(request), receipt: saved };
}
function perform(kind: Kind) {
  if (kind === "decision") return owner.decide("approve", () => true);
  if (kind === "waiver") return owner.waive(issue, true, null, () => true);
  if (kind === "fallback") return owner.fallback(true, () => true);
  return owner.finding({ runId, issueId: issue, expectedDecisionId: null, disposition: "rejected", evidence }, () => true);
}
function setup(kind: Kind = "decision") {
  const target = reviewTargetFixture(kind === "fallback" ? { selectionId: null, revisionId: null, translationText: null } : {});
  const view = render(<Probe />, project);
  act(() => { owner.setSelected(target); owner.setActor("Reviewer A"); owner.editReason(target, "Reason A"); });
  return { target, view };
}
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

it.each(kinds.flatMap(kind => (["lost", "invalid"] as const).map(ack => ({kind,ack}))))("confirms the original $kind after one $ack ACK read with no replacement identity or write", async ({kind,ack}) => {
  const { target } = setup(kind), command = names[kind];
  let original!: Business;
  invoke.mockImplementation(async (name: string, args: { request: Record<string, unknown> }) => {
    if (name === "create_execution_identity") return fixtureIdentity(3320);
    if (name === command.write) { original = structuredClone(args.request[command.body] as Business); if (ack === "invalid") return {}; throw new Error("Lost ACK"); }
    if (name === command.read) return actionRead(kind, original, target);
    throw new Error(`Unexpected command ${name}`);
  });
  await act(async () => { await perform(kind); });
  expect(owner.current().pending).toBeNull(); expect(owner.current().notice).toBe("saved"); expect(owner.current().reasonValue).toBe("");
  expect(calls(command.write)).toHaveLength(1); expect(calls(command.read)).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls(command.read)[0][1].request).toEqual(kind === "finding"
    ? { projectId: project.metadata.projectId, sessionToken: project.sessionToken, actionId: original.actionId }
    : calls(command.write)[0][1].request);
  expect(owner.current().drafts[`${target.locale}:${target.unitId}`]).toBe("");
});

it.each(kinds)("keeps a null %s unresolved with original diagnostics and permits only an explicit exact retry", async kind => {
  const { target } = setup(kind), command = names[kind];
  const lost = { code: "outcome-unknown", stage: "execution-adopt", outcome: "unknown", recoveryRequired: true,
    diagnosticId: fixtureIdentity(3321), recoveryGuidance: "review-current" };
  let writes = 0;
  invoke.mockImplementation(async (name: string, args: { request: Record<string, unknown> }) => {
    if (name === "create_execution_identity") return fixtureIdentity(3320);
    if (name === command.write) { if (++writes === 1) throw lost; return receipt(kind, args.request[command.body] as Business, target); }
    if (name === command.read) return null;
    throw new Error(name);
  });
  await act(async () => { await perform(kind); });
  const pending = owner.current().pending;
  expect(pending).not.toBeNull(); expect(owner.current().pendingUncertain).toBe(true); expect(owner.current().retryAllowed).toBe(true);
  expect(owner.current().reasonValue).toMatchObject({ code: "outcome-unknown", diagnosticId: lost.diagnosticId });
  act(() => { owner.setActor("Reviewer B"); owner.editReason(target, "Reason B"); });
  await act(async () => { await owner.retryPending(); });
  expect(owner.current().pending).toBeNull(); expect(owner.current().actor).toBe("Reviewer B");
  expect(owner.current().drafts[`${target.locale}:${target.unitId}`]).toBe("Reason B");
  expect(calls(command.write).map(([, args]) => args.request)).toEqual([calls(command.write)[0][1].request, calls(command.write)[0][1].request]);
  expect(calls(command.read)).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
});

it("holds one flight across write and lookup, preserves B through consumer removal, and settles independently of current facts", async () => {
  const { target, view } = setup(), writing = deferred<unknown>(), checking = deferred<unknown>();
  invoke.mockImplementation((name: string) => name === "create_execution_identity" ? Promise.resolve(fixtureIdentity(3320))
    : name === names.decision.write ? writing.promise : name === names.decision.read ? checking.promise : Promise.reject(new Error(name)));
  let operation!: Promise<void>;
  act(() => { operation = owner.decide("approve", () => true); });
  await waitFor(() => expect(calls(names.decision.write)).toHaveLength(1));
  expect(owner.current().checkingAction).toBe(false);
  await act(async () => { await owner.decide("approve", () => true); await owner.checkPending(); });
  expect(calls("create_execution_identity")).toHaveLength(1);
  act(() => { owner.setActor("Reviewer B"); owner.editReason(target, "Reason B");
    manual.begin({ unitId: fixtureIdentity(3322), locale: target.locale, sourceRevisionId: fixtureIdentity(3323), key: "other", sourceText: "Other source" }, null, null, "Manual B"); });
  await act(async () => { writing.reject(new Error("Lost write")); });
  await waitFor(() => expect(owner.current().checkingAction).toBe(true));
  const pending = owner.current().pending!, original = calls(names.decision.write)[0][1].request.decision as ReviewWrite;
  await act(async () => { await owner.retryPending(); await owner.checkPending(); await owner.approveBatch(); });
  expect(calls(names.decision.read)).toHaveLength(1); expect(owner.inFlight()).toBe(true);
  view.rerender(null, { ...project, metadata: { ...project.metadata, targetLocales: ["ja"], metadataRevision: "2" } });
  act(() => { reads.invalidate(["source", "translation", "resources", "review"]); });
  await act(async () => { checking.resolve(actionRead("decision", original, target)); await operation; });
  expect(pending.request).toEqual(original); expect(owner.current().pending).toBeNull(); expect(owner.current().checkingAction).toBe(false);
  expect(owner.current().actor).toBe("Reviewer B"); expect(owner.current().drafts[`${target.locale}:${target.unitId}`]).toBe("Reason B");
  expect(manual.current()?.text).toBe("Manual B"); expect(calls(names.decision.write)).toHaveLength(1);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["create_execution_identity", names.decision.write, names.decision.read]);
});

it.each(kinds)("does not read a fresh formally rejected %s or erase the first unknown on a rejected retry", async kind => {
  const { target } = setup(kind), command = names[kind];
  let rejectFresh = true;
  invoke.mockImplementation(async (name: string) => {
    if (name === "create_execution_identity") return fixtureIdentity(3320);
    if (name === command.write) { if (rejectFresh) throw errorWire.errors[1]; throw new Error("Lost write"); }
    if (name === command.read) return null;
    throw new Error(name);
  });
  await act(async () => { await perform(kind); });
  expect(owner.current().pending).toBeNull(); expect(calls(command.read)).toHaveLength(0);
  rejectFresh = false;
  await act(async () => { await perform(kind); });
  const original = owner.current().pending;
  expect(original).not.toBeNull(); expect(owner.current().retryAllowed).toBe(true);
  rejectFresh = true;
  await act(async () => { await owner.retryPending(); });
  expect(owner.current().pending).toBe(original); expect(owner.current().pendingUncertain).toBe(true); expect(owner.current().retryAllowed).toBe(false);
  expect(calls(command.read)).toHaveLength(1);
  act(() => { owner.editReason(target, "New B"); });
  await act(async () => { await owner.retryPending(); });
  expect(calls(command.write)).toHaveLength(3);
  await act(async () => { await owner.checkPending(); });
  expect(owner.current().retryAllowed).toBe(true); expect(calls(command.read)).toHaveLength(2);
});

it.each(["read-error", "wrong-request", "undefined"] as const)("keeps %s unknown and offers pure manual checking without another write", async failure => {
  const { target } = setup(); let lookups = 0, original!: ReviewWrite;
  invoke.mockImplementation(async (name: string, args: { request: Record<string, unknown> }) => {
    if (name === "create_execution_identity") return fixtureIdentity(3320);
    if (name === names.decision.write) { original = args.request.decision as ReviewWrite; throw new Error("Lost write"); }
    if (name === names.decision.read) {
      if (++lookups === 1) {
        if (failure === "read-error") throw new Error("Lookup unavailable");
        if (failure === "undefined") return undefined;
        return { request: { ...original, expectedDecisionId: fixtureIdentity(3325) }, receipt: reviewDecisionFixture(original, target) };
      }
      return actionRead("decision", original, target);
    }
    throw new Error(name);
  });
  await act(async () => { await perform("decision"); });
  const originalPending = owner.current().pending;
  expect(originalPending).not.toBeNull(); expect(owner.current().retryAllowed).toBe(false);
  await act(async () => { await owner.retryPending(); });
  expect(calls(names.decision.write)).toHaveLength(1);
  await act(async () => { await owner.checkPending(); });
  expect(owner.current().pending).toBeNull(); expect(owner.current().reasonValue).toBe(""); expect(lookups).toBe(2);
  expect(calls(names.decision.write)).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["before-read", "during-read"] as const)("ignores retirement %s without dispatching another recovery action", async phase => {
  const { target } = setup(), writing = deferred<unknown>(), checking = deferred<unknown>();
  invoke.mockImplementation((name: string) => name === "create_execution_identity" ? Promise.resolve(fixtureIdentity(3320))
    : name === names.decision.write ? writing.promise : name === names.decision.read ? checking.promise : Promise.reject(new Error(name)));
  let operation!: Promise<void>;
  act(() => { operation = owner.decide("approve", () => true); });
  await waitFor(() => expect(calls(names.decision.write)).toHaveLength(1));
  const oldOwner = owner, original = oldOwner.current().pending, request = calls(names.decision.write)[0][1].request.decision as ReviewWrite;
  let retiredState = oldOwner.current();
  if (phase === "before-read") act(() => reads.retire());
  await act(async () => { writing.reject(new Error("Lost write")); });
  if (phase === "during-read") {
    await waitFor(() => expect(calls(names.decision.read)).toHaveLength(1));
    retiredState = oldOwner.current();
    act(() => reads.retire());
    await act(async () => { checking.resolve(actionRead("decision", request, target)); });
  }
  await act(async () => { await operation; await oldOwner.checkPending(); await oldOwner.retryPending(); });
  expect(calls(names.decision.read)).toHaveLength(phase === "before-read" ? 0 : 1);
  expect(oldOwner.current()).toBe(retiredState); expect(oldOwner.current().pending).toBe(original); expect(oldOwner.current().notice).not.toBe("saved");
});

it.each([false, true])("settles only the uncertain batch entry and retains the remaining frozen count (late check: %s)", async late => {
  const { target } = setup(), second = reviewTargetFixture({ unitId: fixtureIdentity(3340), nativeKey: "second" });
  act(() => { owner.toggleChosen(reviewSummaryFor(target), true); owner.toggleChosen(reviewSummaryFor(second), true); });
  let original!: ReviewWrite, lookups = 0;
  invoke.mockImplementation(async (name: string, args: { request: Record<string, unknown> }) => {
    if (name === "create_execution_identity") return fixtureIdentity(3320);
    if (name === names.decision.write) { original = args.request.decision as ReviewWrite; throw new Error("Lost batch ACK"); }
    if (name === names.decision.read) { if (late && ++lookups === 1) throw new Error("Automatic lookup unavailable"); return actionRead("decision", original, target); }
    throw new Error(name);
  });
  await act(async () => { await owner.approveBatch(); });
  expect(owner.current().batchStatus).toEqual({ applied: late ? 0 : 1, conflicted: 0, failed: late ? 1 : 0, notStarted: 1 });
  if (late) await act(async () => { await owner.checkPending(); });
  expect(owner.current().pending).toBeNull(); expect(owner.current().batchStatus).toEqual({ applied: 1, conflicted: 0, failed: 0, notStarted: 1 });
  expect(Object.values(owner.current().chosen).map(entry => entry.unitId)).toEqual([second.unitId]);
  expect(calls(names.decision.write)).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
});


it("keeps a later current approval when the original historical approval is confirmed",async()=>{
  const {target}=setup(),checking=deferred<unknown>();let original!:ReviewWrite;
  invoke.mockImplementation(async(name:string,args:{request:Record<string,unknown>})=>{
    if(name==="create_execution_identity")return fixtureIdentity(3350);
    if(name===names.decision.write){original=args.request.decision as ReviewWrite;throw new Error("Lost ACK");}
    if(name===names.decision.read)return checking.promise;
    throw new Error(name);
  });
  let operation!:Promise<void>;act(()=>{operation=owner.decide("approve",()=>true);});
  await waitFor(()=>expect(owner.current().checkingAction).toBe(true));
  const later=reviewDecisionFixture({...original,actionId:fixtureIdentity(3351)},target);later.decisionId=fixtureIdentity(3352);
  act(()=>{owner.observeProjection({...target,currentDecision:later},{unitId:target.unitId,locale:target.locale,basis:target.basis,
    editSeq:owner.current().editSeq[`${target.locale}:${target.unitId}`]});});
  await act(async()=>{checking.resolve(actionRead("decision",original,target));await operation;});
  expect(owner.current().pending).toBeNull();expect(owner.current().notice).toBe("saved");
  expect(owner.current().projection?.currentDecision).toEqual(later);expect(calls(names.decision.write)).toHaveLength(1);
});

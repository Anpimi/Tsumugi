import { useLayoutEffect } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench } from "./testSupport/WorkbenchTestShell";
import { useReviewDraftSession } from "./ReviewDraftSession";
import { useResourceDraftSession } from "./ResourceDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewTargetFixture, reviewDecisionFixture, reviewCheckFixture } from "./testSupport/reviewFixture";
import { sourceRowFixture } from "./testSupport/sourceFixture";
import type { ReviewWrite } from "./reviewCommands";
import type { ProjectView } from "./projectCommands";
import resourceFixture from "../test/fixtures/resourceCommands.contract.json";
import { validateResponseCapture } from "./generated/resource.validators";
import errors from "../test/fixtures/commandErrors.contract.json";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "original-session", locator: "C:\\synthetic", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(800), displayName: "Recovery", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const target = reviewTargetFixture();
const row = sourceRowFixture({ unitId: target.unitId, sourceRevisionId: target.sourceRevisionId });
let review!: ReturnType<typeof useReviewDraftSession>, resource!: ReturnType<typeof useResourceDraftSession>, reads!: ReturnType<typeof useSessionReads>;
function Probe() { const a = useReviewDraftSession(), b = useResourceDraftSession(), c = useSessionReads();
  useLayoutEffect(() => { review = a; resource = b; reads = c; }); return null; }
const cases = [
  ["decision", "write_review_decision", "read_review_decision_action", "decision"],
  ["check", "prepare_review_checks", "read_review_check_action", ""],
  ["waiver", "waive_review_issue", "read_review_waiver_action", "waiver"],
  ["fallback", "allow_source_fallback", "read_review_fallback_action", "fallback"],
  ["term", "save_term", "read_term_save_action", "term"],
  ["context", "save_context", "read_context_save_action", "context"],
  ["capture", "capture_context", "read_context_capture_action", "capture"],
  ["file", "decide_resource_entry", "read_resource_decision_action", "decision"],
] as const;
type Case = typeof cases[number];
// Inputs are read through the real typed boundary. Dynamic fixture builders mirror each wire DTO.
type Wire = Record<string, any>;
function receipt(kind: Case[0], request: Wire): object {
  if (kind === "decision") return reviewDecisionFixture(request as ReviewWrite, target);
  if (kind === "check") return reviewCheckFixture(target, request.actionId);
  if (kind === "waiver") return { waiverId: fixtureIdentity(810), actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    basis: request.expectedBasis, issueId: request.issueId, grant: request.grant, previousWaiverId: request.expectedWaiverId ?? null,
    policyVersion: "balanced-1", actor: request.actor, reason: request.reason, createdAt: "2026-10-18T00:00:00Z" };
  if (kind === "fallback") return { fallbackId: fixtureIdentity(811), actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    sourceRevisionId: target.sourceRevisionId, allow: request.allow, previousFallbackId: request.expectedFallbackId ?? null,
    policyVersion: "balanced-1", actor: request.actor, reason: request.reason, createdAt: "2026-10-18T00:00:00Z" };
  if (kind === "term") return { ...resourceFixture.responses.term, revisionId: fixtureIdentity(812), termId: request.termId ?? fixtureIdentity(813),
    locale: request.locale, source: request.source, aliases: request.aliases, target: request.target, protected: request.protected,
    scopeUnitId: request.scopeUnitId ?? null, previousRevisionId: request.expectedRevisionId ?? null, reason: request.reason,
    originKind: "manual", captureId: null, externalEntryId: null, removed: false };
  if (kind === "context") return { revisionId: fixtureIdentity(814), unitId: request.unitId, locale: request.locale,
    text: request.text, reason: request.reason, previousRevisionId: request.expectedRevisionId ?? null };
  if (kind === "capture") return { captureId: fixtureIdentity(815), unitId: request.unitId, locale: request.locale,
    sourceRevisionId: request.sourceRevisionId, budgetBytes: request.budgetBytes, included: [], omitted: [] };
  return { request, actionId: request.actionId, decision: request.decision, revision: null };
}
function pending(test: Case) {
  const value = ["decision", "check", "waiver", "fallback"].includes(test[0]) ? review.current() : resource.current();
  return { ...value, pendingCheckedMissing: "retryAllowed" in value ? value.retryAllowed : value.pendingCheckedMissing,
    checkingAction: Boolean(value.checkingAction) };
}

async function prepare(test: Case) {
  renderWorkbench(<Probe />, project);
  await act(async () => {
    if (["decision", "check", "waiver", "fallback"].includes(test[0])) { review.setSelected(target); review.setActor("Reviewer A"); review.editReason(target, "Original A"); }
    if (test[0] === "term") resource.editTerm({ source: "Barrel", aliases: ["Cask"], target: "A", protected: false, scopeUnitId: null, reason: "Original A" }, "Cask, ");
    if (test[0] === "context" || test[0] === "capture") { resource.beginContext(row, null); resource.editContext("A"); resource.editContextReason("Original A"); }
    if (test[0] === "file") {
      const capture: unknown = resourceFixture.responses.preview.capture;
      if (!validateResponseCapture(capture) || capture === null) throw new Error("Invalid canonical resource capture");
      await resource.openPreview(capture);
    }
  });
}
function start(test: Case) {
  switch (test[0]) {
    case "decision": return review.decide("approve", () => true);
    case "check": return review.prepareCheck(() => true);
    case "waiver": return review.waive("a".repeat(64), true, null, () => true);
    case "fallback": return review.fallback(true, () => true);
    case "term": return resource.saveTerm();
    case "context": return resource.saveContext();
    case "capture": return resource.captureContext();
    case "file": { const entry = resource.current().preview!.rows[0]; return resource.decide(entry.entry.id, entry.current?.revisionId ?? null, "keep"); }
  }
}
let mode: "saved" | "missing" | "undefined" | "mismatch" | "error" | "deferred";
let writeRejected: boolean, finish: (value: unknown) => void, lastOriginal: Wire, lastReceipt: object;
function useCase(test: Case) {
  invoke.mockImplementation(async (command: string, args: { request: Wire }) => {
    if (command === "create_execution_identity") return fixtureIdentity(820);
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: target.sourceSnapshotId };
    if (command === "read_resource_preview") return resourceFixture.responses.preview;
    if (command === test[1]) { if (writeRejected) throw errors.errors[0]; throw new Error("Lost acknowledgement"); }
    if (command === test[2]) {
      lastOriginal = test[3] ? args.request[test[3]] : Object.fromEntries(Object.entries(args.request).filter(([key]) => key !== "sessionToken"));
      lastReceipt = receipt(test[0], lastOriginal);
      if (mode === "missing") return null;
      if (mode === "undefined") return undefined;
      if (mode === "error") throw new Error("Read failed");
      if (mode === "deferred") return new Promise(resolve => { finish = resolve; });
      return { request: mode === "mismatch" ? { ...lastOriginal, projectId: fixtureIdentity(999) } : lastOriginal, receipt: lastReceipt };
    }
    throw new Error(command);
  });
}
beforeEach(() => { invoke.mockReset(); mode = "saved"; writeRejected = false; });
afterEach(cleanup);
for (const test of cases) {
  it(`${test[0]} automatically confirms once without a second write or identity`, async () => {
    useCase(test); await prepare(test); await act(async () => { await start(test); });
    expect(pending(test).pending).toBeNull(); expect(pending(test).completionVersion).toBe(1);
    expect(invoke.mock.calls.filter(([name]) => name === test[1])).toHaveLength(1);
    expect(invoke.mock.calls.filter(([name]) => name === test[2])).toHaveLength(1);
    expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  });
  it(`${test[0]} true null enables only explicit retry and preserves uncertainty after a rejected retry`, async () => {
    mode = "missing"; useCase(test); await prepare(test); await act(async () => { await start(test); });
    const original = pending(test).pending; expect(original).not.toBeNull(); expect(pending(test).pendingCheckedMissing).toBe(true);
    writeRejected = true; await act(async () => { if (["decision", "check", "waiver", "fallback"].includes(test[0])) await review.retryPending(); else await resource.retryPending(); });
    expect(pending(test).pending).toBe(original); expect(pending(test).pendingCheckedMissing).toBe(false);
    expect(invoke.mock.calls.filter(([name]) => name === test[1])).toHaveLength(2);
    expect(invoke.mock.calls.filter(([name]) => name === test[2])).toHaveLength(1);
  });
  for (const invalid of ["undefined", "mismatch", "error"] as const) it(`${test[0]} keeps pending after ${invalid}, blocks replay, and shares manual lookup`, async () => {
    mode = invalid; useCase(test); await prepare(test); await act(async () => { await start(test); });
    const original = pending(test).pending; expect(original).not.toBeNull(); expect(pending(test).pendingCheckedMissing).toBe(false);
    await act(async () => { if (["decision", "check", "waiver", "fallback"].includes(test[0])) await review.retryPending(); else await resource.retryPending(); });
    expect(invoke.mock.calls.filter(([name]) => name === test[1])).toHaveLength(1);
    mode = "saved"; await act(async () => { if (["decision", "check", "waiver", "fallback"].includes(test[0])) await review.checkPending(); else await resource.checkPending(); });
    expect(pending(test).pending).toBeNull(); expect(invoke.mock.calls.filter(([name]) => name === test[2])).toHaveLength(2);
  });
  it(`${test[0]} formal fresh rejection performs zero receipt reads`, async () => {
    writeRejected = true; useCase(test); await prepare(test); await act(async () => { await start(test); });
    expect(pending(test).pending).toBeNull(); expect(pending(test).completionVersion).toBe(0);
    expect(invoke.mock.calls.filter(([name]) => name === test[2])).toHaveLength(0);
  });
  it(`${test[0]} retirement fences a late original read`, async () => {
    mode = "deferred"; useCase(test); await prepare(test); let work!: Promise<void>;
    act(() => { work = start(test); }); await waitFor(() => expect(pending(test).checkingAction).toBe(true));
    const original = pending(test).pending; reads.retire();
    await act(async () => { finish({ request: lastOriginal, receipt: lastReceipt }); await work; });
    expect(pending(test).pending).toBe(original); expect(pending(test).completionVersion).toBe(0);
  });
}
it("an original term read preserves B and raw aliases while the owner remains hidden", async () => {
  const test = cases[4]; mode = "deferred"; useCase(test); await prepare(test); let work!: Promise<void>;
  act(() => { work = start(test); }); await waitFor(() => expect(Boolean(resource.current().checkingAction)).toBe(true));
  act(() => resource.editTerm({ ...resource.current().termDraft, target: "B", reason: "New B" }, "Cask, B raw, "));
  await act(async () => { finish({ request: lastOriginal, receipt: lastReceipt }); await work; });
  expect(resource.current()).toMatchObject({ pending: null, newerTerm: true, termDraft: { target: "B", reason: "New B" }, aliasInput: "Cask, B raw, " });
});
it("an original context read preserves B text and reason", async () => {
  const test = cases[5]; mode = "deferred"; useCase(test); await prepare(test); let work!: Promise<void>;
  act(() => { work = start(test); }); await waitFor(() => expect(Boolean(resource.current().checkingAction)).toBe(true));
  act(() => { resource.editContext("B"); resource.editContextReason("New B"); });
  await act(async () => { finish({ request: lastOriginal, receipt: lastReceipt }); await work; });
  expect(resource.current()).toMatchObject({ pending: null, newerContext: true, contextDraft: "B", contextReason: "New B" });
});
for (const test of cases.slice(0, 2)) it(`${test[0]} historical receipt cannot overwrite newer same-basis Query evidence or B`, async () => {
  mode = "deferred"; useCase(test); await prepare(test); let work!: Promise<void>;
  act(() => { work = start(test); }); await waitFor(() => expect(review.current().checkingAction).toBe(true));
  const newer = test[0] === "decision" ? { ...target, currentDecision: { ...reviewDecisionFixture(lastOriginal as ReviewWrite, target), decisionId: fixtureIdentity(999) } }
    : { ...target, currentCheck: reviewCheckFixture(target, fixtureIdentity(998), "failed", { runId: fixtureIdentity(999) }) };
  act(() => { review.observeProjection(newer, { unitId: target.unitId, locale: target.locale, basis: target.basis, editSeq: review.current().editSeq[`${target.locale}:${target.unitId}`] }); review.editReason(target, "New B"); review.setActor("Reviewer B"); });
  await act(async () => { finish({ request: lastOriginal, receipt: lastReceipt }); await work; });
  expect(review.current().projection).toEqual(newer); expect(review.current().drafts[`${target.locale}:${target.unitId}`]).toBe("New B"); expect(review.current().actor).toBe("Reviewer B");
});

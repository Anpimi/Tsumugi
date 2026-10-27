import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCandidateDecisionSession } from "../../../CandidateDecisionSession";
import type { DraftHead, DraftKey, DraftReadView, DraftValue } from "../../../draftCommands";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import type { CandidateDecision, CandidateDecisionRequest, TranslationCandidateSlice, TranslationCandidateSliceRow, TranslationRevision } from "../../../translationCommands";
import type { WorkspaceSelection } from "../../workspace/workspaceSelection";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import { CandidateBatchSession, type CandidateBatchMode } from "./CandidateBatchSession";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "fixed-candidate-batch", locator: "/synthetic/candidate-batch", reconciliationState: "settled",
  metadata: { projectId: id(900), displayName: "Fixed candidate batch", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const context = executionContext(project), copy = <T,>(value: T): T => structuredClone(value);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function row(index: number, count = 1, rejected = false): TranslationCandidateSliceRow {
  const target = reviewTargetFixture({ unitId: id(1000 + index), nativeKey: `entry-${index}`, sourceRevisionId: id(2000 + index),
    sourceText: `Source ${index}`, selectionId: null, revisionId: null, translationText: null, basis: `basis-${index}` });
  const revisions = Array.from({ length: count }, (_, ordinal): TranslationRevision => ({ revisionId: id(10000 + index * 100 + ordinal), actionId: id(20000 + index * 100 + ordinal),
    unitId: target.unitId, locale: target.locale, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId, ordinal: String(ordinal + 1),
    originKind: "ai", text: index === 0 ? "" : `Candidate ${index}/${ordinal} {name}\né 👩🏽‍💻`, contributors: [], attemptId: id(30000 + index),
    resultId: id(31000 + index), itemId: id(32000 + index), artifactId: null, logicalPath: null, declaredLocale: null, nativeKey: null, fileDigest: null,
    candidateDecision: rejected ? { sourceSnapshotId: target.sourceSnapshotId, request: { projectId: context.projectId, actionId: id(40000 + index * 100 + ordinal),
      unitId: target.unitId, locale: target.locale, revisionId: id(10000 + index * 100 + ordinal), sourceRevisionId: target.sourceRevisionId,
      expectedSelectionId: null, expectedDecisionId: null, disposition: "rejected", actor: "Original reviewer", reason: "Original reason" } } : null }));
  return { target, revisions, candidateCount: revisions.length, selectedOriginKind: null,
    protection: { unitId: target.unitId, locale: target.locale, protected: false, revision: "0" } };
}
const resources: { batch: CandidateBatchSession; drafts: TranslationDrafts; reads: SessionReads }[] = [];
afterEach(() => { cleanup(); resources.splice(0).forEach(({ batch, drafts, reads }) => { batch.dispose(); drafts.retire(); reads.retire(); }); vi.restoreAllMocks(); });

async function harness(initial = [row(0), row(1)]) {
  const rows = new Map(initial.map(value => [value.target.unitId, copy(value)])), disk = new Map<string, DraftHead>(), recorded = new Map<string, CandidateDecision>();
  let version = "a".repeat(64), identities = 50000, completed = 0;
  const slice = vi.fn<TranslationDraftPorts["candidateSlice"]>(async request => {
    if (request.readVersion && request.readVersion !== version) throw { code: "dependency-conflict", stage: "execution-read", outcome: "rejected", recoveryRequired: false };
    const output: TranslationCandidateSliceRow[] = []; let budget = 50, next: TranslationCandidateSlice["next"] = null;
    for (const [index, unitId] of request.unitIds.entries()) {
      const original = rows.get(unitId); if (!original) throw new Error("Missing fixed synthetic unit");
      const all = original.revisions.filter(revision => (revision.candidateDecision?.request.disposition === "rejected") === (request.state === "rejected"));
      const remaining = all.filter(revision => BigInt(revision.ordinal) > (index === 0 ? BigInt(request.afterOrdinal ?? "0") : 0n));
      const revisions = remaining.slice(0, budget); output.push({ ...copy(original), candidateCount: all.length, revisions: copy(revisions) });
      budget -= Math.max(1, revisions.length);
      if (revisions.length < remaining.length) { next = { unitOffset: index, afterOrdinal: revisions.at(-1)!.ordinal }; break; }
      if (!budget && index + 1 < request.unitIds.length) { next = { unitOffset: index + 1, afterOrdinal: "0" }; break; }
    }
    return { projectId: request.projectId, locale: request.locale, sourceSnapshotId: request.sourceSnapshotId,
      scopeId: request.scopeId ?? null, readVersion: version, rows: output, next };
  });
  const view = (key: DraftKey): DraftReadView => {
    const target = rows.get(key.unitId)!.target;
    return { head: copy(disk.get(key.unitId) ?? { key, revision: "0", writerId: null, value: null }),
      current: { kind: "current", nativeKey: target.nativeKey, sourceText: target.sourceText,
        basis: { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText } } };
  };
  const ports = {
    list: vi.fn<TranslationDraftPorts["list"]>(async () => ({ items: [], next: null })), candidateSlice: slice,
    read: vi.fn<TranslationDraftPorts["read"]>(async request => view(request.key)),
    readMany: vi.fn<TranslationDraftPorts["readMany"]>(async request => ({ items: request.unitIds.map(unitId => view({ projectId: context.projectId, unitId, locale: request.locale })), nextAfter: null })),
    write: vi.fn<TranslationDraftPorts["write"]>(async ({ write }) => {
      expect(write.expectedRevision).toBe(disk.get(write.key.unitId)?.revision ?? "0");
      const head: DraftHead = { key: write.key, revision: String(BigInt(write.expectedRevision) + 1n), writerId: write.writerId, value: copy(write.value) as DraftValue };
      disk.set(write.key.unitId, head); return copy(head);
    }), writerId: () => id(49999),
    identity: vi.fn<TranslationDraftPorts["identity"]>(), history: vi.fn<TranslationDraftPorts["history"]>(), save: vi.fn<TranslationDraftPorts["save"]>(), select: vi.fn<TranslationDraftPorts["select"]>(),
  };
  const reads = new SessionReads(context), drafts = new TranslationDrafts({ context, reads, ports }); await drafts.initialize();
  function receipt(request: CandidateDecisionRequest): CandidateDecision {
    const value: CandidateDecision = { request: { ...copy(request.decision), expectedDecisionId: request.decision.expectedDecisionId ?? null,
      expectedSelectionId: request.decision.expectedSelectionId ?? null }, sourceSnapshotId: initial[0].target.sourceSnapshotId };
    recorded.set(request.decision.actionId, value);
    const original = rows.get(request.decision.unitId)!;
    original.revisions = original.revisions.map(revision => revision.revisionId === request.decision.revisionId ? { ...revision, candidateDecision: value } : revision);
    version = (++completed).toString(16).padStart(64, "0"); return value;
  }
  const decide = vi.fn(async (request: CandidateDecisionRequest) => receipt(request));
  const lookup = vi.fn(async (request: { actionId: string }) => recorded.get(request.actionId) ?? null);
  invoke.mockReset(); invoke.mockImplementation((command, args) => {
    if (command === "create_execution_identity") return Promise.resolve(id(identities++));
    if (command === "decide_translation_candidate") return decide(args.request);
    if (command === "read_translation_candidate_action") return lookup(args.request);
    throw new Error(`Unexpected native command ${command}`);
  });
  const hook = renderHook(() => useCandidateDecisionSession(project, { current: () => null,
    reserve: () => drafts.reserveMutation("retained-for-navigation"), release: token => drafts.releaseMutation(token) }),
  { wrapper: ({ children }: { children: ReactNode }) => <SessionReadProvider context={context} reads={reads} bridge={false}>{children}</SessionReadProvider> });
  act(() => { hook.result.current.edit("actor", "Reviewer A"); hook.result.current.edit("reason", "Reason A"); });
  const batch = new CandidateBatchSession({ project, reads, drafts, read: slice, decisions: () => hook.result.current }); resources.push({ batch, drafts, reads });
  const selection: Extract<WorkspaceSelection, { kind: "ids" }> = { kind: "ids", locale: initial[0].target.locale, sourceSnapshotId: initial[0].target.sourceSnapshotId, unitIds: initial.map(value => value.target.unitId) };
  async function capture(mode: CandidateBatchMode = "stage", value: WorkspaceSelection = selection) {
    let result = false; await act(async () => { result = await batch.capture(value, mode, () => true); }); return result;
  }
  return { batch, drafts, reads, ports, slice, rows, disk, view, decide, lookup, receipt, selection, capture, decisions: () => hook.result.current,
    setVersion: (next: string) => { version = next; }, captureId: () => { const value = batch.current().captureId; if (value === null) throw new Error("No fixed batch"); return value; } };
}

it("previews one fixed cross-page set, preserves protected and human selections, then stages only eligible Host drafts", async () => {
  const protectedRow = row(1); protectedRow.protection.protected = true;
  const manual = row(2); manual.selectedOriginKind = "manual"; manual.target = reviewTargetFixture({ ...manual.target,
    selectionId: id(60000), revisionId: id(60001), translationText: "Human result" });
  const h = await harness([row(0), protectedRow, manual]); expect(await h.capture()).toBe(true);
  expect(h.batch.current().items.map(item => [item.status, item.skipReason])).toEqual([["ready", null], ["skipped", "protected"], ["skipped", "human-selection"]]);
  expect(h.ports.write).not.toHaveBeenCalled(); const captureId = h.captureId();
  await act(async () => h.batch.confirm(captureId, () => true));
  expect(h.batch.current().phase).toBe("complete"); expect(h.batch.current().captureId).toBe(captureId);
  expect(h.disk.get(h.selection.unitIds[0])?.value?.text).toBe(""); expect(h.ports.write).toHaveBeenCalledTimes(1);
  expect(h.ports.identity).not.toHaveBeenCalled(); expect(h.ports.history).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});

it("collects all partial-unit pages before deciding uniqueness, rather than treating a visible prefix as one candidate", async () => {
  const h = await harness([row(0, 60)]); expect(await h.capture()).toBe(true);
  expect(h.slice).toHaveBeenCalledTimes(2); expect(h.slice.mock.calls.map(([request]) => request.afterOrdinal)).toEqual(["0", "50"]);
  expect(h.batch.current().items).toHaveLength(1); expect(h.batch.current().items[0]).toMatchObject({ status: "skipped", skipReason: "multiple-candidates", row: { candidateCount: 60 } });
  expect(h.batch.current().items[0].row.revisions).toHaveLength(60);
  expect(h.ports.write).not.toHaveBeenCalled();
});

it("freezes original scope exclusions and bases without reselecting from the current filter", async () => {
  const original = [row(0), row(1), row(2)], h = await harness(original);
  const selection: WorkspaceSelection = { kind: "scope", query: { text: "original query", selection: "all", status: "all" }, selection: { ...context,
    capture: { scopeId: id(61000), locale: "zh-CN", sourceSnapshotId: original[0].target.sourceSnapshotId, readVersion: "a".repeat(64), query: "original query",
      units: original.map((value, index) => ({ unitId: value.target.unitId, expectedBasis: index === 2 ? "older basis" : value.target.basis, expectedDecisionId: id(62000 + index) })) }, excluded: [original[1].target.unitId] } };
  expect(await h.capture("reject", selection)).toBe(true);
  expect(h.slice.mock.calls[0][0]).toMatchObject({ scopeId: id(61000), unitIds: [original[0].target.unitId, original[2].target.unitId] });
  expect(h.batch.current().excluded).toEqual([original[1].target.unitId]);
  expect(h.batch.current().items.map(item => [item.key.unitId, item.skipReason])).toEqual([[original[0].target.unitId, null], [original[2].target.unitId, "basis-changed"]]);
  await act(async () => h.batch.confirm(h.captureId(), () => true));
  expect(h.decide).toHaveBeenCalledTimes(1); expect(h.decide.mock.calls[0][0].decision.expectedDecisionId).toBeNull();
  expect(h.batch.current().selection).toEqual(selection);
});

it("requires the same preview readVersion across distinct 50-unit blocks", async () => {
  const h = await harness(Array.from({ length: 51 }, (_, index) => row(index))), read = h.slice.getMockImplementation()!;
  h.slice.mockImplementationOnce(async request => { const page = await read(request); h.setVersion("b".repeat(64)); return page; });
  expect(await h.capture("reject")).toBe(false); expect(h.batch.current()).toMatchObject({ phase: "paused", pauseReason: "failed", items: [] });
  expect(h.slice.mock.calls[1][0].readVersion).toBe("a".repeat(64)); expect(h.decide).not.toHaveBeenCalled();
});

it.each(["no-progress", "missing-member", "missing-version", "count-drift"] as const)("rejects %s preview continuation without presenting an incomplete ready batch", async broken => {
  const h = await harness([row(0, 2), row(1)]), read = h.slice.getMockImplementation()!;
  h.slice.mockImplementationOnce(async request => {
    const page = await read(request);
    if (broken === "no-progress") return { ...page, rows: [{ ...page.rows[0], revisions: [] }], next: { unitOffset: 0, afterOrdinal: "0" } };
    if (broken === "missing-member") return { ...page, rows: page.rows.slice(0, 1) };
    if (broken === "missing-version") return { ...page, rows: [{ ...page.rows[0], revisions: page.rows[0].revisions.slice(0, 1) }, page.rows[1]] };
    return { ...page, rows: [{ ...page.rows[0], candidateCount: 1 }, page.rows[1]] };
  });
  expect(await h.capture("reject")).toBe(false); expect(h.batch.current().phase).toBe("paused"); expect(h.batch.current().items).toHaveLength(0);
  expect(h.decide).not.toHaveBeenCalled(); expect(h.ports.write).not.toHaveBeenCalled();
});

it.each(["reject", "restore"] as const)("refreshes multiple %s members in one bounded read and keeps original tuples despite its own invalidations", async mode => {
  const h = await harness([row(0, 1, mode === "restore"), row(1, 2, mode === "restore"), row(2, 1, mode === "restore")]);
  expect(await h.capture(mode)).toBe(true); const originalIds = h.batch.current().items.map(item => item.revision?.revisionId);
  await act(async () => h.batch.confirm(h.captureId(), () => true));
  expect(h.batch.current().phase).toBe("complete"); expect(h.batch.current().items.map(item => item.status)).toEqual(Array(4).fill("recorded"));
  expect(h.slice).toHaveBeenCalledTimes(2); expect(h.slice.mock.calls[1][0].unitIds).toEqual(h.selection.unitIds);
  expect(h.slice.mock.calls[1][0].readVersion).toBeUndefined();
  expect(h.decide.mock.calls.map(([request]) => request.decision.revisionId)).toEqual(originalIds);
  expect(h.decide.mock.calls.every(([request]) => request.decision.disposition === (mode === "restore" ? "restored" : "rejected"))).toBe(true);
  expect(h.ports.readMany).not.toHaveBeenCalled(); expect(h.ports.write).not.toHaveBeenCalled();
});

it("does not replace a newer local B entered after the fixed stage preview", async () => {
  const h = await harness([row(0)]); expect(await h.capture()).toBe(true); const item = h.batch.current().items[0];
  act(() => h.drafts.edit(item.key, "Newer local B 👩🏽‍💻"));
  await act(async () => h.batch.confirm(h.captureId(), () => true));
  expect(h.drafts.getEntry(item.key)?.value?.text).toBe("Newer local B 👩🏽‍💻"); expect(h.batch.current().items[0].status).toBe("skipped");
  expect(h.ports.write.mock.calls.every(([request]) => request.write.value.text === "Newer local B 👩🏽‍💻")).toBe(true); expect(h.decide).not.toHaveBeenCalled();
});

it("pauses at the first undurable journal, retains later ready items and continues only after explicit original-draft recovery", async () => {
  const h = await harness(); expect(await h.capture()).toBe(true); const captureId = h.captureId();
  h.ports.write.mockRejectedValueOnce(new Error("Lost journal acknowledgement"));
  await act(async () => h.batch.confirm(captureId, () => true));
  expect(h.batch.current()).toMatchObject({ phase: "paused", pauseReason: "journal" });
  expect(h.batch.current().items.map(item => item.status)).toEqual(["undurable", "ready"]); expect(h.batch.end(captureId)).toBe(false);
  await act(async () => h.batch.continue(captureId, () => true)); expect(h.ports.write).toHaveBeenCalledTimes(1);
  await act(async () => h.batch.check(captureId, h.batch.current().items[0].id));
  expect(h.batch.current().items.map(item => item.status)).toEqual(["staged", "ready"]); expect(h.batch.current().phase).toBe("paused");
  await act(async () => h.batch.continue(captureId, () => true));
  expect(h.batch.current().phase).toBe("complete"); expect(h.batch.current().items.map(item => item.status)).toEqual(["staged", "staged"]);
});

it("pauses on original unknown A, recovers the same request with no views, then explicitly uses audit B only for untouched members", async () => {
  const h = await harness(); expect(await h.capture("reject")).toBe(true); const captureId = h.captureId();
  h.decide.mockRejectedValueOnce(new Error("Lost decision acknowledgement")); h.lookup.mockRejectedValueOnce(new Error("Original result unavailable"));
  await act(async () => h.batch.confirm(captureId, () => true));
  const item = h.batch.current().items[0], request = item.request; if (!request) throw new Error("Expected original unknown action");
  expect(h.batch.current().items.map(value => value.status)).toEqual(["pending", "ready"]); expect(h.decide).toHaveBeenCalledTimes(1);
  expect(h.batch.lifecycleParticipant().inspect({ kind: "close-view" }).status).toBe("ready");
  expect(h.batch.lifecycleParticipant().inspect({ kind: "close-project" }).status).toBe("blocked"); expect(h.batch.end(captureId)).toBe(false);
  act(() => h.decisions().edit("reason", "New reason B"));
  expect(h.batch.retryAllowed(item.id)).toBe(false);
  await act(async () => h.batch.check(captureId, item.id)); expect(h.batch.retryAllowed(item.id)).toBe(true);
  await act(async () => h.batch.retry(captureId, item.id));
  expect(h.decide.mock.calls[1][0]).toBe(request); expect(request.decision.reason).toBe("Reason A");
  expect(h.batch.current().phase).toBe("paused"); expect(h.decide).toHaveBeenCalledTimes(2);
  await act(async () => h.batch.continue(captureId, () => true));
  expect(h.batch.current().phase).toBe("complete"); expect(h.decide.mock.calls[2][0].decision.reason).toBe("New reason B");
  expect(h.decide.mock.calls[2][0].decision.actionId).not.toBe(request.decision.actionId);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2);
});

it("pauses rather than starting the next item when audit B is entered during A", async () => {
  const h = await harness(); expect(await h.capture("reject")).toBe(true);
  const write = deferred<CandidateDecision>(); h.decide.mockImplementationOnce(() => write.promise);
  let running!: Promise<void>; act(() => { running = h.batch.confirm(h.captureId(), () => true); });
  await waitFor(() => expect(h.decide).toHaveBeenCalledTimes(1));
  act(() => h.decisions().edit("reason", "B while A writes"));
  await act(async () => { write.resolve(h.receipt(h.decide.mock.calls[0][0])); await running; });
  expect(h.batch.current()).toMatchObject({ phase: "paused", pauseReason: "audit-changed" });
  expect(h.batch.current().items.map(item => item.status)).toEqual(["recorded", "ready"]); expect(h.decisions().hasDraft()).toBe(true);
  await act(async () => h.batch.continue(h.captureId(), () => true)); expect(h.batch.current().phase).toBe("complete");
});

it("finishes the final unknown member after a global original check instead of retaining an obsolete unknown banner", async () => {
  const h = await harness([row(0)]); expect(await h.capture("reject")).toBe(true);
  h.decide.mockImplementationOnce(async request => { h.receipt(request); throw new Error("Lost recorded reply"); });
  h.lookup.mockRejectedValueOnce(new Error("Original result unavailable"));
  await act(async () => h.batch.confirm(h.captureId(), () => true));
  expect(h.batch.current()).toMatchObject({ phase: "paused", pauseReason: "unknown", failure: "failed" });
  await act(async () => { h.batch.acceptOutcome(await h.decisions().check()); });
  expect(h.batch.current()).toMatchObject({ phase: "complete", pauseReason: null, failure: null });
  expect(h.batch.current().items[0].status).toBe("recorded"); expect(h.decide).toHaveBeenCalledTimes(1);
  expect(h.batch.lifecycleParticipant().inspect({ kind: "close-project" }).status).toBe("ready");
});

it("finishes the final undurable draft after the original journal is flushed", async () => {
  const h = await harness([row(0)]); expect(await h.capture()).toBe(true);
  h.ports.write.mockRejectedValueOnce(new Error("Journal reply lost"));
  await act(async () => h.batch.confirm(h.captureId(), () => true));
  const item = h.batch.current().items[0]; expect(item.status).toBe("undurable");
  await act(async () => h.batch.check(h.captureId(), item.id));
  expect(h.batch.current()).toMatchObject({ phase: "complete", pauseReason: null, failure: null });
  expect(h.batch.current().items[0].status).toBe("staged");
});

it("retains a preview through navigation, requires explicit ending for project exit, and retires a late preview without mutations", async () => {
  const h = await harness(); expect(await h.capture("reject")).toBe(true); const captureId = h.captureId();
  expect(h.batch.lifecycleParticipant().inspect({ kind: "language" }).status).toBe("ready");
  expect(h.batch.lifecycleParticipant().inspect({ kind: "close-project" }).status).toBe("blocked");
  expect(h.batch.end(captureId)).toBe(true); expect(h.batch.current()).toMatchObject({ phase: "complete", ended: true });
  expect(h.batch.current().items.every(item => item.status === "skipped" && item.skipReason === "ended")).toBe(true);
  expect(h.batch.lifecycleParticipant().inspect({ kind: "close-project" }).status).toBe("ready");
  const response = deferred<TranslationCandidateSlice>(); h.slice.mockImplementationOnce(() => response.promise);
  let capturing!: Promise<boolean>; act(() => { capturing = h.batch.capture(h.selection, "reject", () => true); });
  h.batch.dispose();
  await act(async () => { response.resolve({ projectId: context.projectId, locale: "zh-CN", sourceSnapshotId: h.selection.sourceSnapshotId,
    scopeId: null, readVersion: "a".repeat(64), rows: [...h.rows.values()].map(copy), next: null }); expect(await capturing).toBe(false); });
  expect(h.batch.current().phase).toBe("retired"); expect(h.decide).not.toHaveBeenCalled(); expect(h.ports.write).not.toHaveBeenCalled();
});

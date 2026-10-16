import { useLayoutEffect } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { StrategyDraftSession, useStrategyDraftSession } from "./StrategyDraftSession";
import { confirmArenaView } from "./ArenaDraftSession";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { useSessionReads } from "./SessionReadProvider";
import { defaultAiConfig, editedAiConfig, sameAiConfig, type AiConfig } from "./aiCommands";
import { strategyCommands, strategyKeys, type ContextStrategyCandidate, type ContextStrategyDefaultRevision, type StrategyEvaluationView, type StrategySuite, type Prepared, type StrategyCheckReceipt } from "./strategyCommands";
import { reviewCommands } from "./reviewCommands";
import { resourceCommands, type CorrectionTermEvidence } from "./resourceCommands";
import { executionCommands } from "./executionCommands";
import { validateResponseEditor, validateResponseCheck, validateResponsePrepareCheck } from "./generated/review.validators";
import reviewWire from "../test/fixtures/reviewCommands.contract.json";
import resourceWire from "../test/fixtures/resourceCommands.contract.json";
import executionWire from "../test/fixtures/executionCommands.contract.json";
import { defaultArenaConfig, type ArenaView } from "./arenaCommands";
import { arenaViewFixture } from "./testSupport/aiFixture";
import type { AiItem } from "./aiCommands";
import { validateResponseCorrectionBasis } from "./generated/resource.validators";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ProjectView } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const bridgeStops: (() => void)[] = [];
const project: ProjectView = { sessionToken: "strategy-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: resourceWire.responses.correctionBasis.basis.projectId, displayName: "Synthetic strategies", sourceLocale: "en", targetLocales: ["zh-CN", "ja"], metadataRevision: "1" } };
let owner: ReturnType<typeof useStrategyDraftSession>, ai: ReturnType<typeof useAiPreparation>, reads: ReturnType<typeof useSessionReads>;
let evidence: CorrectionTermEvidence;
function Probe() { const value = useStrategyDraftSession(), session = useSessionReads(); useLayoutEffect(() => { owner = value; reads = session; }); return null; }
function AiProbe() { const value = useAiPreparation(); useLayoutEffect(() => { ai = value; }); return null; }
function Harness({ current = project, withAi = false }: { current?: ProjectView; withAi?: boolean }) {
  return <StrategyDraftSession project={current}><Probe />{withAi ? <AiPreparationSession initialLocale="zh-CN" targetLocales={current.metadata.targetLocales}><AiProbe /></AiPreparationSession> : null}</StrategyDraftSession>;
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function candidate(actionId = fixtureIdentity(2400), reason = "Preserve the speaker context"): ContextStrategyCandidate {
  return { candidateId: actionId, projectId: project.metadata.projectId, locale: "zh-CN", evidence: structuredClone(evidence),
    sourceContext: { ...defaultAiConfig.sourceContext, extracted: true }, reason, exceptions: "Only this project and language; inferred notes are excluded.", digest: "a".repeat(64) };
}
function revision(value: ContextStrategyCandidate, revisionId = fixtureIdentity(2401)): ContextStrategyDefaultRevision {
  return { revisionId, actionId: revisionId, projectId: project.metadata.projectId, locale: "zh-CN", previousRevisionId: null,
    evaluationId: fixtureIdentity(2402), reference: { projectId: project.metadata.projectId, candidateId: value.candidateId, revisionId } };
}
beforeEach(() => {
  vi.restoreAllMocks(); invoke.mockReset(); invoke.mockImplementation(async (command: string) => { if (command === "read_context_strategy_default") return null; throw new Error(command); });
  const source: unknown = structuredClone(resourceWire.responses.correctionBasis); if (!validateResponseCorrectionBasis(source)) throw new Error("Invalid canonical correction fixture"); evidence = source;
  const editor: unknown = structuredClone(reviewWire.responses.editor); if (!validateResponseEditor(editor)) throw new Error("Invalid canonical editor fixture");
  if (!editor.translations.current) throw new Error("Saved selection fixture required");
  editor.target.unitId = evidence.basis.unitId; editor.target.sourceRevisionId = evidence.basis.sourceRevisionId;
  editor.translations.current.eventId = evidence.basis.after.selectionId; editor.translations.current.revisionId = evidence.basis.after.revisionId;
  editor.translations.current.previousEventId = evidence.basis.before.selectionId;
  vi.spyOn(reviewCommands, "editorSnapshot").mockResolvedValue(editor);
  vi.spyOn(resourceCommands, "correctionBasis").mockResolvedValue(evidence);
  let identity = 2410; vi.spyOn(executionCommands, "identity").mockImplementation(async () => fixtureIdentity(identity++));
  vi.spyOn(strategyCommands, "capture").mockImplementation(async request => ({ ...candidate(request.capture.actionId, request.capture.reason), sourceContext: request.capture.sourceContext,
    exceptions: request.capture.exceptions, evidence: { ...evidence, basis: request.capture.basis } }));
});
afterEach(() => { bridgeStops.splice(0).forEach(stop => stop()); cleanup(); });
async function correction() {
  act(() => owner.edit("correctionUnit", evidence.basis.unitId));
  await act(async () => owner.inspectCorrection());
  act(() => { owner.edit("sourceContext", { ...defaultAiConfig.sourceContext, extracted: true }); owner.edit("reason", "Saved correction A"); owner.edit("exceptions", "No inferred context or other languages"); });
}

it("captures only the exact saved manual correction and preserves newer candidate input", async () => {
  render(<Harness />, project); await correction();
  const response = deferred<ContextStrategyCandidate>(); vi.mocked(strategyCommands.capture).mockReturnValueOnce(response.promise);
  let saving!: Promise<void>; act(() => { saving = owner.capture(); });
  await waitFor(() => expect(strategyCommands.capture).toHaveBeenCalledOnce());
  const request = vi.mocked(strategyCommands.capture).mock.calls[0][0];
  expect(request.capture.basis).toEqual(evidence.basis); expect(request.capture.reason).toBe("Saved correction A");
  act(() => owner.edit("reason", "Newer hypothesis B"));
  await act(async () => { response.resolve({ ...candidate(request.capture.actionId, request.capture.reason), exceptions: request.capture.exceptions }); await saving; });
  expect(owner.state.reason).toBe("Newer hypothesis B"); expect(owner.dirty()).toBe(true); expect(owner.state.candidate).toBeNull();
});

it("keeps an unknown original action, checks absence, and retries only the same fixed request", async () => {
  render(<Harness />, project); await correction();
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce(new Error("Synthetic connection loss"));
  await act(async () => owner.capture()); const original = owner.state.pending?.request;
  expect(owner.state.pending?.uncertain).toBe(true); expect(owner.reset()).toBe(false);
  act(() => owner.edit("reason", "Newer B"));
  const read = vi.spyOn(strategyCommands, "action").mockResolvedValue(null);
  await act(async () => owner.reconcile()); expect(read).toHaveBeenCalledWith(expect.objectContaining({ actionId: fixtureIdentity(2410) }));
  expect(owner.state.pending?.retryAllowed).toBe(true);
  await act(async () => owner.retry()); expect(vi.mocked(strategyCommands.capture).mock.calls[1][0]).toBe(original);
  expect(owner.state.reason).toBe("Newer B"); expect(owner.dirty()).toBe(true);
});

it("does not settle an unknown candidate from a foreign saved action", async () => {
  render(<Harness />, project); await correction();
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce(new Error("Synthetic connection loss")); await act(async () => owner.capture());
  const pending = owner.state.pending; if (pending?.kind !== "candidate") throw new Error("Original capture required");
  vi.spyOn(strategyCommands, "action").mockResolvedValue({ kind: "candidate", request: { ...pending.request.capture, reason: "Foreign" }, candidate: candidate() });
  await act(async () => owner.reconcile()); expect(owner.state.pending?.uncertain).toBe(true); expect(owner.state.pending?.retryAllowed).toBe(false); expect(owner.state.candidate).toBeNull();
});

it("releases a missing original capture after its exact receipt-first stale rejection", async () => {
  render(<Harness />, project); await correction();
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce(new Error("Synthetic lost acknowledgement")); await act(async () => owner.capture());
  const original = owner.state.pending?.request;
  vi.spyOn(strategyCommands, "action").mockResolvedValue(null); await act(async () => owner.reconcile());
  act(() => { owner.edit("reason", "Newer hypothesis B"); reads.invalidate(["source"]); });
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce({ code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "strategy-correction-stale" });
  await act(async () => owner.retry()); expect(vi.mocked(strategyCommands.capture).mock.calls[1][0]).toBe(original);
  expect(owner.state.pending).toBeNull(); expect(owner.state.reason).toBe("Newer hypothesis B"); expect(owner.state.stale).toBe(true); expect(owner.dirty()).toBe(true);
  act(() => expect(owner.reset()).toBe(true));
});

it("keeps unknown writes pending after Host preflight rejection without receipt-first proof", async () => {
  render(<Harness />, project); await correction();
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce(new Error("Synthetic lost acknowledgement")); await act(async () => owner.capture());
  vi.spyOn(strategyCommands, "action").mockResolvedValue(null); await act(async () => owner.reconcile());
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce({ code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "connection-profile-current" });
  await act(async () => owner.retry()); expect(owner.state.pending?.uncertain).toBe(true); expect(owner.reset()).toBe(false);
});

it("rejects late correction reads after a locale change or retired project session", async () => {
  const rendered = render(<Harness />, project); const response = deferred<CorrectionTermEvidence>();
  vi.mocked(resourceCommands.correctionBasis).mockReturnValueOnce(response.promise);
  act(() => owner.edit("correctionUnit", evidence.basis.unitId)); let reading!: Promise<void>;
  act(() => { reading = owner.inspectCorrection(); }); await waitFor(() => expect(resourceCommands.correctionBasis).toHaveBeenCalledOnce());
  expect(owner.setLocale("ja")).toBe(false);
  const old = owner; const next = { ...project, sessionToken: "new-session" }; rendered.rerender(<Harness current={next} />, next);
  await act(async () => { response.resolve(evidence); await reading; });
  expect(owner).not.toBe(old); expect(owner.state.evidence).toBeNull(); expect(owner.state.locale).toBe("zh-CN");
});

it("requires explicit exception scope and a current saved correction before candidate capture", async () => {
  render(<Harness />, project); await correction(); act(() => owner.edit("exceptions", ""));
  await act(async () => owner.capture()); expect(strategyCommands.capture).not.toHaveBeenCalled();
  act(() => owner.edit("exceptions", "Only declared source context"));
  act(() => reads.invalidate(["source"])); await act(async () => owner.capture()); expect(strategyCommands.capture).not.toHaveBeenCalled();
  expect(owner.state.reason).toBe("Saved correction A");
});

it("captures a future default once and applies withdrawal only to a fully reset draft", async () => {
  const saved = candidate(), first = revision(saved);
  const defaultRead = vi.spyOn(strategyCommands, "default").mockResolvedValue(first);
  vi.spyOn(strategyCommands, "candidate").mockResolvedValue(saved);
  render(<Harness withAi />, project); await waitFor(() => expect(ai.strategyDefault).toBe("ready"));
  expect(ai.config.contextStrategy).toEqual(first.reference); expect(ai.config.sourceContext).toEqual(saved.sourceContext);
  act(() => ai.setConfig(value => ({ ...value, model: "user model", maxRequests: 7, shareTerms: false, shareContext: true })));
  expect(ai.config.contextStrategy).toEqual(first.reference);
  defaultRead.mockResolvedValue({ ...first, revisionId: fixtureIdentity(2450), actionId: fixtureIdentity(2450), previousRevisionId: first.revisionId, reference: null, evaluationId: null });
  act(() => reads.invalidate(["arena"])); expect(ai.config.model).toBe("user model"); expect(ai.config.contextStrategy).toEqual(first.reference);
  act(() => { expect(ai.reset()).toBe(true); }); await waitFor(() => expect(ai.strategyDefault).toBe("ready"));
  expect(ai.config.contextStrategy).toBeNull(); expect(ai.config.sourceContext).toEqual(defaultAiConfig.sourceContext);
});

it("does not overwrite input edited while a new draft's default read is pending", async () => {
  const response = deferred<ContextStrategyDefaultRevision | null>(), saved = candidate();
  vi.spyOn(strategyCommands, "default").mockReturnValue(response.promise); vi.spyOn(strategyCommands, "candidate").mockResolvedValue(saved);
  render(<Harness withAi />, project);
  const manual = { ...defaultAiConfig.sourceContext, neighbors: true, maxItems: 7 };
  act(() => ai.setConfig(value => ({ ...value, sourceContext: manual, model: "Newer B" })));
  await act(async () => { response.resolve(revision(saved)); });
  expect(ai.config.model).toBe("Newer B"); expect(ai.config.sourceContext).toEqual(manual); expect(ai.config.contextStrategy).toBeNull();
});

it("compares complete strategy identity and detaches only edited context content", () => {
  const saved = candidate(), first: AiConfig = { ...defaultAiConfig, sourceContext: saved.sourceContext, contextStrategy: revision(saved).reference };
  expect(sameAiConfig(first, { ...first, contextStrategy: { ...revision(saved).reference!, revisionId: fixtureIdentity(2451) } })).toBe(false);
  expect(editedAiConfig(first, { ...first, model: "Another model", maxRequests: 3, shareTerms: true }).contextStrategy).toEqual(first.contextStrategy);
  expect(editedAiConfig(first, { ...first, sourceContext: { ...first.sourceContext, neighbors: true } }).contextStrategy).toBeNull();
});

it.each([false, true])("orchestrates fixed Arena and Review requests with a real change bridge=%s", async bridge => {
  render(<Harness />, project); await correction(); await act(async () => owner.capture());
  const savedCandidate = owner.state.candidate; if (!savedCandidate) throw new Error("Saved candidate required");
  const run: unknown = structuredClone(reviewWire.responses.check), preparation: unknown = structuredClone(reviewWire.responses.prepareCheck);
  if (!validateResponseCheck(run) || !run.evidence || !validateResponsePrepareCheck(preparation) || preparation.kind !== "plugin") throw new Error("Complete canonical Review fixtures required");
  const checkEvidence = run.evidence, checkerView = preparation.view;
  const holdout = fixtureIdentity(2460), attemptId = fixtureIdentity(2461), baseline = { ...defaultAiConfig, endpoint: "http://127.0.0.1:4000/v1/chat/completions", model: "synthetic", maxItems: 2, maxRequests: 4 };
  const item: AiItem = { unitId: evidence.basis.unitId, sourceRevisionId: evidence.basis.sourceRevisionId, sourceSnapshotId: evidence.basis.sourceSnapshotId,
    nativeKey: "correction", sourceLocale: "en", targetLocale: "zh-CN", sourceText: evidence.sourceText, terms: [], context: null,
    sourceContext: { kind: "not-selected" }, projectContext: { kind: "not-selected" }, omissions: ["terms-not-shared", "context-not-shared"], resourceBaseline: "0" };
  let suite!: StrategySuite, prepared!: Prepared;
  let changeSequence = 0;
  const epoch = fixtureIdentity(2462);
  if (bridge) {
    invoke.mockImplementation(async (command: string) => {
      if (command === "read_project_changes") return { ...reads.context, epoch, sequence: String(changeSequence), progressSequence: "0", scopes: ["resources"], runtime: { active: false, quiescing: false, queryCount: 0, error: null } };
      throw new Error(command);
    });
    await act(async () => { bridgeStops.push(reads.start()); await reads.synchronizeFresh(); });
  }
  const suiteWrite = vi.spyOn(strategyCommands, "suite").mockImplementation(async request => {
    const config = { ...defaultArenaConfig(), blind: true, maxItems: 2, maxRequests: 4, variants: [request.capture.config, { ...request.capture.config, sourceContext: savedCandidate.sourceContext }] };
    suite = { suiteId: request.capture.actionId, request: request.capture, projectId: project.metadata.projectId, candidateId: savedCandidate.candidateId, locale: "zh-CN", digest: "c".repeat(64),
      units: [item.unitId, holdout].map(unitId => ({ unitId, holdout: unitId === holdout, sourceRevisionId: item.sourceRevisionId,
        reviewBasis: { ...run.basisEvidence, sourceSnapshotId: item.sourceSnapshotId, sourceRevisionId: item.sourceRevisionId },
        terms: { unitId, locale: "zh-CN", sourceRevisionId: item.sourceRevisionId, entries: [] }, sourceBinding: checkEvidence.sourceBinding })),
      preview: { config, digest: "d".repeat(64), items: [item.unitId, holdout].flatMap((unitId, sourceOrder) => [0, 1].map(slot => ({ slot, sourceOrder, item: { ...item, unitId, nativeKey: sourceOrder ? "holdout" : "correction" } }))) } };
    return suite;
  });
  vi.spyOn(strategyCommands, "prepare").mockImplementation(async request => {
    prepared = { attemptId, canStart: true, preview: suite.preview, evaluation: { evaluationId: request.capture.actionId, request: request.capture, locale: "zh-CN",
      projectId: project.metadata.projectId, candidateId: savedCandidate.candidateId, suiteId: suite.suiteId, attemptId, inputDigest: "e".repeat(64) } };
    if (bridge) { const afterSequence = String(changeSequence++); reads.receive({ ...reads.context, epoch, kind: "change", afterSequence, sequence: String(changeSequence), scopes: ["resources"] }); }
    return prepared;
  });
  const observedView = (): StrategyEvaluationView => ({ evaluation: prepared.evaluation, candidate: savedCandidate, suite, checks: [], judgments: [], current: true,
    slots: suite.preview.items.map((row, index) => ({ itemId: fixtureIdentity(2470 + index), unitId: row.item.unitId, slot: row.slot, resultId: null })) });
  const evaluationRead = vi.spyOn(strategyCommands, "evaluation").mockImplementation(async () => observedView());
  const start = vi.spyOn(strategyCommands, "start").mockRejectedValueOnce(new Error("Synthetic lost start acknowledgement")).mockResolvedValue(attemptId);
  act(() => { owner.copyConfig({ ...baseline, shareTerms: true, shareContext: true }); owner.edit("roles", { [item.unitId]: "calibration", [holdout]: "holdout" }); });
  await act(async () => owner.captureSuite());
  expect(suiteWrite).toHaveBeenCalledOnce(); expect(suite.request.config).toMatchObject({ model: baseline.model, maxRequests: 4, shareTerms: false, shareContext: false, contextStrategy: null, sourceContext: defaultAiConfig.sourceContext });
  if (bridge) {
    const observation = deferred<void>(); evaluationRead.mockImplementationOnce(async () => { const captured = observedView(); await observation.promise; return captured; });
    let preparing!: Promise<void>; act(() => { preparing = owner.prepare(); });
    await waitFor(() => expect(evaluationRead).toHaveBeenCalledOnce());
    await act(async () => { const afterSequence = String(changeSequence++); reads.receive({ ...reads.context, epoch, kind: "change", afterSequence, sequence: String(changeSequence), scopes: ["resources"] }); await reads.synchronizeFresh(); });
    await act(async () => { observation.resolve(undefined); await preparing; });
    expect(owner.state.prepared).toBeNull(); expect(owner.state.stale).toBe(true); expect(owner.state.pending).toBeNull();
  }
  await act(async () => owner.prepare()); expect(owner.canStart()).toBe(false);
  if (bridge) await act(async () => { await new Promise(resolve => setTimeout(resolve, 75)); });
  expect(owner.state.prepared).not.toBeNull(); expect(owner.state.stale).toBe(false);
  if (bridge) {
    act(() => owner.setConsent(true)); expect(owner.canStart()).toBe(true);
    await act(async () => { const afterSequence = String(changeSequence++); reads.receive({ ...reads.context, epoch, kind: "change", afterSequence, sequence: String(changeSequence), scopes: ["resources"] }); await reads.synchronizeFresh(); });
    expect(owner.canStart()).toBe(false); expect(owner.state.consent).toBe(false);
    await act(async () => owner.prepare());
  }
  act(() => owner.setConsent(true)); await act(async () => owner.start());
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ evaluationId: prepared.evaluation.evaluationId, attemptId, digest: prepared.evaluation.inputDigest, confirmed: true }));
  expect(start.mock.calls[0][0].digest).not.toBe(prepared.preview.digest);
  expect(owner.state.pending?.uncertain).toBe(true);
  const originalStart = start.mock.calls[0][0]; vi.spyOn(strategyCommands, "startReceipt").mockResolvedValue(null);
  await act(async () => owner.reconcile()); expect(owner.state.pending?.retryAllowed).toBe(true);
  await act(async () => owner.retry()); expect(start.mock.calls[1][0]).toBe(originalStart);
  let arena = arenaViewFixture(item, suite.preview.config);
  const originalArena = structuredClone(arena);
  const rows: ArenaView["rows"] = [item.unitId, holdout].flatMap((unitId, sourceOrder) => arena.rows.map((row, slot) => ({ ...row,
    itemId: fixtureIdentity(2470 + sourceOrder * 2 + slot), resultId: fixtureIdentity(2480 + sourceOrder * 2 + slot),
    item: { ...row.item, unitId }, output: row.output ? { ...row.output, unitId } : null, sourceOrder, label: 1 - slot })));
  arena.rows = rows;
  arena.detail.attemptId = attemptId; arena.detail.recovery.attemptId = attemptId;
  arena.detail.items = rows.map((row, index) => ({ ...originalArena.detail.items[index % 2], resultId: row.resultId,
    scope: { ...originalArena.detail.items[index % 2].scope, id: row.item.unitId }, status: { ...originalArena.detail.items[index % 2].status, itemId: row.itemId, adoption: "unapplied" } }));
  arena.detail.recovery.units = rows.map((row, index) => ({ ...originalArena.detail.recovery.units[index % 2], unitId: fixtureIdentity(2900 + index),
    itemIds: [row.itemId], remainingItemIds: [row.itemId], resultIds: row.resultId ? [row.resultId] : [], scopes: [{ kind: "translation-unit", id: row.item.unitId, locale: row.item.targetLocale }] }));
  arena.detail.progress = { ...arena.detail.progress, total: 4, succeeded: 4 };
  let view: StrategyEvaluationView = { evaluation: prepared.evaluation, candidate: savedCandidate, suite, checks: [], judgments: [], current: true,
    slots: rows.map((row, index) => ({ itemId: row.itemId, unitId: row.item.unitId, slot: index % 2, resultId: row.resultId })) };
  function freshView() { reads.client.setQueryData(reads.key(strategyKeys.evaluation(view.evaluation.evaluationId)), structuredClone(view));
    reads.client.setQueryData(reads.key(["arena", attemptId]), structuredClone(arena));
    const latest = reads.client.getQueryData<StrategyEvaluationView>(reads.key(strategyKeys.evaluation(view.evaluation.evaluationId))), latestArena = reads.client.getQueryData<ArenaView>(reads.key(["arena", attemptId]));
    if (!latest || !latestArena) throw new Error("Fresh evaluation and original Arena required"); view = latest; arena = latestArena;
    confirmArenaView(arena, attemptId); expect(owner.evaluationCurrent(view)).toBe(true);
    expect(reads.client.getQueryState(reads.key(["arena", attemptId]))).toMatchObject({ status: "success", fetchStatus: "idle", isInvalidated: false, error: null }); }
  vi.spyOn(strategyCommands, "saveCandidate").mockImplementation(async request => {
    const unit = arena.detail.recovery.units.find(unit => unit.itemIds.includes(request.itemId)); if (!unit) throw new Error("Original execution unit required");
    return { ...executionWire.receipt, actionId: request.actionId, projectId: project.metadata.projectId, attemptId, unitId: unit.unitId,
      changes: [{ kind: "translation-revision", id: fixtureIdentity(2490), revision: "1" }] };
  }).mockImplementationOnce(async request => ({ ...executionWire.receipt, actionId: request.actionId, projectId: project.metadata.projectId,
    attemptId, unitId: rows[0].item.unitId, changes: [{ kind: "translation-revision", id: fixtureIdentity(2490), revision: "1" }] }));
  vi.spyOn(strategyCommands, "prepareCheck").mockImplementation(async request => ({ kind: "plugin", view: { ...checkerView, actionId: request.check.actionId,
    unitId: rows.find(row => row.itemId === request.check.itemId)!.item.unitId, locale: "zh-CN" } }));
  const check = vi.spyOn(strategyCommands, "check").mockImplementation(async request => ({ request: request.check.check, revisionId: fixtureIdentity(2491),
    basis: run.basisEvidence, rules: run.rules, evidence: checkEvidence }));
  for (const row of rows) {
    act(freshView); await act(async () => owner.saveCandidate(view, row, arena));
    expect(strategyCommands.saveCandidate).toHaveBeenCalledWith(expect.objectContaining({ itemId: row.itemId, resultId: row.resultId }));
    if (row === rows[0]) {
      const pending = owner.state.pending; if (pending?.kind !== "save-candidate") throw new Error("Mismatched source-unit receipt must remain unknown");
      expect(pending.unitId).not.toBe(row.item.unitId); expect(pending.unitId).toBe(fixtureIdentity(2900));
      vi.spyOn(executionCommands, "receipt").mockResolvedValue({ ...executionWire.receipt, actionId: pending.request.actionId, projectId: project.metadata.projectId, attemptId,
        unitId: pending.unitId, changes: [{ kind: "translation-revision", id: fixtureIdentity(2490), revision: "1" }] });
      const actionRead = vi.spyOn(executionCommands, "prepare").mockImplementation(async request => ({ ...executionWire.action, projectId: request.projectId, attemptId: request.attemptId,
        actionId: request.actionId, unitId: request.unitId, resultIds: request.resultIds, parameters: null, operation: "arena-translation" }));
      await act(async () => owner.reconcile()); expect(owner.state.pending).toBeNull(); expect(actionRead).toHaveBeenCalledWith(expect.objectContaining({ unitId: pending.unitId, resultIds: [row.resultId] }));
    }
    act(freshView); await act(async () => owner.prepareCheck(view, row));
    expect(owner.checkersConfirmed()).toBe(false);
    act(freshView); await act(async () => owner.check(view));
    expect(check).toHaveBeenCalledTimes(view.checks.length);
    act(() => owner.state.check?.preparation.view.checkers.forEach(slot => owner.setCheckerConsent(slot.attemptId, true)));
    const checkCapture = owner.state.check; if (!checkCapture) throw new Error("Independent check capture required");
    act(freshView); await act(async () => owner.check(view));
    const receipt: StrategyCheckReceipt = { request: checkCapture.request.check, revisionId: fixtureIdentity(2491), basis: run.basisEvidence, rules: run.rules, evidence: checkEvidence };
    view = { ...view, checks: [...view.checks, receipt] };
  }
  expect(check).toHaveBeenCalledTimes(4); expect(check.mock.calls.every(([request]) => request.executions.length === checkerView.checkers.length && request.executions.every(value => value.unsandboxedExecution))).toBe(true);
  const judgment = vi.spyOn(strategyCommands, "judgment").mockImplementation(async request => ({ judgmentId: request.judgment.actionId,
    request: { ...request.judgment, elapsedSeconds: request.judgment.elapsedSeconds ?? null, modifiedCharacters: request.judgment.modifiedCharacters ?? null, expectedJudgmentId: request.judgment.expectedJudgmentId ?? null },
    baselineResultId: rows[2].resultId!, candidateResultId: rows[3].resultId! }));
  act(() => { freshView(); owner.editJudgment(holdout, { preference: "candidate-preferred", notes: "Human comparison of these two exact results", elapsed: "31536001", modified: "3" }); });
  await act(async () => owner.judge(view, holdout)); expect(judgment).not.toHaveBeenCalled(); expect(owner.state.failure).toBe("strategy-report");
  act(() => owner.editJudgment(holdout, { elapsed: "12" }));
  await act(async () => owner.judge(view, holdout)); expect(judgment).toHaveBeenCalledWith(expect.objectContaining({ judgment: expect.objectContaining({ unitId: holdout, preference: "candidate-preferred", elapsedSeconds: 12, modifiedCharacters: 3, expectedJudgmentId: null }) }));
  const promote = vi.spyOn(strategyCommands, "promote").mockRejectedValueOnce(new Error("Synthetic lost default acknowledgement")).mockResolvedValue(revision(savedCandidate));
  act(freshView); await act(async () => owner.changeDefault(view, false, null, () => true));
  expect(promote).toHaveBeenCalledWith(expect.objectContaining({ promotion: expect.objectContaining({ evaluationId: view.evaluation.evaluationId, expectedRevisionId: null }) }));
  expect(owner.state.pending?.uncertain).toBe(true); const originalPromotion = owner.state.pending?.request;
  vi.spyOn(strategyCommands, "action").mockResolvedValue(null); await act(async () => owner.reconcile());
  promote.mockRejectedValueOnce({ code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "strategy-default-current" });
  await act(async () => owner.retry()); expect(promote.mock.calls[1][0]).toBe(originalPromotion); expect(owner.state.pending).toBeNull();
  act(freshView); await act(async () => owner.changeDefault(view, false, fixtureIdentity(2950), () => true));
  expect(promote.mock.calls[2][0].promotion.expectedRevisionId).toBe(fixtureIdentity(2950)); expect(owner.state.pending).toBeNull();
});

it("rejects a default that became stale while its immutable candidate was being read", async () => {
  const saved = candidate(), response = deferred<ContextStrategyCandidate>();
  vi.spyOn(strategyCommands, "default").mockResolvedValue(revision(saved)); vi.spyOn(strategyCommands, "candidate").mockReturnValue(response.promise);
  render(<Harness withAi />, project); await waitFor(() => expect(strategyCommands.candidate).toHaveBeenCalledOnce());
  act(() => reads.invalidate(["arena"]));
  await act(async () => { response.resolve(saved); });
  expect(ai.strategyDefault).toBe("failed"); expect(ai.config.contextStrategy).toBeNull(); expect(ai.config.sourceContext).toEqual(defaultAiConfig.sourceContext);
});

it("keeps stale candidate evidence visible and refuses a new evaluation set", async () => {
  render(<Harness />, project); const stale = candidate(); stale.evidence.current = false;
  act(() => { expect(owner.chooseCandidate(stale)).toBe(true); owner.copyConfig({ ...defaultAiConfig, endpoint: "http://127.0.0.1:4000/v1/chat/completions", model: "synthetic", maxRequests: 4 });
    owner.edit("roles", { [stale.evidence.basis.unitId]: "calibration", [fixtureIdentity(2960)]: "holdout" }); });
  const captureSuite = vi.spyOn(strategyCommands, "suite"); await act(async () => owner.captureSuite());
  expect(captureSuite).not.toHaveBeenCalled(); expect(owner.state.candidate?.evidence.sourceText).toBe(evidence.sourceText); expect(owner.state.stale).toBe(true);
});

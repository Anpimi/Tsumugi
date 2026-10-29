import { confirmArenaView } from "../../../ArenaDraftSession";
import { useLayoutEffect } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { StrategyDraftSession, useStrategyDraftSession, type StrategyOwner, type StrategyTranslationMutation } from "../../../StrategyDraftSession";
import { ExecutionTaskProvider, useExecutionTaskSession } from "../../../ExecutionTaskSession";
import { strategyDraftCommands, type StrategyDraftHead } from "../../../strategyDraftCommands";
import { strategyCommands, type ContextStrategyCandidate, type StrategyEvaluationView, type StrategySuite, type Prepared } from "../../../strategyCommands";
import { defaultAiConfig, type AiItem } from "../../../aiCommands";
import { defaultArenaConfig, arenaCommands } from "../../../arenaCommands";
import { executionCommands, executionContext } from "../../../executionCommands";
import { resourceCommands } from "../../../resourceCommands";
import { reviewCommands } from "../../../reviewCommands";
import { connectionCommands } from "../../../connectionCommands";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { sourcePageFixture, sourceRowFixture } from "../../../testSupport/sourceFixture";
import { arenaViewFixture } from "../../../testSupport/aiFixture";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { strategyDraftActionFixture, strategyDraftHeadFixture } from "../../../testSupport/strategyDraftFixture";
import { validateResponseEditor, validateResponseCheck, validateResponsePrepareCheck } from "../../../generated/review.validators";
import { validateResponseCorrectionBasis } from "../../../generated/resource.validators";
import { i18n } from "../../../i18n";
import { strategyViewEn, strategyViewZh } from "../../../i18n/strategyView";
import type { ProjectView } from "../../../projectCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { StrategyView, type StrategyIntent, type StrategyRequestTarget } from "./StrategyView";
import reviewWire from "../../../../test/fixtures/reviewCommands.contract.json";
import resourceWire from "../../../../test/fixtures/resourceCommands.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "synthetic-strategy-v2", locator: "isolated", reconciliationState: "settled", metadata: {
  projectId: resourceWire.responses.correctionBasis.basis.projectId, displayName: "Synthetic context experiment", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const translation: StrategyTranslationMutation = { mutationReserved: false, reserveMutation: () => Symbol("synthetic-translation-write"), releaseMutation: () => {} };
const cleanups: (() => void)[] = [];
let owner: StrategyOwner;
let saved: ContextStrategyCandidate[];
const text = (key: string, values: Record<string, string | number> = {}) => i18n.t(key, { ...values, defaultValue: key });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function correctionFixture() {
  const evidence: unknown = structuredClone(resourceWire.responses.correctionBasis), editor: unknown = structuredClone(reviewWire.responses.editor);
  if (!validateResponseCorrectionBasis(evidence) || !validateResponseEditor(editor) || !editor.translations.current) throw new Error("Canonical saved correction required");
  editor.target.unitId = evidence.basis.unitId; editor.target.sourceRevisionId = evidence.basis.sourceRevisionId;
  editor.translations.current.eventId = evidence.basis.after.selectionId; editor.translations.current.revisionId = evidence.basis.after.revisionId;
  editor.translations.current.previousEventId = evidence.basis.before.selectionId;
  return { evidence, editor };
}
beforeEach(async () => {
  vi.restoreAllMocks(); invoke.mockReset(); saved = [];
  i18n.addResourceBundle("en-US", "translation", { strategyView: strategyViewEn }, true, true);
  i18n.addResourceBundle("zh-CN", "translation", { strategyView: strategyViewZh }, true, true);
  await i18n.changeLanguage("en-US");
  let revision = 0;
  vi.spyOn(strategyDraftCommands, "read").mockImplementation(async request => ({ key: request.key, revision: "0", writerId: null, value: null }));
  vi.spyOn(strategyDraftCommands, "write").mockImplementation(async ({ write }) => strategyDraftHeadFixture({ key: write.key, revision: String(++revision), writerId: write.writerId, value: structuredClone(write.value) }));
  vi.spyOn(strategyDraftCommands, "resolve").mockImplementation(async ({ resolve }) => strategyDraftHeadFixture({ key: resolve.write.key, revision: String(++revision), writerId: resolve.write.writerId, value: structuredClone(resolve.write.value) }));
  vi.spyOn(strategyDraftCommands, "action").mockImplementation(async ({ pending }) => strategyDraftActionFixture({ pending: structuredClone(pending), disposition: null }));
  vi.spyOn(strategyDraftCommands, "close").mockImplementation(async ({ pending }) => strategyDraftActionFixture({ pending: structuredClone(pending), disposition: "confirmed-not-applied" }));
  const { evidence, editor } = correctionFixture();
  vi.spyOn(reviewCommands, "editorSnapshot").mockResolvedValue(editor); vi.spyOn(resourceCommands, "correctionBasis").mockResolvedValue(evidence);
  let serial = 8200; vi.spyOn(executionCommands, "identity").mockImplementation(async () => fixtureIdentity(serial++));
  vi.spyOn(strategyCommands, "candidates").mockImplementation(async () => ({ rows: saved, nextOffset: null }));
  vi.spyOn(strategyCommands, "candidate").mockImplementation(async request => { const candidate = saved.find(value => value.candidateId === request.candidateId); if (!candidate) throw new Error("Synthetic candidate missing"); return candidate; });
  vi.spyOn(strategyCommands, "evaluations").mockResolvedValue({ rows: [], nextOffset: null });
  vi.spyOn(strategyCommands, "default").mockResolvedValue(null); vi.spyOn(strategyCommands, "defaults").mockResolvedValue({ rows: [], nextOffset: null });
  vi.spyOn(connectionCommands, "read").mockResolvedValue(connectionFixture([]));
  vi.spyOn(strategyCommands, "capture").mockImplementation(async request => {
    const candidate: ContextStrategyCandidate = { candidateId: request.capture.actionId, projectId: project.metadata.projectId, locale: "zh-CN", evidence,
      sourceContext: request.capture.sourceContext, reason: request.capture.reason, exceptions: request.capture.exceptions, digest: "a".repeat(64) };
    saved.push(candidate); return candidate;
  });
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: evidence.basis.sourceSnapshotId };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: evidence.basis.sourceSnapshotId,
      scope: { revision: "2", currentSnapshot: evidence.basis.sourceSnapshotId }, rows: [
        sourceRowFixture({ unitId: evidence.basis.unitId, sourceRevisionId: evidence.basis.sourceRevisionId }, { key: "scene.correction", text: evidence.sourceText }),
        sourceRowFixture({ unitId: fixtureIdentity(8300), sourceRevisionId: evidence.basis.sourceRevisionId }, { key: "scene.holdout", text: "Separate holdout source {name}" }),
      ] });
    throw new Error(`Unexpected external or runtime request: ${command}`);
  });
});
afterEach(() => { cleanup(); cleanups.splice(0).forEach(dispose => dispose()); });
function Harness({ gate, intent, requestTarget }: { gate: InteractionGate; intent?: StrategyIntent; requestTarget?: StrategyRequestTarget }) {
  owner = useStrategyDraftSession();
  const tasks = useExecutionTaskSession();
  useLayoutEffect(() => { gate.setVisibleOwner("strategy-view"); }, [gate]);
  return <StrategyView project={project} owner={owner} tasks={tasks} visible disabled={false} gate={gate} viewId="strategy-view" intent={intent} requestTarget={requestTarget}
    config={{ ...defaultAiConfig, endpoint: "http://127.0.0.1:4000/v1/chat/completions", model: "synthetic-model", maxItems: 2, maxRequests: 4 }}/>;
}
function mount(intent?: StrategyIntent) {
  const gate = new InteractionGate(), context = executionContext(project), reads = new SessionReads(context);
  const tree = (target = intent, requestTarget?: StrategyRequestTarget) => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={project} mutations={translation}><StrategyDraftSession project={project} translationMutation={translation}><Harness gate={gate} intent={target} requestTarget={requestTarget}/></StrategyDraftSession></ExecutionTaskProvider>
  </SessionReadProvider></ApplicationReadProvider>;
  const rendered = render(tree()); cleanups.push(() => { gate.dispose(); reads.retire(); });
  return { gate, reads, rerender: (target?: StrategyIntent) => rendered.rerender(tree(target)), requestTarget: (target: StrategyRequestTarget) => rendered.rerender(tree(intent, target)) };
}
async function flush() { await act(async () => { expect(await owner.flush()).toBe(true); }); await waitFor(() => expect(owner.reserved()).toBe(false)); }
async function fill() {
  const user = userEvent.setup(), { evidence } = correctionFixture(); mount({ unitId: evidence.basis.unitId, locale: "zh-CN", sequence: 1 });
  await screen.findByRole("heading", { name: text("strategy.after") });
  await user.click(screen.getByRole("checkbox", { name: text("sourceContext.choose.extracted") }));
  await user.type(screen.getByRole("textbox", { name: text("strategy.reason") }), "Keep the extracted scene");
  await user.type(screen.getByRole("textbox", { name: text("strategy.exceptions") }), "Only this project and language");
  await flush(); return user;
}
async function saveCandidate() {
  const user = await fill(); await user.click(screen.getByRole("button", { name: text("strategy.create") }));
  await waitFor(() => expect(owner.state.candidate).not.toBeNull()); await flush(); return user;
}

it.each(["en-US", "zh-CN"])("loads a saved correction and captures the candidate through the original owner in %s", async language => {
  await i18n.changeLanguage(language); const user = await fill();
  expect(screen.getByRole("heading", { level: 1, name: language === "en-US" ? "Compare context settings" : "比较上下文效果" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: text("strategy.create") }));
  await waitFor(() => expect(strategyCommands.capture).toHaveBeenCalledOnce());
  expect(vi.mocked(strategyCommands.capture).mock.calls[0]?.[0].capture).toMatchObject({ basis: resourceWire.responses.correctionBasis.basis,
    reason: "Keep the extracted scene", exceptions: "Only this project and language", sourceContext: { extracted: true, inferred: false, neighbors: false } });
  await screen.findByText(text("strategyView.candidateReady"));
  expect(screen.queryByRole("textbox", { name: /unitId|candidateId|selectionId/i })).toBeNull();
  expect(invoke.mock.calls.some(([command]) => String(command).startsWith("start_"))).toBe(false);
});

it("retains newer input and focus when an earlier candidate save returns", async () => {
  const user = await fill(), result = deferred<ContextStrategyCandidate>();
  vi.mocked(strategyCommands.capture).mockReturnValueOnce(result.promise);
  await user.click(screen.getByRole("button", { name: text("strategy.create") }));
  await waitFor(() => expect(strategyCommands.capture).toHaveBeenCalledOnce());
  const reason = screen.getByRole("textbox", { name: text("strategy.reason") }); await user.clear(reason); await user.type(reason, "Newer hypothesis B");
  const original = vi.mocked(strategyCommands.capture).mock.calls[0]?.[0]; if (!original) throw new Error("Original request required");
  const { evidence } = correctionFixture();
  await act(async () => { result.resolve({ candidateId: original.capture.actionId, projectId: project.metadata.projectId, locale: "zh-CN", evidence,
    sourceContext: original.capture.sourceContext, reason: original.capture.reason, exceptions: original.capture.exceptions, digest: "a".repeat(64) }); await result.promise; });
  expect(reason).toHaveValue("Newer hypothesis B"); expect(document.activeElement).toBe(reason); expect(owner.state.candidate).toBeNull();
  await flush();
});

it("checks and explicitly retries the same unknown request while retaining newer hypothesis input", async () => {
  const user = await fill();
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce(new Error("Synthetic lost acknowledgement"));
  const lookup = vi.spyOn(strategyCommands, "action").mockResolvedValue(null);
  await user.click(screen.getByRole("button", { name: text("strategy.create") }));
  await screen.findByRole("button", { name: text("strategy.retryOriginal") });
  const reason = screen.getByRole("textbox", { name: text("strategy.reason") }); await user.clear(reason); await user.type(reason, "Retained newer B");
  await act(async () => { await owner.flush(); });
  await waitFor(() => expect(owner.current().busy).toBe(false));
  await user.click(screen.getByRole("button", { name: text("strategy.reconcile") }));
  await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole("button", { name: text("strategy.retryOriginal") }));
  await waitFor(() => expect(strategyCommands.capture).toHaveBeenCalledTimes(2));
  expect(vi.mocked(strategyCommands.capture).mock.calls[1]?.[0]).toBe(vi.mocked(strategyCommands.capture).mock.calls[0]?.[0]);
  expect(reason).toHaveValue("Retained newer B");
});

it("keeps a dirty strategy when a different saved-edit intent arrives and offers an explicit new draft", async () => {
  const { evidence } = correctionFixture(), h = mount(); await waitFor(() => expect(owner.hydrating).toBe(false));
  act(() => owner.edit("reason", "Retained hypothesis B")); await flush();
  h.rerender({ unitId: evidence.basis.unitId, locale: "zh-CN", sequence: 2 });
  await screen.findByText(text("strategyView.intentBlocked")); expect(owner.state.reason).toBe("Retained hypothesis B");
  expect(screen.getByRole("button", { name: text("strategyView.loadIntent") })).toBeDisabled();
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: text("strategy.reset") }));
  const dialog = await screen.findByRole("dialog", { name: text("strategyView.newDraftTitle") });
  await user.click(within(dialog).getByRole("button", { name: text("strategy.reset") }));
  await screen.findByRole("heading", { name: text("strategy.after") }); expect(owner.state.reason).toBe("");
});

it("does not retarget a stale inbox request to a different current pending action", async () => {
  const { evidence } = correctionFixture(), h = mount({ unitId: evidence.basis.unitId, locale: "zh-CN", sequence: 1 });
  await screen.findByRole("heading", { name: text("strategy.after") });
  act(() => { owner.edit("sourceContext", { ...defaultAiConfig.sourceContext, extracted: true }); owner.edit("reason", "Original request"); owner.edit("exceptions", "Only this project"); });
  await flush(); vi.mocked(strategyCommands.capture).mockRejectedValueOnce(new Error("Synthetic lost acknowledgement"));
  const lookup = vi.spyOn(strategyCommands, "action").mockResolvedValue(null);
  await act(async () => { await owner.capture(); }); await screen.findByRole("button", { name: text("strategy.reconcile") });
  const pending = owner.current().pending;
  h.requestTarget({ actionId: fixtureIdentity(8999), submittedSeq: "999" });
  await screen.findByText(text("strategyView.requestChanged")); expect(screen.queryByRole("button", { name: text("strategy.reconcile") })).toBeNull();
  expect(owner.current().pending).toBe(pending); expect(lookup).toHaveBeenCalledOnce();
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: text("strategyView.viewCurrent") }));
  await screen.findByRole("button", { name: text("strategy.reconcile") }); expect(lookup).toHaveBeenCalledOnce();
});

it("freezes both variants, confirms and starts the exact evaluation, and recovers its original stop request", async () => {
  const user = await saveCandidate(), { evidence } = correctionFixture();
  const run: unknown = structuredClone(reviewWire.responses.check);
  if (!validateResponseCheck(run) || !run.evidence) throw new Error("Canonical review basis required");
  const checkEvidence = run.evidence, holdout = fixtureIdentity(8300), attemptId = fixtureIdentity(8400);
  let suite: StrategySuite | null = null, prepared: Prepared | null = null;
  vi.spyOn(strategyCommands, "suite").mockImplementation(async request => {
    const candidate = owner.state.candidate; if (!candidate) throw new Error("Saved candidate required");
    const item: AiItem = { unitId: evidence.basis.unitId, sourceRevisionId: evidence.basis.sourceRevisionId, sourceSnapshotId: evidence.basis.sourceSnapshotId,
      nativeKey: "scene.correction", sourceLocale: "en", targetLocale: "zh-CN", sourceText: evidence.sourceText, terms: [], context: null,
      sourceContext: { kind: "not-selected" }, projectContext: { kind: "not-selected" }, omissions: [], resourceBaseline: "0" };
    suite = { suiteId: request.capture.actionId, request: request.capture, projectId: project.metadata.projectId, candidateId: candidate.candidateId, locale: "zh-CN", digest: "b".repeat(64),
      units: [item.unitId, holdout].map(unitId => ({ unitId, holdout: unitId === holdout, sourceRevisionId: item.sourceRevisionId, reviewBasis: run.basisEvidence,
        terms: { unitId, locale: "zh-CN", sourceRevisionId: item.sourceRevisionId, entries: [] }, sourceBinding: checkEvidence.sourceBinding })),
      preview: { config: { ...defaultArenaConfig(), blind: true, maxItems: 2, maxRequests: 4, variants: [request.capture.config, { ...request.capture.config, sourceContext: candidate.sourceContext }] }, digest: "c".repeat(64),
        items: [item.unitId, holdout].flatMap((unitId, sourceOrder) => [0, 1].map(slot => ({ slot, sourceOrder, item: { ...item, unitId, nativeKey: sourceOrder ? "scene.holdout" : item.nativeKey } }))) } };
    return suite;
  });
  vi.spyOn(strategyCommands, "prepare").mockImplementation(async request => {
    const candidate = owner.state.candidate; if (!suite || !candidate) throw new Error("Frozen suite required");
    prepared = { attemptId, canStart: true, preview: suite.preview, evaluation: { evaluationId: request.capture.actionId, request: request.capture, projectId: project.metadata.projectId,
      locale: "zh-CN", candidateId: candidate.candidateId, suiteId: suite.suiteId, attemptId, inputDigest: "d".repeat(64) } }; return prepared;
  });
  vi.spyOn(strategyCommands, "evaluation").mockImplementation(async () => {
    const candidate = owner.state.candidate; if (!suite || !prepared || !candidate) throw new Error("Prepared evaluation required");
    return { evaluation: prepared.evaluation, candidate, suite, checks: [], judgments: [], current: true,
      slots: suite.preview.items.map((row, index) => ({ itemId: fixtureIdentity(8410 + index), unitId: row.item.unitId, slot: row.slot, resultId: null })) };
  });
  vi.spyOn(arenaCommands, "read").mockImplementation(async () => {
    const first = suite?.preview.items[0]; if (!first) throw new Error("Fixed source required");
    const arena = arenaViewFixture(first.item, suite!.preview.config), original = structuredClone(arena);
    arena.detail.attemptId = attemptId; arena.detail.recovery.attemptId = attemptId;
    arena.rows = suite!.preview.items.map((row, index) => {
      const base = original.rows[index % 2]; if (!base) throw new Error("Canonical variant required");
      return { ...base, itemId: fixtureIdentity(8410 + index), resultId: null, sourceOrder: row.sourceOrder, label: row.slot, item: row.item, output: null };
    });
    arena.detail.items = arena.rows.map((row, index) => {
      const base = original.detail.items[index % 2]; if (!base) throw new Error("Canonical queued item required");
      return { ...base, resultId: null, scope: { kind: "translation-unit" as const, id: row.item.unitId, locale: row.item.targetLocale }, status: {
        ...base.status, itemId: row.itemId, execution: "queued" as const, validation: "absent" as const, adoption: "unapplied" as const } };
    });
    arena.detail.recovery.units = arena.rows.map((row, index) => {
      const base = original.detail.recovery.units[index % 2]; if (!base) throw new Error("Canonical queued unit required");
      return { ...base, unitId: fixtureIdentity(8420 + index), itemIds: [row.itemId], remainingItemIds: [row.itemId], resultIds: [],
        scopes: [{ kind: "translation-unit" as const, id: row.item.unitId, locale: row.item.targetLocale }] };
    });
    arena.detail.progress = { ...arena.detail.progress, total: 4, queued: 4, running: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0, adopted: 0 };
    return arena;
  });
  const start = vi.spyOn(strategyCommands, "start").mockResolvedValue(attemptId);
  const cancellation = vi.spyOn(executionCommands, "cancel").mockRejectedValueOnce(new Error("Synthetic lost stop acknowledgement")).mockResolvedValue("2");
  const cancellationRead = vi.spyOn(executionCommands, "cancellationAction").mockResolvedValue(null);
  await user.click(screen.getByRole("button", { name: text("strategyView.continue") }));
  await user.click(screen.getByRole("button", { name: text("strategy.useConnection") })); await flush();
  await user.click(screen.getByRole("button", { name: text("strategyView.assignment", { entry: "scene.correction" }) }));
  await user.click(screen.getByRole("menuitem", { name: text("strategy.calibration") }));
  await user.click(screen.getByRole("button", { name: text("strategyView.assignment", { entry: "scene.holdout" }) }));
  await user.click(screen.getByRole("menuitem", { name: text("strategy.holdout") })); await flush();
  await user.click(screen.getByRole("button", { name: text("strategy.saveSuite") })); await waitFor(() => expect(owner.state.suite).not.toBeNull()); await flush();
  await user.click(screen.getByRole("button", { name: text("strategy.evaluate") })); await screen.findByRole("region", { name: text("strategy.preview") }); await flush();
  expect(start).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: text("strategy.start") })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: text("strategy.consent") }));
  await user.click(screen.getByRole("button", { name: text("strategy.start") }));
  await waitFor(() => expect(start).toHaveBeenCalledOnce());
  expect(start.mock.calls[0]?.[0]).toMatchObject({ attemptId, digest: "d".repeat(64), confirmed: true });
  expect(vi.mocked(strategyCommands.suite).mock.calls[0]?.[0].capture).toMatchObject({ calibrationUnitIds: [evidence.basis.unitId], holdoutUnitIds: [holdout],
    config: { shareTerms: false, shareContext: false, contextStrategy: null } });
  const stop = await screen.findByRole("button", { name: text("strategyView.stopEvaluation") }); await waitFor(() => expect(stop).toBeEnabled()); await user.click(stop);
  await screen.findByRole("button", { name: text("execution.checkCancellation") });
  const originalStop = cancellation.mock.calls[0]?.[0]; if (!originalStop) throw new Error("Original stop request required");
  await user.click(screen.getByRole("button", { name: text("execution.checkCancellation") })); await waitFor(() => expect(cancellationRead).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole("button", { name: text("execution.retryCancellation") })); await waitFor(() => expect(cancellation).toHaveBeenCalledTimes(2));
  expect(cancellation.mock.calls[1]?.[0]).toBe(originalStop); await screen.findByText(text("execution.cancelRecorded"));
});

it("shows local storage failure with a real owner retry and keeps original input", async () => {
  mount(); await waitFor(() => expect(owner.hydrating).toBe(false));
  vi.mocked(strategyDraftCommands.write).mockRejectedValueOnce(new Error("Synthetic local storage failure"));
  act(() => owner.edit("reason", "Retained after local failure")); await act(async () => { await owner.flush(); });
  await screen.findByText(text("strategyView.localFailure")); expect(owner.state.reason).toBe("Retained after local failure");
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: text("strategyView.retryLocal") }));
  await waitFor(() => expect(owner.state.journalFailure).toBeNull()); expect(owner.state.reason).toBe("Retained after local failure");
});

it("offers retry instead of remaining in loading when the local draft cannot initially be read", async () => {
  vi.mocked(strategyDraftCommands.read).mockRejectedValueOnce(new Error("Synthetic unavailable local storage"));
  mount(); await screen.findByText(text("strategyView.localFailure"));
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: text("strategyView.retryLocal") }));
  await waitFor(() => expect(owner.hydrating).toBe(false)); expect(strategyDraftCommands.read).toHaveBeenCalledTimes(2);
});

it("opens original results from history, keeps blind roles exact, and records independent checks and human review", async () => {
  const user = await saveCandidate(), candidate = owner.state.candidate;
  if (!candidate) throw new Error("Saved original candidate required");
  const { evidence } = correctionFixture(), run: unknown = structuredClone(reviewWire.responses.check), preparation: unknown = structuredClone(reviewWire.responses.prepareCheck);
  if (!validateResponseCheck(run) || !run.evidence || !validateResponsePrepareCheck(preparation) || preparation.kind !== "plugin") throw new Error("Canonical independent checker required");
  const holdout = fixtureIdentity(8300), suiteId = fixtureIdentity(8500), evaluationId = fixtureIdentity(8501), attemptId = fixtureIdentity(8502);
  const item: AiItem = { unitId: evidence.basis.unitId, sourceRevisionId: evidence.basis.sourceRevisionId, sourceSnapshotId: evidence.basis.sourceSnapshotId,
    nativeKey: "scene.correction", sourceLocale: "en", targetLocale: "zh-CN", sourceText: evidence.sourceText, terms: [], context: null,
    sourceContext: { kind: "not-selected" }, projectContext: { kind: "not-selected" }, omissions: [], resourceBaseline: "0" };
  const config = { ...defaultArenaConfig(), blind: true, variants: [defaultAiConfig, { ...defaultAiConfig, sourceContext: candidate.sourceContext }] };
  const checkEvidence = run.evidence;
  const suite: StrategySuite = { suiteId, candidateId: candidate.candidateId, projectId: project.metadata.projectId, locale: "zh-CN", digest: "b".repeat(64),
    request: { actionId: suiteId, projectId: project.metadata.projectId, candidateId: candidate.candidateId, config: defaultAiConfig, calibrationUnitIds: [item.unitId], holdoutUnitIds: [holdout] },
    units: [item.unitId, holdout].map(unitId => ({ unitId, holdout: unitId === holdout, sourceRevisionId: item.sourceRevisionId, reviewBasis: run.basisEvidence,
      terms: { unitId, locale: "zh-CN", sourceRevisionId: item.sourceRevisionId, entries: [] }, sourceBinding: checkEvidence.sourceBinding })),
    preview: { config, digest: "c".repeat(64), items: [item.unitId, holdout].flatMap((unitId, sourceOrder) => [0, 1].map(slot => ({ slot, sourceOrder, item: { ...item, unitId } }))) } };
  const arena = arenaViewFixture(item, config), original = structuredClone(arena);
  arena.detail.attemptId = attemptId; arena.detail.recovery.attemptId = attemptId;
  arena.rows = [item.unitId, holdout].flatMap((unitId, sourceOrder) => original.rows.map((row, slot) => ({ ...row, itemId: fixtureIdentity(8510 + sourceOrder * 2 + slot),
    resultId: fixtureIdentity(8520 + sourceOrder * 2 + slot), sourceOrder, label: 1 - slot, item: { ...row.item, unitId, nativeKey: sourceOrder ? "scene.holdout" : "scene.correction" },
    output: row.output ? { ...row.output, unitId, text: `${sourceOrder ? "Holdout" : "Calibration"} ${slot ? "candidate" : "baseline"} {name}` } : null })));
  arena.detail.items = arena.rows.map((row, index) => {
    const base = original.detail.items[index % 2]; if (!base) throw new Error("Canonical item status required");
    return { ...base, resultId: row.resultId, scope: { ...base.scope, id: row.item.unitId }, status: { ...base.status, itemId: row.itemId, adoption: "committed" } };
  });
  arena.detail.recovery.units = arena.rows.map((row, index) => {
    const base = original.detail.recovery.units[index % 2]; if (!base) throw new Error("Canonical recovery unit required");
    return { ...base, unitId: fixtureIdentity(8530 + index), itemIds: [row.itemId], remainingItemIds: [], resultIds: row.resultId ? [row.resultId] : [],
      scopes: [{ kind: "translation-unit", id: row.item.unitId, locale: row.item.targetLocale }] };
  });
  arena.detail.progress = { ...arena.detail.progress, total: 4, succeeded: 4 };
  confirmArenaView(arena, attemptId);
  let view: StrategyEvaluationView = { evaluation: { evaluationId, projectId: project.metadata.projectId, locale: "zh-CN", candidateId: candidate.candidateId, suiteId, attemptId,
    inputDigest: "d".repeat(64), request: { actionId: evaluationId, projectId: project.metadata.projectId, candidateId: candidate.candidateId, suiteId } }, candidate, suite, checks: [], judgments: [], current: true,
    slots: arena.rows.map((row, index) => ({ itemId: row.itemId, unitId: row.item.unitId, slot: index % 2, resultId: row.resultId })) };
  vi.mocked(strategyCommands.evaluations).mockResolvedValue({ rows: [view.evaluation], nextOffset: null });
  vi.spyOn(strategyCommands, "evaluation").mockImplementation(async () => view); vi.spyOn(arenaCommands, "read").mockResolvedValue(arena);
  const prepareCheck = vi.spyOn(strategyCommands, "prepareCheck").mockImplementation(async request => ({ kind: "plugin", view: { ...preparation.view,
    actionId: request.check.actionId, unitId: item.unitId, locale: "zh-CN" } }));
  const check = vi.spyOn(strategyCommands, "check").mockImplementation(async request => {
    const receipt = { request: request.check.check, revisionId: fixtureIdentity(8540), basis: run.basisEvidence, rules: run.rules, evidence: checkEvidence };
    view = { ...view, checks: [receipt] }; return receipt;
  });
  const judge = vi.spyOn(strategyCommands, "judgment").mockImplementation(async request => {
    const baselineResultId = view.slots.find(slot => slot.unitId === holdout && slot.slot === 0)?.resultId;
    const candidateResultId = view.slots.find(slot => slot.unitId === holdout && slot.slot === 1)?.resultId;
    if (!baselineResultId || !candidateResultId) throw new Error("Both exact holdout results required");
    const judgment = { judgmentId: request.judgment.actionId, request: { ...request.judgment, elapsedSeconds: request.judgment.elapsedSeconds ?? null,
      modifiedCharacters: request.judgment.modifiedCharacters ?? null, expectedJudgmentId: request.judgment.expectedJudgmentId ?? null }, baselineResultId, candidateResultId }; view = { ...view, judgments: [judgment] }; return judgment;
  });
  await user.click(screen.getByRole("tab", { name: text("strategyView.history") }));
  await user.click(screen.getByRole("button", { name: text("strategy.refresh") }));
  await user.click(await screen.findByRole("button", { name: text("strategyView.evaluation", { number: 1, locale: "zh-CN" }) }));
  const calibration = await screen.findByRole("region", { name: "scene.correction" });
  const baseline = within(calibration).getByRole("heading", { name: text("strategy.baseline") }).closest("article");
  if (!baseline) throw new Error("Original baseline result article required");
  expect(baseline).toHaveTextContent("Calibration baseline {name}");
  expect(within(baseline).getByRole("heading", { name: text("strategy.baseline") })).toBeVisible();
  await waitFor(() => expect(within(baseline).getByRole("button", { name: text("strategy.prepareCheck") })).toBeEnabled());
  await user.click(within(baseline).getByRole("button", { name: text("strategy.prepareCheck") }));
  await screen.findByRole("region", { name: text("strategy.qa") }); await flush();
  expect(screen.getByRole("button", { name: text("strategy.runCheck") })).toBeDisabled();
  for (const consent of screen.getAllByRole("checkbox", { name: text("strategy.checkConsent") })) await user.click(consent);
  await user.click(screen.getByRole("button", { name: text("strategy.runCheck") })); await waitFor(() => expect(check).toHaveBeenCalledOnce()); await flush();
  expect(prepareCheck.mock.calls[0]?.[0].check).toMatchObject({ evaluationId, itemId: arena.rows[0]?.itemId, resultId: arena.rows[0]?.resultId });
  await user.click(screen.getByRole("radio", { name: text("strategy.candidatePreferred") }));
  await user.type(screen.getByRole("textbox", { name: text("strategy.notes") }), "Candidate preserves the intended scene"); await flush();
  await user.click(screen.getByRole("button", { name: text("strategy.saveJudgment") })); await waitFor(() => expect(judge).toHaveBeenCalledOnce());
  expect(judge.mock.calls[0]?.[0].judgment).toMatchObject({ evaluationId, unitId: holdout, preference: "candidate-preferred", elapsedSeconds: null, modifiedCharacters: null });
  expect(invoke.mock.calls.some(([command]) => String(command).startsWith("start_"))).toBe(false);
});


it("keeps a cleared request budget empty after reopening and cannot prepare with its storage basis", async () => {
  const user = await saveCandidate(), { evidence } = correctionFixture();
  await user.click(screen.getByRole("button", { name: text("strategyView.continue") }));
  await user.click(screen.getByRole("button", { name: text("strategy.useConnection") })); await flush();
  await user.click(screen.getByRole("button", { name: text("strategyView.assignment", { entry: "scene.correction" }) }));
  await user.click(screen.getByRole("menuitem", { name: text("strategy.calibration") }));
  await user.click(screen.getByRole("button", { name: text("strategyView.assignment", { entry: "scene.holdout" }) }));
  await user.click(screen.getByRole("menuitem", { name: text("strategy.holdout") })); await flush();
  const suite = vi.spyOn(strategyCommands, "suite"), prepare = vi.spyOn(strategyCommands, "prepare");
  expect(screen.getByRole("button", { name: text("strategy.saveSuite") })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: text("strategyView.advanced") }));
  const requests = screen.getByRole("spinbutton", { name: text("ai.maxRequests") });
  expect(requests).toHaveValue(4);
  const retained: StrategyDraftHead[] = [];
  const write = vi.mocked(strategyDraftCommands.write).getMockImplementation();
  if (!write) throw new Error("Synthetic shared journal required");
  vi.mocked(strategyDraftCommands.write).mockImplementation(async request => { const head = await write(request); retained.push(structuredClone(head)); return head; });
  await user.clear(requests); await flush();
  expect(requests).toHaveValue(null); expect(owner.journalFailure).toBeNull();
  const saved = retained.at(-1);
  if (!saved?.value) throw new Error("The cleared number must be journaled before closing");
  expect(saved.value.numberDrafts?.["config-max-requests"]).toEqual({ text: "", previous: 4 });
  expect(saved.value.config.maxRequests).toBe(4);
  expect(screen.getByRole("button", { name: text("strategy.saveSuite") })).toBeDisabled();
  cleanup(); cleanups.splice(0).forEach(dispose => dispose());
  vi.mocked(strategyDraftCommands.read).mockResolvedValue(structuredClone(saved));
  mount(); await waitFor(() => expect(owner.hydrating).toBe(false));
  await user.click(screen.getByRole("tab", { name: text("strategyView.experiment") }));
  await user.click(screen.getByRole("button", { name: text("strategyView.advanced") }));
  expect(screen.getByRole("spinbutton", { name: text("ai.maxRequests") })).toHaveValue(null);
  expect(owner.state.config.maxRequests).toBeNaN();
  expect(owner.state.roles).toEqual({ [evidence.basis.unitId]: "calibration", [fixtureIdentity(8300)]: "holdout" });
  expect(screen.getByRole("button", { name: text("strategy.saveSuite") })).toBeDisabled();
  await act(async () => { await owner.captureSuite(); await owner.prepare(); });
  expect(suite).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
});

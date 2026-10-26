import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useLayoutEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkbenchCommands } from "./workbenchCommands";
import { StrategyDraftSession, useStrategyDraftSession } from "./StrategyDraftSession";
import { StrategyWorkbench, StrategyEvaluationResults } from "./StrategyWorkbench";
import { strategyCommands, strategyKeys, type ContextStrategyCandidate, type StrategyEvaluationView, type StrategySuite } from "./strategyCommands";
import { defaultAiConfig, type AiItem } from "./aiCommands";
import { defaultArenaConfig } from "./arenaCommands";
import { arenaViewFixture } from "./testSupport/aiFixture";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { reviewCommands } from "./reviewCommands";
import { resourceCommands } from "./resourceCommands";
import { executionCommands } from "./executionCommands";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { validateResponseEditor, validateResponseCheck, validateResponsePrepareCheck } from "./generated/review.validators";
import { validateResponseCorrectionBasis } from "./generated/resource.validators";
import { i18n } from "./i18n";
import { enUS } from "./i18n/en-US";
import reviewWire from "../test/fixtures/reviewCommands.contract.json";
import resourceWire from "../test/fixtures/resourceCommands.contract.json";
import errorWire from "../test/fixtures/commandErrors.contract.json";
import { isCommandError, type ProjectView } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "strategy-ui", locator: "isolated", reconciliationState: "settled", metadata: {
  projectId: resourceWire.responses.correctionBasis.basis.projectId, displayName: "Synthetic context project", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let saved: ContextStrategyCandidate[];
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); vi.restoreAllMocks(); saved = [];
  const evidence: unknown = structuredClone(resourceWire.responses.correctionBasis), editor: unknown = structuredClone(reviewWire.responses.editor);
  if (!validateResponseCorrectionBasis(evidence) || !validateResponseEditor(editor) || !editor.translations.current) throw new Error("Complete canonical saved correction required");
  editor.target.unitId = evidence.basis.unitId; editor.target.sourceRevisionId = evidence.basis.sourceRevisionId;
  editor.translations.current.eventId = evidence.basis.after.selectionId; editor.translations.current.revisionId = evidence.basis.after.revisionId; editor.translations.current.previousEventId = evidence.basis.before.selectionId;
  vi.spyOn(reviewCommands, "editorSnapshot").mockResolvedValue(editor); vi.spyOn(resourceCommands, "correctionBasis").mockResolvedValue(evidence);
  let serial = 2500; vi.spyOn(executionCommands, "identity").mockImplementation(async () => fixtureIdentity(serial++));
  vi.spyOn(strategyCommands, "candidates").mockImplementation(async () => ({ rows: saved, nextOffset: null }));
  vi.spyOn(strategyCommands, "candidate").mockImplementation(async request => { const value = saved.find(value => value.candidateId === request.candidateId); if (!value) throw new Error("Saved candidate not found"); return value; });
  vi.spyOn(strategyCommands, "evaluations").mockResolvedValue({ rows: [], nextOffset: null });
  vi.spyOn(strategyCommands, "default").mockResolvedValue(null); vi.spyOn(strategyCommands, "defaults").mockResolvedValue({ rows: [], nextOffset: null });
  vi.spyOn(strategyCommands, "capture").mockImplementation(async request => {
    const value: ContextStrategyCandidate = { candidateId: request.capture.actionId, projectId: project.metadata.projectId, locale: "zh-CN", evidence,
      sourceContext: request.capture.sourceContext, reason: request.capture.reason, exceptions: request.capture.exceptions, digest: "a".repeat(64) };
    saved = [...saved, value]; return value;
  });
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: evidence.basis.sourceSnapshotId };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: evidence.basis.sourceSnapshotId, scope: { revision: "2", currentSnapshot: evidence.basis.sourceSnapshotId },
      rows: [sourceRowFixture({ unitId: evidence.basis.unitId, sourceRevisionId: evidence.basis.sourceRevisionId }, { key: "door.barrel", text: evidence.sourceText })] });
    throw new Error(command);
  });
});
afterEach(cleanup);
let commands!: ReturnType<typeof useWorkbenchCommands>;
function RecoveryRegistryProbe() { const value = useWorkbenchCommands(); useLayoutEffect(() => { commands = value; }); return null; }
function mount(area: "ai" | "arena" = "ai") { return render(<StrategyDraftSession project={project}><RecoveryRegistryProbe /><StrategyWorkbench area={area} project={project} active disabled={false} config={defaultAiConfig} /></StrategyDraftSession>, project); }
async function fill(area: "ai" | "arena" = "ai") {
  const user = userEvent.setup(); mount(area); await user.click(screen.getByText(enUS.strategy.title));
  await screen.findByRole("option", { name: /door.barrel/ });
  await user.selectOptions(screen.getByRole("combobox", { name: enUS.strategy.correction }), resourceWire.responses.correctionBasis.basis.unitId);
  await user.click(screen.getByRole("button", { name: enUS.strategy.inspectCorrection }));
  await screen.findByRole("heading", { name: enUS.strategy.after });
  await user.click(screen.getByRole("checkbox", { name: enUS.sourceContext.choose.extracted }));
  await user.type(screen.getByRole("textbox", { name: enUS.strategy.reason }), "Preserve the extracted scene");
  await user.type(screen.getByRole("textbox", { name: enUS.strategy.exceptions }), "Only this project and target language");
  return user;
}
it("offers a saved correction by entry name and reaches the real immutable-candidate command", async () => {
  const user = await fill(); await user.click(screen.getByRole("button", { name: enUS.strategy.create }));
  await waitFor(() => expect(strategyCommands.capture).toHaveBeenCalledOnce());
  expect(vi.mocked(strategyCommands.capture).mock.calls[0][0].capture).toMatchObject({ basis: resourceWire.responses.correctionBasis.basis,
    reason: "Preserve the extracted scene", exceptions: "Only this project and target language", sourceContext: { extracted: true, inferred: false, neighbors: false } });
  await screen.findByText(/Saved candidate: Preserve the extracted scene/);
  expect(screen.getByText(enUS.strategy.saved)).toBeVisible();
  expect(screen.getByRole("heading", { name: enUS.strategy.suite })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: /selectionId|candidateId|unitId/i })).not.toBeInTheDocument();
});
it("keeps newer text visible and exposes exact recovery after an uncertain candidate write", async () => {
  const user = await fill(); vi.mocked(strategyCommands.capture).mockRejectedValueOnce(new Error("Synthetic lost acknowledgement"));
  vi.spyOn(strategyCommands, "action").mockResolvedValue(null);
  await user.click(screen.getByRole("button", { name: enUS.strategy.create }));
  await screen.findByRole("button", { name: enUS.strategy.reconcile });
  const reason = screen.getByRole("textbox", { name: enUS.strategy.reason }); await user.clear(reason); await user.type(reason, "Newer input B");
  expect(reason).toHaveValue("Newer input B");
  await user.click(screen.getByRole("button", { name: enUS.strategy.reconcile }));
  await screen.findByRole("button", { name: enUS.strategy.retryOriginal });
  expect(reason).toHaveValue("Newer input B"); expect(strategyCommands.capture).toHaveBeenCalledOnce();
});

const rejectedGateCases = [
  { language: "en-US", reason: "strategy-checks-incomplete", message: "The default for future drafts was not updated because some comparison results are still missing QA checks. Run the required QA checks on both sides of every evaluation entry, then try again." },
  { language: "en-US", reason: "strategy-no-improvement", message: "The default for future drafts was not updated because none of the saved holdout comparisons favored the candidate. Review the results and notes—keep the current default unless the holdout comparisons show the candidate performs better." },
  { language: "zh-CN", reason: "strategy-checks-incomplete", message: "未更新后续草稿的默认策略：部分对比结果尚未完成 QA 检查。请先为每个评估条目的两侧结果完成必需的 QA 检查后再试。" },
  { language: "zh-CN", reason: "strategy-no-improvement", message: "未更新后续草稿的默认策略：已保存的留出集对比中没有偏向候选策略的结果。请复核对比结果与备注；除非留出集结果证明候选策略更优，否则请维持当前默认设置。" },
];
it.each(rejectedGateCases)("explains a confirmed strategy gate $reason in $language", async ({ language, reason, message }) => {
  const user = await fill(); await act(async () => { await i18n.changeLanguage(language); });
  const failure = { ...errorWire.errors[0], conflict: null, reason }; expect(isCommandError(failure)).toBe(true);
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce(failure);
  const original = vi.spyOn(strategyCommands, "action").mockResolvedValue(null);
  await user.click(screen.getByRole("button", { name: i18n.t("strategy.create") }));
  expect(await screen.findByText(message)).toBeVisible();
  expect(screen.queryByText(i18n.t("strategy.failed"))).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("strategy.reconcile") })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: i18n.t("strategy.reason") })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: i18n.t("strategy.reason") })).toHaveValue("Preserve the extracted scene");
  expect(original).not.toHaveBeenCalled();
});

it.each(["unknown-outcome", "untyped-reason", "unknown-action-read"] as const)("keeps an unconfirmed strategy outcome for %s", async kind => {
  const user = await fill(), reason = "strategy-checks-incomplete";
  const rejected = { ...errorWire.errors[0], conflict: null, reason };
  const failure = kind === "unknown-outcome" ? { ...rejected, outcome: "unknown" }
    : kind === "untyped-reason" ? { reason, outcome: "rejected" } : new Error("Lost original strategy ACK");
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce(failure);
  const original = vi.spyOn(strategyCommands, "action").mockResolvedValueOnce(null).mockRejectedValueOnce(rejected);
  await user.click(screen.getByRole("button", { name: enUS.strategy.create }));
  await screen.findByRole("button", { name: enUS.strategy.reconcile });
  if (kind === "unknown-action-read") await user.click(screen.getByRole("button", { name: enUS.strategy.reconcile }));
  await waitFor(() => expect(original).toHaveBeenCalledTimes(kind === "unknown-action-read" ? 2 : 1));
  expect(screen.getAllByText(enUS.strategy.unknown).length).toBeGreaterThan(0);
  for (const entry of rejectedGateCases.filter(entry => entry.language === "en-US")) expect(screen.queryByText(entry.message)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: enUS.strategy.reconcile })).toBeVisible();
});

it.each(["failed", "cancelled", "unavailable"] as const)("allows a fresh independent QA after a saved %s receipt without rerunning the model", async outcome => {
  const evidence: unknown = structuredClone(resourceWire.responses.correctionBasis), run: unknown = structuredClone(reviewWire.responses.check), preparation: unknown = structuredClone(reviewWire.responses.prepareCheck);
  if (!validateResponseCorrectionBasis(evidence) || !validateResponseCheck(run) || !run.evidence || !validateResponsePrepareCheck(preparation) || preparation.kind !== "plugin") throw new Error("Complete canonical evidence required");
  const candidate: ContextStrategyCandidate = { candidateId: fixtureIdentity(2600), projectId: project.metadata.projectId, locale: "zh-CN", evidence,
    sourceContext: { ...defaultAiConfig.sourceContext, extracted: true }, reason: "Synthetic context candidate", exceptions: "Synthetic evaluation only", digest: "a".repeat(64) };
  const item: AiItem = { unitId: evidence.basis.unitId, sourceRevisionId: evidence.basis.sourceRevisionId, sourceSnapshotId: evidence.basis.sourceSnapshotId, nativeKey: "calibration",
    sourceLocale: "en", targetLocale: "zh-CN", sourceText: evidence.sourceText, terms: [], context: null, sourceContext: { kind: "not-selected" }, projectContext: { kind: "not-selected" }, omissions: [], resourceBaseline: "0" };
  const holdout = fixtureIdentity(2601), suiteId = fixtureIdentity(2602), evaluationId = fixtureIdentity(2603), attemptId = fixtureIdentity(2604);
  const config = { ...defaultArenaConfig(), blind: true, variants: [defaultAiConfig, { ...defaultAiConfig, sourceContext: candidate.sourceContext }] };
  const suite: StrategySuite = { suiteId, candidateId: candidate.candidateId, projectId: project.metadata.projectId, locale: "zh-CN", digest: "b".repeat(64),
    request: { actionId: suiteId, projectId: project.metadata.projectId, candidateId: candidate.candidateId, config: defaultAiConfig, calibrationUnitIds: [item.unitId], holdoutUnitIds: [holdout] },
    units: [item.unitId, holdout].map(unitId => ({ unitId, holdout: unitId === holdout, sourceRevisionId: item.sourceRevisionId, reviewBasis: run.basisEvidence,
      terms: { unitId, locale: "zh-CN", sourceRevisionId: item.sourceRevisionId, entries: [] }, sourceBinding: run.evidence!.sourceBinding })),
    preview: { config, digest: "c".repeat(64), items: [item.unitId, holdout].flatMap((unitId, sourceOrder) => [0, 1].map(slot => ({ slot, sourceOrder, item: { ...item, unitId } }))) } };
  const arena = arenaViewFixture(item, config);
  const original = structuredClone(arena);
  arena.detail.attemptId = attemptId;
  arena.detail.recovery.attemptId = attemptId;
  arena.rows = [item.unitId, holdout].flatMap((unitId, sourceOrder) => original.rows.map((row, slot) => ({ ...row, itemId: fixtureIdentity(2620 + sourceOrder * 2 + slot),
    resultId: fixtureIdentity(2630 + sourceOrder * 2 + slot), sourceOrder, label: 1 - slot, item: { ...row.item, unitId },
    output: row.output ? { ...row.output, unitId } : null })));
  arena.detail.items = arena.rows.map((row, index) => ({ ...original.detail.items[index % 2], resultId: row.resultId,
    scope: { ...original.detail.items[index % 2].scope, id: row.item.unitId }, status: { ...original.detail.items[index % 2].status, itemId: row.itemId, adoption: "committed" } }));
  arena.detail.recovery.units = arena.rows.map((row, index) => ({ ...original.detail.recovery.units[index % 2], unitId: fixtureIdentity(2640 + index),
    itemIds: [row.itemId], remainingItemIds: [], resultIds: row.resultId ? [row.resultId] : [], scopes: [{ kind: "translation-unit", id: row.item.unitId, locale: row.item.targetLocale }] }));
  arena.detail.progress = { ...arena.detail.progress, total: 4, succeeded: 4 };
  if (!arena.rows[0].output) throw new Error("Original candidate output required"); arena.rows[0].output.text = "Original baseline output";
  const first = arena.rows[0]; if (!first.resultId) throw new Error("Original result identity required");
  const view: StrategyEvaluationView = { evaluation: { evaluationId, projectId: project.metadata.projectId, locale: "zh-CN", candidateId: candidate.candidateId, suiteId, attemptId, inputDigest: "d".repeat(64),
    request: { actionId: evaluationId, projectId: project.metadata.projectId, candidateId: candidate.candidateId, suiteId } }, candidate, suite, judgments: [], current: true,
    slots: arena.rows.map((row, index) => ({ itemId: row.itemId, unitId: row.item.unitId, slot: index % 2, resultId: row.resultId })),
    checks: [{ request: { actionId: fixtureIdentity(2610), projectId: project.metadata.projectId, evaluationId, itemId: first.itemId, resultId: first.resultId }, revisionId: fixtureIdentity(2611),
      basis: run.basisEvidence, rules: run.rules.map(rule => ({ ...rule, status: outcome, findings: [] })), evidence: { ...run.evidence, results: run.evidence.results.map(result => ({ ...result, coveredTargets: [], outcome: { kind: outcome } })) } }] };
  const prepared = vi.spyOn(strategyCommands, "prepareCheck").mockImplementation(async request => ({ kind: "plugin", view: { ...preparation.view, actionId: request.check.actionId, unitId: item.unitId, locale: "zh-CN" } }));
  function Results() {
    const owner = useStrategyDraftSession(), reads = useSessionReads();
    const query = useSessionQuery({ key: strategyKeys.evaluation(evaluationId), scopes: ["arena"], enabled: true, read: async () => view });
    useEffect(() => { owner.selectEvaluation(evaluationId); }, [reads]);
    return <StrategyEvaluationResults view={query.data ?? view} arena={arena} disabled={false} />;
  }
  const user = userEvent.setup(); render(<StrategyDraftSession project={project}><Results /></StrategyDraftSession>, project);
  const article = screen.getByText("Original baseline output").closest("article"); if (!article) throw new Error("Original result article required");
  expect(within(article).getByRole("heading", { name: enUS.strategy.baseline })).toBeVisible();
  const retry = within(article).getByRole("button", { name: enUS.strategy.prepareCheck }); await waitFor(() => expect(retry).toBeEnabled());
  expect(within(article).getByText(enUS.strategy.qaFailed)).toBeVisible(); await user.click(retry);
  await waitFor(() => expect(prepared).toHaveBeenCalledOnce());
  expect(prepared.mock.calls[0][0].check).toMatchObject({ evaluationId, itemId: first.itemId, resultId: first.resultId });
  expect(screen.getByRole("button", { name: enUS.strategy.runCheck })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "start_strategy_evaluation" || command === "start_arena_translation")).toBe(false);
});


it.each(["ai", "arena"] as const)("registers separate strategy recovery actions for the %s surface with hidden and busy gates", async area => {
  const user = await fill(area);
  let resolve!: (value: null) => void;
  const pending = new Promise<null>(done => { resolve = done; });
  vi.mocked(strategyCommands.capture).mockRejectedValueOnce(new Error("Lost original ACK"));
  const read = vi.spyOn(strategyCommands, "action").mockReturnValueOnce(pending);
  await user.click(screen.getByRole("button", { name: enUS.strategy.create }));
  await screen.findByText(enUS.strategy.checkingSaved);
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area };
  expect(commands.list(scope).find(value => value.id === "strategy.check-pending")).toMatchObject({ risk: "reads-strategy", availability: { enabled: false, reason: "busy" } });
  expect(commands.dispatch("strategy.check-pending", scope)).toBe(false); expect(commands.dispatch("strategy.retry-pending", scope)).toBe(false);
  await act(async () => { resolve(null); }); await screen.findByRole("button", { name: enUS.strategy.retryOriginal });
  await waitFor(() => expect(commands.list(scope).find(value => value.id === "strategy.retry-pending")?.availability.enabled).toBe(true));
  await user.click(screen.getByText(enUS.strategy.title));
  await waitFor(() => expect(commands.list(scope).find(value => value.id === "strategy.check-pending")?.availability).toEqual({ enabled: false, reason: "hidden" }));
  expect(commands.dispatch("strategy.check-pending", scope)).toBe(false); expect(commands.dispatch("strategy.retry-pending", scope)).toBe(false);
  expect(read).toHaveBeenCalledOnce(); expect(strategyCommands.capture).toHaveBeenCalledOnce();
});

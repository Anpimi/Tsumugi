import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiSemanticReview } from "./AiSemanticReview";
import { aiSemanticReviewCommands, type AiSemanticReviewPrepared } from "./aiSemanticReviewCommands";
import { useReviewDraftSession } from "./ReviewDraftSession";
import type { ProjectView } from "./projectCommands";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { semanticConfig, semanticPreparedFixture, semanticTargetFixture, semanticViewFixture } from "./testSupport/aiSemanticReviewFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewSummaryFor } from "./testSupport/reviewFixture";
import { i18n } from "./i18n";
import { connectionFixture } from "./testSupport/connectionFixture";
import { executionCommands, type PrepareRequest, type Receipt } from "./executionCommands";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import execution from "../test/fixtures/executionCommands.contract.json";
import { ReviewFindings } from "./ReviewFindings";
import { reviewCommands } from "./reviewCommands";
import { semanticDiagnosticFixture } from "./testSupport/semanticDiagnosticFixture";
import { useSessionReads } from "./SessionReadProvider";
import { semanticReviewKey } from "./aiSemanticReviewQueries";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "semantic-review-session", locator: "/synthetic/semantic", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(2400), displayName: "Synthetic semantic review", sourceLocale: "en", targetLocales: ["zh-CN", "ja"], metadataRevision: "1" } };
let review!: ReturnType<typeof useReviewDraftSession>;
let tasks!: ReturnType<typeof useExecutionTaskSession>;
let reads!: ReturnType<typeof useSessionReads>;
let target = semanticTargetFixture();
function Probe() { const owner = useReviewDraftSession(), taskOwner = useExecutionTaskSession(), readOwner = useSessionReads(); useLayoutEffect(() => { review = owner; tasks = taskOwner; reads = readOwner; }); return null; }
function Harness() { return <><Probe /><AiSemanticReview project={project} active disabled={false} currentTarget={() => target} /></>; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(expanded = true) {
  render(<Harness />, project);
  act(() => { review.setSelected(target); review.semantic.setConfig({ ...semanticConfig }); review.semantic.setExpanded(expanded); });
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); target = semanticTargetFixture(); invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_model_connections") return connectionFixture([]);
    throw new Error(command);
  });
  vi.spyOn(aiSemanticReviewCommands, "prepare").mockImplementation(async request => {
    const prepared = semanticPreparedFixture(target, request.config);
    return { ...prepared, preview: { ...prepared.preview, rules: request.rules, items: request.targets.map(pair => semanticPreparedFixture({ ...target, unitId: pair.unitId, locale: pair.locale }, request.config).preview.items[0]) } };
  });
  vi.spyOn(aiSemanticReviewCommands, "start").mockImplementation(async request => request.attemptId);
  vi.spyOn(aiSemanticReviewCommands, "read").mockImplementation(async request => ({ attemptId: request.attemptId, view: semanticViewFixture() }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps the discoverable review entry collapsed without preparing or starting a model", async () => {
  await setup(false);
  expect(screen.getByRole("button", { name: "AI meaning and style review" })).toHaveAttribute("aria-expanded", "false");
  expect(aiSemanticReviewCommands.prepare).not.toHaveBeenCalled(); expect(aiSemanticReviewCommands.start).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Send this exact review" })).toBeNull();
});

it("keeps a shared current findings witness fresh when the known-attempt model panel is collapsed", async () => {
  const value = semanticDiagnosticFixture(), locate = vi.fn(async () => true); target = value.target;
  vi.spyOn(reviewCommands, "findings").mockResolvedValue(value.findings);
  vi.mocked(aiSemanticReviewCommands.prepare).mockResolvedValue({ attemptId: value.view.detail.attemptId, preview: value.view.preview });
  vi.mocked(aiSemanticReviewCommands.read).mockResolvedValue({ attemptId: value.view.detail.attemptId, view: value.view });
  render(<><Harness /><ReviewFindings project={project} target={target} active available={() => ({ enabled: true })} currentTarget={() => target}
    freshReadProof={() => () => true} onOpenTranslation={() => true} onLocateDiagnostic={locate} /></>, project);
  act(() => { review.setSelected(target); review.semantic.setConfig(semanticConfig); review.semantic.setExpanded(true); });
  await act(async () => { await review.semantic.prepare(); }); act(() => review.semantic.setConsent(true));
  await act(async () => { await review.semantic.start(); });
  const button = await within(screen.getByRole("region", { name: "Advisory findings" })).findByRole("button", { name: "Locate in translation" });
  await waitFor(() => expect(reads.client.getQueryState(reads.key(semanticReviewKey(value.view.detail.attemptId)))?.fetchStatus).toBe("idle"));
  const submitted = vi.mocked(aiSemanticReviewCommands.start).mock.calls.length, user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "AI meaning and style review" }));
  expect(reads.client.getQueryState(reads.key(semanticReviewKey(value.view.detail.attemptId)))?.isInvalidated).toBe(false);
  await user.click(button); expect(locate).toHaveBeenCalledWith(target, expect.objectContaining({ runId: value.run.runId, source: value.source }), 0);
  expect(aiSemanticReviewCommands.start).toHaveBeenCalledTimes(submitted);
});

it("shows the selected saved translation and requires independent fresh consent", async () => {
  await setup(); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Preview this review" }));
  const preview = within(await screen.findByRole("region", { name: "Exact model review preview" }));
  expect(preview.getByText(target.translationText!)).toBeVisible();
  expect(preview.getByRole("button", { name: "Send this exact review" })).toBeDisabled();
  await user.click(preview.getByRole("checkbox"));
  await user.click(preview.getByRole("button", { name: "Send this exact review" }));
  await waitFor(() => expect(aiSemanticReviewCommands.start).toHaveBeenCalledOnce());
  expect(aiSemanticReviewCommands.start).toHaveBeenCalledWith(expect.objectContaining({ attemptId: fixtureIdentity(2401), digest: "e".repeat(64), confirmed: true }));
  expect((await screen.findAllByText("The model reported no findings for this rule. This is advisory and does not establish approval or mechanical QA success.", { exact: true })).length).toBe(2);
});

it("retains config B when preview A returns and never restores A's consent", async () => {
  const pending = deferred<AiSemanticReviewPrepared>(); vi.mocked(aiSemanticReviewCommands.prepare).mockReturnValueOnce(pending.promise);
  await setup(); let work!: Promise<void>;
  act(() => { work = review.semantic.prepare(); });
  act(() => review.semantic.setConfig(value => ({ ...value, model: "newer-model-B", maxItems: 7 })));
  await act(async () => { pending.resolve(semanticPreparedFixture()); await work; });
  expect(review.semantic.current().config).toMatchObject({ model: "newer-model-B", maxItems: 7 });
  expect(review.semantic.current().prepared).toBeNull(); expect(review.semantic.current().consent).toBe(false);
  expect(aiSemanticReviewCommands.start).not.toHaveBeenCalled();
});

it("freezes an explicit cross-language pair batch and invalidates consent when the range changes", async () => {
  await setup();
  const japanese = semanticTargetFixture({ locale: "ja", translationText: "こんにちは" });
  act(() => { review.toggleChosen(reviewSummaryFor(target), true); review.toggleChosen(reviewSummaryFor(japanese), true); review.semantic.setMode("chosen"); });
  await act(async () => { await review.semantic.prepare(); });
  expect(aiSemanticReviewCommands.prepare).toHaveBeenCalledWith(expect.objectContaining({ targets: [{ unitId: target.unitId, locale: "zh-CN" }, { unitId: target.unitId, locale: "ja" }] }));
  act(() => review.semantic.setConsent(true)); expect(review.semantic.current().consent).toBe(true);
  act(() => review.toggleChosen(reviewSummaryFor(japanese), false));
  expect(review.semantic.current().consent).toBe(false); expect(review.semantic.current().prepared).toBeNull();
});

it("keeps the same unknown start through failed reads and only retries after an observed absence", async () => {
  vi.mocked(aiSemanticReviewCommands.start).mockRejectedValueOnce(new Error("Lost original ACK"));
  vi.mocked(aiSemanticReviewCommands.read).mockRejectedValueOnce(new Error("Read unavailable"));
  await setup();
  await act(async () => { await review.semantic.prepare(); }); act(() => review.semantic.setConsent(true));
  await act(async () => { await review.semantic.start(); });
  const request = review.semantic.current().pending!.request;
  await act(async () => { await review.semantic.check(); await review.semantic.retry(); });
  expect(review.semantic.current().pending?.request).toBe(request); expect(review.semantic.current().pending?.absent).toBe(false);
  expect(aiSemanticReviewCommands.start).toHaveBeenCalledOnce();
  vi.mocked(aiSemanticReviewCommands.read).mockResolvedValueOnce({ attemptId: request.attemptId, view: null });
  await act(async () => { await review.semantic.check(); await review.semantic.retry(); });
  expect(aiSemanticReviewCommands.start).toHaveBeenCalledTimes(2); expect(vi.mocked(aiSemanticReviewCommands.start).mock.calls[1][0]).toBe(request);
  expect(review.semantic.current().pending).toBeNull();
});

it("reconciles the original accepted attempt without overwriting newer config or sending a replacement", async () => {
  vi.mocked(aiSemanticReviewCommands.start).mockRejectedValueOnce(new Error("Lost original ACK"));
  await setup(); await act(async () => { await review.semantic.prepare(); }); act(() => review.semantic.setConsent(true));
  await act(async () => { await review.semantic.start(); });
  act(() => review.semantic.setConfig(value => ({ ...value, model: "retained-model-B" })));
  await act(async () => { await review.semantic.check(); });
  expect(review.semantic.current().pending).toBeNull(); expect(review.semantic.current().attemptId).toBe(fixtureIdentity(2401));
  expect(review.semantic.current().config.model).toBe("retained-model-B"); expect(aiSemanticReviewCommands.start).toHaveBeenCalledOnce();
});

it("invalidates authorization on saved input changes and retains old results as advice", async () => {
  await setup(); await act(async () => { await review.semantic.prepare(); }); act(() => review.semantic.setConsent(true));
  await refreshWorkbenchReads(["translation"]);
  expect(review.semantic.current().prepared).toBeNull(); expect(review.semantic.current().consent).toBe(false);
  await act(async () => { await review.semantic.start(); }); expect(aiSemanticReviewCommands.start).not.toHaveBeenCalled();
});

it("records exactly one authoritative recovery unit through the original Task owner and reconciles a lost receipt", async () => {
  const view = semanticViewFixture();
  vi.mocked(aiSemanticReviewCommands.read).mockResolvedValue({ attemptId: view.detail.attemptId, view });
  vi.spyOn(executionCommands, "identity").mockResolvedValue(fixtureIdentity(2480));
  let captured!: PrepareRequest;
  const prepare = vi.spyOn(executionCommands, "prepare").mockImplementation(async request => {
    captured = request;
    return { ...execution.action, projectId: request.projectId, actionId: request.actionId, attemptId: request.attemptId,
      unitId: request.unitId, operation: "ai-semantic-review", resultIds: request.resultIds, parameters: null };
  });
  const adopt = vi.spyOn(executionCommands, "adopt").mockRejectedValueOnce(new Error("Lost recording ACK"));
  const receipt = vi.spyOn(executionCommands, "receipt").mockImplementation(async () => ({ ...execution.receipt,
    projectId: captured.projectId, actionId: captured.actionId, attemptId: captured.attemptId, unitId: captured.unitId,
    changes: [{ kind: "ai-semantic-review", id: target.unitId, revision: "1" }] } satisfies Receipt));
  await setup(); await act(async () => { await review.semantic.prepare(); }); act(() => review.semantic.setConsent(true));
  await act(async () => { await review.semantic.start(); }); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Review recording these advisory findings" }));
  await user.click(await screen.findByRole("button", { name: "Record these advisory findings" }));
  await waitFor(() => expect(tasks.currentActivity()?.phase).toBe("unknown"));
  expect(captured).toMatchObject({ attemptId: view.detail.attemptId, unitId: view.detail.recovery.units[0].unitId, resultIds: [view.detail.items[0].resultId] });
  act(() => review.editReason(target, "Newer reason B"));
  await user.click(screen.getByRole("button", { name: "Check original recording receipt" }));
  await waitFor(() => expect(tasks.currentActivity()?.phase).toBe("recorded"));
  expect(prepare).toHaveBeenCalledOnce(); expect(adopt).toHaveBeenCalledOnce(); expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ actionId: captured.actionId }));
  expect(review.current().drafts[`${target.locale}:${target.unitId}`]).toBe("Newer reason B");
});

it("cancels only the original review Task while keeping its result and current input", async () => {
  const view = semanticViewFixture();
  view.detail.progress = { ...view.detail.progress, succeeded: 0, running: 1 };
  view.detail.items[0] = { ...view.detail.items[0], resultId: null, status: { ...view.detail.items[0].status, execution: "dispatched", validation: "absent" } };
  view.detail.recovery.units[0] = { ...view.detail.recovery.units[0], resultIds: [], actions: [], remainingItemIds: [view.rows[0].itemId] };
  view.rows[0] = { ...view.rows[0], output: null };
  vi.mocked(aiSemanticReviewCommands.read).mockResolvedValue({ attemptId: view.detail.attemptId, view });
  vi.spyOn(executionCommands, "identity").mockResolvedValue(fixtureIdentity(2481));
  const cancel = vi.spyOn(executionCommands, "cancel").mockResolvedValue("1");
  await setup(); await act(async () => { await review.semantic.prepare(); }); act(() => review.semantic.setConsent(true));
  await act(async () => { await review.semantic.start(); });
  act(() => review.semantic.setConfig(value => ({ ...value, model: "Next review B" })));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Stop this review task" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ taskId: view.detail.taskId, projectId: project.metadata.projectId }));
  expect(tasks.current(view.detail.taskId)?.target.attemptId).toBe(view.detail.attemptId);
  expect(review.semantic.current().attemptId).toBe(view.detail.attemptId); expect(review.semantic.current().config.model).toBe("Next review B");
});

it("does not let a departed session apply a late preview to the replacement session", async () => {
  const pending = deferred<AiSemanticReviewPrepared>(); vi.mocked(aiSemanticReviewCommands.prepare).mockReturnValueOnce(pending.promise);
  const ui = render(<Harness />, project); act(() => { review.setSelected(target); review.semantic.setConfig(semanticConfig); });
  let work!: Promise<void>; act(() => { work = review.semantic.prepare(); });
  const replacement = { ...project, sessionToken: "replacement-semantic-session" };
  ui.rerender(<Probe />, replacement);
  await act(async () => { pending.resolve(semanticPreparedFixture()); await work; });
  expect(review.semantic.current().prepared).toBeNull(); expect(review.semantic.current().pending).toBeNull();
});

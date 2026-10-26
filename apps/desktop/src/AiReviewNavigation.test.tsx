import { createRef, useLayoutEffect, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSessionWorkbench, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import * as reviewOwner from "./ReviewDraftSession";
import * as aiOwner from "./AiPreparationSession";
import * as session from "./SessionReadProvider";
import type { ProjectView } from "./projectCommands";
import type { AiView } from "./aiCommands";
import type { ReviewTarget } from "./reviewCommands";
import type { WorkPlanStatusView } from "./workPlanCommands";
import { aiWorkPlanFixture } from "./testSupport/aiFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { formatReviewSlotFixture } from "./testSupport/textReviewFixture";
import { connectionFixture } from "./testSupport/connectionFixture";
import { reviewTargetFixture, reviewSummaryFor, reviewSummaryPageFixture, reviewFindingViewFixture } from "./testSupport/reviewFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import aiWire from "../test/fixtures/aiCommands.contract.json";
import reviewWire from "../test/fixtures/reviewCommands.contract.json";
import * as aiValidation from "./generated/ai.validators";
import * as reviewValidation from "./generated/review.validators";
import * as sourceValidation from "./generated/source.validators";
import * as executionValidation from "./generated/execution.validators";
import { validateResponseChanges } from "./generated/validators";
import { validateResponseSnapshot as validateConnections } from "./generated/connections.validators";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const project: ProjectView = { sessionToken: "current-review-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: aiWire.requests.automaticRead.projectId, displayName: "Current review", sourceLocale: "en", targetLocales: ["zh-CN", "ja-JP"], metadataRevision: "1" } };
const actualReview = reviewOwner.useReviewDraftSession, actualAi = aiOwner.useAiPreparation, actualReads = session.useSessionReads;
let review: ReturnType<typeof actualReview>, ai: ReturnType<typeof actualAi>, reads: ReturnType<typeof actualReads>;
let view: AiView, target: ReviewTarget, status: WorkPlanStatusView, memory: WorkspaceViewMemory, area: WorkspaceArea;
let failures: string[], failRead: boolean, holdRead: Promise<ReviewTarget> | null, holdWrite: Promise<void> | null, serial: number;
const handle = createRef<ProjectSessionHandle>();
const validators: Record<string, (value: unknown) => boolean> = {
  read_project_changes: validateResponseChanges,
  read_content_scope: sourceValidation.validateResponseScope, read_source_content: sourceValidation.validateResponsePage,
  read_execution_task_activity: executionValidation.validateResponseActivity,
  read_ai_translation: aiValidation.validateResponseView, read_work_plan_status: aiValidation.validateResponseWorkPlanStatus,
  read_work_plan_team_history: aiValidation.validateResponseWorkPlanTeamHistory,
  read_review_target: reviewValidation.validateResponseTarget, read_review_history: reviewValidation.validateResponseHistory,
  read_review_decision_action: reviewValidation.validateResponseDecisionAction,
  read_review_summary_page: reviewValidation.validateResponseSummary, read_review_findings: reviewValidation.validateResponseFindings,
  prepare_review_checks: reviewValidation.validateResponsePrepareCheck,
  create_execution_identity: executionValidation.validateResponseIdentity,
  read_model_connections: validateConnections,
};
function Harness({ value = project }: { value?: ProjectView }) {
  const [current, setArea] = useState<WorkspaceArea>("overview");
  const [retained] = useState(() => { const value = new WorkspaceViewMemory(); value.write("translation", "tab", "edit"); return value; }), [commands] = useState(() => new WorkbenchCommands());
  useLayoutEffect(() => { memory = retained; area = current; });
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}><WorkspaceViewProvider value={{ area: current, memory: retained,
    activate: setArea, deactivate: closing => setArea(before => before === closing ? "overview" : before) }}>
    <ProjectSessionWorkbench ref={handle} project={value} disabled={false} onActivate={setArea} onCoordinatingChange={() => {}} />
  </WorkspaceViewProvider></WorkbenchCommandsProvider></ApplicationReadProvider>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function origin() { return { attemptId: view.detail.attemptId, taskId: view.detail.taskId, itemId: view.rows[0].itemId, editSeq: ai.current().editSeq }; }
function destination() { const item = view.rows[0].item; return { kind: "review-target" as const,
  target: { unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: item.nativeKey, sourceText: item.sourceText }, locale: item.targetLocale, origin: origin() }; }
async function openAi() {
  const rendered = render(<Harness />);
  await act(async () => { expect(await handle.current!.navigate({ kind: "attempt", area: "ai", attemptId: view.detail.attemptId })).toBe(true); });
  await screen.findByRole("button", { name: "Review active translation" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Review active translation" })).toBeEnabled());
  return rendered;
}
function noHandoffWrites(before = 0) {
  const commands = invoke.mock.calls.slice(before).map(([name]) => name);
  expect(commands.filter(name => !name.startsWith("read_") && !name.startsWith("list_"))).toEqual([]);
  expect(failures).toEqual([]);
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); vi.restoreAllMocks();
  // Observe the actual production hooks; no owner or provider is substituted.
  vi.spyOn(reviewOwner, "useReviewDraftSession").mockImplementation(() => { const value = actualReview(); review = value; return value; });
  vi.spyOn(aiOwner, "useAiPreparation").mockImplementation(() => { const value = actualAi(); ai = value; return value; });
  vi.spyOn(session, "useSessionReads").mockImplementation(() => { const value = actualReads(); reads = value; return value; });
  const candidate: unknown = structuredClone(aiWire.responses.automaticView);
  if (!aiValidation.validateResponseView(candidate)) throw new Error("Invalid canonical candidate fixture");
  view = candidate;
  const effect = view.rows[0].automation, receipt = effect?.receipt;
  if (!effect || !receipt || !view.planId || !view.planGeneration) throw new Error("Recorded candidate evidence required");
  effect.phase = "checked"; receipt.policy = "candidates-only"; receipt.policyVersion = "checked-selection-3";
  receipt.selection = null; receipt.checkRunId = null; receipt.blocked = null; receipt.candidateBasis.selectionId = null;
  const item = view.rows[0].item;
  target = reviewTargetFixture({ unitId: item.unitId, locale: item.targetLocale, sourceSnapshotId: item.sourceSnapshotId,
    sourceRevisionId: item.sourceRevisionId, nativeKey: item.nativeKey, sourceText: item.sourceText,
    revisionId: fixtureIdentity(1801), selectionId: fixtureIdentity(1802), translationText: "Current human translation", basis: "current-review-basis" });
  const plan = aiWorkPlanFixture({ attemptId: view.detail.attemptId, preview: { config: view.config, recipe: view.recipe,
    digest: "captured-review-plan", items: view.rows.map(row => row.item) } }, structuredClone(aiOwner.defaultPlanOptions));
  const slot = formatReviewSlotFixture(); plan.planId = view.planId; plan.checkers = [{ kind: "ready", checker: slot.checker, plugin: slot.plugin }];
  status = { plan, lease: { planId: view.planId, generation: view.planGeneration }, state: "paused", effects: ["save-candidate", "run-checks"],
    expiresAt: "9007199254740994", toolInvocations: null };
  failures = []; failRead = false; holdRead = null; holdWrite = null; serial = 1810;
  invoke.mockReset().mockImplementation(async (command: string, { request }: { request: Record<string, unknown> }) => {
    if (command === "read_context_strategy_default") return null;
    let result: unknown;
    if (command === "read_project_changes") result = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, epoch: fixtureIdentity(1800), sequence: "0", progressSequence: "0", scopes: [], runtime: { active: false, quiescing: false, queryCount: 0, error: null } };
    else if (command === "read_execution_task_activity") result = { total: "0", active: "0", attention: "0", saved: "0", rows: [] };
    else if (command === "read_content_scope") result = { revision: "1", currentSnapshot: target.sourceSnapshotId };
    else if (command === "read_source_content") result = sourcePageFixture({ snapshotId: target.sourceSnapshotId, scope: { revision: "1", currentSnapshot: target.sourceSnapshotId },
      rows: [sourceRowFixture({ unitId: target.unitId, sourceRevisionId: target.sourceRevisionId }, { key: target.nativeKey, text: target.sourceText })] });
    else if (command === "read_ai_translation") result = structuredClone(view);
    else if (command === "read_work_plan_status") result = structuredClone(status);
    else if (command === "read_work_plan_team_history") result = { planId: request.planId, members: [], authorRoles: [], posts: [], nextAfter: null };
    else if (command === "read_model_connections") result = connectionFixture([]);
    else if (command === "read_plugin_text_reviews") result = { settingsRevision: "1", entries: [] };
    else if (command === "read_review_target") {
      expect(request).toMatchObject({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, unitId: target.unitId, locale: target.locale });
      if (failRead) throw new Error("Synthetic current target read failed");
      result = holdRead ? await holdRead : structuredClone(target);
    }
    else if (command === "read_review_summary_page") result = reviewSummaryPageFixture([reviewSummaryFor(target)]);
    else if (command === "read_review_history") result = { decisions: [], checks: [], waivers: [], fallbacks: [], nextOffset: null };
    else if (command === "read_review_findings") result = reviewFindingViewFixture(target);
    else if (command === "create_execution_identity") result = fixtureIdentity(serial++);
    else if (command === "prepare_review_checks") result = { kind: "plugin", view: { ...reviewWire.responses.prepareCheck.view,
      actionId: request.actionId, unitId: request.unitId, locale: request.locale, basis: request.expectedBasis } };
    else if (command === "read_review_decision_action") result = null;
    else if (command === "write_review_decision") { if (holdWrite) await holdWrite; throw new Error("Synthetic lost original review acknowledgement"); }
    else { failures.push(command); throw new Error(`Unexpected current review command: ${command}`); }
    const check = validators[command];
    if (check && !check(result)) { failures.push(command); throw new Error(`Invalid current review fixture: ${command}`); }
    return result;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["zh-CN", "ja-JP"])("opens the exact %s current selection rather than the Checked AI candidate, and returns with AI B and position retained", async locale => {
  if (locale !== target.locale) {
    target = reviewTargetFixture({ ...target, basisEvidence: undefined, locale });
    view.rows[0].item.targetLocale = locale; view.rows[0].output!.targetLocale = locale;
    view.rows[0].automation!.receipt!.request.locale = locale;
    view.detail.items.forEach(item => { item.scope.locale = locale; });
    view.detail.recovery.units.forEach(unit => unit.scopes.forEach(scope => { scope.locale = locale; }));
    status.plan.locale = locale; status.plan.preview!.items[0].targetLocale = locale;
  }
  const user = userEvent.setup(); await openAi();
  const earlierQueue = { ...reads.context, locale, unitId: target.unitId, tab: "work", summaryScope: null, pageAfter: 0, workOffset: 50 };
  memory.write("review", "editorOrigin", earlierQueue); memory.write("review", "editorReturned", earlierQueue);
  act(() => ai.setConfig(before => ({ ...before, model: "AI newer B" })));
  const before = ai.current(), cursor = memory.read("ai", "after");
  expect(target.revisionId).not.toBe(view.rows[0].savedRevisionId);
  await user.click(screen.getByRole("button", { name: "Review active translation" }));
  await screen.findByText("Current human translation", { exact: false });
  expect(area).toBe("review"); expect(review.current().selected?.revisionId).toBe(target.revisionId);
  expect(memory.read("review", "editorOrigin")).toBeNull(); expect(memory.read("review", "editorReturned")).toBeNull();
  expect(review.current().selected?.currentCheck).toBeNull(); expect(review.current().selected?.currentDecision).toBeNull();
  expect(screen.getByText(/Unselected AI candidates and their check results/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Return to AI workspace" }));
  await screen.findByRole("button", { name: "Review active translation" });
  expect(area).toBe("ai"); expect(ai.current().config).toEqual(before.config); expect(ai.current().dirty).toBe(true);
  expect(ai.current().attempt).toBe(before.attempt); expect(memory.read("ai", "after")).toBe(cursor);
  noHandoffWrites();
});

it.each(["no-selection", "source", "foreign-unit"] as const)("keeps AI work and offers current content when the fresh target has %s", async kind => {
  const user = userEvent.setup(); await openAi();
  if (kind === "no-selection") target = reviewTargetFixture({ ...target, basisEvidence: undefined, selectionId: null, revisionId: null, translationText: null });
  if (kind === "source") target = reviewTargetFixture({ ...target, basisEvidence: undefined, sourceRevisionId: fixtureIdentity(1820) });
  const original = invoke.getMockImplementation()!;
  if (kind === "foreign-unit") invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_review_target"
    ? Promise.resolve({ ...target, unitId: fixtureIdentity(1821) }) : original(command, args));
  const before = review.current();
  await user.click(screen.getByRole("button", { name: "Review active translation" }));
  await screen.findByRole("button", { name: "Open Translations" });
  expect(area).toBe("ai"); expect(review.current()).toBe(before);
  expect(screen.getByRole("button", { name: i18n.t("ai.openEditor") })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Review active translation" })).toBeEnabled();
  if (kind === "source") {
    await user.click(screen.getByRole("button", { name: "Open Translations" }));
    await waitFor(() => expect(area).toBe("translation"));
    expect(await screen.findByRole("button", { name: target.nativeKey })).toBeVisible();
  }
  if (kind === "no-selection") {
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(await screen.findByText(/此条目尚未采用任何译文/)).toBeVisible();
    expect(screen.getByRole("button", { name: "打开“译文”工作区" })).toBeEnabled();
  }
  noHandoffWrites();
});

it("rejects a substituted original AI row before reading or rebinding a Review target", async () => {
  await openAi(); const before = review.current(), request = destination();
  request.origin.taskId = fixtureIdentity(1823);
  await act(async () => { expect(await handle.current!.navigate(request)).toBe(false); });
  expect(calls("read_review_target")).toHaveLength(0);
  expect(area).toBe("ai"); expect(review.current()).toBe(before); noHandoffWrites();
});

it("accepts freshly reread equal source and target data through their structurally shared cache identities", async () => {
  const user = userEvent.setup(); await openAi();
  const key = reads.key(["review-target", target.unitId, target.locale]), capturedTarget = structuredClone(target);
  act(() => { reads.client.setQueryData(key, capturedTarget); });
  const sourceKey = reads.key(["source-scope"]), capturedSource = reads.client.getQueryData(sourceKey);
  expect(capturedSource).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Review active translation" }));
  await screen.findByText("Current human translation", { exact: false });
  expect(area).toBe("review"); expect(calls("read_review_target").length).toBeGreaterThan(0);
  expect(reads.client.getQueryData(key)).toBe(capturedTarget);
  expect(reads.client.getQueryData(sourceKey)).toBe(capturedSource);
  expect(review.current().selected).toBe(capturedTarget); noHandoffWrites();
});

it("retries only the fresh current read after failure without clearing AI or Review drafts", async () => {
  const user = userEvent.setup(); await openAi();
  act(() => { ai.setConfig(before => ({ ...before, model: "Kept AI B" })); review.editReason(target, "Kept review B"); });
  failRead = true;
  await user.click(screen.getByRole("button", { name: "Review active translation" }));
  expect(await screen.findByText(/Could not load review details/)).toBeVisible();
  expect(area).toBe("ai"); expect(review.current().drafts[reviewOwner.reviewDraftKey(target)]).toBe("Kept review B");
  failRead = false;
  await user.click(screen.getByRole("button", { name: "Review active translation" }));
  await screen.findByRole("textbox", { name: "Reason or evidence" });
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Kept review B");
  expect(ai.current().config.model).toBe("Kept AI B"); noHandoffWrites();
});

it("preserves old reason B, actor and chosen basis and exposes the original explicit current comparison", async () => {
  const user = userEvent.setup(); await openAi();
  const old = reviewTargetFixture({ ...target, basisEvidence: undefined, basis: "earlier-basis", revisionId: fixtureIdentity(1822), translationText: "Earlier review translation" });
  act(() => { review.setSelected(old); review.setActor("Reviewer B"); review.editReason(old, "Original reason B"); review.toggleChosen(reviewSummaryFor(old), true); });
  const before = review.current();
  await user.click(screen.getByRole("button", { name: "Review active translation" }));
  await screen.findByText("Earlier review translation", { exact: false });
  expect(review.current().selected).toBe(old); expect(review.current().projection?.basis).toBe(target.basis);
  expect(review.current().drafts).toBe(before.drafts); expect(review.current().chosen).toBe(before.chosen);
  expect(screen.getByRole("textbox", { name: "Reviewer name" })).toHaveValue("Reviewer B");
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Original reason B");
  expect(screen.getByText("Current human translation", { exact: false })).toBeVisible();
  expect(screen.getByRole("button", { name: "Use current content and keep reason" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Return to AI workspace" }));
  await screen.findByRole("button", { name: "Review active translation" });
  expect(review.current().selected).toBe(old); expect(review.current().drafts).toBe(before.drafts); expect(review.current().chosen).toBe(before.chosen);
  noHandoffWrites();
});

it.each(["unknown", "prepared-checks"] as const)("keeps original %s recovery reachable without rebinding Review", async kind => {
  const user = userEvent.setup(); await openAi();
  act(() => { review.setSelected(target); review.setActor("Reviewer"); review.editReason(target, "Original pending reason"); });
  if (kind === "unknown") await act(async () => { await review.decide("request-changes", () => true); });
  else await act(async () => { await review.prepareCheck(() => true); });
  const before = review.current();
  if (kind === "unknown") expect(before.pendingUncertain).toBe(true);
  else {
    expect(before.checkReview).not.toBeNull();
    const slot = before.checkReview!.view.checkers[0];
    act(() => review.setCheckerConsent(slot.attemptId, slot.inputDigest, true));
  }
  const original = review.current(), count = invoke.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Review active translation" }));
  await screen.findByRole("button", { name: "Open active review" });
  expect(area).toBe("ai"); expect(review.current()).toBe(original);
  await user.click(screen.getByRole("button", { name: "Open active review" }));
  await screen.findByRole("textbox", { name: "Reason or evidence" });
  expect(review.current().pending).toBe(original.pending); expect(review.current().checkReview).toBe(original.checkReview);
  expect(review.current().checkConsent).toEqual(original.checkConsent); noHandoffWrites(count);
});

it("does not rebind an in-flight original batch or consume its selected entry", async () => {
  const user = userEvent.setup(); await openAi(); const waiting = deferred<void>(); holdWrite = waiting.promise;
  act(() => { review.setSelected(target); review.setActor("Batch reviewer"); review.toggleChosen(reviewSummaryFor(target), true); });
  let batch!: Promise<void>;
  act(() => { batch = review.approveBatch(); });
  await waitFor(() => expect(calls("write_review_decision")).toHaveLength(1));
  const before = review.current(), count = invoke.mock.calls.length;
  expect(before.batchRunning).toBe(true);
  await user.click(screen.getByRole("button", { name: "Review active translation" }));
  await screen.findByRole("button", { name: "Open active review" });
  expect(area).toBe("ai"); expect(review.current().selected).toBe(before.selected); expect(review.current().chosen).toBe(before.chosen);
  expect(calls("read_review_target")).toHaveLength(0); noHandoffWrites(count);
  await act(async () => { review.stopBatch(); waiting.resolve(); await batch; });
  expect(review.current().pending?.request.actionId).toBe(calls("write_review_decision")[0][1].request.decision.actionId);
});

it.each(["review-B", "ai-B", "source", "removed-locale", "removed-query", "retired"] as const)("rejects a delayed handoff after %s without first rebinding Review", async kind => {
  const rendered = await openAi(), user = userEvent.setup(), pending = deferred<ReviewTarget>(), original = review.current();
  const captured = structuredClone(target); holdRead = pending.promise;
  await user.click(screen.getByRole("button", { name: "Review active translation" }));
  await waitFor(() => expect(calls("read_review_target")).toHaveLength(1));
  if (kind === "review-B") act(() => review.editReason(target, "Later review B"));
  if (kind === "ai-B") act(() => ai.setConfig(before => ({ ...before, model: "Later AI B" })));
  if (kind === "source") act(() => reads.invalidate(["source"]));
  if (kind === "removed-locale") rendered.rerender(<Harness value={{ ...project, metadata: { ...project.metadata, targetLocales: [], metadataRevision: "2" } }} />);
  if (kind === "removed-query") reads.client.removeQueries({ queryKey: reads.key(["aiCommands", view.detail.attemptId]), exact: true });
  if (kind === "retired") act(() => handle.current!.retire());
  await act(async () => { pending.resolve(captured); await pending.promise; });
  await waitFor(() => expect(screen.queryByText(i18n.t("workbench.openingDestination"))).not.toBeInTheDocument());
  expect(area).toBe("ai"); expect(review.current().selected).toBe(original.selected);
  if (kind === "review-B") expect(review.current().drafts[reviewOwner.reviewDraftKey(target)]).toBe("Later review B");
  if (kind === "ai-B") expect(ai.current().config.model).toBe("Later AI B");
  noHandoffWrites();
});

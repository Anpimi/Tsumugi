import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translationFixture from "../../test/fixtures/translation-commands.json";
import { draftCommands, type DraftBasis, type DraftHead, type DraftValue } from "../draftCommands";
import { executionCommands } from "../executionCommands";
import { i18n } from "../i18n";
import type { ProjectView } from "../projectCommands";
import { resourceCommands } from "../resourceCommands";
import { reviewCommands } from "../reviewCommands";
import { segmentCommands, type SegmentPage } from "../segmentCommands";
import { SessionReads } from "../sessionReads";
import { sourceCommands } from "../sourceCommands";
import { fixtureIdentity } from "../testSupport/executionFixture";
import { reviewSummaryFor, reviewTargetFixture } from "../testSupport/reviewFixture";
import { translationCommands, type CandidateDecision, type CandidateDecisionRequest, type TranslationHistory, type TranslationRevision } from "../translationCommands";
import WorkbenchApp from "./WorkbenchApp";
import { ProjectLifecycle } from "./platform/projectLifecycle";
import aiFixture from "../../test/fixtures/aiCommands.contract.json";
import { conversationCommands } from "../conversationCommands";
import { canonicalConversationDraft, conversationDraftCommands, type ConversationDraftHead } from "../conversationDraftCommands";
import { workPlanCommands } from "../workPlanCommands";
import { conversationWorkPlanFixture } from "../testSupport/conversationWorkPlanFixture";
import { validateResponseView, validateResponseWorkPlan, validateResponseWorkPlanStatus, validateResponseWorkPlanRun } from "../generated/ai.validators";
import { validateResponseRevision } from "../generated/translation.validators";
import { validateResponseConversationWritten } from "../generated/draft.validators";

const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: nativeInvoke }));
vi.mock("./platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));
const project: ProjectView = { sessionToken: "workbench-candidate-session", locator: "/synthetic/workbench-candidates", reconciliationState: "settled",
  metadata: { projectId: translationFixture.save.projectId, displayName: "Candidate workspace", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const target = reviewTargetFixture({ unitId: translationFixture.save.unitId, locale: translationFixture.save.locale,
  sourceRevisionId: translationFixture.save.sourceRevisionId, sourceSnapshotId: translationFixture.receipt.revision.sourceSnapshotId,
  nativeKey: "dialogue.candidate", sourceText: "Complete source {name}", selectionId: null, revisionId: null, translationText: null });
const key = { projectId: project.metadata.projectId, unitId: target.unitId, locale: target.locale };
const basis: DraftBasis = { sourceRevisionId: target.sourceRevisionId, selectionId: null, revisionId: null, text: null };
const candidate: TranslationRevision = { ...translationFixture.receipt.revision, ordinal: "1", originKind: "ai", text: "  AI {name}\né 👩🏽‍💻  ",
  unitId: target.unitId, locale: target.locale, sourceRevisionId: target.sourceRevisionId, sourceSnapshotId: target.sourceSnapshotId, candidateDecision: null };
const checks = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
const page: SegmentPage = { projectId: project.metadata.projectId, locale: target.locale, query: { text: "", selection: "all", status: "all" },
  scopeId: fixtureIdentity(970), sourceSnapshotId: target.sourceSnapshotId, queryFingerprint: "candidate-query", epoch: fixtureIdentity(971), sequence: "1",
  readVersion: "1", total: 1, nextCursor: null, rows: [{ content: reviewSummaryFor(target), sourceTruncated: false, translationTruncated: false,
    candidateCount: 1, aiCandidateCount: 1, protection: { unitId: target.unitId, locale: target.locale, protected: false, revision: "0" },
    qa: { current: false, outcome: null, mandatoryCoverageComplete: null, mandatory: checks, advisory: { ...checks } },
    terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
    applicability: { selectedSourceRevisionId: null, sourceBasisCurrent: null, capturedBasisCurrent: null, resourceImpact: null, resourceReviewRequired: false },
    qualification: { blockerCount: 0, exceptionCount: 0, blockers: [], exceptions: [], truncated: false } }] };
type SimpleLabel = "projectFolder" | "openProject" | "candidateReject" | "candidateTitle" | "candidateAdopt" | "dockTabs" | "editorConfirm"
  | "candidateActor" | "candidateReason" | "candidateRecord" | "candidateCheck" | "noViews" | "agent" | "detail";
const w = (name: SimpleLabel) => i18n.t(`workbenchV2.${name}`);
const copy = <T,>(value: T): T => structuredClone(value);
const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
let controller: ProjectLifecycle | undefined, disk: DraftHead, decision: CandidateDecision | null;
function historyView(): TranslationHistory {
  return { unitId: target.unitId, locale: target.locale, current: null, currentText: null, rows: [{ ...copy(candidate), candidateDecision: copy(decision) }], total: "1", nextOrdinal: null };
}
function receipt(request: CandidateDecisionRequest): CandidateDecision {
  return { request: { ...request.decision, expectedSelectionId: request.decision.expectedSelectionId ?? null,
    expectedDecisionId: request.decision.expectedDecisionId ?? null }, sourceSnapshotId: target.sourceSnapshotId };
}

beforeEach(async () => {
  nativeInvoke.mockReset();
  localStorage.clear(); history.replaceState(null, "", "/"); await i18n.changeLanguage("en-US");
  // Both the inline row and Inspector are visible in the desktop layout.
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  disk = { key, revision: "0", writerId: null, value: null }; decision = null;
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ currentSnapshot: target.sourceSnapshotId, revision: "1" });
  vi.spyOn(segmentCommands, "page").mockResolvedValue(copy(page));
  vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => ({ projectId: project.metadata.projectId, locale: request.locale,
    scopeId: page.scopeId, sourceSnapshotId: target.sourceSnapshotId, query: copy(page.query), queryFingerprint: page.queryFingerprint,
    epoch: page.epoch, sequence: "1", total: 1, firstPosition: 0, previousUnitId: null, nextUnitId: null, rows: copy(page.rows) }));
  vi.spyOn(reviewCommands, "editorSnapshot").mockImplementation(async () => ({ target: copy(target), translations: historyView(),
    terms: { unitId: target.unitId, locale: target.locale, sourceRevisionId: target.sourceRevisionId, entries: [] }, context: null, readVersion: "1" }));
  vi.spyOn(draftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(draftCommands, "read").mockImplementation(async ({ key: readKey }) => {
    expect(readKey).toEqual(key);
    return { head: copy(disk), current: { kind: "current", basis: copy(basis), nativeKey: target.nativeKey, sourceText: target.sourceText } };
  });
  vi.spyOn(draftCommands, "write").mockImplementation(async ({ write }) => {
    expect(write.key).toEqual(key); expect(write.expectedRevision).toBe(disk.revision);
    disk = { key: copy(write.key), revision: (BigInt(disk.revision) + 1n).toString(), writerId: write.writerId, value: copy(write.value) as DraftValue };
    return copy(disk);
  });
  vi.spyOn(translationCommands, "history").mockImplementation(async () => historyView());
  vi.spyOn(resourceCommands, "suggestions").mockResolvedValue([]);
  vi.spyOn(executionCommands, "identity").mockResolvedValue(fixtureIdentity(972));
  vi.spyOn(translationCommands, "save").mockRejectedValue(new Error("This test only stages a local draft"));
  vi.spyOn(translationCommands, "select").mockRejectedValue(new Error("This test does not select a formal revision"));
  vi.spyOn(translationCommands, "decideCandidate").mockImplementation(async request => receipt(request));
  vi.spyOn(translationCommands, "candidateAction").mockResolvedValue(null);
});
afterEach(() => { cleanup(); controller?.dispose(); controller = undefined; if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth); });

async function openCandidates() {
  const close = vi.fn(async () => ({ closed: true }));
  controller = new ProjectLifecycle({ open: async () => project, close, status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  const lifecycle = controller;
  render(<StrictMode><WorkbenchApp controller={lifecycle} native /></StrictMode>);
  fireEvent.change(screen.getByRole("textbox", { name: w("projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: w("openProject") }));
  const details = await screen.findByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: target.nativeKey }) }, { timeout: 5000 });
  await waitFor(() => expect(details).toBeEnabled()); fireEvent.click(details);
  const row = await screen.findByRole("listitem", { name: target.nativeKey });
  const inspect = await within(row).findByRole("button", { name: w("candidateReject") });
  await waitFor(() => expect(inspect).toBeEnabled()); fireEvent.click(inspect);
  const panel = await screen.findByRole("region", { name: w("candidateTitle") });
  await waitFor(() => expect(within(panel).getByRole("button", { name: w("candidateAdopt") })).toBeEnabled());
  return { lifecycle, close, row, panel };
}
function dockTab(name: "agent" | "detail") {
  fireEvent.mouseDown(within(screen.getByRole("tablist", { name: w("dockTabs") })).getByRole("tab", { name: w(name) }), { button: 0, ctrlKey: false });
}

async function openAssistantCandidate(width: number, ordinal: string) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  const context = { projectId: project.metadata.projectId, sessionToken: project.sessionToken }, conversationId = fixtureIdentity(68000), threadKey = { projectId: context.projectId, conversationId };
  const base = conversationWorkPlanFixture(threadKey), plan = copy(base.prepared.plan), observed: unknown = copy(aiFixture.responses.view);
  if (!validateResponseView(observed) || !plan.preview || !observed.rows[0].output || base.revision.content.kind !== "proposal") throw new Error("Complete assistant candidate fixture required");
  const view = observed, item = { ...copy(plan.preview.items[0]), unitId: target.unitId, sourceRevisionId: target.sourceRevisionId,
    sourceSnapshotId: target.sourceSnapshotId, nativeKey: target.nativeKey, sourceText: target.sourceText, context: null };
  plan.scope = [{ ...plan.scope[0], unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, sourceSnapshotId: item.sourceSnapshotId, nativeKey: item.nativeKey }];
  plan.preview.items = [item]; plan.preview.config.maxItems = 1;
  const output = view.rows[0].output; if (!output) throw new Error("Returned assistant text required");
  view.rows = [{ ...view.rows[0], item, savedRevisionId: candidate.revisionId, output: { ...output, unitId: item.unitId, text: candidate.text } }];
  view.detail.items = [{ ...view.detail.items[0], scope: { kind: "translation", id: target.unitId, locale: target.locale },
    status: { ...view.detail.items[0].status, adoption: "committed" } }];
  view.detail.progress.adopted = 1; view.detail.recovery.units = [];
  view.config = copy(plan.preview.config); view.recipe = plan.preview.recipe; view.planId = plan.planId; view.planGeneration = "1";
  const link = { ...base.prepared.proposal, planId: plan.planId, planDigest: plan.digest, actionId: fixtureIdentity(68001), ordinal: "1" };
  const start = { projectId: context.projectId, planId: plan.planId, actionId: link.actionId, expectedGeneration: "1", taskId: view.detail.taskId, attemptId: view.detail.attemptId };
  const run: unknown = { projectId: context.projectId, planId: plan.planId, planDigest: plan.digest, lease: { planId: plan.planId, generation: "1" }, state: "active", lastStart: start, budgetRootTaskId: start.taskId, budget: null };
  const status: unknown = { plan, lease: { planId: plan.planId, generation: "1" }, state: "active", effects: ["save-candidate"], expiresAt: "18446744073709551615", toolInvocations: null };
  const revision: TranslationRevision = { ...copy(candidate), ordinal, attemptId: start.attemptId, itemId: view.rows[0].itemId, resultId: view.rows[0].resultId };
  if (!validateResponseWorkPlan(plan) || !validateResponseView(view) || !validateResponseWorkPlanRun(run) || !validateResponseWorkPlanStatus(status) || !validateResponseRevision(revision)) throw new Error("Invalid assistant candidate projection");
  const revisionRead = vi.fn(async () => copy(revision));
  nativeInvoke.mockImplementation(async command => {
    if (command === "read_ai_translation") return copy(view);
    if (command === "read_translation_revision") return revisionRead();
    throw new Error(`Unexpected assistant candidate command: ${command}`);
  });
  let journal: ConversationDraftHead = { key: threadKey, revision: "1", writerId: fixtureIdentity(68002), value: { text: "Retained message draft", editSeq: "1", pending: null } };
  vi.spyOn(conversationDraftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(conversationDraftCommands, "read").mockImplementation(async () => copy(journal));
  vi.spyOn(conversationDraftCommands, "write").mockImplementation(async ({ write }) => {
    const value: unknown = { key: write.key, writerId: write.writerId, revision: String(BigInt(journal.revision) + 1n), value: canonicalConversationDraft(write.value) };
    if (!validateResponseConversationWritten(value)) throw new Error("Invalid assistant journal fixture"); journal = value; return copy(value);
  });
  vi.spyOn(conversationCommands, "list").mockResolvedValue({ projectId: context.projectId, rows: [{ ...threadKey, title: "Recorded assistant", ordinal: "1" }], nextAfter: null });
  vi.spyOn(conversationCommands, "messages").mockResolvedValue({ ...threadKey, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "planningAttempts").mockResolvedValue({ ...threadKey, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "proposalRevisions").mockResolvedValue({ ...threadKey, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "proposalWorkPlans").mockResolvedValue({ ...threadKey, rows: [link], nextAfter: null });
  vi.spyOn(conversationCommands, "readProposal").mockResolvedValue({ ...base.revision, content: { ...base.revision.content, unitIds: [target.unitId] } });
  vi.spyOn(workPlanCommands, "status").mockResolvedValue(status); vi.spyOn(workPlanCommands, "run").mockResolvedValue(run);
  vi.spyOn(executionCommands, "attempt").mockResolvedValue(view.detail);
  vi.mocked(translationCommands.history).mockImplementation(async () => ({ ...historyView(), rows: [copy(revision)], total: ordinal }));
  const close = vi.fn(async () => ({ closed: true }));
  controller = new ProjectLifecycle({ open: async () => project, close, status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  const lifecycle = controller; render(<StrictMode><WorkbenchApp controller={lifecycle} native /></StrictMode>);
  fireEvent.change(screen.getByRole("textbox", { name: w("projectFolder") }), { target: { value: project.locator } }); fireEvent.click(screen.getByRole("button", { name: w("openProject") }));
  const details = await screen.findByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: target.nativeKey }) }, { timeout: 5000 });
  await waitFor(() => expect(details).toBeEnabled());
  if (width < 700) fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openAgent") }));
  const choose = await screen.findByRole("button", { name: i18n.t("conversation.chooseThread") });
  await waitFor(() => expect(choose).toBeEnabled()); choose.focus(); fireEvent.keyDown(choose, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Recorded assistant" }));
  const composer = await screen.findByRole("textbox", { name: i18n.t("conversation.message") });
  fireEvent.click(await screen.findByRole("button", { name: i18n.t("conversation.runShow") }));
  await screen.findByRole("heading", { name: i18n.t("conversation.runStateActive") });
  expect(screen.getByRole("button", { name: i18n.t("conversation.runPause") })).toBeEnabled(); expect(screen.getByRole("button", { name: i18n.t("conversation.runStop") })).toBeEnabled();
  expect(nativeInvoke.mock.calls.some(([command]) => command === "read_ai_translation")).toBe(false);
  fireEvent.click(await screen.findByRole("button", { name: i18n.t("conversation.runResultsShow") }));
  const open = await screen.findByRole("button", { name: i18n.t("conversation.runResultsOpenCandidate") }); await waitFor(() => expect(open).toBeEnabled());
  expect(screen.getByRole("button", { name: i18n.t("conversation.runPause") })).toBeEnabled(); expect(screen.getByRole("button", { name: i18n.t("conversation.runStop") })).toBeEnabled();
  return { lifecycle, close, revision, revisionRead, composer, open, journal: () => copy(journal) };
}

it.each([[1440, "9007199254740993"], [360, "75"]] as const)("assistant run candidate navigates the real %spx workspace to its exact saved candidate page", async (width, ordinal) => {
  const h = await openAssistantCandidate(width, ordinal); h.open.focus(); fireEvent.click(h.open);
  const panel = await screen.findByRole("region", { name: w("candidateTitle") }, { timeout: 5000 });
  expect(await within(panel).findByRole("region", { name: i18n.t("workbenchV2.candidateAudit") })).toBeVisible();
  expect(translationCommands.history).toHaveBeenCalledWith({ projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    unitId: target.unitId, locale: target.locale, afterOrdinal: String(BigInt(ordinal) - 1n), limit: 50 });
  expect(nativeInvoke).toHaveBeenCalledWith("read_translation_revision", { request: { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    unitId: target.unitId, locale: target.locale, revisionId: h.revision.revisionId } });
  expect(translationCommands.save).not.toHaveBeenCalled(); expect(translationCommands.select).not.toHaveBeenCalled(); expect(translationCommands.decideCandidate).not.toHaveBeenCalled(); expect(executionCommands.identity).not.toHaveBeenCalled();
}, 15000);

it("assistant run candidate keeps the original view and message draft after a failed exact revision read, then recovers", async () => {
  const h = await openAssistantCandidate(1440, "9007199254740993"); h.revisionRead.mockRejectedValueOnce(new Error("Exact candidate temporarily unavailable"));
  fireEvent.change(h.composer, { target: { value: "Message B retained after failed navigation" } });
  h.open.focus(); fireEvent.click(h.open); await screen.findByText(i18n.t("conversation.runResultsOpenFailed"));
  expect(h.composer).toBeVisible(); expect(h.composer).toHaveValue("Message B retained after failed navigation");
  expect(vi.mocked(translationCommands.history).mock.calls.some(([request]) => request.afterOrdinal === "9007199254740992")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runResultsRecoverRead") }));
  const retry = await screen.findByRole("button", { name: i18n.t("conversation.runResultsOpenCandidate") }); await waitFor(() => expect(retry).toBeEnabled()); retry.focus(); fireEvent.click(retry);
  await screen.findByRole("region", { name: w("candidateTitle") }); expect(h.journal().value?.text).toBe("Message B retained after failed navigation");
  expect(translationCommands.save).not.toHaveBeenCalled(); expect(translationCommands.select).not.toHaveBeenCalled();
});

it.each(["composition", "dialog"] as const)("assistant run candidate refuses a late revision while a %s owns the real workspace", async guard => {
  const h = await openAssistantCandidate(1440, "75"); let answer!: (value: TranslationRevision) => void;
  const reply = new Promise<TranslationRevision>(resolve => { answer = resolve; }); h.revisionRead.mockReturnValueOnce(reply);
  h.open.focus(); fireEvent.click(h.open); await waitFor(() => expect(h.revisionRead).toHaveBeenCalledOnce());
  if (guard === "composition") fireEvent.compositionStart(h.composer);
  else { fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") })); await screen.findByRole("dialog"); }
  await act(async () => { answer(h.revision); await reply; });
  expect(vi.mocked(translationCommands.history).mock.calls.some(([request]) => request.afterOrdinal === "74")).toBe(false);
  expect(h.journal().value?.text).toBe("Retained message draft"); expect(translationCommands.save).not.toHaveBeenCalled(); expect(translationCommands.select).not.toHaveBeenCalled();
  if (guard === "composition") fireEvent.compositionEnd(h.composer);
});

it("opens Inspector from the focused inline candidate, keeps the other snapshot observer current, and stages into the shared editor until explicit confirmation", async () => {
  const h = await openCandidates(), reads = h.lifecycle.getSnapshot().session!.reads;
  const snapshotKey = reads.key(["workbench-entry-details", target.unitId, target.locale]);
  await waitFor(() => expect(reads.client.getQueryCache().find({ queryKey: snapshotKey, exact: true })?.getObserversCount()).toBeGreaterThanOrEqual(2));
  const before = reads.client.getQueryState(snapshotKey)?.dataUpdateCount;
  dockTab("agent");
  await waitFor(() => expect(reads.client.getQueryCache().find({ queryKey: snapshotKey, exact: true })?.getObserversCount()).toBe(1));
  expect(reads.client.getQueryState(snapshotKey)).toMatchObject({ isInvalidated: false, fetchStatus: "idle", dataUpdateCount: before });
  await waitFor(() => expect(within(h.row).getByRole("button", { name: w("candidateAdopt") })).toBeEnabled());
  dockTab("detail");
  await waitFor(() => expect(within(screen.getByRole("region", { name: w("candidateTitle") })).getByRole("button", { name: w("candidateAdopt") })).toBeEnabled());
  fireEvent.click(within(screen.getByRole("region", { name: w("candidateTitle") })).getByRole("button", { name: w("candidateAdopt") }));
  const editor = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: target.nativeKey }) });
  await waitFor(() => expect(editor).toHaveValue(candidate.text));
  expect(disk).toMatchObject({ key, value: { text: candidate.text, basis, pending: null } });
  expect(screen.getByRole("button", { name: w("editorConfirm") })).toBeEnabled();
  expect(translationCommands.save).not.toHaveBeenCalled(); expect(translationCommands.select).not.toHaveBeenCalled();
  expect(executionCommands.identity).not.toHaveBeenCalled();
});

it("retains the original unknown candidate decision after the last view closes and checks it without allocating or dispatching another action", async () => {
  const h = await openCandidates();
  let original: CandidateDecisionRequest | null = null;
  vi.mocked(translationCommands.decideCandidate).mockImplementation(async request => {
    original = copy(request); decision = receipt(request); throw new Error("Lost candidate decision acknowledgement");
  });
  vi.mocked(translationCommands.candidateAction).mockRejectedValueOnce(new Error("Original receipt temporarily unavailable"))
    .mockImplementation(async () => copy(decision));
  fireEvent.change(within(h.panel).getByRole("textbox", { name: w("candidateActor") }), { target: { value: "Reviewer A" } });
  fireEvent.change(within(h.panel).getByRole("textbox", { name: w("candidateReason") }), { target: { value: "Does not fit this dialogue" } });
  const record = within(h.panel).getByRole("button", { name: w("candidateRecord") });
  await waitFor(() => expect(record).toBeEnabled()); fireEvent.click(record);
  await waitFor(() => expect(within(h.panel).getByRole("button", { name: w("candidateCheck") })).toBeEnabled());
  expect(original).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.viewName", { locale: target.locale }) }) }));
  expect(await screen.findByText(w("noViews"))).toBeVisible();
  await act(async () => { expect(await h.lifecycle.close()).toBe(false); });
  expect(h.close).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: w("candidateCheck") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: w("candidateCheck") }));
  await waitFor(() => expect(screen.queryByRole("button", { name: w("candidateCheck") })).not.toBeInTheDocument());
  const recordedRequest = vi.mocked(translationCommands.decideCandidate).mock.calls[0][0];
  expect(translationCommands.candidateAction).toHaveBeenLastCalledWith({ projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    actionId: recordedRequest.decision.actionId, unitId: target.unitId, locale: target.locale });
  expect(translationCommands.decideCandidate).toHaveBeenCalledTimes(1); expect(executionCommands.identity).toHaveBeenCalledTimes(1);
  expect(vi.mocked(translationCommands.decideCandidate).mock.calls[0][0]).toEqual(original);
  expect(translationCommands.save).not.toHaveBeenCalled(); expect(translationCommands.select).not.toHaveBeenCalled();
  await act(async () => { expect(await h.lifecycle.close()).toBe(true); });
  expect(h.close).toHaveBeenCalledOnce();
});

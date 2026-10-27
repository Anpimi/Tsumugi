import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translationFixture from "../../test/fixtures/translation-commands.json";
import { draftCommands, type DraftBasis, type DraftHead } from "../draftCommands";
import { executionCommands } from "../executionCommands";
import { i18n } from "../i18n";
import type { workbenchEn } from "../i18n/workbench";
import type { ProjectView } from "../projectCommands";
import { pluginCommands } from "../pluginCommands";
import { formatReviewSlotFixture } from "../testSupport/textReviewFixture";
import { resourceCommands } from "../resourceCommands";
import { reviewCommands, type ReviewWrite, type ReviewTarget, type ReviewCheckRequest } from "../reviewCommands";
import { segmentCommands, type SegmentPage } from "../segmentCommands";
import { SessionReads } from "../sessionReads";
import { sourceCommands } from "../sourceCommands";
import { fixtureIdentity } from "../testSupport/executionFixture";
import { reviewCheckFixture, reviewFindingViewFixture, reviewDecisionFixture, reviewSummaryFor, reviewTargetFixture } from "../testSupport/reviewFixture";
import { translationCommands, type TranslationHistory } from "../translationCommands";
import WorkbenchApp from "./WorkbenchApp";
import { ProjectLifecycle } from "./platform/projectLifecycle";

vi.mock("./platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));
const project: ProjectView = { sessionToken: "workbench-review-session", locator: "/synthetic/workbench-review", reconciliationState: "settled",
  metadata: { projectId: translationFixture.save.projectId, displayName: "Review workspace", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const target = reviewTargetFixture({ unitId: translationFixture.save.unitId, locale: translationFixture.save.locale,
  sourceRevisionId: translationFixture.save.sourceRevisionId, sourceSnapshotId: translationFixture.receipt.revision.sourceSnapshotId,
  selectionId: translationFixture.receipt.selection.eventId, revisionId: translationFixture.receipt.revision.revisionId,
  nativeKey: "dialogue.review", sourceText: "Complete source {name}", translationText: "" });
const key = { projectId: project.metadata.projectId, unitId: target.unitId, locale: target.locale };
const basis: DraftBasis = { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: "" };
const counts = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
const copy = <T,>(value: T): T => structuredClone(value);
type Label = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (name: Label) => i18n.t(`workbenchV2.${name}`);
const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
let controller: ProjectLifecycle | undefined, current: ReviewTarget, disk: DraftHead;
function historyView(): TranslationHistory {
  return { unitId: target.unitId, locale: target.locale, current: copy(translationFixture.receipt.selection), currentText: "",
    rows: [{ ...copy(translationFixture.receipt.revision), originKind: "manual", text: "", sourceRevisionId: target.sourceRevisionId }], total: "1", nextOrdinal: null };
}
function page(): SegmentPage {
  return { projectId: project.metadata.projectId, locale: target.locale, query: { text: "", selection: "all", status: "all" },
    scopeId: fixtureIdentity(9900), sourceSnapshotId: target.sourceSnapshotId, queryFingerprint: "human-review-query", epoch: fixtureIdentity(9901),
    sequence: "1", readVersion: "1", total: 1, nextCursor: null, rows: [{ content: reviewSummaryFor(current), sourceTruncated: false, translationTruncated: false,
      candidateCount: 1, aiCandidateCount: 0, protection: { unitId: target.unitId, locale: target.locale, protected: false, revision: "0" },
      qa: { current: false, outcome: null, mandatoryCoverageComplete: null, mandatory: counts, advisory: { ...counts } },
      terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
      applicability: { selectedSourceRevisionId: target.sourceRevisionId, sourceBasisCurrent: true, capturedBasisCurrent: true, resourceImpact: null, resourceReviewRequired: false },
      qualification: { blockerCount: 0, exceptionCount: 0, blockers: [], exceptions: [], truncated: false } }] };
}
beforeEach(async () => {
  localStorage.clear(); history.replaceState(null, "", "/"); await i18n.changeLanguage("en-US");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  current = copy(target); disk = { key, revision: "0", writerId: null, value: null };
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ currentSnapshot: target.sourceSnapshotId, revision: "1" });
  vi.spyOn(segmentCommands, "page").mockImplementation(async () => page());
  vi.spyOn(reviewCommands, "editorSnapshot").mockImplementation(async () => ({ target: copy(current), translations: historyView(),
    terms: { unitId: target.unitId, locale: target.locale, sourceRevisionId: target.sourceRevisionId, entries: [] }, context: null, readVersion: "1" }));
  vi.spyOn(draftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(draftCommands, "read").mockImplementation(async () => ({ head: copy(disk), current: { kind: "current", basis: copy(basis), nativeKey: target.nativeKey, sourceText: target.sourceText } }));
  vi.spyOn(draftCommands, "write").mockRejectedValue(new Error("Review must not write a translation draft"));
  vi.spyOn(translationCommands, "history").mockImplementation(async () => historyView());
  vi.spyOn(resourceCommands, "suggestions").mockResolvedValue([]);
  vi.spyOn(executionCommands, "identity").mockResolvedValue(fixtureIdentity(9902));
  vi.spyOn(translationCommands, "save").mockRejectedValue(new Error("Review must not save a translation"));
  vi.spyOn(translationCommands, "select").mockRejectedValue(new Error("Review must not select a translation"));
  vi.spyOn(reviewCommands, "check").mockRejectedValue(new Error("Human review must not run QA"));
});
afterEach(() => { cleanup(); controller?.dispose(); controller = undefined; if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth); vi.restoreAllMocks(); });

it("retains an original human review and newer input after all views close, checks it without another write, and requires an explicit discard before project exit", async () => {
  let submitted: ReviewWrite | null = null;
  vi.spyOn(reviewCommands, "decide").mockImplementation(async (_, request) => {
    submitted = copy(request); current = { ...current, currentDecision: reviewDecisionFixture(request, current) };
    throw Object.assign(new Error("Lost review acknowledgement"), { outcome: "unknown" });
  });
  vi.spyOn(reviewCommands, "decisionAction").mockRejectedValueOnce(new Error("Original receipt unavailable"))
    .mockImplementation(async (_, request) => ({ request: { ...request, expectedDecisionId: request.expectedDecisionId ?? null }, receipt: reviewDecisionFixture(request, target) }));
  const close = vi.fn(async () => ({ closed: true }));
  controller = new ProjectLifecycle({ open: async () => project, close, status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  const lifecycle = controller;
  render(<StrictMode><WorkbenchApp controller={lifecycle} native /></StrictMode>);
  fireEvent.change(screen.getByRole("textbox", { name: w("projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: w("openProject") }));
  const details = await screen.findByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: target.nativeKey }) }, { timeout: 5000 });
  await waitFor(() => expect(details).toBeEnabled()); fireEvent.click(details);
  const review = await screen.findByRole("region", { name: w("entryReviewTitle") });
  fireEvent.change(within(review).getByRole("textbox", { name: w("entryReviewActor") }), { target: { value: "Reviewer A" } });
  fireEvent.change(within(review).getByRole("textbox", { name: w("entryReviewReason") }), { target: { value: "Reason A" } });
  const requestChanges = within(review).getByRole("button", { name: w("entryReviewRequestChanges") });
  await waitFor(() => expect(requestChanges).toBeEnabled()); fireEvent.click(requestChanges);
  await waitFor(() => expect(within(review).getByRole("button", { name: w("entryReviewCheck") })).toBeEnabled());
  fireEvent.change(within(review).getByRole("textbox", { name: w("entryReviewReason") }), { target: { value: "New reason B" } });
  const closeView = () => fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.viewName", { locale: target.locale }) }) }));
  closeView(); expect(await screen.findByText(w("noViews"))).toBeVisible();
  await act(async () => { expect(await lifecycle.close()).toBe(false); }); expect(close).not.toHaveBeenCalled();
  const check = await screen.findByRole("button", { name: w("reviewRecoveryCheck") }); await waitFor(() => expect(check).toBeEnabled()); fireEvent.click(check);
  await waitFor(() => expect(screen.queryByRole("button", { name: w("reviewRecoveryCheck") })).not.toBeInTheDocument());
  expect(reviewCommands.decide).toHaveBeenCalledTimes(1); expect(executionCommands.identity).toHaveBeenCalledTimes(1);
  expect(reviewCommands.decisionAction).toHaveBeenLastCalledWith({ projectId: project.metadata.projectId, sessionToken: project.sessionToken }, submitted);
  await act(async () => { expect(await lifecycle.close()).toBe(false); }); expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: w("reviewRecoveryOpen") }));
  const reopened = await screen.findByRole("region", { name: w("entryReviewTitle") });
  expect(within(reopened).getByRole("textbox", { name: w("entryReviewReason") })).toHaveValue("New reason B");
  closeView(); await screen.findByText(w("noViews"));
  fireEvent.click(screen.getByRole("button", { name: w("reviewRecoveryDiscard") }));
  await act(async () => { expect(await lifecycle.close()).toBe(true); }); expect(close).toHaveBeenCalledOnce();
  expect(draftCommands.write).not.toHaveBeenCalled(); expect(translationCommands.save).not.toHaveBeenCalled(); expect(translationCommands.select).not.toHaveBeenCalled(); expect(reviewCommands.check).not.toHaveBeenCalled();
});

it("keeps prepared checker permissions through the retained host and recovers the original check after all views close", async () => {
  const user = userEvent.setup(), slot = formatReviewSlotFixture();
  let submitted: ReviewCheckRequest | null = null;
  vi.spyOn(pluginCommands, "textReviews").mockResolvedValue({ settingsRevision: slot.plugin.plugin.settingsRevision, entries: [] });
  vi.spyOn(reviewCommands, "findings").mockImplementation(async () => reviewFindingViewFixture(current));
  vi.spyOn(reviewCommands, "prepareCheck").mockImplementation(async request => ({ kind: "plugin", view: {
    actionId: request.actionId, unitId: request.unitId, locale: request.locale, basis: request.expectedBasis, checkers: [copy(slot)] } }));
  vi.mocked(reviewCommands.check).mockImplementation(async request => {
    submitted = copy(request.check); current = { ...current, currentCheck: reviewCheckFixture(current, request.check.actionId) };
    throw Object.assign(new Error("Lost check acknowledgement"), { outcome: "unknown" });
  });
  vi.spyOn(reviewCommands, "checkAction").mockRejectedValueOnce(new Error("Original run is unavailable"))
    .mockImplementation(async request => ({ request: { projectId: request.projectId, actionId: request.actionId, unitId: request.unitId,
      locale: request.locale, expectedBasis: request.expectedBasis, advisoryChecks: [] }, receipt: reviewCheckFixture(target, request.actionId) }));
  vi.spyOn(reviewCommands, "cancelCheck").mockResolvedValue(true);
  controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }), status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
  fireEvent.change(screen.getByRole("textbox", { name: w("projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: w("openProject") }));
  const details = await screen.findByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: target.nativeKey }) }, { timeout: 5000 });
  await waitFor(() => expect(details).toBeEnabled()); await user.click(details);
  await user.click(await screen.findByRole("tab", { name: w("issues") }));
  const checks = await screen.findByRole("region", { name: w("entryChecksTitle") });
  const prepare = within(checks).getByRole("button", { name: w("entryChecksPrepare") });
  await waitFor(() => expect(prepare).toBeEnabled());
  expect(reviewCommands.prepareCheck).not.toHaveBeenCalled(); expect(reviewCommands.check).not.toHaveBeenCalled();
  await user.click(prepare);
  const permission = await within(checks).findByRole("checkbox", { name: i18n.t("review.checkConsent") });
  await waitFor(() => expect(permission).toBeEnabled()); expect(permission).not.toBeChecked();
  const run = within(checks).getByRole("button", { name: w("entryChecksRun") }); expect(run).toBeDisabled();
  await user.click(permission); await waitFor(() => expect(run).toBeEnabled()); await user.click(run);
  await waitFor(() => expect(within(checks).getByRole("button", { name: w("entryChecksCheck") })).toBeEnabled());
  expect(reviewCommands.prepareCheck).toHaveBeenCalledTimes(1); expect(reviewCommands.check).toHaveBeenCalledTimes(1);
  const original = vi.mocked(reviewCommands.check).mock.calls[0][0];
  expect(original.executions).toHaveLength(1); expect(original.executions[0]).toMatchObject({ attemptId: slot.attemptId, inputDigest: slot.inputDigest, unsandboxedExecution: true });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.viewName", { locale: target.locale }) }) }));
  await screen.findByText(w("noViews"));
  await user.click(await screen.findByRole("button", { name: w("reviewRecoveryCancel") }));
  await waitFor(() => expect(reviewCommands.cancelCheck).toHaveBeenCalledWith({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, actionId: original.check.actionId }));
  expect(screen.getByRole("button", { name: w("reviewRecoveryCheck") })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: w("reviewRecoveryCheck") }));
  await waitFor(() => expect(screen.queryByRole("button", { name: w("reviewRecoveryCheck") })).not.toBeInTheDocument());
  expect(reviewCommands.checkAction).toHaveBeenLastCalledWith(submitted);
  expect(reviewCommands.prepareCheck).toHaveBeenCalledTimes(1); expect(reviewCommands.check).toHaveBeenCalledTimes(1); expect(executionCommands.identity).toHaveBeenCalledTimes(2);
  expect(draftCommands.write).not.toHaveBeenCalled(); expect(translationCommands.save).not.toHaveBeenCalled(); expect(translationCommands.select).not.toHaveBeenCalled();
});

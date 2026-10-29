import { StrictMode } from "react";
import { canonicalTranslationReuse } from "../translationReuse";
import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import wire from "../../test/fixtures/reviewCommands.contract.json";
import translationWire from "../../test/fixtures/translation-commands.json";
import { validateResponseWritten } from "../generated/draft.validators";
import { draftCommands, type DraftBasis, type DraftHead } from "../draftCommands";
import { executionCommands } from "../executionCommands";
import { i18n } from "../i18n";
import type { workbenchEn } from "../i18n/workbench";
import { pluginCommands } from "../pluginCommands";
import type { ProjectView } from "../projectCommands";
import { resourceCommands } from "../resourceCommands";
import { reviewCommands } from "../reviewCommands";
import { segmentCommands, type SegmentPage } from "../segmentCommands";
import { SessionReads } from "../sessionReads";
import { sourceCommands } from "../sourceCommands";
import { fixtureIdentity } from "../testSupport/executionFixture";
import { reviewDiagnosticFixture } from "../testSupport/reviewDiagnosticFixture";
import { reviewFindingViewFixture, reviewSummaryFor } from "../testSupport/reviewFixture";
import { translationCommands } from "../translationCommands";
import { workPlanCommands } from "../workPlanCommands";
import WorkbenchApp from "./WorkbenchApp";
import { ProjectLifecycle } from "./platform/projectLifecycle";

vi.mock("./platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));
const copy = <T,>(value: T): T => structuredClone(value);
type Label = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (name: Label) => i18n.t(`workbenchV2.${name}`);
const project: ProjectView = { sessionToken: "diagnostic-workspace", locator: "/synthetic/diagnostic-workspace", reconciliationState: "settled",
  metadata: { projectId: wire.requests.target.projectId, displayName: "Diagnostic workspace", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const counts = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
let controller: ProjectLifecycle | undefined, fixture: ReturnType<typeof reviewDiagnosticFixture>, disk: DraftHead, currentBasis: DraftBasis;
let loseSave = false, serial = 10000;
const scopeId = fixtureIdentity(10001);
function page(query: SegmentPage["query"]): SegmentPage {
  const target = fixture.target;
  return { projectId: project.metadata.projectId, locale: target.locale, query, scopeId, sourceSnapshotId: target.sourceSnapshotId,
    queryFingerprint: JSON.stringify(query), epoch: fixtureIdentity(10002), sequence: "1", readVersion: "1", total: 1, nextCursor: null,
    rows: [{ content: reviewSummaryFor(target), sourceTruncated: false, translationTruncated: false, candidateCount: 0, aiCandidateCount: 0,
      protection: { unitId: target.unitId, locale: target.locale, protected: false, revision: "0" },
      qa: { current: !!target.currentCheck, outcome: target.currentCheck?.outcome ?? null, mandatoryCoverageComplete: null, mandatory: counts, advisory: counts },
      terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
      applicability: { selectedSourceRevisionId: target.sourceRevisionId, sourceBasisCurrent: true, capturedBasisCurrent: true, resourceImpact: null, resourceReviewRequired: false },
      qualification: { blockerCount: 0, exceptionCount: 0, blockers: [], exceptions: [], truncated: false } }] };
}
beforeEach(async () => {
  localStorage.clear(); history.replaceState(null, "", "/"); await i18n.changeLanguage("en-US"); loseSave = false;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  fixture = reviewDiagnosticFixture("utf16", "translation", true);
  const target = fixture.target;
  currentBasis = { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText };
  disk = { key: { projectId: project.metadata.projectId, unitId: target.unitId, locale: target.locale }, revision: "0", writerId: null, value: null };
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {}); vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(sourceCommands, "scope").mockImplementation(async () => ({ currentSnapshot: fixture.target.sourceSnapshotId, revision: "1" }));
  vi.spyOn(segmentCommands, "page").mockImplementation(async request => page({ ...request.query, status: request.query.status ?? "all" }));
  vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => ({ ...page({ text: "", selection: "all", status: "issues" }),
    scopeId: request.scopeId, firstPosition: 0, previousUnitId: null, nextUnitId: null }));
  vi.spyOn(reviewCommands, "editorSnapshot").mockImplementation(async () => copy(fixture.editor));
  vi.spyOn(reviewCommands, "diagnosticLocation").mockImplementation(async () => copy(fixture.location));
  vi.spyOn(reviewCommands, "findings").mockImplementation(async () => ({ ...reviewFindingViewFixture(fixture.target), findings: [{ aiOrigin: null, decision: null,
    finding: fixture.finding, purpose: "qa", requirement: fixture.requirement, runId: fixture.run.runId }] }));
  vi.spyOn(pluginCommands, "textReviews").mockResolvedValue({ settingsRevision: "1", entries: [] });
  vi.spyOn(draftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(draftCommands, "read").mockImplementation(async () => ({ head: copy(disk), current: { kind: "current", basis: copy(currentBasis), nativeKey: fixture.target.nativeKey, sourceText: fixture.target.sourceText } }));
  vi.spyOn(draftCommands, "write").mockImplementation(async ({ write }) => {
    expect(write.expectedRevision).toBe(disk.revision);
    const head: unknown = { key: copy(write.key), revision: String(BigInt(disk.revision) + 1n), writerId: write.writerId, value: { ...copy(write.value), merge: write.value.merge ?? null, pending: write.value.pending ?? null } };
    if (!validateResponseWritten(head)) throw new Error("Invalid synthetic draft write response");
    disk = head; return copy(disk);
  });
  vi.spyOn(draftCommands, "clear").mockImplementation(async () => { disk = { ...disk, revision: String(BigInt(disk.revision) + 1n), value: null, writerId: null }; return copy(disk); });
  vi.spyOn(translationCommands, "history").mockImplementation(async () => copy(fixture.editor.translations));
  vi.spyOn(resourceCommands, "suggestions").mockResolvedValue([]);
  vi.spyOn(workPlanCommands, "protection").mockResolvedValue({ unitId: target.unitId, locale: target.locale, protected: false, revision: "0" });
  vi.spyOn(executionCommands, "identity").mockImplementation(async () => fixtureIdentity(++serial));
  vi.spyOn(translationCommands, "save").mockImplementation(async request => {
    if (loseSave) throw Object.assign(new Error("Lost save acknowledgement"), { outcome: "unknown" });
    const selection = { ...copy(translationWire.receipt.selection), unitId: request.unitId, locale: request.locale, actionId: request.actionId,
      previousEventId: request.expectedSelectionId ?? null, eventId: fixtureIdentity(++serial), revisionId: fixtureIdentity(++serial) };
    const revision = { ...copy(translationWire.receipt.revision), unitId: request.unitId, locale: request.locale, actionId: request.actionId,
      revisionId: selection.revisionId, sourceRevisionId: request.sourceRevisionId, sourceSnapshotId: fixture.target.sourceSnapshotId, text: request.text, originKind: "manual" as const };
    currentBasis = { sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId, revisionId: revision.revisionId, text: request.text };
    fixture.target = { ...fixture.target, translationText: request.text, selectionId: selection.eventId, revisionId: revision.revisionId, basis: "updated-basis",
      basisEvidence: { ...fixture.target.basisEvidence, selectionId: selection.eventId, revisionId: revision.revisionId }, currentCheck: null };
    fixture.editor = { ...fixture.editor, target: fixture.target, translations: { ...fixture.editor.translations, current: selection, currentText: request.text, rows: [revision] } };
    return { projectId: request.projectId, actionId: request.actionId, selection, revision, basis: { sourceSnapshotId: fixture.target.sourceSnapshotId, sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId } };
  });
  vi.spyOn(translationCommands, "recoverSave").mockImplementation(async request => {
    const { sessionToken: _session, ...original } = request;
    return { request: { ...original, reuseOrigin: canonicalTranslationReuse(original.reuseOrigin), expectedSelectionId: original.expectedSelectionId ?? null }, outcome: { kind: "pending", replay: "explicit-same-request" } };
  });
  vi.spyOn(reviewCommands, "check").mockRejectedValue(new Error("No QA execution"));
  vi.spyOn(reviewCommands, "prepareCheck").mockRejectedValue(new Error("No QA preparation"));
  vi.spyOn(reviewCommands, "decide").mockRejectedValue(new Error("No review decision"));
  vi.spyOn(reviewCommands, "finding").mockRejectedValue(new Error("No repair mutation"));
});
afterEach(() => { cleanup(); controller?.dispose(); controller = undefined; if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth); vi.restoreAllMocks(); });
async function openIssues() {
  const user = userEvent.setup();
  controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }), status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  fireEvent.change(screen.getByRole("textbox", { name: w("projectFolder") }), { target: { value: project.locator } });
  await user.click(screen.getByRole("button", { name: w("openProject") }));
  const ready = await screen.findByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: fixture.target.nativeKey }) }, { timeout: 5000 });
  await waitFor(() => expect(ready).toBeEnabled());
  const filter = screen.getByRole("button", { name: w("allEntries") });
  filter.focus(); await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("menuitem", { name: w("entryPresetIssues") }));
  const details = await screen.findByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: fixture.target.nativeKey }) });
  await waitFor(() => expect(details).toBeEnabled()); await user.click(details);
  await user.click(await screen.findByRole("tab", { name: w("issues") }));
  await screen.findByRole("region", { name: w("entryIssuesTitle") });
  return user;
}
// The first full editor journey also loads the lazy work surfaces. Its timeout
// covers module transformation in the test runner, not an input latency target.
it("locates the saved Unicode range, confirms an edit and returns to the original fixed issue scope without recapturing it", { timeout: 15_000 }, async () => {
  const user = await openIssues();
  const captures = vi.mocked(segmentCommands.page).mock.calls.filter(([request]) => !request.scopeId).length;
  await user.click(await screen.findByRole("button", { name: i18n.t("review.diagnosticNavigation.locateTranslation") }));
  const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: fixture.target.nativeKey }) });
  await waitFor(() => expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe("👩🏽‍💻")); expect(field).toHaveFocus();
  expect(field.value).toContain("\n"); expect(draftCommands.write).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: `${field.value} repaired` } });
  await user.click(screen.getByRole("button", { name: w("editorConfirm") }));
  await waitFor(() => expect(translationCommands.save).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("button", { name: w("reviewEditorReturn") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: w("reviewEditorReturn") }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: fixture.target.nativeKey }) })).not.toBeInTheDocument());
  expect(await screen.findByRole("tab", { name: w("issues"), selected: true })).toBeVisible();
  expect(vi.mocked(segmentCommands.page).mock.calls.filter(([request]) => !request.scopeId)).toHaveLength(captures);
  expect(segmentCommands.queueWindow).toHaveBeenLastCalledWith(expect.objectContaining({ scopeId, locale: fixture.target.locale }));
  expect(reviewCommands.check).not.toHaveBeenCalled(); expect(reviewCommands.prepareCheck).not.toHaveBeenCalled(); expect(reviewCommands.decide).not.toHaveBeenCalled(); expect(reviewCommands.finding).not.toHaveBeenCalled();
});
it("keeps an uncertain save and blocks returning without replaying or rerunning work", async () => {
  const user = await openIssues();
  await user.click(await screen.findByRole("button", { name: i18n.t("review.diagnosticNavigation.locateTranslation") }));
  const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: fixture.target.nativeKey }) });
  await waitFor(() => expect(field).toHaveFocus()); loseSave = true;
  fireEvent.change(field, { target: { value: `${field.value} pending` } });
  await user.click(screen.getByRole("button", { name: w("editorConfirm") }));
  await waitFor(() => expect(translationCommands.recoverSave).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: w("reviewEditorReturn") }));
  await screen.findByText(w("reviewEditorReturnBlocked")); expect(translationCommands.save).toHaveBeenCalledOnce();
  expect(translationCommands.recoverSave).toHaveBeenCalledOnce(); expect(reviewCommands.check).not.toHaveBeenCalled(); expect(reviewCommands.prepareCheck).not.toHaveBeenCalled(); expect(reviewCommands.finding).not.toHaveBeenCalled();
});

it("locates read-only source from a narrow inspector while retaining an existing translation draft", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 900 });
  fixture = reviewDiagnosticFixture("utf16", "source", true);
  disk = { ...disk, revision: "1", writerId: fixtureIdentity(10050), value: { basis: copy(currentBasis), text: "Newer draft B", editSeq: "12", pending: null, merge: null } };
  const user = await openIssues();
  await user.click(await screen.findByRole("button", { name: i18n.t("review.diagnosticNavigation.locateSource") }));
  const source = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("workbenchV2.editorDiagnosticSourceLabel", { key: fixture.target.nativeKey }) });
  await waitFor(() => expect(source).toHaveFocus()); expect(source).toHaveAttribute("readonly");
  expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe("👩🏽‍💻");
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: fixture.target.nativeKey }) })).toHaveValue("Newer draft B");
  expect(draftCommands.write).not.toHaveBeenCalled(); expect(translationCommands.save).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: w("reviewEditorReturn") }));
  expect(await screen.findByRole("dialog")).toBeVisible();
  expect(await screen.findByRole("tab", { name: w("issues"), selected: true })).toBeVisible();
  expect(translationCommands.save).not.toHaveBeenCalled(); expect(reviewCommands.check).not.toHaveBeenCalled();
});

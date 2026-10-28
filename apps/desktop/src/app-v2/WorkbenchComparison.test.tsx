import { StrictMode } from "react";
import { canonicalTranslationReuse } from "../translationReuse";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import arenaFixture from "../../test/fixtures/arenaCommands.contract.json";
import translationFixture from "../../test/fixtures/translation-commands.json";
import { arenaCommands, type ComparisonView } from "../arenaCommands";
import { draftCommands, type DraftBasis, type DraftHead } from "../draftCommands";
import { executionCommands } from "../executionCommands";
import { validateRequestCompare, validateResponseComparison } from "../generated/arena.validators";
import { validateRequestRevision, validateResponseRevision } from "../generated/translation.validators";
import { i18n } from "../i18n";
import type { ProjectView } from "../projectCommands";
import { resourceCommands } from "../resourceCommands";
import { reviewCommands } from "../reviewCommands";
import { segmentCommands, type SegmentPage } from "../segmentCommands";
import { SessionReads } from "../sessionReads";
import { sourceCommands } from "../sourceCommands";
import { fixtureIdentity } from "../testSupport/executionFixture";
import { reviewSummaryFor, reviewTargetFixture } from "../testSupport/reviewFixture";
import { translationCommands, type TranslationHistory, type TranslationRevision } from "../translationCommands";
import { workPlanCommands } from "../workPlanCommands";
import WorkbenchApp from "./WorkbenchApp";
import { ProjectLifecycle } from "./platform/projectLifecycle";

vi.mock("./platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));
const savedComparison = arenaFixture.responses.comparison;
const project: ProjectView = { sessionToken: "workbench-comparison-session", locator: "/synthetic/workbench-comparison", reconciliationState: "settled",
  metadata: { projectId: arenaFixture.requests.compare.projectId, displayName: "Comparison workspace", metadataRevision: "1", sourceLocale: "en", targetLocales: [savedComparison.locale] } };
// Revision reads return complete translation records, independently of Arena's display projection.
const revisions: TranslationRevision[] = [
  { ...translationFixture.receipt.revision, revisionId: savedComparison.rows[0].revisionId, actionId: fixtureIdentity(980), ordinal: "1",
    unitId: savedComparison.unitId, locale: savedComparison.locale, sourceRevisionId: savedComparison.sourceRevisionId,
    originKind: "ai", text: savedComparison.rows[0].text, candidateDecision: null },
  { ...translationFixture.receipt.revision, revisionId: savedComparison.rows[1].revisionId, actionId: fixtureIdentity(981), ordinal: "2",
    unitId: savedComparison.unitId, locale: savedComparison.locale, sourceRevisionId: savedComparison.sourceRevisionId,
    originKind: "manual", text: savedComparison.rows[1].text, candidateDecision: null },
];
const target = reviewTargetFixture({ unitId: savedComparison.unitId, locale: savedComparison.locale, nativeKey: savedComparison.nativeKey,
  sourceSnapshotId: revisions[0].sourceSnapshotId, sourceRevisionId: savedComparison.sourceRevisionId, sourceText: savedComparison.sourceText,
  selectionId: savedComparison.selectionId, revisionId: savedComparison.selectedRevisionId, translationText: savedComparison.selectedText, basis: savedComparison.basis });
const selection = { ...translationFixture.receipt.selection, unitId: target.unitId, locale: target.locale, eventId: savedComparison.selectionId,
  revisionId: savedComparison.selectedRevisionId, sequence: "1", previousEventId: null };
const key = { projectId: project.metadata.projectId, unitId: target.unitId, locale: target.locale };
const basis: DraftBasis = { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText };
const checks = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
const page: SegmentPage = { projectId: project.metadata.projectId, locale: target.locale, query: { text: "", selection: "all", status: "all" },
  scopeId: fixtureIdentity(982), sourceSnapshotId: target.sourceSnapshotId, queryFingerprint: "comparison-query", epoch: fixtureIdentity(983), sequence: "1",
  readVersion: "1", total: 1, nextCursor: null, rows: [{ content: reviewSummaryFor(target), sourceTruncated: false, translationTruncated: false,
    candidateCount: 1, aiCandidateCount: 0, protection: { unitId: target.unitId, locale: target.locale, protected: false, revision: "0" },
    qa: { current: false, outcome: null, mandatoryCoverageComplete: null, mandatory: checks, advisory: { ...checks } },
    terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
    applicability: { selectedSourceRevisionId: target.sourceRevisionId, sourceBasisCurrent: true, capturedBasisCurrent: true, resourceImpact: null, resourceReviewRequired: false },
    qualification: { blockerCount: 0, exceptionCount: 0, blockers: [], exceptions: [], truncated: false } }] };
type Label = "projectFolder" | "openProject" | "agent" | "entryDetailsTabs" | "candidates" | "comparisonOpen" | "comparisonTitle"
  | "comparisonCreate" | "comparisonBlind" | "comparisonReveal" | "comparisonStageMerge" | "candidateAdopt" | "editorConfirm" | "editorMergeDraft"
  | "candidateBatchMenu" | "candidateBatchStage" | "candidateBatchTitle" | "candidateBatchConfirm" | "candidateBatchEdit" | "candidateBatchOpen" | "close";
const w = (name: Label) => i18n.t(`workbenchV2.${name}`);
const editorLabel = () => i18n.t("workbenchV2.editorLabel", { key: target.nativeKey });
const copy = <T,>(value: T): T => structuredClone(value);
const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth"), originalHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
let controller: ProjectLifecycle | undefined, disk: DraftHead, comparisons: Map<string, ComparisonView>;
let journalWait: Promise<void> | null = null, releaseJournal: (() => void) | null = null;
function historyView(afterOrdinal = "0", limit = 50): TranslationHistory {
  const remaining = revisions.filter(row => BigInt(row.ordinal) > BigInt(afterOrdinal)), rows = remaining.slice(0, limit);
  return { unitId: target.unitId, locale: target.locale, current: copy(selection), currentText: target.translationText, rows: copy(rows),
    total: String(revisions.length), nextOrdinal: remaining.length > rows.length ? rows[rows.length - 1].ordinal : null };
}

beforeEach(async () => {
  localStorage.clear(); history.replaceState(null, "", "/"); await i18n.changeLanguage("en-US");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 980 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 720 });
  disk = { key: copy(key), revision: "0", writerId: null, value: null }; comparisons = new Map();
  journalWait = null; releaseJournal = null;
  for (const revision of revisions) expect(validateResponseRevision(revision)).toBe(true);
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
    if (journalWait) await journalWait;
    const value = copy(write.value), pending = value.pending;
    disk = { key: copy(write.key), revision: (BigInt(disk.revision) + 1n).toString(), writerId: write.writerId,
      value: { ...value, reuseOrigin: canonicalTranslationReuse(value.reuseOrigin), basis: { ...value.basis, selectionId: value.basis.selectionId ?? null,
        revisionId: value.basis.revisionId ?? null, text: value.basis.text ?? null }, merge: value.merge ?? null,
        pending: pending == null ? null : pending.kind === "selection"
          ? { ...pending, request: { ...pending.request, expectedSelectionId: pending.request.expectedSelectionId ?? null } }
          : { ...pending, request: { ...pending.request, reuseOrigin: canonicalTranslationReuse(pending.request.reuseOrigin), expectedSelectionId: pending.request.expectedSelectionId ?? null } } } };
    return copy(disk);
  });
  vi.spyOn(translationCommands, "history").mockImplementation(async request => {
    expect(request).toMatchObject({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, unitId: target.unitId, locale: target.locale });
    return historyView(request.afterOrdinal ?? "0", request.limit);
  });
  vi.spyOn(translationCommands, "revision").mockImplementation(async request => {
    expect(validateRequestRevision(request)).toBe(true);
    expect(request).toMatchObject({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, unitId: target.unitId, locale: target.locale });
    const revision = revisions.find(row => row.revisionId === request.revisionId);
    if (!revision) throw new Error("Unknown saved revision");
    return copy(revision);
  });
  vi.spyOn(resourceCommands, "suggestions").mockResolvedValue([]);
  vi.spyOn(workPlanCommands, "protection").mockResolvedValue({ unitId: target.unitId, locale: target.locale, protected: false, revision: "0" });
  vi.spyOn(executionCommands, "identity").mockResolvedValue(arenaFixture.requests.compare.actionId);
  vi.spyOn(arenaCommands, "compare").mockImplementation(async request => {
    expect(validateRequestCompare(request)).toBe(true);
    expect(request).toMatchObject({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, unitId: target.unitId, locale: target.locale });
    const order = request.blind ? [...request.revisionIds].reverse() : request.revisionIds;
    const view: ComparisonView = { ...copy(savedComparison), comparisonId: request.actionId, blind: request.blind, revealed: !request.blind,
      rows: order.map(id => {
        const revision = revisions.find(row => row.revisionId === id);
        if (!revision) throw new Error("Unknown comparison contributor");
        return { revisionId: revision.revisionId, sourceRevisionId: revision.sourceRevisionId, text: revision.text, originKind: revision.originKind,
          contributors: [...revision.contributors], basisCurrent: true, candidateDisposition: null, model: null, recipe: null };
      }) };
    expect(validateResponseComparison(view)).toBe(true); comparisons.set(request.actionId, copy(view)); return copy(view);
  });
  vi.spyOn(arenaCommands, "comparison").mockImplementation(async request => {
    expect(request).toMatchObject({ projectId: project.metadata.projectId, sessionToken: project.sessionToken });
    const view = comparisons.get(request.comparisonId); if (!view) throw new Error("Unknown comparison"); return copy(view);
  });
  vi.spyOn(arenaCommands, "comparisons").mockImplementation(async () => [...comparisons].map(([comparisonId, view]) => ({ comparisonId, nativeKey: view.nativeKey, locale: view.locale })));
  vi.spyOn(arenaCommands, "merge").mockRejectedValue(new Error("A local merge draft is not a formal merge"));
  vi.spyOn(arenaCommands, "reveal").mockRejectedValue(new Error("Sources are not revealed by staging"));
  vi.spyOn(arenaCommands, "preview").mockRejectedValue(new Error("Saved comparisons do not call a model"));
  vi.spyOn(arenaCommands, "start").mockRejectedValue(new Error("Saved comparisons do not start generation"));
  vi.spyOn(translationCommands, "save").mockRejectedValue(new Error("Only explicit confirmation may save"));
  vi.spyOn(translationCommands, "select").mockRejectedValue(new Error("Staging does not select a formal revision"));
});
afterEach(() => {
  releaseJournal?.(); cleanup(); controller?.dispose(); controller = undefined;
  if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
  if (originalHeight) Object.defineProperty(window, "innerHeight", originalHeight);
});

async function openComparison(blind: boolean) {
  controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }),
    status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
  fireEvent.change(screen.getByRole("textbox", { name: w("projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: w("openProject") }));
  const details = await screen.findByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: target.nativeKey }) }, { timeout: 5000 });
  await waitFor(() => expect(details).toBeEnabled()); fireEvent.click(details);
  const sheet = await screen.findByRole("dialog", { name: w("agent") });
  expect(sheet).toBeVisible();
  const tabs = await within(sheet).findByRole("tablist", { name: w("entryDetailsTabs") }, { timeout: 5000 });
  fireEvent.mouseDown(within(tabs).getByRole("tab", { name: w("candidates") }), { button: 0, ctrlKey: false });
  const open = await within(sheet).findByRole("button", { name: w("comparisonOpen") });
  await waitFor(() => expect(open).toBeEnabled()); fireEvent.click(open);
  const setup = await within(sheet).findByRole("region", { name: w("comparisonTitle") }, { timeout: 5000 });
  for (const number of ["1", "2"]) {
    const choice = await within(setup).findByRole("checkbox", { name: i18n.t("workbenchV2.comparisonChoice", { number }) });
    await waitFor(() => expect(choice).toBeEnabled()); fireEvent.click(choice); expect(choice).toBeChecked();
  }
  if (blind) fireEvent.click(within(setup).getByRole("checkbox", { name: w("comparisonBlind") }));
  const create = within(setup).getByRole("button", { name: w("comparisonCreate") });
  await waitFor(() => expect(create).toBeEnabled()); fireEvent.click(create);
  await within(sheet).findByRole("article", { name: i18n.t("workbenchV2.comparisonCandidate", { label: "A" }) });
  expect(screen.getByRole("dialog", { name: w("agent") })).toBe(sheet);
  expect(arenaCommands.compare).toHaveBeenCalledOnce();
  expect(vi.mocked(arenaCommands.compare).mock.calls[0][0]).toMatchObject({ actionId: arenaFixture.requests.compare.actionId, blind,
    revisionIds: revisions.map(row => row.revisionId) });
  await waitFor(() => expect(translationCommands.revision).toHaveBeenCalledWith(expect.objectContaining({ revisionId: revisions[1].revisionId })));
  const label = blind ? "A" : "B";
  const manual = within(sheet).getByRole("article", { name: i18n.t("workbenchV2.comparisonCandidate", { label }) });
  expect(manual).toHaveTextContent(revisions[1].text);
  return { sheet, manual };
}
async function stageIntoEditor(sheet: HTMLElement, button: HTMLElement) {
  expect(draftCommands.write).not.toHaveBeenCalled();
  journalWait = new Promise(resolve => { releaseJournal = () => { journalWait = null; resolve(); }; });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  await waitFor(() => expect(draftCommands.write).toHaveBeenCalledOnce());
  expect(sheet).toBeVisible();
  expect(screen.queryByRole("textbox", { name: editorLabel() })).not.toBeInTheDocument();
  await act(async () => { releaseJournal!(); releaseJournal = null; });
  const editor = await screen.findByRole("textbox", { name: editorLabel() });
  await waitFor(() => { expect(editor).toHaveValue(revisions[1].text); expect(editor).toHaveFocus(); });
  expect(screen.queryByRole("dialog", { name: w("agent") })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: w("editorConfirm") })).toBeEnabled();
  return editor;
}
function expectNoFormalWrite() {
  expect(arenaCommands.merge).not.toHaveBeenCalled(); expect(translationCommands.save).not.toHaveBeenCalled(); expect(translationCommands.select).not.toHaveBeenCalled();
  expect(arenaCommands.reveal).not.toHaveBeenCalled(); expect(arenaCommands.preview).not.toHaveBeenCalled(); expect(arenaCommands.start).not.toHaveBeenCalled();
  expect(executionCommands.identity).toHaveBeenCalledOnce();
}

it("creates a saved comparison inside the narrow Inspector and closes its Sheet only after adopting a durable shared draft", async () => {
  const h = await openComparison(false);
  await stageIntoEditor(h.sheet, within(h.manual).getByRole("button", { name: w("candidateAdopt") }));
  expect(disk).toMatchObject({ key, value: { text: revisions[1].text, basis, pending: null } });
  expect(disk.value?.merge ?? null).toBeNull();
  expect(screen.queryByText(w("editorMergeDraft"))).not.toBeInTheDocument();
  expect(translationCommands.history).toHaveBeenCalledWith(expect.objectContaining({ afterOrdinal: "1", limit: 1 }));
  expectNoFormalWrite();
});

it("keeps blind display order and basis in the journal when merging into the focused table editor, without formally merging or losing later input", async () => {
  const h = await openComparison(true);
  expect(within(h.sheet).getByRole("button", { name: w("comparisonReveal") })).toBeEnabled();
  const editor = await stageIntoEditor(h.sheet, within(h.manual).getByRole("button", { name: w("comparisonStageMerge") }));
  const merge = { comparisonId: arenaFixture.requests.compare.actionId, contributors: [revisions[1].revisionId, revisions[0].revisionId], expectedBasis: target.basis };
  expect(disk).toMatchObject({ key, value: { text: revisions[1].text, basis, merge, pending: null } });
  expect(screen.getByText(w("editorMergeDraft"))).toBeVisible();
  const edited = "  Merged 👩🏽‍💻 é {name}\nKeep the next line  ";
  fireEvent.change(editor, { target: { value: edited } });
  expect(editor).toHaveValue(edited); expect(editor).toHaveFocus();
  await waitFor(() => expect(disk).toMatchObject({ value: { text: edited, basis, merge, pending: null } }));
  expect(screen.getByText(w("editorMergeDraft"))).toBeVisible();
  expect(comparisons.get(merge.comparisonId)).toMatchObject({ blind: true, revealed: false });
  expectNoFormalWrite();
});

it("previews a fixed selection before staging and releases the batch Dialog before focusing the shared row editor", async () => {
  const candidate: TranslationRevision = { ...copy(revisions[0]), revisionId: fixtureIdentity(995), actionId: fixtureIdentity(996), ordinal: "3",
    text: "Fixed batch candidate é 👩🏽‍💻 {name}" };
  vi.spyOn(translationCommands, "candidateSlice").mockImplementation(async request => {
    expect(request.unitIds).toEqual([target.unitId]);
    return { projectId: project.metadata.projectId, locale: target.locale, sourceSnapshotId: target.sourceSnapshotId, scopeId: request.scopeId ?? null,
      readVersion: "fixed-candidate-read", rows: [{ target: copy(target), selectedOriginKind: "ai", protection: copy(page.rows[0].protection),
        candidateCount: 1, revisions: [copy(candidate)] }], next: null };
  });
  vi.spyOn(draftCommands, "readMany").mockImplementation(async request => {
    expect(request.unitIds).toEqual([target.unitId]);
    return { items: [{ head: copy(disk), current: { kind: "current", basis: copy(basis), nativeKey: target.nativeKey, sourceText: target.sourceText } }], nextAfter: null };
  });
  controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }),
    status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
  fireEvent.change(screen.getByRole("textbox", { name: w("projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: w("openProject") }));
  const member = await screen.findByRole("checkbox", { name: i18n.t("workbenchV2.entrySelect", { key: target.nativeKey }) }, { timeout: 5000 });
  await waitFor(() => expect(member).toBeEnabled()); fireEvent.click(member);
  const menu = await screen.findByRole("button", { name: w("candidateBatchMenu") }, { timeout: 5000 });
  act(() => menu.focus()); fireEvent.keyDown(menu, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: w("candidateBatchStage") }));
  let dialog = await screen.findByRole("dialog", { name: w("candidateBatchTitle") }, { timeout: 5000 });
  let confirm = await within(dialog).findByRole("button", { name: w("candidateBatchConfirm") });
  await waitFor(() => expect(confirm).toBeEnabled());
  expect(dialog).toHaveTextContent(candidate.text); expect(draftCommands.write).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getAllByRole("button", { name: w("close") }).at(-1)!);
  const retained = await screen.findByRole("button", { name: w("candidateBatchOpen") });
  await waitFor(() => expect(retained).toHaveFocus());
  expect(menu).toBeDisabled(); fireEvent.click(retained);
  dialog = await screen.findByRole("dialog", { name: w("candidateBatchTitle") });
  confirm = await within(dialog).findByRole("button", { name: w("candidateBatchConfirm") });
  await waitFor(() => expect(confirm).toBeEnabled());
  journalWait = new Promise(resolve => { releaseJournal = () => { journalWait = null; resolve(); }; });
  fireEvent.click(confirm);
  await waitFor(() => expect(draftCommands.write).toHaveBeenCalledOnce());
  expect(dialog).toBeVisible(); expect(within(dialog).queryByRole("button", { name: w("candidateBatchEdit") })).not.toBeInTheDocument();
  await act(async () => { releaseJournal!(); releaseJournal = null; });
  const edit = await within(dialog).findByRole("button", { name: w("candidateBatchEdit") });
  await waitFor(() => expect(edit).toBeEnabled()); fireEvent.click(edit);
  const editor = await screen.findByRole("textbox", { name: editorLabel() }, { timeout: 5000 });
  await waitFor(() => { expect(editor).toHaveValue(candidate.text); expect(editor).toHaveFocus(); });
  expect(screen.queryByRole("dialog", { name: w("candidateBatchTitle") })).not.toBeInTheDocument();
  expect(disk.value).toMatchObject({ text: candidate.text, basis, pending: null });
  expect(disk.value?.merge ?? null).toBeNull();
  expect(executionCommands.identity).not.toHaveBeenCalled(); expect(translationCommands.save).not.toHaveBeenCalled();
  expect(translationCommands.select).not.toHaveBeenCalled(); expect(arenaCommands.merge).not.toHaveBeenCalled(); expect(arenaCommands.start).not.toHaveBeenCalled();
});

import { StrictMode, useLayoutEffect, useSyncExternalStore, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aiSemanticReviewCommands } from "../aiSemanticReviewCommands";
import { conversationCommands } from "../conversationCommands";
import { canonicalConversationDraft, conversationDraftCommands, type ConversationDraftHead } from "../conversationDraftCommands";
import { draftCommands } from "../draftCommands";
import { executionCommands } from "../executionCommands";
import { validateResponseConversationWritten } from "../generated/draft.validators";
import { i18n } from "../i18n";
import { pluginCommands } from "../pluginCommands";
import type { ProjectView } from "../projectCommands";
import { resourceCommands } from "../resourceCommands";
import { reviewCommands } from "../reviewCommands";
import { segmentCommands, type SegmentPage } from "../segmentCommands";
import { SessionReads } from "../sessionReads";
import { sourceCommands } from "../sourceCommands";
import { fixtureIdentity as id } from "../testSupport/executionFixture";
import { installWorkbenchInputJournalFixtures } from "../testSupport/inputJournalFixture";
import { reviewSummaryFor } from "../testSupport/reviewFixture";
import { teamReviewFixture } from "../testSupport/teamReviewFixture";
import { translationCommands, type TranslationHistory } from "../translationCommands";
import { workPlanCommands } from "../workPlanCommands";
import translationWire from "../../test/fixtures/translation-commands.json";
import WorkbenchApp from "./WorkbenchApp";
import { ProjectLifecycle } from "./platform/projectLifecycle";
import { teamFindingTarget, type TeamRunFindingTarget } from "./features/assistant/teamFindingReads";

vi.mock("./platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));
type ConversationProps = ComponentProps<typeof import("./features/assistant/ConversationPanel")["default"]>;
let conversation: ConversationProps | null = null;
vi.mock("./features/assistant/ConversationPanel", () => ({ default: function ConversationProbe(props: ConversationProps) {
  const state = useSyncExternalStore(props.owner.subscribe, props.owner.getSnapshot, props.owner.getSnapshot);
  const input = state.activeId ? state.inputs.get(state.activeId) : null;
  useLayoutEffect(() => { if (props.visible) conversation = props; });
  return props.visible ? <section aria-label="Original Agent owner">
    <label>Original Agent draft<textarea value={input?.value.text ?? ""} onChange={event => { if (state.activeId) props.owner.edit(state.activeId, event.target.value); }}/></label>
  </section> : null;
} }));

const counts = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
const copy = <T,>(value: T): T => structuredClone(value);
let fixture: ReturnType<typeof teamReviewFixture>, controller: ProjectLifecycle | null, disk: ConversationDraftHead;
let target: TeamRunFindingTarget;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function agent() { if (!conversation) throw new Error("Missing original Conversation presentation"); return conversation; }
function selectedPage(query: SegmentPage["query"]): SegmentPage {
  return { projectId: fixture.context.projectId, locale: fixture.target.locale, query, queryFingerprint: JSON.stringify(query), scopeId: id(9950),
    sourceSnapshotId: fixture.target.sourceSnapshotId, readVersion: "1", epoch: id(9951), sequence: "1", total: 1, nextCursor: null,
    rows: [{ content: reviewSummaryFor(fixture.target), sourceTruncated: false, translationTruncated: false, candidateCount: 0, aiCandidateCount: 0,
      protection: { unitId: fixture.target.unitId, locale: fixture.target.locale, protected: false, revision: "0" },
      qa: { current: false, outcome: null, mandatoryCoverageComplete: null, mandatory: counts, advisory: counts },
      terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
      applicability: { selectedSourceRevisionId: fixture.target.sourceRevisionId, sourceBasisCurrent: true, capturedBasisCurrent: true, resourceImpact: null, resourceReviewRequired: false },
      qualification: { blockerCount: 0, exceptionCount: 0, blockers: [], exceptions: [], truncated: false } }] };
}
function translations(): TranslationHistory {
  const t = fixture.target;
  return { unitId: t.unitId, locale: t.locale, currentText: t.translationText,
    current: { ...copy(translationWire.receipt.selection), eventId: t.selectionId!, revisionId: t.revisionId!, unitId: t.unitId, locale: t.locale },
    rows: [{ ...copy(translationWire.receipt.revision), revisionId: t.revisionId!, unitId: t.unitId, locale: t.locale, text: t.translationText!, originKind: "manual",
      sourceSnapshotId: t.sourceSnapshotId, sourceRevisionId: t.sourceRevisionId }], total: "1", nextOrdinal: null };
}

beforeEach(installWorkbenchInputJournalFixtures);
beforeEach(async () => {
  localStorage.clear(); history.replaceState(null, "", "/"); await i18n.changeLanguage("en-US");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 }); conversation = null; controller = null;
  fixture = teamReviewFixture();
  const model = fixture.row.output!.rules[0].findings[0], saved = fixture.run.rules[0].findings[0], evidence = fixture.findings.findings[0];
  fixture.row.output!.rules[0].findings = Array.from({ length: 26 }, (_, index) => ({ ...copy(model), code: `meaning-${index}`, detail: `Original concern ${index}`, suggestion: `Inspect original concern ${index}` }));
  fixture.run.rules[0].findings = fixture.row.output!.rules[0].findings.map((finding, index) => ({ ...copy(saved), issueId: index.toString(16).padStart(64, "a"), code: `ai-${index}`, detail: finding.detail }));
  fixture.findings.findings = fixture.run.rules[0].findings.map(finding => ({ ...copy(evidence), finding }));
  if (fixture.work.output?.outcome.kind !== "review" || !fixture.work.output.outcome.report) throw new Error("Structured report fixture required");
  fixture.work.output.outcome.report.rules = copy(fixture.row.output!.rules);
  const captured = teamFindingTarget(fixture.link, fixture.page, fixture.work, fixture.view, fixture.run.rules[0].findings[25].issueId);
  if (!captured) throw new Error("Original current finding fixture required"); target = captured;
  const key = { projectId: fixture.context.projectId, conversationId: fixture.link.conversationId };
  disk = { key, revision: "1", writerId: id(9952), value: { text: "Existing B stays", editSeq: "1", pending: null } };
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {}); vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(sourceCommands, "scope").mockImplementation(async () => ({ currentSnapshot: fixture.target.sourceSnapshotId, revision: "1" }));
  vi.spyOn(segmentCommands, "page").mockImplementation(async request => selectedPage({ ...request.query, status: request.query.status ?? "all" }));
  vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => ({ ...selectedPage({ text: "", selection: "all", status: "all" }), scopeId: request.scopeId,
    firstPosition: 0, previousUnitId: null, nextUnitId: null }));
  vi.spyOn(reviewCommands, "editorSnapshot").mockImplementation(async () => ({ target: copy(fixture.target), translations: translations(),
    terms: { unitId: fixture.target.unitId, locale: fixture.target.locale, sourceRevisionId: fixture.target.sourceRevisionId, entries: [] }, context: null, readVersion: "1" }));
  vi.spyOn(reviewCommands, "target").mockImplementation(async () => copy(fixture.target));
  vi.spyOn(reviewCommands, "findings").mockImplementation(async request => ({ ...copy(fixture.findings), findings: copy(fixture.findings.findings.slice(request.offset, request.offset + request.limit)),
    nextOffset: request.offset + request.limit < fixture.findings.findings.length ? request.offset + request.limit : null }));
  vi.spyOn(pluginCommands, "textReviews").mockResolvedValue({ settingsRevision: "1", entries: [] });
  vi.spyOn(draftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(draftCommands, "read").mockImplementation(async request => ({ head: { key: { projectId: request.key.projectId, unitId: fixture.target.unitId, locale: fixture.target.locale }, revision: "0", writerId: null, value: null },
    current: { kind: "current", basis: { sourceRevisionId: fixture.target.sourceRevisionId, selectionId: fixture.target.selectionId, revisionId: fixture.target.revisionId, text: fixture.target.translationText }, nativeKey: fixture.target.nativeKey, sourceText: fixture.target.sourceText } }));
  vi.spyOn(translationCommands, "history").mockImplementation(async () => translations());
  vi.spyOn(resourceCommands, "suggestions").mockResolvedValue([]);
  vi.spyOn(workPlanCommands, "protection").mockResolvedValue({ unitId: fixture.target.unitId, locale: fixture.target.locale, revision: "0", protected: false });
  vi.spyOn(workPlanCommands, "status").mockImplementation(async () => copy(fixture.status));
  vi.spyOn(workPlanCommands, "teamExecution").mockImplementation(async () => copy(fixture.page));
  vi.spyOn(conversationCommands, "readProposalWorkPlan").mockImplementation(async () => copy(fixture.link));
  vi.spyOn(aiSemanticReviewCommands, "read").mockImplementation(async () => ({ attemptId: fixture.work.receipt.attemptId, view: copy(fixture.view) }));
  vi.spyOn(conversationDraftCommands, "list").mockResolvedValue({ items: [{ key, revision: disk.revision, editSeq: "1", hasPending: false }], next: null });
  vi.spyOn(conversationDraftCommands, "read").mockImplementation(async () => copy(disk));
  vi.spyOn(conversationDraftCommands, "write").mockImplementation(async request => {
    const head: unknown = { key, revision: String(BigInt(disk.revision) + 1n), writerId: request.write.writerId, value: copy(canonicalConversationDraft(request.write.value)) };
    if (!validateResponseConversationWritten(head)) throw new Error("Invalid local finding draft fixture"); disk = head; return copy(disk);
  });
  vi.spyOn(conversationCommands, "append"); vi.spyOn(conversationCommands, "preparePlanning"); vi.spyOn(conversationCommands, "startPlanning");
  vi.spyOn(reviewCommands, "finding"); vi.spyOn(reviewCommands, "waive"); vi.spyOn(reviewCommands, "check");
  vi.spyOn(executionCommands, "prepare"); vi.spyOn(executionCommands, "adopt");
});
afterEach(() => {
  cleanup(); controller?.dispose(); if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
  expect(conversationCommands.append).not.toHaveBeenCalled(); expect(conversationCommands.preparePlanning).not.toHaveBeenCalled(); expect(conversationCommands.startPlanning).not.toHaveBeenCalled();
  expect(reviewCommands.finding).not.toHaveBeenCalled(); expect(reviewCommands.waive).not.toHaveBeenCalled(); expect(reviewCommands.check).not.toHaveBeenCalled();
  expect(executionCommands.prepare).not.toHaveBeenCalled(); expect(executionCommands.adopt).not.toHaveBeenCalled(); vi.restoreAllMocks();
});

async function openWorkspace() {
  const project: ProjectView = { locator: "/synthetic/team-findings", sessionToken: fixture.context.sessionToken, reconciliationState: "settled",
    metadata: { projectId: fixture.context.projectId, displayName: "Team findings", metadataRevision: "1", sourceLocale: "en", targetLocales: [fixture.target.locale] } };
  controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }), status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  await screen.findByRole("region", { name: "Original Agent owner" }, { timeout: 5000 });
  await waitFor(() => expect(agent().disabled).toBe(false));
  await act(async () => { expect(await agent().owner.open(fixture.link.conversationId)).toBe(true); });
  await screen.findByDisplayValue("Existing B stays");
}

it("routes the exact current team finding to the original Issues owner at its real offset", { timeout: 15_000 }, async () => {
  await openWorkspace(); const callback = agent().onOpenTeamFinding; if (!callback) throw new Error("Missing Shell finding callback");
  await act(async () => { expect(await callback(target, () => true)).toBe(true); });
  const issues = await screen.findByRole("region", { name: i18n.t("workbenchV2.entryIssuesTitle") }, { timeout: 5000 });
  expect(await within(issues).findByText("Original concern 25", {}, { timeout: 5000 })).toBeVisible();
  expect(reviewCommands.findings).toHaveBeenCalledWith({ ...fixture.context, unitId: fixture.target.unitId, locale: fixture.target.locale, offset: 20, limit: 20 });
  expect(screen.queryByText(i18n.t("workbenchV2.decisionFindingChanged"))).not.toBeInTheDocument();
  expect(disk.value?.text).toBe("Existing B stays");
});

it("prepares a one-entry Agent repair through the retained original composer and journal without starting a model", { timeout: 15_000 }, async () => {
  await openWorkspace(); const owner = agent().owner, callback = agent().onPrepareFindingRepair; if (!callback) throw new Error("Missing Shell repair callback");
  await act(async () => { expect(await callback(target, () => true)).toBe(true); });
  const input = owner.getSnapshot().inputs.get(fixture.link.conversationId); if (!input) throw new Error("Missing retained local draft");
  expect(input.value.text).toContain("Existing B stays"); expect(input.value.text).toContain("Original concern 25"); expect(input.value.text).toContain("Inspect original concern 25");
  expect(input.planning).toMatchObject({ open: true, prepared: null, consent: false, purpose: null, messageIds: [],
    selection: { kind: "ids", locale: fixture.target.locale, sourceSnapshotId: fixture.target.sourceSnapshotId, unitIds: [fixture.target.unitId] } });
  expect(disk.value?.text).toBe(input.value.text); expect(screen.getByRole("textbox", { name: "Original Agent draft" })).toHaveValue(input.value.text);
});

it.each(["newer-input", "source-change"] as const)("refuses a late Agent repair after %s and preserves the current draft", { timeout: 15_000 }, async change => {
  await openWorkspace(); const owner = agent().owner, callback = agent().onPrepareFindingRepair; if (!callback) throw new Error("Missing Shell repair callback");
  const hold = deferred<typeof fixture.target>(); vi.mocked(reviewCommands.target).mockReturnValueOnce(hold.promise);
  let operation!: Promise<boolean>;
  act(() => { operation = callback(target, () => true); });
  await waitFor(() => expect(reviewCommands.target).toHaveBeenCalled());
  if (change === "newer-input") await act(async () => { owner.edit(fixture.link.conversationId, "Later C remains"); await owner.flush(); });
  else act(() => { controller!.getSnapshot().session!.reads.invalidate(["source"]); });
  await act(async () => { hold.resolve(copy(fixture.target)); expect(await operation).toBe(false); });
  expect(owner.getSnapshot().inputs.get(fixture.link.conversationId)?.value.text).toBe(change === "newer-input" ? "Later C remains" : "Existing B stays");
  expect(screen.queryByRole("region", { name: i18n.t("workbenchV2.entryIssuesTitle") })).not.toBeInTheDocument();
});

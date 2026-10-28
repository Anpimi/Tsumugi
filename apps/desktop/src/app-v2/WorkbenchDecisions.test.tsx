import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import wire from "../../test/fixtures/reviewCommands.contract.json";
import { conversationCommands } from "../conversationCommands";
import { conversationDraftCommands } from "../conversationDraftCommands";
import { decisionCommands, type DecisionPage, type DecisionPageRequest } from "../decisionCommands";
import { draftCommands, type DraftBasis } from "../draftCommands";
import { executionContext } from "../executionCommands";
import { DecisionSourceValues } from "../generated/decisions.enums";
import { validateRequestPage, validateResponsePage } from "../generated/decisions.validators";
import { validateResponseDeliveryRecord } from "../generated/release.validators";
import { i18n } from "../i18n";
import type { workbenchEn } from "../i18n/workbench";
import { pluginCommands } from "../pluginCommands";
import type { ProjectView } from "../projectCommands";
import { releaseCommands, type DeliveryRecordView } from "../releaseCommands";
import { resourceCommands } from "../resourceCommands";
import { reviewCommands } from "../reviewCommands";
import { segmentCommands, type SegmentPage } from "../segmentCommands";
import { SessionReads } from "../sessionReads";
import { sourceCommands } from "../sourceCommands";
import { fixtureIdentity as id } from "../testSupport/executionFixture";
import { reviewDiagnosticFixture } from "../testSupport/reviewDiagnosticFixture";
import { conversationProposalFixture } from "../testSupport/conversationProposalFixture";
import { reviewSummaryFor } from "../testSupport/reviewFixture";
import { translationCommands } from "../translationCommands";
import { workPlanCommands } from "../workPlanCommands";
import WorkbenchApp from "./WorkbenchApp";
import { ProjectLifecycle } from "./platform/projectLifecycle";

vi.mock("./platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));
type Label = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (key: Label, values?: Record<string, string | number>) => i18n.t(`workbenchV2.${key}`, values);
const copy = <T,>(value: T): T => structuredClone(value);
const project: ProjectView = { sessionToken: "synthetic-decision-workspace", locator: "/synthetic/decision-workspace", reconciliationState: "settled",
  metadata: { projectId: wire.requests.target.projectId, displayName: "Decision workspace", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN", "fr-FR"] } };
const context = executionContext(project), releaseId = id(90000), deliveryId = id(90001), actionId = id(90002);
const counts = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
let controller: ProjectLifecycle | undefined, reads: SessionReads, fixture: ReturnType<typeof reviewDiagnosticFixture>;
let knownCount = 2, basis = "a".repeat(64);
let originalItems: DecisionPage["items"] | null = null;

function segmentPage(query: SegmentPage["query"]): SegmentPage {
  const target = fixture.target;
  return { projectId: context.projectId, locale: target.locale, query, scopeId: id(90003), sourceSnapshotId: target.sourceSnapshotId,
    queryFingerprint: JSON.stringify(query), epoch: id(90004), sequence: "1", readVersion: "1", total: 1, nextCursor: null,
    rows: [{ content: reviewSummaryFor(target), sourceTruncated: false, translationTruncated: false, candidateCount: 0, aiCandidateCount: 0,
      protection: { unitId: target.unitId, locale: target.locale, protected: false, revision: "0" },
      qa: { current: !!target.currentCheck, outcome: target.currentCheck?.outcome ?? null, mandatoryCoverageComplete: null, mandatory: counts, advisory: counts },
      terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
      applicability: { selectedSourceRevisionId: target.sourceRevisionId, sourceBasisCurrent: true, capturedBasisCurrent: true, resourceImpact: null, resourceReviewRequired: false },
      qualification: { blockerCount: 0, exceptionCount: 0, blockers: [], exceptions: [], truncated: false } }] };
}

function decisionPage(request: DecisionPageRequest): DecisionPage {
  const items: DecisionPage["items"] = originalItems ?? Array.from({ length: knownCount }, (_, index) => {
    const originalDelivery = index === 0 ? deliveryId : id(90100 + index), originalAction = index === 0 ? actionId : id(90200 + index);
    return { decisionId: `delivery-unknown:${originalDelivery}`, source: "delivery-unknown", state: "awaiting-recheck", locale: null,
      targets: [{ kind: "delivery", releaseId, deliveryId: originalDelivery }], targetsComplete: true, basis: "b".repeat(64), sourceActionId: originalAction,
      action: { kind: "inspect-delivery-outcome", releaseId, deliveryId: originalDelivery, actionId: originalAction },
      evidence: { kind: "delivery-outcome", state: "unknown", locales: ["fr-FR", "zh-CN"], fileCount: 2, unknownFileCount: 1 } };
  });
  const coverage = DecisionSourceValues.map((source): DecisionPage["coverage"][number] => {
    if (source === "agent-question") return { source, state: "partial", knownCount: items.filter(item => item.source === source).length,
      total: null, reason: "source-not-implemented", errorCode: null };
    if (source === "local-action-recovery" && request.activity == null) return { source, state: "unavailable", knownCount: 0,
      total: null, reason: "lifecycle-unavailable", errorCode: null };
    const count = items.filter(item => item.source === source).length;
    return { source, state: "complete", knownCount: count, total: count, reason: null, errorCode: null };
  });
  const value: unknown = { projectId: context.projectId, query: { locale: null, sources: [] }, basis, items, next: null,
    knownCount, total: null, coverage, executionActivity: [], deliveryActivity: [],
    localActions: { journalBasis: "c".repeat(64), journalComplete: true, activity: copy(request.activity ?? null), observations: [] } };
  if (!validateResponsePage(value)) throw new Error("Invalid synthetic decision response");
  return value;
}

function deliveryRecord(): DeliveryRecordView {
  const value: unknown = { releaseId, deliveryId, actionId, state: "unknown", createdAt: "2026-10-29T08:30:00Z", files: [
    { fileName: "dialogue.fr.json", locale: "fr-FR", state: "succeeded", expectedSha256: "d".repeat(64), actualSha256: "d".repeat(64) },
    { fileName: "dialogue.zh.json", locale: "zh-CN", state: "unknown", expectedSha256: "e".repeat(64), actualSha256: null },
  ] };
  if (!validateResponseDeliveryRecord(value) || value === null) throw new Error("Invalid synthetic delivery record");
  return value;
}

beforeEach(async () => {
  localStorage.clear(); history.replaceState(null, "", "/"); await i18n.changeLanguage("en-US");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  fixture = reviewDiagnosticFixture(); knownCount = 2; originalItems = null; basis = "a".repeat(64); reads = new SessionReads(context);
  const target = fixture.target;
  const currentBasis: DraftBasis = { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText };
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {}); vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(sourceCommands, "scope").mockImplementation(async request => {
    expect(request).toEqual(context); return { currentSnapshot: target.sourceSnapshotId, revision: "1" };
  });
  vi.spyOn(segmentCommands, "page").mockImplementation(async request => segmentPage({ ...request.query, status: request.query.status ?? "all" }));
  vi.spyOn(reviewCommands, "editorSnapshot").mockImplementation(async () => copy(fixture.editor));
  vi.spyOn(translationCommands, "history").mockImplementation(async () => copy(fixture.editor.translations));
  vi.spyOn(draftCommands, "list").mockImplementation(async request => {
    expect(request).toEqual({ ...context, after: null, limit: 100 }); return { items: [], next: null };
  });
  vi.spyOn(draftCommands, "read").mockImplementation(async () => ({ head: { key: { projectId: context.projectId, unitId: target.unitId, locale: target.locale },
    revision: "0", writerId: null, value: null }, current: { kind: "current", basis: copy(currentBasis), nativeKey: target.nativeKey, sourceText: target.sourceText } }));
  vi.spyOn(conversationDraftCommands, "list").mockImplementation(async request => {
    expect(request).toEqual({ ...context, after: null, limit: 50 }); return { items: [], next: null };
  });
  vi.spyOn(conversationCommands, "list").mockImplementation(async request => {
    expect(request).toEqual({ ...context, after: null, limit: 50 }); return { projectId: context.projectId, rows: [], nextAfter: null };
  });
  vi.spyOn(pluginCommands, "textReviews").mockResolvedValue({ settingsRevision: "1", entries: [] });
  vi.spyOn(resourceCommands, "suggestions").mockResolvedValue([]);
  vi.spyOn(workPlanCommands, "protection").mockResolvedValue({ unitId: target.unitId, locale: target.locale, protected: false, revision: "0" });
  vi.spyOn(decisionCommands, "page").mockImplementation(async request => {
    expect(validateRequestPage(request)).toBe(true);
    expect(request).toEqual({ ...context, query: { locale: null, sources: [] }, cursor: null, limit: 50, activity: request.activity });
    return decisionPage(request);
  });
  vi.spyOn(releaseCommands, "deliveryRecord").mockImplementation(async request => {
    expect(request).toEqual({ ...context, releaseId, deliveryId, actionId }); return deliveryRecord();
  });
  vi.spyOn(releaseCommands, "deliveryAction").mockRejectedValue(new Error("Recovery must not run from decision details"));
  vi.spyOn(releaseCommands, "choose").mockRejectedValue(new Error("No native destination permission in this fixture"));
  vi.spyOn(releaseCommands, "preview").mockRejectedValue(new Error("Opening a saved record must not preview a destination"));
  vi.spyOn(releaseCommands, "export").mockRejectedValue(new Error("Opening a saved record must not export"));
  vi.spyOn(releaseCommands, "reconcile").mockRejectedValue(new Error("Opening a saved record must not reconcile"));
});
afterEach(() => {
  cleanup(); controller?.dispose(); controller = undefined; reads?.retire();
  if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth); vi.restoreAllMocks();
});

const activity = () => within(screen.getByRole("navigation", { name: w("activity") }));
const dock = () => within(screen.getByRole("complementary", { name: w("agent") }));
const views = () => within(screen.getByRole("navigation", { name: w("views") }));
async function openWorkspace() {
  const user = userEvent.setup();
  controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }), createReads: () => reads,
    status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
  fireEvent.change(screen.getByRole("textbox", { name: w("projectFolder") }), { target: { value: project.locator } });
  await user.click(screen.getByRole("button", { name: w("openProject") }));
  const entry = await screen.findByRole("button", { name: w("showEntryDetails", { key: fixture.target.nativeKey }) }, { timeout: 5000 });
  await waitFor(() => expect(entry).toBeEnabled());
  await waitFor(() => expect(vi.mocked(decisionCommands.page).mock.lastCall?.[0].activity).toHaveLength(2));
  await waitFor(() => expect(reads.client.isFetching({ queryKey: reads.key(["workbench-decisions"]) })).toBe(0));
  await waitFor(() => expect(activity().getByRole("button", { name: w("decisions") })).toBeEnabled());
  return user;
}

it("shares current counts across the activity badge, fixed tray and list, then reads the exact saved delivery and returns without losing the entry view", async () => {
  const user = await openWorkspace();
  expect(activity().getByLabelText(w("decisionsBadgePartial", { count: 2 }))).toHaveTextContent("2+");
  expect(dock().getByRole("button", { name: w("decisionsTrayPartial", { count: 2 }) })).toBeEnabled();
  await user.click(activity().getByRole("button", { name: w("decisions") }));
  const list = await screen.findByRole("region", { name: w("decisionsTitle") });
  await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  expect(within(list).getByText(w("decisionsAtLeastCount", { count: 2 }))).toBeVisible();
  expect(views().getByRole("button", { name: w("viewName", { locale: "zh-CN" }) })).toBeInTheDocument();
  await waitFor(() => expect(reads.client.isFetching({ queryKey: reads.key(["workbench-decisions"]) })).toBe(0));
  const before = vi.mocked(decisionCommands.page).mock.calls.length;
  knownCount = 3; basis = "f".repeat(64);
  act(() => { reads.invalidate(["release"]); });
  await waitFor(() => expect(within(list).getByText(w("decisionsAtLeastCount", { count: 3 }))).toBeVisible());
  expect(activity().getByLabelText(w("decisionsBadgePartial", { count: 3 }))).toHaveTextContent("3+");
  expect(dock().getByRole("button", { name: w("decisionsTrayPartial", { count: 3 }) })).toBeEnabled();
  expect(vi.mocked(decisionCommands.page)).toHaveBeenCalledTimes(before + 1);
  const liveRequest = vi.mocked(decisionCommands.page).mock.lastCall?.[0];
  expect(liveRequest?.activity).toHaveLength(2);
  expect(liveRequest?.activity?.every(owner => owner.actions.length === 0)).toBe(true);

  const open = within(list).getAllByRole("button", { name: w("decisionsDeliveryOpen") })[0];
  if (!open) throw new Error("Synthetic delivery decision required");
  await user.click(open);
  const record = await screen.findByRole("region", { name: i18n.t("workbenchV2.decisionDetailsTitles.inspect-delivery-outcome") });
  await within(record).findByText("dialogue.zh.json");
  expect(screen.getByRole("region", { name: w("decisionTargetRegion") })).toHaveFocus();
  expect(within(record).getByRole("heading", { name: i18n.t("workbenchV2.decisionDetailsDeliveryState.unknown") })).toBeVisible();
  expect(releaseCommands.deliveryRecord).toHaveBeenCalledWith({ ...context, releaseId, deliveryId, actionId });
  for (const read of [releaseCommands.deliveryAction, releaseCommands.choose, releaseCommands.preview, releaseCommands.export, releaseCommands.reconcile]) expect(read).not.toHaveBeenCalled();
  await user.click(within(record).getByRole("button", { name: w("decisionDetailsBack") }));
  expect(await screen.findByRole("region", { name: w("decisionsTitle") })).toBeVisible();
  await waitFor(() => expect(open).toHaveFocus());
  expect(views().getByRole("button", { name: w("viewName", { locale: "zh-CN" }) })).toBeInTheDocument();
  expect(views().getByRole("button", { name: w("decisions") })).toHaveAttribute("aria-current", "page");
});

it("keeps an incomplete zero count unconfirmed and blocks both decision entrances during composition before opening the same list from the tray", async () => {
  knownCount = 0;
  const user = await openWorkspace();
  const tray = dock().getByRole("button", { name: w("decisionsTrayUnknown") });
  expect(activity().getByLabelText(w("decisionsBadgeUnknown"))).toHaveTextContent("?");
  const search = screen.getByRole("textbox", { name: w("searchEntries") });
  fireEvent.compositionStart(search);
  expect(activity().getByRole("button", { name: w("decisions") })).toHaveAttribute("aria-disabled", "true");
  expect(tray).toBeDisabled();
  fireEvent.click(activity().getByRole("button", { name: w("decisions") })); fireEvent.click(tray);
  expect(screen.queryByRole("heading", { level: 1, name: w("decisionsTitle") })).not.toBeInTheDocument();
  fireEvent.compositionEnd(search);
  await waitFor(() => expect(tray).toBeEnabled());
  await user.click(tray);
  const list = await screen.findByRole("region", { name: w("decisionsTitle") });
  expect(within(list).getByText(w("decisionsUnknownCount"))).toBeVisible();
  expect(within(list).getByText(w("decisionsPartialEmpty"))).toBeVisible();
  expect(within(list).queryByText(w("decisionsEmpty"))).not.toBeInTheDocument();
  expect(within(list).queryByText(w("decisionsExactCount", { count: 0 }))).not.toBeInTheDocument();
  expect(activity().getByLabelText(w("decisionsBadgeUnknown"))).toHaveTextContent("?");
  expect(dock().getByRole("button", { name: w("decisionsTrayUnknown") })).toBeEnabled();
  act(() => { Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 980 }); window.dispatchEvent(new Event("resize")); });
  await user.click(await screen.findByRole("button", { name: w("openAgent") }));
  const drawer = await screen.findByRole("dialog", { name: w("agent") });
  await user.click(within(drawer).getByRole("button", { name: w("decisionsTrayUnknown") }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: w("agent") })).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
});

it("opens a saved proposal question at its original conversation version without writing the journal or replacing message input", async () => {
  const conversationId = id(90400), key = { projectId: context.projectId, conversationId };
  const proposal = conversationProposalFixture(key).revision;
  proposal.content.questions = ["Which audience should this proposal use?"];
  knownCount = 1;
  originalItems = [{ decisionId: `agent-question:proposal:${proposal.proposalId}`, source: "agent-question", state: "pending", locale: null,
    targets: [{ kind: "conversation-proposal", conversationId, proposalId: proposal.proposalId }], targetsComplete: true,
    basis: "d".repeat(64), sourceActionId: null, evidence: { kind: "proposal-questions", questionCount: 1 },
    action: { kind: "clarify-conversation-proposal", conversationId, proposalId: proposal.proposalId, revisionId: proposal.revisionId } }];
  vi.spyOn(conversationCommands, "readProposal").mockResolvedValue(proposal);
  vi.spyOn(conversationCommands, "read").mockResolvedValue({ ...key, title: "Original conversation", ordinal: "1" });
  vi.spyOn(conversationDraftCommands, "read").mockResolvedValue({ key, revision: "2", writerId: id(90401),
    value: { text: "Later message input B", editSeq: "2", pending: null, messageEditSeq: "2", proposalEdits: [], revocations: [] } });
  vi.spyOn(conversationCommands, "messages").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "planningAttempts").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "proposalRevisions").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "proposalWorkPlans").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  const write = vi.spyOn(conversationDraftCommands, "write").mockRejectedValue(new Error("Viewing questions cannot write the journal"));
  const user = await openWorkspace();
  await user.click(activity().getByRole("button", { name: w("decisions") }));
  await user.click(await screen.findByRole("button", { name: w("decisionsQuestionOpen") }));
  await screen.findByText("Which audience should this proposal use?");
  expect(screen.getByRole("textbox", { name: i18n.t("conversation.message") })).toHaveValue("Later message input B");
  expect(write).not.toHaveBeenCalled();
  expect(conversationCommands.readProposal).toHaveBeenCalledWith({ ...context, conversationId, proposalId: proposal.proposalId, revisionId: proposal.revisionId });
});

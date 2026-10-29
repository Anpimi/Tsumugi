import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SourceMaintenanceBrief from "./SourceMaintenanceBrief";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { sourceCommands, type SourceChangePage } from "../../../sourceCommands";
import { validateResponseComparison } from "../../../generated/source.validators";
import { sourceReads } from "../../../sourceQueries";
import type { ProjectView } from "../../../projectCommands";
import { i18n } from "../../../i18n";
import { sourceDraftStateFixture } from "../../../testSupport/sourceDraftStateFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import wire from "../../../../test/fixtures/sourceCommands.contract.json";

type Props = ComponentProps<typeof SourceMaintenanceBrief>;
const project: ProjectView = { ...wire.session, locator: "/synthetic/source-brief", reconciliationState: "settled",
  metadata: { projectId: wire.session.projectId, displayName: "Source brief", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const session = { projectId: project.metadata.projectId, sessionToken: project.sessionToken };
const receipt = { actionId: id(901), unitId: id(902), snapshotId: id(903), attemptId: id(904), resultId: id(905) }, base = id(906);
const comparison = wire.comparison;
if (!validateResponseComparison(comparison)) throw new Error("Invalid canonical Source comparison");
const appliedPage: SourceChangePage = { ...comparison, attemptId: receipt.attemptId, resultId: receipt.resultId, previousSnapshotId: base,
  total: 2, filteredTotal: 2, nextOrdinal: 1, counts: { unchanged: 0, moved: 0, changed: 2, added: 0, renameCandidate: 0, ambiguous: 0, removed: 0 }, mappingReviewRequired: 2 };
let reads: SessionReads;
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); reads = new SessionReads(session);
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ revision: "3", currentSnapshot: receipt.snapshotId });
  vi.spyOn(sourceCommands, "compare").mockResolvedValue(appliedPage);
  vi.spyOn(sourceCommands, "impact").mockResolvedValue({ snapshotId: receipt.snapshotId, rows: [], nextOrdinal: null,
    summary: { locale: "zh-CN", preserved: 1, reassess: 1, unresolved: 0, total: 2 } });
});
afterEach(() => { cleanup(); reads.retire(); });
function props(): Props {
  const state = sourceDraftStateFixture().source;
  state.receiptRef = { ...receipt }; state.attempt = receipt.attemptId; state.comparison = appliedPage;
  state.comparisonRef = { attemptId: receipt.attemptId, resultId: receipt.resultId, previousSnapshotId: base,
    expectedContentRevision: "2", expectedCurrentSnapshot: base };
  state.actor = "Newer reviewer B"; state.lineage = { 0: { newOrdinal: 0, oldOccurrenceId: id(907), decision: "continue", reason: "Newer reason B 👩🏽‍💻\n人工理由" } };
  return { project, owner: { state, hasDraft: () => true, hasPending: () => false }, visible: true, disabled: false, locale: "zh-CN",
    onOpen: vi.fn(), onSaved: vi.fn(), onAffected: vi.fn() };
}
function open(value: Props) {
  return render(<SessionReadProvider context={session} reads={reads} bridge={false}><SourceMaintenanceBrief {...value}/></SessionReadProvider>);
}
const appliedRegion = () => screen.getByRole("region", { name: i18n.t("sourceMaintenance.appliedVersion") });
const draftRegion = () => screen.getByRole("region", { name: i18n.t("sourceMaintenance.draftVersion") });

it.each(["en-US", "zh-CN"] as const)("keeps applied A and newer human B distinct with real %s labels and separate destinations", async language => {
  await i18n.changeLanguage(language); const value = props(), before = structuredClone(value.owner.state); open(value);
  expect(await screen.findByText(language === "en-US"
    ? "The new source has been applied. Earlier source versions and translations remain in history."
    : "已采用新的源内容。之前的源版本和译文仍保留在历史中。")).toBeVisible();
  expect(within(draftRegion()).getByText(language === "en-US" ? "These changes have not been applied." : "这些修改还没有采用。")).toBeVisible();
  expect(screen.queryByText(i18n.t("sourceMaintenance.notApplied"))).not.toBeInTheDocument();
  await waitFor(() => expect(within(appliedRegion()).getByText("2")).toBeVisible());
  expect(draftRegion().querySelector("dl")).toBeNull();
  expect(sourceCommands.compare).toHaveBeenCalledExactlyOnceWith({ ...session, attemptId: receipt.attemptId, resultId: receipt.resultId, base, after: 0, limit: 1 });
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.preview") }));
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.viewSaved") }));
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.openAffected") }));
  expect(value.onOpen).toHaveBeenCalledOnce(); expect(value.onSaved).toHaveBeenCalledExactlyOnceWith(receipt.snapshotId);
  expect(value.onAffected).toHaveBeenCalledExactlyOnceWith(receipt.snapshotId); expect(value.owner.state).toEqual(before);
});

it("shows historical A without borrowing the newer B comparison base or inventing A counts", async () => {
  vi.mocked(sourceCommands.scope).mockResolvedValue({ revision: "5", currentSnapshot: id(908) });
  const value = props(), draft = { ...appliedPage, attemptId: id(909), resultId: id(910), previousSnapshotId: id(911), total: 17, filteredTotal: 17,
    counts: { ...appliedPage.counts, changed: 17 }, mappingReviewRequired: 17 };
  value.owner.state.attempt = draft.attemptId; value.owner.state.comparison = draft;
  value.owner.state.comparisonRef = { attemptId: draft.attemptId, resultId: draft.resultId, previousSnapshotId: draft.previousSnapshotId,
    expectedContentRevision: "4", expectedCurrentSnapshot: draft.previousSnapshotId };
  const before = structuredClone(value.owner.state); open(value);
  expect(await screen.findByText("This version was applied earlier. The project now uses another source version.")).toBeVisible();
  expect(appliedRegion().querySelector("dl")).toBeNull(); expect(within(draftRegion()).getByText("17")).toBeVisible();
  expect(sourceCommands.compare).not.toHaveBeenCalled(); expect(sourceCommands.impact).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: i18n.t("sourceMaintenance.openAffected") })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.viewSaved") }));
  expect(value.onSaved).toHaveBeenCalledExactlyOnceWith(receipt.snapshotId); expect(value.owner.state).toEqual(before);
});

it("rejects comparison evidence for another base and retries only the exact saved A read while preserving B", async () => {
  vi.mocked(sourceCommands.compare).mockResolvedValueOnce({ ...appliedPage, previousSnapshotId: id(912) }).mockResolvedValue(appliedPage);
  const value = props(), before = structuredClone(value.owner.state); open(value);
  expect(await within(appliedRegion()).findByText(i18n.t("sourceMaintenance.comparisonFailed"))).toBeVisible();
  expect(appliedRegion().querySelector("dl")).toBeNull(); expect(draftRegion().querySelector("dl")).toBeNull();
  await userEvent.setup().click(within(appliedRegion()).getByRole("button", { name: i18n.t("sourceMaintenance.retryRead") }));
  await waitFor(() => expect(within(appliedRegion()).getByText("2")).toBeVisible());
  expect(vi.mocked(sourceCommands.compare).mock.calls.map(([request]) => request)).toEqual([0, 1].map(() => ({ ...session,
    attemptId: receipt.attemptId, resultId: receipt.resultId, base, after: 0, limit: 1 })));
  expect(value.owner.state).toEqual(before);
});

it("keeps current status unknown after a failed scope read and never opens affected entries from invalidated evidence", async () => {
  vi.mocked(sourceCommands.scope).mockRejectedValueOnce(new Error("Synthetic source scope unavailable")).mockResolvedValue({ revision: "3", currentSnapshot: receipt.snapshotId });
  const value = props(), before = structuredClone(value.owner.state); value.owner.state.comparisonRef = null; open(value);
  expect(await within(appliedRegion()).findByRole("button", { name: i18n.t("sourceMaintenance.retryRead") })).toBeEnabled();
  expect(within(appliedRegion()).getByText("This version was applied. The current source has not yet been confirmed.")).toBeVisible();
  expect(screen.queryByRole("button", { name: i18n.t("sourceMaintenance.openAffected") })).not.toBeInTheDocument();
  expect(sourceCommands.compare).not.toHaveBeenCalled();
  expect(appliedRegion().querySelector("dl")).toBeNull();
  await userEvent.setup().click(within(appliedRegion()).getByRole("button", { name: i18n.t("sourceMaintenance.retryRead") }));
  const affected = await screen.findByRole("button", { name: i18n.t("sourceMaintenance.openAffected") });
  const options = sourceReads.scope(session);
  act(() => {
    void reads.client.invalidateQueries({ queryKey: reads.key(options.key), exact: true, refetchType: "none" });
    fireEvent.click(affected);
  });
  expect(value.onAffected).not.toHaveBeenCalled();
  await act(async () => { reads.client.setQueryData(reads.key(options.key), { revision: "4", currentSnapshot: id(913) }); });
  expect(await screen.findByText("This version was applied earlier. The project now uses another source version.")).toBeVisible();
  expect(screen.queryByRole("button", { name: i18n.t("sourceMaintenance.openAffected") })).not.toBeInTheDocument();
  expect(value.owner.state).toEqual({ ...before, comparisonRef: null });
});

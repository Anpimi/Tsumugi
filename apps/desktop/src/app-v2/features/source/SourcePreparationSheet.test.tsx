import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SourcePreparationSheet from "./SourcePreparationSheet";
import { useSourceDraftSession } from "../../../SourceDraftSession";
import { sourceCommands } from "../../../sourceCommands";
import { sourceDraftCommands } from "../../../sourceDraftCommands";
import { sourceDraftValue } from "../../../sourceDraftJournal";
import { sourceReads } from "../../../sourceQueries";
import { translationCommands } from "../../../translationCommands";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { renderWorkbench } from "../../../testSupport/WorkbenchTestShell";
import { installSourceDraftFixture } from "../../../testSupport/sourceDraftFixture";
import { sourceDraftStateFixture } from "../../../testSupport/sourceDraftStateFixture";
import { sourcePageFixture, sourceRowFixture } from "../../../testSupport/sourceFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import wire from "../../../../test/fixtures/sourceCommands.contract.json";
import { sourceCorrectionBasisFixture, sourceCorrectionReceiptFixture } from "../../../testSupport/sourceCorrectionFixture";
import type { SourceLineageCorrectionRequest } from "../../../sourceCommands";
import { validateResponseSourceObserved } from "../../../generated/draft.validators";

const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...wire.session, locator: "/synthetic/source-history-sheet", reconciliationState: "settled",
  metadata: { projectId: wire.session.projectId, displayName: "Source history", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const snapshotId = id(920), currentSnapshot = id(921), attemptB = id(922);
const row = sourceRowFixture({ unitId: id(923), sourceRevisionId: id(924), occurrenceId: id(925) }, { key: "removed.entry", ordinal: 0, text: "Original {{name}} 世界" });
let owner: ReturnType<typeof useSourceDraftSession>, gate: InteractionGate;
const onEntry = vi.fn(), onClose = vi.fn();
function Harness({ saved = snapshotId, open = true }: { saved?: string | null; open?: boolean }) {
  const value = useSourceDraftSession(); useLayoutEffect(() => { owner = value; });
  return <SourcePreparationSheet project={project} owner={value} gate={gate} viewId="entries" open={open} disabled={false}
    onClose={onClose} onApplied={vi.fn()} onOpenEntry={onEntry} target={null} savedSnapshotId={saved}
    drop={null} dropFailure={null} onDropConsumed={vi.fn()}/>;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  invoke.mockImplementation(async command => { throw new Error(`Unexpected history command: ${command}`); });
  gate = new InteractionGate(); gate.setVisibleOwner("entries");
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ revision: "5", currentSnapshot });
  vi.spyOn(sourceCommands, "historyContent").mockResolvedValue(sourcePageFixture({ snapshotId, rows: [row], total: 1, nextOrdinal: null }));
  vi.spyOn(sourceCommands, "lineage").mockResolvedValue([]);
  vi.spyOn(translationCommands, "history").mockResolvedValue({ unitId: row.unitId!, locale: "zh-CN", current: null,
    currentText: null, total: "0", rows: [], nextOrdinal: null });
});

async function restoreCorrectionForNavigation() {
  installSourceDraftFixture(); const basis = sourceCorrectionBasisFixture(project.metadata.projectId), binding = basis.bindings[0];
  const currentRow = sourceRowFixture({ occurrenceId: binding.occurrenceId, unitId: binding.unitId, sourceRevisionId: binding.sourceRevisionId },
    { ordinal: basis.ordinal, key: "restored.correction.entry", text: "Changed source" });
  const page = sourcePageFixture({ snapshotId: basis.snapshotId, scope: basis.scope, rows: [currentRow], total: 1, nextOrdinal: null });
  vi.mocked(sourceCommands.scope).mockResolvedValue(basis.scope);
  vi.mocked(sourceCommands.historyContent).mockImplementation(async request => request.snapshotId === basis.snapshotId ? page
    : sourcePageFixture({ snapshotId: request.snapshotId, rows: [row], total: 1, nextOrdinal: null }));
  vi.spyOn(sourceCommands, "content").mockResolvedValue(page);
  vi.spyOn(sourceCommands, "correctionBasis").mockResolvedValue(basis);
  vi.mocked(sourceCommands.lineage).mockResolvedValue(basis.candidates);
  vi.mocked(translationCommands.history).mockImplementation(async request => ({ unitId: request.unitId, locale: request.locale,
    current: null, currentText: null, total: "0", rows: [], nextOrdinal: null }));
  vi.spyOn(sourceReads, "inventory").mockImplementation(refresh => ({ key: ["source-plugin-inventory", refresh], scopes: [],
    read: async () => ({ choices: [], environments: [] }) }));
  const inputs = sourceDraftStateFixture();
  inputs.source.actor = "Other import input B 人工";
  inputs.source.correctionDraft = { snapshotId: basis.snapshotId, ordinal: basis.ordinal,
    oldOccurrenceId: basis.candidates[0].old.occurrenceId, decision: "reject", actor: "Correction reviewer", reason: "Restored correction B 👩🏽‍💻" };
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key: { projectId: project.metadata.projectId },
    expectedRevision: "0", writerId: id(2150), value: sourceDraftValue(inputs, "2") } });
  return inputs.source.correctionDraft;
}

it("returns to ordinary source preparation after closing a restored correction presentation", async () => {
  const restored = await restoreCorrectionForNavigation(), view = renderWorkbench(<Harness saved={null}/>, project);
  const recovery = await screen.findByRole("region", { name: i18n.t("sourceMaintenance.recoveryTitle") });
  await userEvent.setup().click(within(recovery).getByRole("button", { name: i18n.t("sourceMaintenance.correctionResume") }));
  expect(screen.getByRole("dialog", { name: i18n.t("sourceMaintenance.savedSource") })).toHaveAccessibleName("Saved source details");
  expect(screen.queryByRole("combobox", { name: i18n.t("source.integration") })).not.toBeInTheDocument();
  view.rerender(<Harness saved={null} open={false}/>, project);
  view.rerender(<Harness saved={null}/>, project);
  expect(await screen.findByRole("combobox", { name: i18n.t("source.integration") })).toBeVisible();
  expect(screen.getByRole("dialog", { name: i18n.t("sourceMaintenance.title") })).toHaveAccessibleName("Import an upstream version");
  expect(owner.current().correctionDraft).toEqual(restored); expect(owner.current().actor).toBe("Other import input B 人工");
});

it("opens a different saved snapshot after restoring a correction in the same sheet", async () => {
  const restored = await restoreCorrectionForNavigation(), view = renderWorkbench(<Harness saved={null}/>, project);
  const recovery = await screen.findByRole("region", { name: i18n.t("sourceMaintenance.recoveryTitle") });
  await userEvent.setup().click(within(recovery).getByRole("button", { name: i18n.t("sourceMaintenance.correctionResume") }));
  expect(await screen.findByRole("button", { name: "restored.correction.entry" })).toBeVisible();
  view.rerender(<Harness saved={snapshotId}/>, project);
  expect(await screen.findByRole("button", { name: "removed.entry" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "restored.correction.entry" })).not.toBeInTheDocument();
  expect(sourceCommands.historyContent).toHaveBeenCalledWith({ ...wire.session, snapshotId, query: "", after: 0, limit: 20 });
  expect(owner.current().correctionDraft).toEqual(restored); expect(owner.current().actor).toBe("Other import input B 人工");
});

it("returns to ordinary source preparation after discarding only the restored correction", async () => {
  await restoreCorrectionForNavigation(); renderWorkbench(<Harness saved={null}/>, project); const user = userEvent.setup();
  const recovery = await screen.findByRole("region", { name: i18n.t("sourceMaintenance.recoveryTitle") });
  await user.click(within(recovery).getByRole("button", { name: i18n.t("sourceMaintenance.correctionResume") }));
  const panel = await screen.findByRole("region", { name: i18n.t("sourceMaintenance.correctionTitle") });
  await user.click(within(panel).getByRole("button", { name: i18n.t("sourceMaintenance.correctionResume") }));
  await waitFor(() => expect(within(panel).getByRole("button", { name: i18n.t("sourceMaintenance.correctionDiscard") })).toBeEnabled());
  await user.click(within(panel).getByRole("button", { name: i18n.t("sourceMaintenance.correctionDiscard") }));
  await user.click(within(panel).getByRole("button", { name: i18n.t("sourceMaintenance.correctionDiscardConfirm") }));
  expect(await screen.findByRole("combobox", { name: i18n.t("source.integration") })).toBeVisible();
  await waitFor(() => expect(owner.current().correctionDraft).toBeNull());
  expect(owner.current().actor).toBe("Other import input B 人工");
  await act(async () => { await owner.flush(); });
  const stored = await sourceDraftCommands.read({ sessionToken: project.sessionToken, key: { projectId: project.metadata.projectId } });
  expect(stored.value?.correction).toBeUndefined(); expect(stored.value?.actor).toBe("Other import input B 人工");
});

it("keeps the mounted correction input and selection when recovered A settles with newer B in the real sheet", async () => {
  installSourceDraftFixture(); const basis = sourceCorrectionBasisFixture(project.metadata.projectId), binding = basis.bindings[0];
  const currentRow = sourceRowFixture({ occurrenceId: binding.occurrenceId, unitId: binding.unitId, sourceRevisionId: binding.sourceRevisionId },
    { ordinal: basis.ordinal, key: "current", text: "Changed source" });
  const page = sourcePageFixture({ snapshotId: basis.snapshotId, scope: basis.scope, rows: [currentRow], total: 1, nextOrdinal: null });
  vi.mocked(sourceCommands.scope).mockResolvedValue(basis.scope); vi.mocked(sourceCommands.historyContent).mockResolvedValue(page);
  vi.spyOn(sourceCommands, "content").mockResolvedValue(page); vi.mocked(sourceCommands.lineage).mockResolvedValue(basis.candidates);
  vi.mocked(translationCommands.history).mockImplementation(async request => ({ unitId: request.unitId, locale: request.locale,
    current: null, currentText: null, total: "0", rows: [], nextOrdinal: null }));
  const request: SourceLineageCorrectionRequest = { ...wire.session, correction: { projectId: project.metadata.projectId, actionId: id(2140), basis,
    oldOccurrenceId: basis.candidates[0].old.occurrenceId!, decision: "continue", actor: "Recorder A", reason: "Submitted A" } };
  const inputs = sourceDraftStateFixture(); inputs.source.correctionDraft = { snapshotId: basis.snapshotId, ordinal: basis.ordinal,
    oldOccurrenceId: request.correction.oldOccurrenceId, decision: "continue", actor: "Recorder A", reason: "Submitted A" };
  inputs.source.pendingCorrection = request; inputs.source.editSeq = 1;
  inputs.source.submission = { submittedSeq: "1", submittedMappingSeq: 1 };
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key: { projectId: project.metadata.projectId },
    expectedRevision: "0", writerId: id(2141), value: sourceDraftValue(inputs, "2") } });
  let complete!: () => void;
  const observe = vi.spyOn(sourceDraftCommands, "observe").mockImplementation(input => new Promise(resolve => {
    complete = () => {
      const value = { target: input.target, observation: { kind: "lineage-corrected", receipt: sourceCorrectionReceiptFixture(request) } };
      if (!validateResponseSourceObserved(value)) throw new Error("Invalid synthetic correction observation");
      resolve(value);
    };
  }));
  renderWorkbench(<Harness saved={null}/>, project); const user = userEvent.setup();
  const panel = await screen.findByRole("region", { name: i18n.t("sourceMaintenance.correctionTitle") });
  await user.click(within(panel).getByRole("button", { name: i18n.t("sourceMaintenance.correctionResume") }));
  const field = within(panel).getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("sourceMaintenance.correctionReason") });
  await user.click(within(panel).getByRole("button", { name: i18n.t("sourceMaintenance.correctionCheck") }));
  await waitFor(() => expect(observe).toHaveBeenCalledOnce());
  fireEvent.change(field, { target: { value: "Newer B 👩🏽‍💻\n人工理由" } });
  act(() => { field.focus(); field.setSelectionRange(2, 7, "backward"); });
  fireEvent.compositionStart(field);
  await act(async () => { complete(); });
  await waitFor(() => expect(owner.current().pendingCorrection).toBeNull());
  expect(screen.getByRole("textbox", { name: i18n.t("sourceMaintenance.correctionReason") })).toBe(field);
  expect(field).toHaveFocus(); expect(field).toHaveValue("Newer B 👩🏽‍💻\n人工理由");
  expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(7); expect(field.selectionDirection).toBe("backward");
  expect(gate.getSnapshot().composingOwners).toHaveLength(1); fireEvent.compositionEnd(field);
  expect(gate.getSnapshot().composingOwners).toHaveLength(0);
  expect(owner.current().correctionReceipt?.request.reason).toBe("Submitted A"); expect(observe).toHaveBeenCalledOnce();
});
afterEach(cleanup);

it.each(["en-US", "zh-CN"] as const)("opens saved A through real %s presentation without selecting a current entry or disturbing B", async language => {
  await i18n.changeLanguage(language); installSourceDraftFixture();
  const inputs = sourceDraftStateFixture(); inputs.source.actor = "Retained reviewer B 人工"; inputs.source.attempt = attemptB;
  inputs.source.receiptRef = { actionId: id(926), unitId: id(927), snapshotId, attemptId: id(928), resultId: id(929) };
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key: { projectId: project.metadata.projectId },
    expectedRevision: "0", writerId: id(930), value: sourceDraftValue(inputs, "2") } });
  const picker = vi.spyOn(sourceCommands, "selectPlugin"), start = vi.spyOn(sourceCommands, "startPlugin");
  renderWorkbench(<Harness/>, project);
  await waitFor(() => expect(owner.journal.hydration).toBe("ready"));
  const dialog = await screen.findByRole("dialog", { name: i18n.t("sourceMaintenance.savedSource") });
  expect(dialog).toHaveAccessibleName(language === "en-US" ? "Saved source details" : "已保存的源内容详情");
  await userEvent.setup().click(await screen.findByRole("button", { name: "removed.entry" }));
  expect(await screen.findByText(i18n.t("sourceMaintenance.noSavedTranslations"))).toBeVisible();
  expect(sourceCommands.historyContent).toHaveBeenCalledExactlyOnceWith({ ...wire.session, snapshotId, query: "", after: 0, limit: 20 });
  expect(translationCommands.history).toHaveBeenCalledExactlyOnceWith({ ...wire.session, unitId: row.unitId, locale: "zh-CN", afterOrdinal: "0", limit: 20 });
  expect(screen.queryByRole("button", { name: i18n.t("sourceMaintenance.openCurrentEntry") })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: i18n.t("source.integration") })).not.toBeInTheDocument();
  expect(onEntry).not.toHaveBeenCalled(); expect(picker).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(invoke.mock.calls.some(([command]) => String(command).includes("connection") || command === "read_plugin_inventory")).toBe(false);
  expect(owner.current().actor).toBe("Retained reviewer B 人工"); expect(owner.current().attempt).toBe(attemptB);
  await act(async () => { await owner.flush(); });
  const stored = await sourceDraftCommands.read({ sessionToken: project.sessionToken, key: { projectId: project.metadata.projectId } });
  expect(stored.value?.actor).toBe("Retained reviewer B 人工"); expect(stored.value?.attemptId).toBe(attemptB);
});

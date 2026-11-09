import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pluginInventoryReadKey, useApplicationQueryClient } from "../../../ApplicationReadProvider";
import SourcePreparationSheet from "./SourcePreparationSheet";
import { useSourceDraftSession } from "../../../SourceDraftSession";
import { sourceCommands, type SourceAdoptRequest } from "../../../sourceCommands";
import { sourceDraftCommands } from "../../../sourceDraftCommands";
import { sourceDraftValue } from "../../../sourceDraftJournal";
import { sourceReads } from "../../../sourceQueries";
import { translationCommands } from "../../../translationCommands";
import { i18n } from "../../../i18n";
import type { CommandError, ProjectView } from "../../../projectCommands";
import { renderWorkbench, refreshWorkbenchReads } from "../../../testSupport/WorkbenchTestShell";
import { installSourceDraftFixture } from "../../../testSupport/sourceDraftFixture";
import { sourceDraftStateFixture } from "../../../testSupport/sourceDraftStateFixture";
import { sourceActionFixture, sourceAttemptFixture, sourcePageFixture, sourceReceiptFixture, sourceRowFixture } from "../../../testSupport/sourceFixture";
import { pluginSourceInventory, pluginSourcePackage, pluginSourceRequest, pluginSourceView, pluginSourceWorkflow } from "../../../testSupport/pluginSourceFixture";
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
let owner: ReturnType<typeof useSourceDraftSession>, applicationReads: ReturnType<typeof useApplicationQueryClient>, gate: InteractionGate;
const onEntry = vi.fn(), onClose = vi.fn();
function Harness({ saved = snapshotId, open = true }: { saved?: string | null; open?: boolean }) {
  const value = useSourceDraftSession(), client = useApplicationQueryClient(); useLayoutEffect(() => { owner = value; applicationReads = client; });
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

it.each(["runtime", "package"] as const)("preserves the captured import and requires fresh consent after its %s disappears and returns", async unavailable => {
  const resultId = id(2170), checkerTask = id(2180);
  let checkerAttempt: string | null = null, cancelled = false;
  let nextIdentity = 2171;
  let inventory = structuredClone(pluginSourceInventory);
  invoke.mockImplementation(async (command, { request }) => {
    if (command === "read_plugin_inventory") return inventory;
    if (command === "read_plugin_package") return pluginSourcePackage;
    if (command === "read_plugin_source") return pluginSourceView;
    if (command === "select_plugin_source") return pluginSourceWorkflow.selection;
    if (command === "create_execution_identity") return id(nextIdentity++);
    if (command === "preflight_plugin_source") return { ...pluginSourceWorkflow.preflight, attemptId: request.attemptId, sourceLanguage: "en" };
    if (command === "start_plugin_source") return request.attemptId;
    if (command === "start_source_check") { checkerAttempt = request.attemptId; return checkerAttempt; }
    if (command === "cancel_execution_task") { expect(request.taskId).toBe(checkerTask); cancelled = true; return "1"; }
    if (command === "read_execution_attempt") {
      const detail = sourceAttemptFixture(request.attemptId, resultId);
      detail.items[0].status.validation = "pending";
      if (checkerAttempt === request.attemptId) {
        detail.operation = "source-semantic-check";
        detail.taskId = checkerTask;
        detail.progress = { ...detail.progress, succeeded: 0, running: cancelled ? 0 : 1, cancelled: cancelled ? 1 : 0 };
        detail.items[0].resultId = null;
        detail.items[0].status.execution = cancelled ? "cancelled-before-dispatch" : "dispatched";
        detail.items[0].status.cancellationRequested = cancelled;
      }
      return detail;
    }
    if (command === "prepare_source_check") return { ...pluginSourceWorkflow.checkReview, attemptId: request.attemptId,
      sourceAttemptId: request.sourceAttemptId, sourceResultId: request.sourceResultId };
    throw new Error(`Unexpected source flow command: ${command}`);
  });
  installSourceDraftFixture();
  renderWorkbench(<Harness saved={null}/>, project);
  const user = userEvent.setup(), calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
  const importer = await screen.findByRole("combobox", { name: i18n.t("source.integration") });
  await waitFor(() => expect(importer).toBeEnabled());
  await user.selectOptions(importer, `${pluginSourceRequest.package.packageDigest}:${pluginSourceRequest.resourceId}`);
  await user.selectOptions(screen.getByRole("combobox", { name: i18n.t("sourcePlugin.runtime") }), pluginSourceRequest.environmentDigest);
  const folder = screen.getByRole("button", { name: i18n.t("sourceMaintenance.chooseFolder") });
  await waitFor(() => expect(folder).toBeEnabled());
  await user.click(folder);
  const language = await screen.findByRole("checkbox", { name: i18n.t("source.language", { language: "en" }) });
  await waitFor(() => expect(language).toBeEnabled());
  expect(calls("preflight_plugin_source")).toHaveLength(0);
  await user.click(language);
  const review = await screen.findByRole("region", { name: i18n.t("sourceMaintenance.capturedInput") });
  expect(calls("preflight_plugin_source")).toHaveLength(1);
  const start = within(review).getByRole("button", { name: i18n.t("source.start") });
  expect(start).toBeDisabled();
  expect(calls("start_plugin_source")).toHaveLength(0);
  const consent = within(review).getByRole("checkbox", { name: i18n.t("sourcePlugin.producerConsent") });
  await waitFor(() => expect(consent).toBeEnabled());
  await user.click(consent);
  expect(consent).toBeChecked();
  const captured = owner.current().preflight;
  inventory = { ...inventory, settingsRevision: "2", ...(unavailable === "runtime" ? { runtimeDecisions: [] } : { packageDecisions: [] }) };
  act(() => { applicationReads.setQueryData(pluginInventoryReadKey, inventory); });
  expect(await screen.findByText(i18n.t(unavailable === "runtime" ? "sourceMaintenance.selectedRuntimeUnavailable" : "sourceMaintenance.selectedPackageUnavailable"))).toBeVisible();
  expect(start).toBeDisabled();
  expect(consent).not.toBeChecked();
  expect(owner.current().preflight).toEqual(captured);
  expect(calls("start_plugin_source")).toHaveLength(0);
  inventory = { ...pluginSourceInventory, settingsRevision: "3" };
  act(() => { applicationReads.setQueryData(pluginInventoryReadKey, inventory); });
  await waitFor(() => expect(consent).toBeEnabled());
  expect(start).toBeDisabled();
  await user.click(consent);
  await user.click(start);
  await waitFor(() => expect(calls("prepare_source_check")).toHaveLength(1));
  expect(calls("prepare_source_check")[0][1].request).toMatchObject({ sourceAttemptId: calls("start_plugin_source")[0][1].request.attemptId, sourceResultId: resultId });
  expect(await screen.findByText(i18n.t("sourceMaintenance.phaseCheckerReview"))).toBeVisible();
  expect(screen.getByRole("button", { name: i18n.t("sourceMaintenance.startCheck") })).toBeDisabled();
  expect(calls("start_source_check")).toHaveLength(0);
  const checkerConsent = screen.getByRole("checkbox", { name: i18n.t("sourcePlugin.checkerConsent") });
  await user.click(checkerConsent);
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.startCheck") }));
  const stop = await screen.findByRole("button", { name: i18n.t("sourceMaintenance.stopCheck") });
  await waitFor(() => expect(stop).toBeEnabled());
  await user.click(stop);
  const replace = await screen.findByRole("button", { name: i18n.t("sourceMaintenance.prepareReplacementCheck") });
  await waitFor(() => expect(replace).toBeEnabled());
  expect(calls("prepare_source_check")).toHaveLength(1);
  await user.click(replace);
  await waitFor(() => expect(calls("prepare_source_check")).toHaveLength(2));
  const [first, second] = calls("prepare_source_check").map(([, value]) => value.request);
  expect(second).toEqual({ ...first, attemptId: second.attemptId });
  expect(second.attemptId).not.toBe(first.attemptId);
  expect(await screen.findByRole("button", { name: i18n.t("sourceMaintenance.startCheck") })).toBeDisabled();
  expect(calls("start_plugin_source")).toHaveLength(1);
  expect(calls("start_source_check")).toHaveLength(1);
  expect(calls("adopt_execution")).toHaveLength(0);
});

it("reviews later pages of a first import and applies the complete checked result", async () => {
  const nextOrdinal = 37, total = 52, actionId = id(2190);
  const { attemptId, resultId } = wire.preview;
  const rows = Array.from({ length: total }, (_, ordinal) => sourceRowFixture({}, {
    ordinal, key: `source.entry.${ordinal}`, text: `Source text ${ordinal}`, operationOccurrenceId: id(2200 + ordinal),
  }));
  const first = sourcePageFixture({ rows: rows.slice(0, nextOrdinal), total, nextOrdinal });
  const last = { ...first, rows: rows.slice(nextOrdinal), nextOrdinal: null };
  const otherResult = { ...last, confirmation: { ...last.confirmation, resultDigest: "b".repeat(64) } };
  let readLaterPage = 0, adoption: SourceAdoptRequest | null = null;
  vi.mocked(sourceCommands.scope).mockResolvedValue(first.scope);
  invoke.mockImplementation(async (command, { request }) => {
    if (command === "read_plugin_inventory") return pluginSourceInventory;
    if (command === "read_plugin_package") return pluginSourcePackage;
    if (command === "read_execution_attempt") return sourceAttemptFixture(attemptId, resultId);
    if (command === "read_source_preview") {
      if (request.after === 0) return first;
      if (request.after === nextOrdinal) return ++readLaterPage === 1 ? otherResult : last;
    }
    if (command === "create_execution_identity") return actionId;
    if (command === "prepare_source_adoption") {
      const original: SourceAdoptRequest = request;
      adoption = original;
      return sourceActionFixture(original);
    }
    if (command === "adopt_execution" && adoption) return sourceReceiptFixture(adoption);
    throw new Error(`Unexpected initial source preview command: ${command}`);
  });
  installSourceDraftFixture();
  const inputs = sourceDraftStateFixture();
  inputs.source.attempt = attemptId;
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key: { projectId: project.metadata.projectId },
    expectedRevision: "0", writerId: id(2191), value: sourceDraftValue(inputs, "2") } });
  renderWorkbench(<Harness saved={null}/>, project);
  const user = userEvent.setup(), button = (name: string) => screen.getByRole("button", { name });
  await user.click(await screen.findByRole("button", { name: i18n.t("sourceMaintenance.preview") }));
  expect(await screen.findByText("source.entry.0")).toBeVisible();
  expect(screen.queryByText("source.entry.37")).not.toBeInTheDocument();
  const confirm = screen.getByRole("checkbox", { name: i18n.t("sourceMaintenance.confirmApply", { count: total }) });
  const applyName = i18n.t("sourceMaintenance.apply");
  await user.click(confirm);
  expect(button(applyName)).toBeEnabled();

  const nextName = i18n.t("sourceMaintenance.nextPage");
  await user.click(button(nextName));
  expect(await screen.findByText(i18n.t("sourceMaintenance.previewPageFailed"))).toBeVisible();
  expect(screen.queryByText("source.entry.37")).not.toBeInTheDocument();
  expect(button(applyName)).toBeDisabled();
  expect(adoption).toBeNull();
  await user.click(button(i18n.t("sourceMaintenance.retryRead")));
  expect(await screen.findByText("source.entry.37")).toBeVisible();
  expect(screen.queryByText("source.entry.0")).not.toBeInTheDocument();
  expect(button(nextName)).toBeDisabled();
  expect(screen.getByText(i18n.t("sourceMaintenance.initialEntries", { count: total }))).toBeVisible();
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_preview").map(([, payload]) => payload.request))
    .toEqual([0, nextOrdinal, nextOrdinal].map(after => ({ ...wire.session, attemptId, resultId, after, limit: 50 })));

  await user.click(button(i18n.t("sourceMaintenance.firstPage")));
  expect(await screen.findByText("source.entry.0")).toBeVisible();
  expect(screen.queryByText("source.entry.37")).not.toBeInTheDocument();
  await user.click(button(nextName));
  expect(await screen.findByText("source.entry.37")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: i18n.t("sourceMaintenance.confirmApply", { count: total }) })).toBeChecked();
  await waitFor(() => expect(button(applyName)).toBeEnabled());
  await user.click(button(applyName));
  await waitFor(() => expect(owner.current().receiptRef).toMatchObject({ actionId, attemptId, resultId }));
  expect(adoption).toEqual({ ...wire.session, actionId, attemptId, resultId, confirmation: first.confirmation });
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toEqual([["adopt_execution", { request: { ...wire.session, actionId } }]]);
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
    read: async () => ({ settingsRevision: "1", choices: [], environments: [] }) }));
  const inputs = sourceDraftStateFixture();
  inputs.source.actor = "Other import input B 人工";
  inputs.source.correctionDraft = { snapshotId: basis.snapshotId, ordinal: basis.ordinal,
    oldOccurrenceId: basis.candidates[0].old.occurrenceId, decision: "reject", actor: "Correction reviewer", reason: "Restored correction B 👩🏽‍💻" };
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key: { projectId: project.metadata.projectId },
    expectedRevision: "0", writerId: id(2150), value: sourceDraftValue(inputs, "2") } });
  return inputs.source.correctionDraft;
}

it.each(["en-US", "zh-CN"] as const)("retains importer choices and diagnostic details until an inventory retry succeeds in %s", async language => {
  await i18n.changeLanguage(language);
  const failure: CommandError = { code: "busy", stage: "read", outcome: "rejected", recoveryRequired: false,
    reason: "synthetic-inventory-busy", diagnosticId: id(2160), recoveryGuidance: "review-current" };
  let unavailable = false;
  invoke.mockImplementation(async command => {
    if (command === "read_plugin_inventory") { if (unavailable) throw failure; return pluginSourceInventory; }
    if (command === "read_plugin_package") return pluginSourcePackage;
    if (command === "read_plugin_source") return pluginSourceView;
    throw new Error(`Unexpected source preparation command: ${command}`);
  });
  renderWorkbench(<Harness saved={null}/>, project); const user = userEvent.setup();
  const importer = await screen.findByRole("combobox", { name: i18n.t("source.integration") });
  await waitFor(() => expect(importer).toBeEnabled());
  const key = `${pluginSourceRequest.package.packageDigest}:${pluginSourceRequest.resourceId}`;
  await user.selectOptions(importer, key);
  const runtime = screen.getByRole("combobox", { name: i18n.t("sourcePlugin.runtime") });
  await user.selectOptions(runtime, pluginSourceRequest.environmentDigest);
  const choose = screen.getByRole("button", { name: i18n.t("sourceMaintenance.chooseFolder") });
  await waitFor(() => expect(choose).toBeEnabled());
  const source = structuredClone(owner.current().source);
  unavailable = true; await refreshWorkbenchReads(["project"]);
  expect(await screen.findByText(i18n.t("sourceMaintenance.importersFailed"))).toBeVisible();
  expect(importer).toHaveValue(key); expect(runtime).toHaveValue(pluginSourceRequest.environmentDigest);
  expect(importer).toBeDisabled(); expect(runtime).toBeDisabled(); expect(choose).toBeDisabled();
  await user.click(screen.getByText(i18n.t("execution.diagnostic")));
  expect(screen.getByText(failure.diagnosticId!)).toBeVisible(); expect(screen.getByText(failure.reason!)).toBeVisible();
  expect(screen.getByText(i18n.t("commandError.recovery.review-current"))).toBeVisible();
  unavailable = false; await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.retryRead") }));
  await waitFor(() => expect(choose).toBeEnabled());
  expect(screen.queryByText(i18n.t("sourceMaintenance.importersFailed"))).not.toBeInTheDocument();
  expect(screen.queryByText(failure.diagnosticId!)).not.toBeInTheDocument();
  expect(owner.current().source).toEqual(source); expect(importer).toHaveValue(key); expect(runtime).toHaveValue(pluginSourceRequest.environmentDigest);
  expect(invoke.mock.calls.some(([command]) => ["select_plugin_source", "preflight_plugin_source", "start_plugin_source"].includes(command))).toBe(false);
});

it.each(["en-US", "zh-CN"] as const)("keeps the selected importer unavailable until its failed read is retried in %s", async language => {
  await i18n.changeLanguage(language);
  const failure: CommandError = { code: "busy", stage: "read", outcome: "rejected", recoveryRequired: false,
    reason: "synthetic-integration-busy", diagnosticId: id(2161) };
  let unavailable = false;
  invoke.mockImplementation(async command => {
    if (command === "read_plugin_inventory") return pluginSourceInventory;
    if (command === "read_plugin_package") return pluginSourcePackage;
    if (command === "read_plugin_source") { if (unavailable) throw failure; return pluginSourceView; }
    throw new Error(`Unexpected source preparation command: ${command}`);
  });
  renderWorkbench(<Harness saved={null}/>, project); const user = userEvent.setup();
  const importer = await screen.findByRole("combobox", { name: i18n.t("source.integration") });
  await waitFor(() => expect(importer).toBeEnabled());
  const key = `${pluginSourceRequest.package.packageDigest}:${pluginSourceRequest.resourceId}`;
  await user.selectOptions(importer, key);
  const runtime = screen.getByRole("combobox", { name: i18n.t("sourcePlugin.runtime") });
  await user.selectOptions(runtime, pluginSourceRequest.environmentDigest);
  const choose = screen.getByRole("button", { name: i18n.t("sourceMaintenance.chooseFolder") });
  await waitFor(() => expect(choose).toBeEnabled());
  const source = structuredClone(owner.current().source);
  unavailable = true; await refreshWorkbenchReads(["source"]);
  expect(await screen.findByText(i18n.t("sourceMaintenance.importerUnavailable"))).toBeVisible();
  expect(choose).toBeDisabled(); expect(importer).toHaveValue(key); expect(runtime).toHaveValue(pluginSourceRequest.environmentDigest);
  await user.click(screen.getByText(i18n.t("execution.diagnostic")));
  expect(screen.getByText(failure.diagnosticId!)).toBeVisible(); expect(screen.getByText(failure.reason!)).toBeVisible();
  unavailable = false; await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.retryRead") }));
  await waitFor(() => expect(choose).toBeEnabled());
  expect(screen.queryByText(i18n.t("sourceMaintenance.importerUnavailable"))).not.toBeInTheDocument();
  expect(screen.queryByText(failure.diagnosticId!)).not.toBeInTheDocument();
  expect(owner.current().source).toEqual(source); expect(importer).toHaveValue(key); expect(runtime).toHaveValue(pluginSourceRequest.environmentDigest);
  expect(invoke.mock.calls.some(([command]) => ["select_plugin_source", "preflight_plugin_source", "start_plugin_source"].includes(command))).toBe(false);
});

it("opens the adopted source and its correction from an ordinary sheet without a local adoption receipt", async () => {
  const basis = sourceCorrectionBasisFixture(project.metadata.projectId), binding = basis.bindings[0];
  const currentRow = sourceRowFixture({ occurrenceId: binding.occurrenceId, unitId: binding.unitId, sourceRevisionId: binding.sourceRevisionId },
    { ordinal: basis.ordinal, key: "restored.adopted.entry", text: "Saved source" });
  const page = sourcePageFixture({ snapshotId: basis.snapshotId, scope: basis.scope, rows: [currentRow], total: 1, nextOrdinal: null });
  vi.mocked(sourceCommands.scope).mockResolvedValue(basis.scope);
  vi.mocked(sourceCommands.historyContent).mockResolvedValue(page);
  vi.spyOn(sourceCommands, "content").mockResolvedValue(page);
  const correction = vi.spyOn(sourceCommands, "correctionBasis").mockResolvedValue(basis);
  vi.mocked(translationCommands.history).mockResolvedValue({ unitId: currentRow.unitId!, locale: "zh-CN", current: null,
    currentText: null, total: "0", rows: [], nextOrdinal: null });
  invoke.mockImplementation(async command => {
    if (command === "read_plugin_inventory") return { ...pluginSourceInventory, packages: [], runtimes: [] };
    throw new Error(`Unexpected native command: ${command}`);
  });
  renderWorkbench(<Harness saved={null}/>, project); const user = userEvent.setup();
  await waitFor(() => expect(owner.journal.hydration).toBe("ready"));
  expect(owner.current().receiptRef).toBeNull();
  const entry = await screen.findByRole("button", { name: "View current saved source" });
  expect(sourceCommands.historyContent).not.toHaveBeenCalled();
  await user.click(entry);
  const saved = screen.getByRole("dialog", { name: i18n.t("sourceMaintenance.savedSource") });
  await user.click(await within(saved).findByRole("button", { name: "restored.adopted.entry" }));
  await user.click(await within(saved).findByRole("button", { name: i18n.t("sourceMaintenance.correctionOpen") }));
  await waitFor(() => expect(correction).toHaveBeenCalledExactlyOnceWith({ ...wire.session, snapshotId: basis.snapshotId, ordinal: basis.ordinal }));
  await user.click(within(saved).getByRole("button", { name: "Back to source import" }));
  expect(screen.getByRole("dialog", { name: i18n.t("sourceMaintenance.title") })).toBeVisible();
  expect(owner.current().correctionDraft).toMatchObject({ snapshotId: basis.snapshotId, ordinal: basis.ordinal });
});

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


it.each([false, true])("explains file-set choices and shows the returned names before capture or execution (shared budget: %s)", async shared => {
  const view = { ...pluginSourceView, declaration: { ...pluginSourceView.declaration, materials: [], ...(shared ? { maxTotalBytes: 1024 } : {}), fileSets: [
    { id: "records", displayName: "Record files", role: "source", encoding: "binary", extensions: ["esp", "esl"], minFiles: shared ? 0 : 1, maxFiles: 1, maxBytes: 1024 },
    { id: "tables", displayName: "Companion tables", role: "companion", encoding: "binary", extensions: ["strings"], minFiles: 0, maxFiles: 1, maxBytes: 1024 },
  ] } };
  const pkg = structuredClone(pluginSourcePackage);
  for (const entry of pkg.manifest.contributions) if (entry.contribution.kind === "resource" && entry.contribution.schema.id === "tsumugi.source-import-declaration") entry.contribution.schema.schemaVersion = shared ? 5 : 4;
  invoke.mockImplementation(async command => {
    if (command === "read_plugin_inventory") return pluginSourceInventory;
    if (command === "read_plugin_package") return pkg;
    if (command === "read_plugin_source") return view;
    if (command === "select_plugin_source") return { ...pluginSourceWorkflow.selection, source: view, fileSets: [{ id: "records", logicalPaths: ["Chosen.ESP"] }] };
    throw new Error(`Unexpected file-set command: ${command}`);
  });
  installSourceDraftFixture(); renderWorkbench(<Harness saved={null}/>, project);
  const user = userEvent.setup();
  const importer = await screen.findByRole("combobox", { name: i18n.t("source.integration") });
  await waitFor(() => expect(importer).toBeEnabled());
  await user.selectOptions(importer, `${pluginSourceRequest.package.packageDigest}:${pluginSourceRequest.resourceId}`);
  await user.selectOptions(screen.getByRole("combobox", { name: i18n.t("sourcePlugin.runtime") }), pluginSourceRequest.environmentDigest);
  expect(await screen.findByText(i18n.t("sourceMaintenance.fileSetHelp"))).toBeVisible();
  expect(screen.getByText(i18n.t(shared ? "sourceMaintenance.optionalFileSet" : "sourceMaintenance.fileSet", { name: "Record files", min: shared ? 0 : 1, max: 1, extensions: "esp, esl", bytes: 1024 }))).toBeVisible();
  if (shared) {
    expect(screen.getByText(i18n.t("sourceMaintenance.totalMaterialLimit", { bytes: 1024 }))).toBeVisible();
    expect(screen.getByText(i18n.t("sourceMaintenance.fileSetMinimum"))).toBeVisible();
  }
  const folder = screen.getByRole("button", { name: i18n.t("sourceMaintenance.chooseFolder") });
  await waitFor(() => expect(folder).toBeEnabled()); await user.click(folder);
  expect(await screen.findByRole("list", { name: i18n.t("sourceMaintenance.selectedFiles") })).toHaveTextContent("Chosen.ESP");
  expect(invoke.mock.calls.some(([name]) => ["preflight_plugin_source", "start_plugin_source", "start_source_check"].includes(name))).toBe(false);
});

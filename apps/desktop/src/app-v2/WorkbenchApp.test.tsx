import { RECENT_PROJECTS_STORAGE_KEY, readRecentProject } from "../recentProjects";
import * as tauriCore from "@tauri-apps/api/core";
import * as tauriEvents from "@tauri-apps/api/event";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useCallback, useLayoutEffect, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { i18n } from "../i18n";
import { SessionReads } from "../sessionReads";
import { sourceCommands, type NativeSourceDropEvent, type SourceContextPage } from "../sourceCommands";
import { sourceDraftCommands, type SourceDraftHead } from "../sourceDraftCommands";
import { sourceDraftValue } from "../sourceDraftJournal";
import { sourceDraftStateFixture } from "../testSupport/sourceDraftStateFixture";
import { pluginCommands } from "../pluginCommands";
import { pluginSourceInventory, pluginSourcePackage, pluginSourceRequest, pluginSourceView, pluginSourceWorkflow } from "../testSupport/pluginSourceFixture";
import { startupCommands, type StartupDropEvent } from "../startupCommands";
import type { KnowledgeOwner } from "./features/knowledge/knowledgeTypes";
import type { SourceOwner } from "./features/source/sourceTypes";
import { segmentCommands, type SegmentPage } from "../segmentCommands";
import { decisionCommands } from "../decisionCommands";
import { draftCommands } from "../draftCommands";
import { conversationCommands } from "../conversationCommands";
import { canonicalConversationDraft, conversationDraftCommands } from "../conversationDraftCommands";
import type { ConversationDraftHead } from "../conversationDraftCommands";
import { validateResponseConversationWritten } from "../generated/draft.validators";
import { ConversationSession } from "./features/assistant/ConversationSession";
import { translationCommands } from "../translationCommands";
import { validateSaveReceipt } from "../translationCommands";
import { executionCommands } from "../executionCommands";
import { installDesktopBehavior } from "../desktopBehavior";
import { reviewCommands } from "../reviewCommands";
import { resourceCommands } from "../resourceCommands";
import { resourceDraftCommands, type ResourceDraftHead } from "../resourceDraftCommands";
import { reviewTargetFixture } from "../testSupport/reviewFixture";
import { validateResponseRead, validateResponseWritten, validateResponseCleared } from "../generated/draft.validators";
import { validateResponseRecoverSave } from "../generated/translation.validators";
import draftFixture from "../../test/fixtures/draftCommands.contract.json";
import translationFixture from "../../test/fixtures/translation-commands.json";
import type { DraftBasis, DraftHead } from "../draftCommands";
import { projectCommands, type ProjectView } from "../projectCommands";
import WorkbenchApp from "./WorkbenchApp";
import { ProjectLifecycle, type ProjectLifecyclePorts } from "./platform/projectLifecycle";
import type { TranslationImportPanelProps } from "./features/import/TranslationImportPanel";
import * as applicationSettings from "./features/settings/ApplicationSettings";
import { Button } from "../design-system/Button";
import * as nativeMenu from "./nativeMenu";
import { fixtureIdentity } from "../testSupport/executionFixture";
import { installResourceDraftPortsFixture } from "../testSupport/resourceDraftFixture";
import { installSourceDraftPortsFixture } from "../testSupport/sourceDraftFixture";
import { translationCaptureFixture, translationImportChoice, translationSelectionFixture } from "../testSupport/translationFixture";
import { InteractionGate } from "./workspace/interactionGate";

vi.mock("./platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));
vi.mock("@tauri-apps/api/core", { spy: true });
vi.mock("@tauri-apps/api/event", { spy: true });
vi.mock("@tauri-apps/api/path", () => ({ sep: () => "/", join: async (...parts: string[]) => parts.join("/") }));
vi.mock("./nativeMenu", { spy: true });
const ownerLoad = vi.hoisted(() => ({ execution: null as Promise<void> | Error | null, knowledge: null as Promise<void> | null, source: null as Promise<void> | Error | null,
  knowledgeValue: null as KnowledgeOwner | null, sourceValue: null as SourceOwner | null, deliveryFail: false }));
const entriesPresentation = vi.hoisted(() => vi.fn());
vi.mock("./features/entries/EntriesView", async original => {
  const module = await original<typeof import("./features/entries/EntriesView")>(), Actual = module.default;
  return { ...module, default: function EntriesPresentationProbe(props: ComponentProps<typeof Actual>) {
    useLayoutEffect(() => { entriesPresentation(); });
    return <Actual {...props}/>;
  } };
});
vi.mock("./features/delivery/DeliveryOwnerHost", async original => {
  const module = await original<typeof import("./features/delivery/DeliveryOwnerHost")>(), Actual = module.default;
  return { ...module, default: (props: ComponentProps<typeof Actual>) => {
    if (ownerLoad.deliveryFail) throw new Error("Synthetic initial delivery load failed");
    return <Actual {...props}/>;
  } };
});
vi.mock("./features/execution/ExecutionOwnerHost", async original => {
  const module = await original<typeof import("./features/execution/ExecutionOwnerHost")>(), Actual = module.default;
  return { ...module, default: (props: ComponentProps<typeof Actual>) => {
    if (ownerLoad.execution) throw ownerLoad.execution;
    return <Actual {...props}/>;
  } };
});
vi.mock("./features/knowledge/KnowledgeOwnerHost", async original => {
  const module = await original<typeof import("./features/knowledge/KnowledgeOwnerHost")>(), Actual = module.default;
  return { ...module, default: (props: ComponentProps<typeof Actual>) => {
    const publish = useCallback((owner: KnowledgeOwner | null) => { ownerLoad.knowledgeValue = owner; props.onOwner(owner); }, [props.onOwner]);
    if (ownerLoad.knowledge) throw ownerLoad.knowledge;
    return <Actual {...props} onOwner={publish}/>;
  } };
});
vi.mock("./features/source/SourceOwnerHost", async original => {
  const module = await original<typeof import("./features/source/SourceOwnerHost")>(), Actual = module.default;
  return { ...module, default: (props: ComponentProps<typeof Actual>) => {
    const publish = useCallback((owner: SourceOwner | null) => { ownerLoad.sourceValue = owner; props.onOwner(owner); }, [props.onOwner]);
    if (ownerLoad.source) throw ownerLoad.source;
    return <Actual {...props} onOwner={publish}/>;
  } };
});
let importPresentation: TranslationImportPanelProps | null = null;
type DeliveryPresentationProps = ComponentProps<typeof import("./features/delivery/DeliveryView").default>;
let deliveryPresentation: DeliveryPresentationProps | null = null;
vi.mock("./features/delivery/DeliveryView", () => ({ default: function DeliveryPresentationProbe(props: DeliveryPresentationProps) {
  useLayoutEffect(() => { deliveryPresentation = props; });
  return <section aria-label={i18n.t("workbenchV2.delivery")}>
    <label>Synthetic delivery path<input value={props.owner.names["zh-CN"] ?? ""} disabled={props.disabled}
      onChange={event => props.owner.setName("zh-CN", event.target.value)}/></label>
  </section>;
} }));
vi.mock("./features/import/TranslationImportPanel", () => ({ default: function ImportPresentationProbe(props: TranslationImportPanelProps) {
  useLayoutEffect(() => { importPresentation = props; });
  return <section aria-label={i18n.t("workbenchV2.importTitle")}><h1>{i18n.t("workbenchV2.importTitle")}</h1>
    <output aria-label="Retained import file">{props.owners.imports.state.fileName}</output>
    <output aria-label="Retained import locale">{props.owners.imports.state.targetLocale}</output>
    <Button disabled={props.disabled} onClick={() => props.owners.imports.setFile("retained-import.json")}>Retain import selection</Button>
    <Button onClick={props.onBack}>{i18n.t("workbenchV2.importBack")}</Button>
    <Button disabled={props.disabled} onClick={() => props.onOpenEntry(translationFixture.save.unitId, "zh-CN")}>{i18n.t("workbenchV2.importOpenEntry")}</Button>
  </section>;
} }));

const project: ProjectView = { locator: "/synthetic/project", sessionToken: "session", reconciliationState: "settled", metadata: { projectId: fixtureIdentity(1), metadataRevision: "1", displayName: "Synthetic project", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const emptyChecks = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
const page: SegmentPage = {
  projectId: project.metadata.projectId, locale: "zh-CN", query: { text: "", selection: "all", status: "all" }, queryFingerprint: "fingerprint", epoch: "epoch", sequence: "1",
  scopeId: "scope", sourceSnapshotId: "snapshot", readVersion: "1", total: 1, nextCursor: null,
  rows: [{
    sourceTruncated: false, translationTruncated: false,
    content: { unitId: "unit", locale: "zh-CN", sourceSnapshotId: "snapshot", sourceRevisionId: "source", nativeKey: "dialogue.hello", sourcePreview: "Actual source from the read port", translationPreview: "从读取接口返回的译文", selectionId: "selection", revisionId: "revision", basis: "basis", currentCheck: null, currentDecision: null },
    candidateCount: 0, aiCandidateCount: 0, protection: { unitId: "unit", locale: "zh-CN", revision: "0", protected: false },
    qa: { current: false, outcome: null, mandatoryCoverageComplete: null, mandatory: emptyChecks, advisory: { ...emptyChecks } },
    terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
    applicability: { selectedSourceRevisionId: "source", sourceBasisCurrent: true, capturedBasisCurrent: true, resourceImpact: null, resourceReviewRequired: false },
    qualification: { blockerCount: 2, exceptionCount: 0, blockers: [{ code: "approval-missing-or-stale", reference: null }, { code: "qa-missing-or-stale", reference: null }], exceptions: [], truncated: false },
  }],
};
let controller: ProjectLifecycle;
beforeEach(async () => {
  ownerLoad.execution = null; ownerLoad.knowledge = null; ownerLoad.source = null;
  ownerLoad.knowledgeValue = null; ownerLoad.sourceValue = null;
  ownerLoad.deliveryFail = false;
  installResourceDraftPortsFixture();
  installSourceDraftPortsFixture();
  importPresentation = null;
  deliveryPresentation = null;
  localStorage.clear(); history.replaceState(null, "", "/");
  await i18n.changeLanguage("zh-CN");
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ currentSnapshot: "snapshot", revision: "1" });
  vi.spyOn(segmentCommands, "page").mockResolvedValue(page);
  vi.spyOn(draftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => { cleanup(); controller?.dispose(); });

it.each([1440, 900])("keeps the conversation owner, both inputs and return focus through conversation mode at %i px", async width => {
  const previousWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  const conversationId = fixtureIdentity(982), key = { projectId: project.metadata.projectId, conversationId };
  let head: ConversationDraftHead = { key, revision: "1", writerId: fixtureIdentity(983), value: { text: "Retained Agent draft 🙂", editSeq: "1", pending: null } };
  vi.spyOn(conversationCommands, "list").mockResolvedValue({ projectId: project.metadata.projectId, rows: [{ ...key, title: "Layout conversation", ordinal: "1" }], nextAfter: null });
  vi.spyOn(conversationCommands, "messages").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "planningAttempts").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "proposalRevisions").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "proposalWorkPlans").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  vi.spyOn(conversationDraftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(conversationDraftCommands, "read").mockImplementation(async () => structuredClone(head));
  vi.spyOn(conversationDraftCommands, "write").mockImplementation(async request => {
    const written: unknown = { key, revision: String(BigInt(head.revision) + 1n), writerId: request.write.writerId, value: structuredClone(canonicalConversationDraft(request.write.value)) };
    if (!validateResponseConversationWritten(written)) throw new Error("Invalid layout conversation journal fixture");
    head = written;
    return structuredClone(head);
  });
  const openConversation = vi.spyOn(ConversationSession.prototype, "open"), initialize = vi.spyOn(ConversationSession.prototype, "initialize");
  const prepare = vi.spyOn(conversationCommands, "preparePlanning"), start = vi.spyOn(conversationCommands, "startPlanning");
  try {
    await openImportWorkspace();
    const search = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.searchEntries") });
    fireEvent.change(search, { target: { value: "Unfinished search B {{name}}" } });
    const table = screen.getByRole("region", { name: i18n.t("workbenchV2.entriesTableLabel") });
    table.scrollTop = 120; fireEvent.scroll(table);
    if (width <= 1100) fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openAgent") }));
    // The conversation panel loads lazily on the first project open.
    const picker = await screen.findByRole("button", { name: i18n.t("conversation.chooseThread") }, { timeout: 5000 });
    await waitFor(() => expect(picker).toBeEnabled()); picker.focus(); fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Layout conversation" }));
    const composer = await screen.findByRole("textbox", { name: i18n.t("conversation.message") }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Agent draft B 🙂\nkeep this input" } });
    composer.setSelectionRange(2, 7);
    const owner = openConversation.mock.contexts.at(-1) as ConversationSession;
    await waitFor(() => expect(owner.getSnapshot().inputs.get(conversationId)?.journalBusy).toBe(false));
    const retained = owner.getSnapshot().inputs.get(conversationId), initialized = initialize.mock.calls.length;
    if (width <= 1100) {
      const drawer = screen.getByRole("dialog", { name: i18n.t("workbenchV2.agent") });
      fireEvent.keyDown(composer, { key: "L", ctrlKey: !navigator.platform.includes("Mac"), metaKey: navigator.platform.includes("Mac"), shiftKey: true });
      expect(screen.getByRole("button", { name: i18n.t("workbenchV2.conversationMode"), hidden: true })).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(within(drawer).getByRole("button", { name: i18n.t("workbenchV2.close") }));
      await waitFor(() => expect(drawer).not.toBeInTheDocument());
    }
    search.focus();
    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: "L", ctrlKey: !navigator.platform.includes("Mac"), metaKey: navigator.platform.includes("Mac"), shiftKey: true });
    expect(screen.getByRole("button", { name: i18n.t("workbenchV2.conversationMode") })).toHaveAttribute("aria-pressed", "false");
    fireEvent.compositionEnd(search);
    fireEvent.keyDown(search, { key: "L", ctrlKey: !navigator.platform.includes("Mac"), metaKey: navigator.platform.includes("Mac"), shiftKey: true });
    await waitFor(() => expect(composer).toHaveFocus());
    expect(screen.getByRole("textbox", { name: i18n.t("conversation.message") })).toBe(composer);
    expect(composer).toHaveValue("Agent draft B 🙂\nkeep this input");
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([2, 7]);
    expect(composer.closest('[aria-hidden="true"], [inert]')).toBeNull();
    expect(owner.getSnapshot().activeId).toBe(conversationId);
    expect(owner.getSnapshot().inputs.get(conversationId)).toBe(retained);
    expect(initialize.mock.calls.length).toBe(initialized);
    expect(screen.getAllByPlaceholderText(i18n.t("conversation.placeholder"))).toHaveLength(1);
    const returnButton = screen.getByRole("button", { name: i18n.t("workbenchV2.returnToView") });
    fireEvent.click(returnButton);
    await waitFor(() => expect(search).toHaveFocus());
    expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.searchEntries") })).toBe(search);
    expect(search).toHaveValue("Unfinished search B {{name}}"); expect(table.scrollTop).toBe(120);
    expect(owner.getSnapshot().inputs.get(conversationId)).toBe(retained);
    expect(prepare).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  } finally {
    if (previousWidth) Object.defineProperty(window, "innerWidth", previousWidth);
  }
}, 15000);

it("synchronizes the document language on the welcome screen", async () => {
  document.documentElement.lang = "en";
  render(<WorkbenchApp native={false}/>);
  expect(document.documentElement.lang).toBe("zh-CN");
  await act(async () => { await i18n.changeLanguage("en-US"); });
  expect(document.documentElement.lang).toBe("en-US");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(document.documentElement.lang).toBe("zh-CN");
});

it("shows the offline project brief and continues the previous entry without submitting work", async () => {
  const position = { unitId: page.rows[0].content.unitId, locale: project.metadata.targetLocales[0], nativeKey: "chapter.{{name}}" };
  localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify([{ locator: project.locator, lastOpenedAt: Date.now() - 9 * 60 * 60 * 1000, position }]));
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ currentSnapshot: page.sourceSnapshotId, revision: "1" });
  vi.spyOn(conversationCommands, "list").mockResolvedValue({ projectId: project.metadata.projectId, rows: [], nextAfter: null });
  vi.spyOn(conversationDraftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => ({ projectId: project.metadata.projectId, locale: request.locale,
    sourceSnapshotId: page.sourceSnapshotId, scopeId: request.scopeId, query: page.query, queryFingerprint: page.queryFingerprint,
    epoch: page.epoch, sequence: page.sequence, total: 120, firstPosition: 99, rows: page.rows, previousUnitId: "previous-entry", nextUnitId: "next-entry" }));
  const plan = vi.spyOn(conversationCommands, "preparePlanning");
  await openImportWorkspace();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openAgent") }));
  // The lazy conversation panel can replace the fallback brief while it loads.
  const brief = () => within(screen.getByRole("region", { name: "项目简报" }));
  const continueEntry = () => brief().getByRole("button", { name: `继续 ${position.nativeKey} · ${position.locale}` });
  await waitFor(() => {
    expect(brief().getByText("仅使用项目记录生成，不调用模型。")).toBeVisible();
    expect(continueEntry()).toBeEnabled();
  }, { timeout: 5000 });
  fireEvent.click(continueEntry());
  await screen.findByText("Actual source from the read port");
  await waitFor(() => expect(readRecentProject(project.locator)?.position?.unitId).toBe(position.unitId));
  await waitFor(() => expect(segmentCommands.queueWindow).toHaveBeenCalledWith(expect.objectContaining({ anchorUnitId: position.unitId, locale: position.locale })));
  expect(plan).not.toHaveBeenCalled();
}, 15000);

it("opens project metadata through the shared command and protects name input while cancelling close", async () => {
  await openImportWorkspace();
  await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") }));
  const settings = await screen.findByRole("option", { name: i18n.t("projectMetadata.title") });
  await waitFor(() => expect(settings).not.toHaveAttribute("aria-disabled", "true")); fireEvent.click(settings);
  const sheet = within(await screen.findByRole("dialog", { name: i18n.t("projectMetadata.title") }));
  const name = sheet.getByRole("textbox", { name: i18n.t("projectMetadata.name") });
  fireEvent.change(name, { target: { value: "Project name B {{name}}" } });
  fireEvent.click(sheet.getByRole("button", { name: i18n.t("projectMetadata.close") }));
  fireEvent.click(sheet.getByRole("button", { name: i18n.t("projectMetadata.stay") }));
  expect(name).toHaveValue("Project name B {{name}}");
}, 15000);

it("restores from Welcome, keeps the folder name on cancellation, and installs the returned session", async () => {
  const restored = { ...project, locator: "/synthetic/restored", sessionToken: "restored-session" };
  const restore = vi.fn<ProjectLifecyclePorts["restore"]>()
    .mockResolvedValueOnce({ project: null }).mockResolvedValueOnce({ project: restored });
  controller = new ProjectLifecycle({ restore });
  render(<WorkbenchApp controller={controller} native/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.restoreBackup") }));
  const panel = within(await screen.findByRole("dialog", { name: i18n.t("startup.restoreTitle") }));
  const field = panel.getByRole("textbox", { name: i18n.t("startup.folder") });
  const submit = panel.getByRole("button", { name: i18n.t("startup.restoreChoose") });
  fireEvent.change(field, { target: { value: "Restored" } });
  fireEvent.click(submit);
  await waitFor(() => expect(submit).toBeEnabled());
  expect(field).toHaveValue("Restored");
  expect(controller.getSnapshot().session).toBeNull();
  fireEvent.click(submit);
  await waitFor(() => expect(controller.getSnapshot().session?.project).toEqual(restored));
  expect(restore.mock.calls).toEqual([[{ directoryName: "Restored" }], [{ directoryName: "Restored" }]]);
  expect(await screen.findByText(i18n.t("startup.restoredExternalFiles"))).toBeVisible();
});

it("explains an unsupported project format and keeps the folder available for retry", async () => {
  const open = vi.fn<ProjectLifecyclePorts["open"]>().mockRejectedValueOnce({
    code: "unsupported-schema", stage: "open", outcome: "rejected", recoveryRequired: false,
  }).mockResolvedValueOnce(project);
  controller = new ProjectLifecycle({ open });
  render(<WorkbenchApp controller={controller} native/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  const folder = screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") });
  fireEvent.change(folder, { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  expect(await screen.findByText(i18n.t("startup.projectFormatUnsupported"))).toBeVisible();
  expect(folder).toHaveValue(project.locator);
  expect(controller.getSnapshot().pending).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  await waitFor(() => expect(controller.getSnapshot().session?.project).toEqual(project));
  expect(open).toHaveBeenCalledTimes(2);
});

it("explains an unsupported backup format and keeps the restore name available", async () => {
  const restore = vi.fn<ProjectLifecyclePorts["restore"]>().mockRejectedValue({
    code: "unsupported-schema", stage: "create", outcome: "rejected", recoveryRequired: false,
  });
  controller = new ProjectLifecycle({ restore });
  render(<WorkbenchApp controller={controller} native/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.restoreBackup") }));
  const panel = within(await screen.findByRole("dialog", { name: i18n.t("startup.restoreTitle") }));
  const field = panel.getByRole("textbox", { name: i18n.t("startup.folder") });
  const choose = panel.getByRole("button", { name: i18n.t("startup.restoreChoose") });
  fireEvent.change(field, { target: { value: "Restored" } });
  fireEvent.click(choose);
  expect(await panel.findByText(i18n.t("startup.projectFormatUnsupported"))).toBeVisible();
  expect(field).toHaveValue("Restored");
  expect(choose).toBeEnabled();
  expect(controller.getSnapshot().pending).toBeNull();
});

it("keeps an uncertain restore from repeating and offers opening the destination", async () => {
  const restore = vi.fn<ProjectLifecyclePorts["restore"]>().mockRejectedValue(new Error("lost reply"));
  controller = new ProjectLifecycle({ restore });
  render(<WorkbenchApp controller={controller} native/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.restoreBackup") }));
  const panel = within(await screen.findByRole("dialog", { name: i18n.t("startup.restoreTitle") }));
  fireEvent.change(panel.getByRole("textbox", { name: i18n.t("startup.folder") }), { target: { value: "Restored" } });
  fireEvent.click(panel.getByRole("button", { name: i18n.t("startup.restoreChoose") }));
  expect(await panel.findByText(i18n.t("startup.restoreUnknown"))).toBeVisible();
  expect(panel.getByRole("button", { name: i18n.t("startup.restoreChoose") })).toBeDisabled();
  fireEvent.click(panel.getByRole("button", { name: i18n.t("startup.openDestination") }));
  expect(await screen.findByRole("dialog", { name: i18n.t("workbenchV2.openProject") })).toBeVisible();
  expect(restore).toHaveBeenCalledTimes(1);
});

it("backs up and rescues drafts from project settings without saving a newer name edit", async () => {
  const backup = vi.spyOn(projectCommands, "backup").mockResolvedValue({ saved: true });
  const rescue = vi.spyOn(projectCommands, "rescueDrafts").mockResolvedValue({ saved: true });
  const rename = vi.spyOn(projectCommands, "rename");
  await openImportWorkspace();
  await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") }));
  const settings = await screen.findByRole("option", { name: i18n.t("projectMetadata.title") });
  await waitFor(() => expect(settings).not.toHaveAttribute("aria-disabled", "true"));
  fireEvent.click(settings);
  const sheet = within(await screen.findByRole("dialog", { name: i18n.t("projectMetadata.title") }));
  const name = sheet.getByRole("textbox", { name: i18n.t("projectMetadata.name") });
  fireEvent.change(name, { target: { value: "Unsaved project name" } });
  fireEvent.click(sheet.getByRole("button", { name: i18n.t("projectMetadata.backup") }));
  expect(await sheet.findByText(i18n.t("projectMetadata.backupSaved"))).toBeVisible();
  expect(backup).toHaveBeenCalledWith({ sessionToken: project.sessionToken });
  fireEvent.click(sheet.getByRole("button", { name: i18n.t("projectMetadata.rescue") }));
  expect(await sheet.findByText(i18n.t("projectMetadata.rescueSaved"))).toBeVisible();
  expect(sheet.getByText(i18n.t("projectMetadata.backupSaved"))).toBeVisible();
  expect(rescue).toHaveBeenCalledWith({ sessionToken: project.sessionToken });
  expect(rename).not.toHaveBeenCalled();
  expect(name).toHaveValue("Unsaved project name");
}, 15000);

it("continues and reopens the moved project from Welcome after renaming its folder", async () => {
  const position = { unitId: page.rows[0].content.unitId, locale: project.metadata.targetLocales[0], nativeKey: "chapter.{{name}}" };
  localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify([{ locator: project.locator, lastOpenedAt: Date.now(), position }]));
  const moved: ProjectView = { ...project, locator: "/synthetic/Renamed project", metadata: { ...project.metadata, metadataRevision: "2", displayName: "Renamed project" } };
  let disk = project;
  const open = vi.fn(async ({ locator }: { locator: string }) => {
    if (locator !== disk.locator) throw new Error("Synthetic project folder does not exist");
    return disk;
  });
  const read = vi.fn(async () => disk);
  const rename = vi.spyOn(projectCommands, "rename").mockImplementation(async () => {
    disk = moved;
    return { sessionToken: moved.sessionToken, locator: moved.locator, metadata: moved.metadata, outcome: "changed", directoryChanged: true };
  });
  const user = userEvent.setup();
  const { register } = await openImportWorkspace(project, { open, read });
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") }));
  const settings = await screen.findByRole("option", { name: i18n.t("projectMetadata.title") });
  await waitFor(() => expect(settings).not.toHaveAttribute("aria-disabled", "true")); fireEvent.click(settings);
  const sheet = within(await screen.findByRole("dialog", { name: i18n.t("projectMetadata.title") }));
  fireEvent.change(sheet.getByRole("textbox", { name: i18n.t("projectMetadata.name") }), { target: { value: moved.metadata.displayName } });
  await user.click(sheet.getByRole("checkbox", { name: i18n.t("projectMetadata.renameFolder") }));
  await user.click(sheet.getByRole("button", { name: i18n.t("projectMetadata.saveName") }));
  await sheet.findByText(i18n.t("projectMetadata.saved"));
  await waitFor(() => expect(sheet.getByRole("button", { name: i18n.t("projectMetadata.close") })).toBeEnabled());
  expect(rename).toHaveBeenCalledExactlyOnceWith({ sessionToken: project.sessionToken, expectedRevision: "1", displayName: moved.metadata.displayName, directoryName: moved.metadata.displayName });
  expect(read).toHaveBeenCalledWith({ sessionToken: project.sessionToken });
  expect(controller.getSnapshot().session?.project).toEqual(moved);
  expect(readRecentProject(moved.locator)?.position).toEqual(position);
  expect(readRecentProject(project.locator)).toBeNull();
  await user.click(sheet.getByRole("button", { name: i18n.t("projectMetadata.close") }));

  async function closeProject() {
    await waitFor(() => {
      for (const id of ["execution-tasks", "knowledge-resources"]) {
        const participant = [...register.mock.calls].reverse().find(([value]) => value.id === id)?.[0];
        expect(participant?.inspect({ kind: "close-project" }).status).toBe("ready");
      }
    });
    await act(async () => { const closed = await controller.close(); expect(closed, JSON.stringify(controller.getSnapshot().failure)).toBe(true); });
    await screen.findByRole("button", { name: i18n.t("startup.chooseAndPrepare") });
  }
  await closeProject();
  expect(screen.getByTitle(moved.locator)).toBeVisible();
  expect(screen.queryByTitle(project.locator)).not.toBeInTheDocument();
  expect(screen.getByText(i18n.t("startup.continueRecent", { name: moved.metadata.displayName }))).toBeVisible();
  fireEvent.keyDown(document.body, { key: "Enter" });
  await waitFor(() => expect(open).toHaveBeenNthCalledWith(2, { locator: moved.locator }));
  await screen.findByText("Actual source from the read port");
  expect(controller.getSnapshot().session?.project.metadata.projectId).toBe(project.metadata.projectId);
  await closeProject();
  const recentPath = screen.getByTitle(moved.locator);
  await user.click(screen.getByRole("button", { name: name => name.includes(moved.locator) }));
  await waitFor(() => expect(open).toHaveBeenNthCalledWith(3, { locator: moved.locator }));
  await screen.findByText("Actual source from the read port");
  expect(recentPath).not.toBeInTheDocument();
  expect(controller.getSnapshot().session?.project).toEqual(moved);
  expect(readRecentProject(moved.locator)?.position).toEqual(position);
  expect(readRecentProject(project.locator)).toBeNull();
}, 15000);

it("opens work plans from the enabled activity item and retains the runs view across entry navigation", async () => {
  vi.spyOn(conversationCommands, "list").mockResolvedValue({ projectId: project.metadata.projectId, rows: [], nextAfter: null });
  vi.spyOn(conversationDraftCommands, "list").mockResolvedValue({ items: [], next: null });
  await openImportWorkspace();
  async function openActivity(name: string) {
    const current = () => within(screen.getByRole("navigation", { name: i18n.t("workbenchV2.activity") })).getByRole("button", { name });
    await waitFor(() => { expect(current()).toBeEnabled(); expect(current()).not.toHaveAttribute("aria-disabled", "true"); });
    fireEvent.click(current());
  }
  await openActivity(i18n.t("workbenchV2.runs"));
  expect(await screen.findByRole("heading", { name: "工作计划" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "工作计划" })).toHaveAttribute("aria-selected", "true");
  await openActivity(i18n.t("workbenchV2.entries"));
  await screen.findByText("Actual source from the read port");
  await openActivity(i18n.t("workbenchV2.runs"));
  expect(await screen.findByRole("heading", { name: "工作计划" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.runs") }) })).toHaveLength(1);
}, 15000);

it("retains the original delivery owner after navigating away and closing its view", async () => {
  controller = new ProjectLifecycle({ open: vi.fn(async () => project) });
  const register = vi.spyOn(controller, "register");
  render(<StrictMode><WorkbenchApp controller={controller} native/></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  await screen.findByText("Actual source from the read port", {}, { timeout: 5000 });
  const activity = within(screen.getByRole("navigation", { name: i18n.t("workbenchV2.activity") }));
  const delivery = activity.getByRole("button", { name: i18n.t("workbenchV2.delivery") });
  await waitFor(() => expect(delivery).toBeEnabled()); fireEvent.click(delivery);
  const field = await screen.findByRole("textbox", { name: "Synthetic delivery path" }, { timeout: 5000 });
  fireEvent.change(field, { target: { value: "i18n/人工.json" } });
  const owner = deliveryPresentation!.owner;
  expect(owner.current().names["zh-CN"]).toBe("i18n/人工.json");
  fireEvent.click(activity.getByRole("button", { name: i18n.t("workbenchV2.entries") }));
  await screen.findByText("Actual source from the read port");
  expect(screen.getByRole("button", { name: i18n.t("deliveryWorkbench.backToDelivery") })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.delivery") }) }));
  await waitFor(() => expect(screen.queryByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.delivery") }) })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: i18n.t("deliveryWorkbench.backToDelivery") }));
  expect(await screen.findByRole("textbox", { name: "Synthetic delivery path" })).toHaveValue("i18n/人工.json");
  expect(deliveryPresentation!.owner.current()).toBe(owner.current());
  const participants = register.mock.calls.filter(([participant]) => participant.id === "delivery");
  expect(participants.length).toBeGreaterThan(0);
  expect(participants.at(-1)![0].inspect({ kind: "close-project" }).status).not.toBe("ready");
}, 15000);

it("recovers an initial delivery load failure without moving another workspace view", async () => {
  ownerLoad.deliveryFail = true;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  controller = new ProjectLifecycle({ open: vi.fn(async () => project) });
  render(<WorkbenchApp controller={controller} native/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  await screen.findByText("Actual source from the read port", {}, { timeout: 5000 });
  const activity = within(screen.getByRole("navigation", { name: i18n.t("workbenchV2.activity") }));
  const delivery = activity.getByRole("button", { name: i18n.t("workbenchV2.delivery") });
  await waitFor(() => expect(delivery).toBeEnabled()); fireEvent.click(delivery);
  const retry = await screen.findByRole("button", { name: i18n.t("deliveryWorkbench.retryOwner") }, { timeout: 5000 });
  expect(deliveryPresentation).toBeNull(); ownerLoad.deliveryFail = false; fireEvent.click(retry);
  await screen.findByRole("textbox", { name: "Synthetic delivery path" });
  fireEvent.click(activity.getByRole("button", { name: i18n.t("workbenchV2.entries") }));
  await screen.findByText("Actual source from the read port");
  expect(screen.queryByRole("textbox", { name: "Synthetic delivery path" })).not.toBeInTheDocument();
  expect(controller.getSnapshot().session?.project.sessionToken).toBe(project.sessionToken);
  errors.mockRestore();
}, 15000);

it("shows startup drop rejection inside the plan and discards the invalidated invitation", async () => {
  let deliver: ((event: StartupDropEvent) => void) | undefined;
  const native = vi.spyOn(tauriCore, "isTauri").mockReturnValue(true);
  const listen = vi.spyOn(tauriEvents, "listen").mockImplementation(async (event, handler) => {
    if (event !== "startup-native-drop") return () => {};
    const send = (payload: StartupDropEvent) => handler({ event, id: 1, payload });
    deliver = send;
    return () => { if (deliver === send) deliver = undefined; };
  });
  const dropped = vi.spyOn(startupCommands, "droppedDirectory").mockRejectedValue(new Error("Invalidated drop ticket"));
  const choose = vi.spyOn(startupCommands, "chooseDirectory").mockResolvedValue({
    selectionId: fixtureIdentity(907), folderName: "Recovered source",
  });
  vi.spyOn(pluginCommands, "inventory").mockResolvedValue(pluginSourceInventory);
  vi.spyOn(pluginCommands, "package").mockResolvedValue(pluginSourcePackage);
  controller = new ProjectLifecycle();
  try {
    render(<StrictMode><WorkbenchApp controller={controller} native/></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.manual") }));
    const plan = await screen.findByRole("dialog", { name: i18n.t("startup.title") });
    const name = within(plan).getByRole("textbox", { name: i18n.t("startup.name") });
    fireEvent.change(name, { target: { value: "Retained project name" } });
    await waitFor(() => expect(deliver).toBeTypeOf("function"));

    fireEvent.compositionStart(name);
    await act(async () => { deliver?.({ kind: "ready", dropTicket: fixtureIdentity(908), folderName: "Invalidated source" }); });
    expect(within(plan).getByText(i18n.t("startup.sourceFolder", { folder: "Invalidated source" }))).toBeVisible();
    expect(dropped).not.toHaveBeenCalled();
    await act(async () => { deliver?.({ kind: "rejected", error: {
      code: "invalid-input", stage: "execution-read", outcome: "rejected", recoveryRequired: false, reason: "native-drop-one-directory",
    } }); });
    fireEvent.compositionEnd(name);

    expect(dropped).not.toHaveBeenCalled();
    expect(within(plan).getByText(i18n.t("startup.sourceSelectionFailed"))).toBeVisible();
    expect(name).toHaveValue("Retained project name");
    expect(within(plan).queryByText(i18n.t("startup.sourceFolder", { folder: "Invalidated source" }))).not.toBeInTheDocument();
    const picker = within(plan).getByRole("button", { name: i18n.t("startup.chooseSourceFolder") });
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.click(picker);
    expect(await within(plan).findByText(i18n.t("startup.sourceFolder", { folder: "Recovered source" }))).toBeVisible();
    expect(choose).toHaveBeenCalledOnce();
    expect(dropped).not.toHaveBeenCalled();
    expect(within(plan).queryByText(i18n.t("startup.sourceSelectionFailed"))).not.toBeInTheDocument();
    expect(name).toHaveValue("Retained project name");
  } finally { cleanup(); listen.mockRestore(); native.mockRestore(); }
});

it("opens the real manual creation entry and adopts only its acknowledged project session", async () => {
  const create = vi.fn(async () => project);
  controller = new ProjectLifecycle({ create });
  render(<StrictMode><WorkbenchApp controller={controller} native/></StrictMode>);
  await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("startup.manual") }));
  const dialog = await screen.findByRole("dialog", { name: i18n.t("startup.title") });
  expect(dialog).toHaveAccessibleName("新建项目"); expect(create).not.toHaveBeenCalled();
  for (const [key, value] of [["name", "New human project"], ["parent", "/synthetic"], ["folder", "project"], ["source", "en"], ["target", "zh-CN"]] as const) {
    fireEvent.change(within(dialog).getByRole(key === "source" || key === "target" ? "combobox" : "textbox", { name: i18n.t(`startup.${key}`) }), { target: { value } });
  }
  await userEvent.setup().click(within(dialog).getByRole("button", { name: i18n.t("startup.addTarget") }));
  await userEvent.setup().click(within(dialog).getByRole("button", { name: i18n.t("startup.create") }));
  await waitFor(() => expect(controller.getSnapshot().session?.project).toEqual(project));
  expect(create).toHaveBeenCalledExactlyOnceWith({ destination: project.locator, displayName: "New human project", sourceLocale: "en", targetLocales: ["zh-CN"] });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: i18n.t("startup.title") })).not.toBeInTheDocument());
});

it("creates the reviewed project before explicitly handing its source folder to the retained import owner", async () => {
  const selection = pluginSourceWorkflow.selection;
  vi.spyOn(pluginCommands, "inventory").mockResolvedValue(pluginSourceInventory);
  vi.spyOn(pluginCommands, "package").mockResolvedValue(pluginSourcePackage);
  vi.spyOn(startupCommands, "chooseDirectory").mockResolvedValue({ selectionId: selection.selectionId, folderName: selection.folderName });
  vi.spyOn(startupCommands, "preflight").mockResolvedValue({ directory: { selectionId: selection.selectionId, folderName: selection.folderName }, source: selection.source,
    complete: true, materials: selection.source.declaration.materials.map(file => ({ ...file, byteLength: 1, sha256: "a".repeat(64) })) });
  const claim = vi.spyOn(startupCommands, "claimDirectory").mockResolvedValue(selection);
  const capture = vi.spyOn(sourceCommands, "capturePlugin"), start = vi.spyOn(sourceCommands, "startPlugin");
  const create = vi.fn(async () => project); controller = new ProjectLifecycle({ create });
  render(<StrictMode><WorkbenchApp controller={controller} native/></StrictMode>);
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: i18n.t("startup.manual") }));
  const dialog = await screen.findByRole("dialog", { name: i18n.t("startup.title") });
  await user.click(within(dialog).getByRole("button", { name: i18n.t("startup.chooseSourceFolder") }));
  const format = within(dialog).getByRole("combobox", { name: i18n.t("startup.sourceFormat") });
  await waitFor(() => expect(format).toBeEnabled());
  await user.selectOptions(format, `${pluginSourceRequest.package.packageDigest}:${pluginSourceRequest.resourceId}`);
  await user.selectOptions(within(dialog).getByRole("combobox", { name: i18n.t("startup.sourceRuntime") }), pluginSourceRequest.environmentDigest);
  await user.click(within(dialog).getByRole("button", { name: i18n.t("startup.checkSource") }));
  await within(dialog).findByText(i18n.t("startup.sourceReady"));
  for (const [key, value] of [["name", "New source project"], ["parent", "/synthetic"], ["folder", "project"], ["source", "en"], ["target", "zh-CN"]] as const)
    fireEvent.change(within(dialog).getByRole(key === "source" || key === "target" ? "combobox" : "textbox", { name: i18n.t(`startup.${key}`) }), { target: { value } });
  await user.click(within(dialog).getByRole("button", { name: i18n.t("startup.addTarget") }));
  await user.click(within(dialog).getByRole("button", { name: i18n.t("startup.create") }));
  await screen.findByText("项目已创建，源文件夹还没有导入。"); expect(create).toHaveBeenCalledOnce(); expect(claim).not.toHaveBeenCalled();
  const next = screen.getByRole("button", { name: i18n.t("startup.continueImport") });
  await waitFor(() => expect(ownerLoad.sourceValue?.journal, `draft reads: ${vi.mocked(draftCommands.list).mock.calls.length}; ${document.body.textContent ?? ""}`).toMatchObject({ hydration: "ready" }), { timeout: 20000 });
  await waitFor(() => expect(next).toBeEnabled(), { timeout: 5000 }); await user.click(next);
  await waitFor(() => expect(claim).toHaveBeenCalledExactlyOnceWith({ selectionId: selection.selectionId, source: pluginSourceRequest,
    projectId: project.metadata.projectId, sessionToken: project.sessionToken }));
  expect(capture).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(ownerLoad.sourceValue?.current().selection).toEqual(selection);
  await waitFor(() => expect(screen.queryByText(i18n.t("startup.createdBeforeImport"))).not.toBeInTheDocument());
}, 30000);

async function openImportWorkspace(opened: ProjectView = project, ports: Partial<ProjectLifecyclePorts> = {}) {
  const close = vi.fn(async () => ({ closed: true }));
  controller = new ProjectLifecycle({ open: vi.fn(async () => opened), close,
    status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }), ...ports });
  const register = vi.spyOn(controller, "register");
  render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: opened.locator } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  const button = await screen.findByRole("button", { name: i18n.t("workbenchV2.importTitle") }, { timeout: 5000 });
  await waitFor(() => expect(button).toBeEnabled());
  return { close, register, button };
}

function waitForSourceAndKnowledgeJournals() {
  return waitFor(() => {
    expect(ownerLoad.sourceValue?.journal.hydration).toBe("ready");
    expect(ownerLoad.knowledgeValue?.journal.hydration).toBe("ready");
  }, { timeout: 5000 });
}

it("updates native command readiness and suspends the workspace group without replacing Edit", async () => {
  type NativeItem = { id: string; enabled: boolean };
  const items = new Map<number, NativeItem>();
  const submenus = new Map<number, number[]>();
  const submenuEnabled = new Map<number, boolean>();
  const menus = new Map<number, number[]>();
  const hostMenu = 1;
  let currentMenu = hostMenu, nextResource = hostMenu;
  const setAppMenu = vi.fn((resource: number) => {
    const previous = currentMenu;
    currentMenu = resource;
    return [previous, String(previous)];
  });
  const setEnabled = vi.fn<(kind: string, enabled: boolean, previous: boolean | undefined) => void>();
  const gateIntents = vi.spyOn(InteractionGate.prototype, "acquireIntent");
  const readSettings = applicationSettings.useApplicationSettings;
  const showReferences = new Set<(visible: boolean) => void>();
  const settingsSpy = vi.spyOn(applicationSettings, "useApplicationSettings").mockImplementation(function useDeferredReferenceCommands() {
    const settings = readSettings(), [visible, setVisible] = useState(false);
    useLayoutEffect(() => {
      showReferences.add(setVisible);
      return () => { showReferences.delete(setVisible); };
    }, []);
    return visible ? settings : { ...settings, openReferences: undefined, openMcpQuery: undefined, openMcpShare: undefined };
  });
  // Hold the independent background read so it cannot commit while measuring the gate update.
  const readDecisions = vi.spyOn(decisionCommands, "page").mockReturnValue(new Promise(() => {}));
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("innerWidth", 1440);
  mockIPC((command, args) => {
    const { kind, options, rid, enabled } = args as {
      kind?: string; options?: { enabled?: boolean; items?: (NativeItem | [number, string])[] };
      rid: number; enabled: boolean;
    };
    if (command === "plugin:menu|new") {
      const resource = ++nextResource;
      const children = options?.items?.map(item => {
        if (Array.isArray(item)) return item[0];
        const child = ++nextResource;
        items.set(child, { id: item.id, enabled: item.enabled });
        return child;
      }) ?? [];
      if (kind === "Submenu") {
        submenus.set(resource, children);
        submenuEnabled.set(resource, options?.enabled ?? true);
      }
      if (kind === "Menu") menus.set(resource, children);
      return [resource, String(resource)];
    }
    if (command === "plugin:menu|items") return (submenus.get(rid) ?? []).map(child => [child, items.get(child)!.id, "MenuItem"]);
    if (command === "plugin:menu|set_enabled") {
      setEnabled(kind ?? "", enabled, kind === "Submenu" ? submenuEnabled.get(rid) : items.get(rid)?.enabled);
      if (kind === "Submenu") submenuEnabled.set(rid, enabled);
      else items.get(rid)!.enabled = enabled;
      return;
    }
    if (command === "plugin:menu|set_as_app_menu") return setAppMenu(rid);
    return null;
  }, { shouldMockEvents: true });
  const enabled = (id: string) => {
    const workspace = menus.get(currentMenu)?.[0];
    if (workspace !== undefined && submenuEnabled.get(workspace) === false) return false;
    return submenus.get(workspace ?? 0)?.map(resource => items.get(resource)).find(item => item?.id === id)?.enabled;
  };
  try {
    await openImportWorkspace();
    expect(await screen.findByText(page.rows[0].content.sourcePreview, {}, { timeout: 5000 })).toBeVisible();
    await waitForSourceAndKnowledgeJournals();
    await screen.findByRole("button", { name: i18n.t("conversation.chooseThread") }, { timeout: 5000 });
    await waitFor(() => {
      expect(readDecisions).toHaveBeenCalled();
      expect(enabled("workspace.open-project")).toBe(true);
    }, { timeout: 5000 });
    const activity = within(screen.getByRole("navigation", { name: i18n.t("workbenchV2.activity") }));
    const entries = () => activity.getByRole("button", { name: i18n.t("workbenchV2.entries") });
    expect(entries()).toBeEnabled();
    const gate = gateIntents.mock.contexts.find((_, index) => gateIntents.mock.calls[index][0] === "restore");
    if (!(gate instanceof InteractionGate)) throw new Error("Missing workspace interaction gate");
    // The lazy conversation panel registers its own command. Let the menu
    // include it before checking that availability-only changes keep Edit.
    const setup = { intent: null as ReturnType<InteractionGate["acquireIntent"]> };
    act(() => { setup.intent = gate.acquireIntent("menu-fixture"); });
    if (!setup.intent) throw new Error("Workspace interaction gate is still busy");
    await waitFor(() => expect(enabled("workspace.open-project")).toBe(false));
    act(setup.intent.release);
    await waitFor(() => expect(enabled("workspace.open-project")).toBe(true));
    expect(enabled("conversation.new-thread")).toBeDefined();
    const installed = currentMenu;
    setAppMenu.mockClear();
    setEnabled.mockClear();
    const referenceCommands = ["workspace.references", "workspace.mcp-query", "workspace.mcp-share"];
    for (const command of referenceCommands) expect(enabled(command)).toBe(false);
    act(() => { showReferences.forEach(show => show(true)); });
    await waitFor(() => { for (const command of referenceCommands) expect(enabled(command)).toBe(true); });
    expect(currentMenu).toBe(installed);
    expect(setAppMenu).not.toHaveBeenCalled();
    setEnabled.mockClear();
    entriesPresentation.mockClear();
    let reservation: ReturnType<InteractionGate["acquireIntent"]> = null;
    act(() => { reservation = gate.acquireIntent("editor-paste"); });
    expect(reservation).not.toBeNull();
    expect(entries()).toHaveAttribute("aria-disabled", "true");
    expect(entriesPresentation).not.toHaveBeenCalled();
    await waitFor(() => expect(enabled("workspace.open-project")).toBe(false));
    expect(currentMenu).toBe(installed);
    expect(setEnabled.mock.calls).toEqual([["Submenu", false, true]]);
    entriesPresentation.mockClear();
    act(() => { reservation!.release(); });
    expect(entries()).toBeEnabled();
    expect(entriesPresentation).not.toHaveBeenCalled();
    await waitFor(() => expect(enabled("workspace.open-project")).toBe(true));
    expect(setAppMenu).not.toHaveBeenCalled();
    expect(setEnabled.mock.lastCall).toEqual(["Submenu", true, false]);
    // An owner can finish loading during the reservation. Publish any real
    // per-item changes before restoring the group.
    expect(setEnabled.mock.calls.slice(1, -1).every(([kind, enabled, previous]) => kind === "MenuItem" && enabled !== previous)).toBe(true);

    setEnabled.mockClear();
    act(() => gate.setComposing("test-editor", true));
    await waitFor(() => expect(enabled("workspace.open-project")).toBe(false));
    act(() => gate.setComposing("test-editor", false));
    await waitFor(() => expect(enabled("workspace.open-project")).toBe(true));
    let closeDialog!: () => void;
    act(() => { closeDialog = gate.pushDialog("test-dialog"); });
    await waitFor(() => expect(enabled("workspace.open-project")).toBe(false));
    act(closeDialog);
    await waitFor(() => expect(enabled("workspace.open-project")).toBe(true));
    expect(setEnabled.mock.calls).toEqual([["Submenu", false, true], ["Submenu", true, false], ["Submenu", false, true], ["Submenu", true, false]]);
    expect(setAppMenu).not.toHaveBeenCalled();
  } finally {
    cleanup();
    try { await waitFor(() => expect(currentMenu).toBe(hostMenu)); }
    finally { settingsSpy.mockRestore(); clearMocks(); vi.unstubAllGlobals(); }
  }
}, 15000);

it("lets the first entries and startup journals settle before starting the passive decision count", async () => {
  let finishPage!: (value: SegmentPage) => void;
  const firstPage = new Promise<SegmentPage>(resolve => { finishPage = resolve; });
  const readEntries = vi.mocked(segmentCommands.page).mockReturnValue(firstPage);
  let finishSource!: (value: SourceDraftHead) => void;
  const source = new Promise<SourceDraftHead>(resolve => { finishSource = resolve; });
  const readSource = vi.mocked(sourceDraftCommands.read).mockReturnValue(source);
  let failResources!: (cause: Error) => void;
  const resources = new Promise<ResourceDraftHead>((_, reject) => { failResources = reject; });
  const readResources = vi.mocked(resourceDraftCommands.read).mockReturnValue(resources);
  const readDecisions = vi.spyOn(decisionCommands, "page").mockRejectedValue(new Error("No decision fixture"));
  await openImportWorkspace();
  await waitFor(() => {
    expect(readEntries).toHaveBeenCalled();
    expect(readSource).toHaveBeenCalled();
    expect(readResources).toHaveBeenCalled();
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(readDecisions).not.toHaveBeenCalled();
    await act(async () => { finishPage(page); });
    expect(screen.getByText(page.rows[0].content.sourcePreview)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(readDecisions).not.toHaveBeenCalled();
    await act(async () => { finishSource({ key: { projectId: project.metadata.projectId }, revision: "0", writerId: null, value: null }); });
    expect(ownerLoad.sourceValue?.journal.hydration).toBe("ready");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(readDecisions).not.toHaveBeenCalled();
    await act(async () => { failResources(new Error("Synthetic resource journal read failed")); });
    expect(ownerLoad.knowledgeValue?.journal.hydration).toBe("failed");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(readDecisions).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("waits for the new session's journals and still reads decisions when opened explicitly", async () => {
  const reopened = { ...project, sessionToken: "reopened-session" };
  const readSource = vi.mocked(sourceDraftCommands.read);
  const original = readSource.getMockImplementation()!;
  const held = new Promise<SourceDraftHead>(() => {});
  readSource.mockImplementation(request => request.sessionToken === reopened.sessionToken ? held : original(request));
  const readDecisions = vi.spyOn(decisionCommands, "page").mockRejectedValue(new Error("No decision fixture"));
  await openImportWorkspace(project, { open: vi.fn().mockResolvedValueOnce(project).mockResolvedValueOnce(reopened) });
  await waitFor(() => expect(readDecisions).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: project.sessionToken })));
  readDecisions.mockClear();
  await act(async () => { expect(await controller.open(reopened.locator)).toBe(true); });
  await waitFor(() => expect(readSource).toHaveBeenCalledWith({ sessionToken: reopened.sessionToken, key: { projectId: reopened.metadata.projectId } }));
  expect(await screen.findByText(page.rows[0].content.sourcePreview)).toBeVisible();
  const decisions = screen.getByRole("button", { name: i18n.t("workbenchV2.decisions") });
  await waitFor(() => expect(decisions).toBeEnabled());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(readDecisions).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
  fireEvent.click(decisions);
  await waitFor(() => expect(readDecisions).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: reopened.sessionToken })));
});

it.each([
  { owner: "source", error: "sourceMaintenance.ownerFailed" },
  { owner: "execution", error: "knowledge.loadFailed" },
] as const)("continues the passive decision count when the $owner owner cannot load", async ({ owner, error }) => {
  ownerLoad[owner] = new Error("Synthetic startup owner load failed");
  const readDecisions = vi.spyOn(decisionCommands, "page").mockRejectedValue(new Error("No decision fixture"));
  await openImportWorkspace();
  expect(await screen.findByText(i18n.t(error))).toBeVisible();
  await waitFor(() => expect(readDecisions).toHaveBeenCalled());
});

it("uses the folder picker after a rejected native drop invalidates the offered folder", async () => {
  let deliver: ((event: NativeSourceDropEvent) => void) | undefined;
  const native = vi.spyOn(tauriCore, "isTauri").mockReturnValue(true);
  const menu = vi.spyOn(nativeMenu, "installWorkspaceMenu").mockReturnValue({ update: vi.fn(), dispose: vi.fn() });
  const listen = vi.spyOn(tauriEvents, "listen").mockImplementation(async (event, handler) => {
    if (event !== "source-native-drop") return () => {};
    const send = (payload: NativeSourceDropEvent) => handler({ event, id: 1, payload });
    deliver = send;
    return () => { if (deliver === send) deliver = undefined; };
  });
  vi.spyOn(pluginCommands, "inventory").mockResolvedValue(pluginSourceInventory);
  vi.spyOn(pluginCommands, "package").mockResolvedValue(pluginSourcePackage);
  vi.spyOn(pluginCommands, "source").mockResolvedValue(pluginSourceView);
  const choose = vi.spyOn(sourceCommands, "selectPlugin").mockResolvedValue(pluginSourceWorkflow.selection);
  const selectDropped = vi.spyOn(sourceCommands, "selectDropped").mockResolvedValue(pluginSourceWorkflow.selection);
  const send = (event: NativeSourceDropEvent) => act(() => deliver?.(event));
  const ready = (folderName: string, dropTicket: string) => send({
    kind: "ready", projectId: project.metadata.projectId, sessionToken: project.sessionToken, folderName, dropTicket,
  });
  const invalidDrop = () => send({ kind: "rejected", error: {
    code: "invalid-input", stage: "execution-read", outcome: "rejected", recoveryRequired: false, reason: "native-drop-one-directory",
  } });
  try {
    await openImportWorkspace();
    await waitFor(() => expect(deliver).toBeTypeOf("function"));
    ready("First source", fixtureIdentity(923));
    const sheet = await screen.findByRole("dialog", { name: i18n.t("sourceMaintenance.title") });
    const importer = await within(sheet).findByRole("combobox", { name: i18n.t("source.integration") });
    await waitFor(() => expect(importer).toBeEnabled());
    const choice = `${pluginSourceRequest.package.packageDigest}:${pluginSourceRequest.resourceId}`;
    fireEvent.change(importer, { target: { value: choice } });
    const runtime = within(sheet).getByRole("combobox", { name: i18n.t("sourcePlugin.runtime") });
    fireEvent.change(runtime, { target: { value: pluginSourceRequest.environmentDigest } });
    const dropButton = { name: i18n.t("sourceMaintenance.useDroppedFolder") };
    await waitFor(() => expect(within(sheet).getByRole("button", dropButton)).toBeEnabled());

    invalidDrop();
    expect(within(sheet).queryByRole("button", dropButton)).not.toBeInTheDocument();
    expect(within(sheet).getByText(i18n.t("sourceMaintenance.dropFailed"))).toBeVisible();
    expect(within(sheet).queryByText(i18n.t("sourceMaintenance.droppedFolder", { folder: "First source" }))).not.toBeInTheDocument();
    expect(importer).toHaveValue(choice);
    expect(runtime).toHaveValue(pluginSourceRequest.environmentDigest);
    expect(choose).not.toHaveBeenCalled();
    expect(selectDropped).not.toHaveBeenCalled();

    ready("New source", fixtureIdentity(924));
    expect(within(sheet).getByText(i18n.t("sourceMaintenance.droppedFolder", { folder: "New source" }))).toBeVisible();
    expect(within(sheet).queryByText(i18n.t("sourceMaintenance.dropFailed"))).not.toBeInTheDocument();
    invalidDrop();
    fireEvent.click(within(sheet).getByRole("button", { name: i18n.t("sourceMaintenance.chooseFolder") }));
    await waitFor(() => expect(choose).toHaveBeenCalledOnce());
    expect(selectDropped).not.toHaveBeenCalled();
  } finally {
    listen.mockRestore(); native.mockRestore(); menu.mockRestore();
  }
});

it("keeps entries stable when opening the first local draft and pasting in recovery", async () => {
  const { unitId, locale, nativeKey, sourceRevisionId, sourcePreview } = page.rows[0].content;
  const key = { projectId: project.metadata.projectId, unitId, locale };
  const basis: DraftBasis = { sourceRevisionId, selectionId: null, revisionId: null, text: null };
  let head: DraftHead = { key, revision: "0", writerId: null, value: null };
  vi.spyOn(segmentCommands, "queueWindow").mockResolvedValue({ ...page, firstPosition: 0, previousUnitId: null, nextUnitId: null });
  vi.spyOn(draftCommands, "read").mockImplementation(async () => ({ head: structuredClone(head), current: {
    kind: "current", basis, nativeKey, sourceText: sourcePreview,
  } }));
  const write = vi.spyOn(draftCommands, "write").mockImplementation(async ({ write }) => {
    const { editSeq, text } = write.value;
    head = { key: write.key, revision: (BigInt(head.revision) + 1n).toString(), writerId: write.writerId, value: { basis, editSeq, text, pending: null } };
    return structuredClone(head);
  });
  vi.spyOn(decisionCommands, "page").mockRejectedValue(new Error("No decision fixture"));
  await openImportWorkspace();
  const edit = await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: nativeKey }) }, { timeout: 5000 });
  await waitFor(() => expect(edit).toBeEnabled());
  fireEvent.click(edit);
  const inputName = i18n.t("workbenchV2.editorLabel", { key: nativeKey });
  const input = await screen.findByRole("textbox", { name: inputName }, { timeout: 5000 });
  await waitForSourceAndKnowledgeJournals();
  await screen.findByLabelText(i18n.t("workbenchV2.decisionsBadgeError"), {}, { timeout: 5000 });
  const recoveryName = i18n.t("workbenchV2.draftRecoveryTitle");
  expect(screen.getByRole("button", { name: recoveryName })).toBeDisabled();
  entriesPresentation.mockClear();

  const text = "First local draft e\u0301 👩🏽‍💻 {{name}}\nSecond line";
  fireEvent.change(input, { target: { value: text } });
  const recovery = screen.getByRole("button", { name: recoveryName });
  expect(recovery).toBeEnabled();
  expect(entriesPresentation).not.toHaveBeenCalled();
  await waitFor(() => expect(write).toHaveBeenCalledWith(expect.objectContaining({ write: expect.objectContaining({
    key, value: expect.objectContaining({ text }),
  }) })));
  act(() => recovery.focus());
  fireEvent.click(recovery);
  const sheet = await screen.findByRole("dialog", { name: recoveryName });
  const recovered = await within(sheet).findByRole<HTMLTextAreaElement>("textbox", { name: inputName });
  expect(recovered).toHaveValue(text);

  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const execCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  let finishRead!: (text: string) => void;
  const readText = vi.fn(() => new Promise<string>(resolve => { finishRead = resolve; }));
  const insertText = vi.fn((command: string, _showUi: boolean, value: string) => {
    if (command !== "insertText" || document.activeElement !== recovered) return false;
    fireEvent.change(recovered, { target: { value } });
    return true;
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: insertText });
  try {
    const replacement = "Recovered e\u0301 👩🏽‍💻 {{name}}\nSecond line";
    await waitFor(() => expect(recovered).toHaveFocus());
    expect(within(sheet).getByRole("button", { name: nativeKey })).toHaveAttribute("aria-current", "true");
    expect(within(sheet).getByText(sourcePreview)).toBeVisible();
    entriesPresentation.mockClear();
    recovered.select();
    expect(fireEvent.paste(recovered, { clipboardData: { getData: () => replacement.normalize("NFC") } })).toBe(false);
    expect(readText).toHaveBeenCalledTimes(1);
    await act(async () => { finishRead(replacement); });
    expect(insertText).toHaveBeenCalledWith("insertText", false, replacement);
    expect(recovered).toHaveValue(replacement);
    await waitFor(() => expect(head.value?.text).toBe(replacement));
    await within(sheet).findByText(i18n.t("workbenchV2.editorPreserved"));
    expect(entriesPresentation).not.toHaveBeenCalled();

    recovered.select();
    fireEvent.paste(recovered, { clipboardData: { getData: () => "Cancelled input" } });
    expect(readText).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(recovered, { key: "Escape" });
    expect(sheet).toBeVisible();
    expect(recovered).toHaveFocus();
    expect(within(sheet).getByText(i18n.t("workbenchV2.editorPasteCancelled"))).toBeVisible();
    await act(async () => { finishRead("Cancelled input"); });
    expect(insertText).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveValue(replacement);
    expect(head.value?.text).toBe(replacement);

    fireEvent.keyDown(recovered, { key: "Escape" });
    await waitFor(() => {
      expect(sheet).not.toBeInTheDocument();
      expect(recovery).toHaveFocus();
    });
  } finally {
    platform.mockRestore();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (execCommand) Object.defineProperty(document, "execCommand", execCommand);
    else Reflect.deleteProperty(document, "execCommand");
  }
}, 15000);

it("creates an empty project without restoring the previous project's focused route or extra view", async () => {
  const created: ProjectView = { ...project, locator: "/synthetic/new-empty", sessionToken: "created-session",
    metadata: { ...project.metadata, projectId: fixtureIdentity(905), displayName: "Created empty project", targetLocales: ["ja"] } };
  vi.mocked(sourceCommands.scope).mockImplementation(async request => ({ currentSnapshot: request.projectId === created.metadata.projectId ? null : "snapshot", revision: "1" }));
  const create = vi.fn(async () => created);
  const { register } = await openImportWorkspace(project, { create });
  const originalSession = controller.getSnapshot().session!;
  fireEvent.click(await screen.findByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: "dialogue.hello" }) }));
  const detailDrawer = screen.queryByRole("dialog", { name: i18n.t("workbenchV2.agent") });
  if (detailDrawer) {
    fireEvent.click(within(detailDrawer).getByRole("button", { name: i18n.t("workbenchV2.close") }));
    await waitFor(() => expect(detailDrawer).not.toBeInTheDocument());
  }
  await waitFor(() => expect(location.hash).toContain("focus=unit"));
  await waitFor(() => {
    const participants = new Map(register.mock.calls.map(([participant]) => [participant.id, participant]));
    expect([...participants.values()].filter(participant => participant.inspect({ kind: "create-project" }).status !== "ready")
      .map(participant => participant.id)).toEqual([]);
  }, { timeout: 5000 });
  await act(async () => {
    const changed = await controller.create({ destination: created.locator, displayName: created.metadata.displayName, sourceLocale: "en", targetLocales: ["ja"] });
    expect(changed, JSON.stringify(controller.getSnapshot().failure)).toBe(true);
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(originalSession.reads.retired).toBe(true);
  expect(controller.getSnapshot().retainedSession).toBeNull();
  expect(await screen.findByRole("button", { name: i18n.t("workbenchV2.noSourceImport") }, { timeout: 5000 })).toBeEnabled();
  const views = within(screen.getByRole("navigation", { name: i18n.t("workbenchV2.views") }));
  expect(views.getAllByRole("button", { name: i18n.t("workbenchV2.viewName", { locale: "ja" }) })).toHaveLength(1);
  expect(views.queryByRole("button", { name: i18n.t("workbenchV2.viewName", { locale: "zh-CN" }) })).not.toBeInTheDocument();
  expect(location.hash).toContain(`projectId=${created.metadata.projectId}`);
  expect(location.hash).not.toContain("focus=unit");
  expect(screen.queryByText("Actual source from the read port")).not.toBeInTheDocument();
  expect(vi.mocked(segmentCommands.page).mock.calls.every(([request]) => request.projectId === project.metadata.projectId)).toBe(true);
}, 15000);
async function openImportPalette() {
  const open = screen.getByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") });
  await waitFor(() => expect(open).toBeEnabled()); fireEvent.click(open);
  const dialog = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.commands") });
  const option = within(dialog).getByRole("option", { name: i18n.t("workbenchV2.importTitle") });
  expect(option).not.toHaveAttribute("aria-disabled", "true"); fireEvent.click(option);
  return screen.findByRole("region", { name: i18n.t("workbenchV2.importTitle") });
}

it("opens the retained Source recovery from the first command while its original owner is still loading", async () => {
  let releaseSource!: () => void; ownerLoad.source = new Promise<void>(resolve => { releaseSource = resolve; });
  const inputs = sourceDraftStateFixture(); inputs.source.actor = "Retained source B 人工"; inputs.source.editSeq = 1;
  const pending = { kind: "capture" as const, request: { projectId: project.metadata.projectId, selectionId: fixtureIdentity(851),
    attemptId: fixtureIdentity(852), sourceLanguage: "en" }, submittedSeq: "1", submittedMappingSeq: "0" };
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key: { projectId: project.metadata.projectId },
    writerId: fixtureIdentity(853), expectedRevision: "0", value: { ...sourceDraftValue(inputs, "2"), pending } } });
  vi.spyOn(pluginCommands, "inventory").mockResolvedValue(pluginSourceInventory);
  vi.spyOn(pluginCommands, "package").mockResolvedValue(pluginSourcePackage);
  const observe = vi.spyOn(sourceDraftCommands, "observe"), select = vi.spyOn(sourceCommands, "selectPlugin"), start = vi.spyOn(sourceCommands, "startPlugin");
  controller = new ProjectLifecycle({ open: async () => project, close: vi.fn(async () => ({ closed: true })),
    status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  const register = vi.spyOn(controller, "register");
  render(<StrictMode><WorkbenchApp controller={controller} native/></StrictMode>);
  const user = userEvent.setup();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  await user.type(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), project.locator);
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  const open = await screen.findByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") }, { timeout: 5000 });
  await waitFor(() => expect(open).toBeEnabled(), { timeout: 5000 }); await user.click(open);
  const palette = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.commands") });
  await user.click(within(palette).getByRole("option", { name: i18n.t("sourceMaintenance.title") }));
  expect(await screen.findByText(i18n.t("sourceMaintenance.recoveryLoading"))).toBeVisible();
  const registeredBeforeLoad = register.mock.calls.filter(([value]) => value.id === "source-maintenance");
  const participant = registeredBeforeLoad.at(-1)?.[0];
  expect(participant).toBeDefined();
  expect(participant?.inspect({ kind: "close-project" }).status).toBe("blocked");
  await act(async () => { ownerLoad.source = null; releaseSource(); });
  const sheet = await screen.findByRole("dialog", { name: i18n.t("sourceMaintenance.title") }, { timeout: 5000 });
  expect(await within(sheet).findByRole("button", { name: i18n.t("sourceMaintenance.recoveryCheck") })).toBeEnabled();
  fireEvent.click(within(sheet).getByRole("button", { name: i18n.t("sourceMaintenance.recoveryShow") }));
  expect(within(sheet).getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("sourceMaintenance.recoveryLocal") }).value).toContain("Retained source B 人工");
  expect(observe).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(register.mock.calls.filter(([value]) => value.id === "source-maintenance")).toHaveLength(registeredBeforeLoad.length);
  expect(participant?.inspect({ kind: "close-project" }).status).toBe("blocked");
  fireEvent.click(within(sheet).getByRole("button", { name: i18n.t("sourceMaintenance.close") }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: i18n.t("sourceMaintenance.title") })).not.toBeInTheDocument());
  const saved = await sourceDraftCommands.read({ sessionToken: project.sessionToken, key: { projectId: project.metadata.projectId } });
  expect(saved.value?.pending).toEqual(pending); expect(saved.value?.actor).toBe("Retained source B 人工");
}, 15000);

it.each(["focus", "view"] as const)("cancels late Source presentation when the user changes %s before the original owner arrives", async movement => {
  let releaseSource!: () => void; ownerLoad.source = new Promise<void>(resolve => { releaseSource = resolve; });
  const close = vi.fn(async () => ({ closed: true }));
  controller = new ProjectLifecycle({ open: async () => project, close,
    status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  const register = vi.spyOn(controller, "register"), observe = vi.spyOn(sourceDraftCommands, "observe"), start = vi.spyOn(sourceCommands, "startPlugin");
  render(<StrictMode><WorkbenchApp controller={controller} native/></StrictMode>); const user = userEvent.setup();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  await user.type(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), project.locator);
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  const open = await screen.findByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") }, { timeout: 5000 });
  await waitFor(() => expect(open).toBeEnabled(), { timeout: 5000 }); await user.click(open);
  const palette = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.commands") });
  await user.click(within(palette).getByRole("option", { name: i18n.t("sourceMaintenance.title") }));
  expect(await screen.findByText(i18n.t("sourceMaintenance.recoveryLoading"))).toBeVisible();
  const participant = register.mock.calls.filter(([value]) => value.id === "source-maintenance").at(-1)?.[0];
  expect(participant).toBeDefined(); expect(participant?.inspect({ kind: "close-project" }).status).toBe("blocked");
  const originalTab = within(screen.getByRole("navigation", { name: i18n.t("workbenchV2.views") })).getByRole("button", { current: "page" });
  let selectedTab = originalTab;
  if (movement === "view") {
    await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.newView") }));
    await waitFor(() => {
      selectedTab = within(screen.getByRole("navigation", { name: i18n.t("workbenchV2.views") })).getByRole("button", { current: "page" });
      expect(selectedTab).not.toBe(originalTab);
    });
  }
  const search = screen.getByRole("textbox", { name: i18n.t("workbenchV2.searchEntries") });
  await user.click(search); await user.type(search, "Newer search B"); expect(search).toHaveFocus();
  await waitFor(() => expect(screen.queryByText(i18n.t("sourceMaintenance.recoveryLoading"))).not.toBeInTheDocument());
  await act(async () => { ownerLoad.source = null; releaseSource(); });
  await waitFor(() => expect(participant?.inspect({ kind: "close-project" }).status).toBe("ready"), { timeout: 5000 });
  expect(search).toHaveFocus(); expect(search).toHaveValue("Newer search B"); expect(selectedTab).toHaveAttribute("aria-current", "page");
  expect(screen.queryByRole("dialog", { name: i18n.t("sourceMaintenance.title") })).not.toBeInTheDocument();
  expect(observe).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
}, 15000);

it("shows project observation fallback in the workspace and refreshes through its guarded command", async () => {
  const write = vi.spyOn(draftCommands, "write");
  const reads = new SessionReads({ projectId: project.metadata.projectId, sessionToken: project.sessionToken });
  vi.spyOn(reads, "subscriptionUnavailable").mockReturnValue(true);
  const synchronize = vi.spyOn(reads, "synchronize").mockResolvedValue();
  const read = vi.fn(async () => project);
  controller = new ProjectLifecycle({ open: async () => project, read, close: async () => ({ closed: true }),
    createReads: () => reads, status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  render(<StrictMode><WorkbenchApp controller={controller} native/></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  await screen.findByText(i18n.t("execution.updatesUsingPolling"));
  // The observation banner is available before lazy workspace modules finish.
  const search = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.searchEntries") }, { timeout: 5000 });
  const refresh = () => {
    const notice = screen.getByText(i18n.t("execution.updatesUsingPolling")).closest<HTMLElement>("[role=status]");
    if (!notice) throw new Error("Project observation notice is missing");
    return within(notice).getByRole("button", { name: i18n.t("execution.refresh") });
  };
  await waitFor(() => expect(refresh()).toBeEnabled());
  fireEvent.compositionStart(search); expect(refresh()).toBeDisabled();
  fireEvent.compositionEnd(search); await waitFor(() => expect(refresh()).toBeEnabled());
  fireEvent.click(refresh());
  await waitFor(() => expect(synchronize).toHaveBeenCalledExactlyOnceWith(true));
  expect(read).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
});

describe("import workspace assembly", () => {
  it("protects lazy owner registration and allows a loaded idle importer to close normally", async () => {
    const { button, close, register } = await openImportWorkspace();
    const loading = register.mock.calls.find(([participant]) => participant.id === "translation-import-loading")![0];
    expect(loading.inspect({ kind: "close-project" }).status).toBe("ready");
    fireEvent.click(button); expect(loading.inspect({ kind: "close-project" }).status).toBe("blocked");
    await screen.findByRole("region", { name: i18n.t("workbenchV2.importTitle") });
    expect(loading.inspect({ kind: "close-project" }).status).toBe("ready");
    await act(async () => { expect(await controller.close()).toBe(true); });
    expect(close).toHaveBeenCalledOnce(); expect(controller.getSnapshot().retainedSession).toBeNull();
    expect(screen.queryByRole("region", { name: i18n.t("workbenchV2.importTitle") })).not.toBeInTheDocument();
  });

  it("retains one import owner across back, tabs, language changes and reopening through the empty-workspace palette", async () => {
    const opened = { ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN", "ja"] } };
    const { button, register } = await openImportWorkspace(opened);
    expect(register.mock.calls.some(([participant]) => participant.id === "translation-import")).toBe(false);
    fireEvent.click(button);
    await screen.findByRole("region", { name: i18n.t("workbenchV2.importTitle") });
    const registrations = register.mock.calls.filter(([participant]) => participant.id === "translation-import").length;
    const original = importPresentation!.owners.imports.current;
    fireEvent.click(screen.getByRole("button", { name: "Retain import selection" }));
    expect(screen.getByLabelText("Retained import file")).toHaveTextContent("retained-import.json");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.importBack") }));
    expect(await screen.findByRole("textbox", { name: i18n.t("workbenchV2.searchEntries") })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.newView") }));
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: i18n.t("workbenchV2.views") })).getAllByRole("button", { name: i18n.t("workbenchV2.viewName", { locale: "zh-CN" }) })).toHaveLength(2));
    await openImportPalette();
    expect(importPresentation!.owners.imports.current()).toBe(original());
    expect(importPresentation!.owners.imports.current().fileName).toBe("retained-import.json");
    const language = screen.getByRole("button", { name: "zh-CN" }); language.focus(); fireEvent.keyDown(language, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "ja" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "ja" })).toBeVisible());
    expect(importPresentation!.owners.imports.current().targetLocale).toBe("zh-CN");
    expect(location.hash).not.toContain("entryMode");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.viewName", { locale: "ja" }) }) }));
    await screen.findByRole("textbox", { name: i18n.t("workbenchV2.searchEntries") });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.viewName", { locale: "zh-CN" }) }) }));
    await screen.findByText(i18n.t("workbenchV2.noViews"));
    await openImportPalette();
    expect(importPresentation!.owners.imports.current().fileName).toBe("retained-import.json");
    expect(register.mock.calls.filter(([participant]) => participant.id === "translation-import")).toHaveLength(registrations);
  }, 15000);

  it("opens the imported entry with its locale and a clean all-entry queue instead of the previous search and filter", async () => {
    const unitId = translationFixture.save.unitId, sourceRevisionId = translationFixture.save.sourceRevisionId;
    const opened = { ...project, metadata: { ...project.metadata, projectId: translationFixture.save.projectId } };
    const row = { ...page.rows[0], protection: { ...page.rows[0].protection, unitId },
      content: { ...page.rows[0].content, unitId, sourceRevisionId, nativeKey: "imported.target", selectionId: null, revisionId: null, translationPreview: null } };
    vi.mocked(segmentCommands.page).mockImplementation(async request => ({ ...page, projectId: opened.metadata.projectId, query: { ...request.query, status: request.query.status ?? "all" },
      scopeId: request.query.text ? "old-search-scope" : "all-entry-scope", rows: [row] }));
    const queue = vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => ({ projectId: opened.metadata.projectId, locale: request.locale,
      scopeId: "all-entry-scope", sourceSnapshotId: "snapshot", query: { text: "", selection: "all", status: "all" }, queryFingerprint: page.queryFingerprint,
      epoch: page.epoch, sequence: "1", total: 1, firstPosition: 0, previousUnitId: null, nextUnitId: null, rows: [row] }));
    vi.spyOn(draftCommands, "read").mockImplementation(async ({ key }) => ({ head: { key, revision: "0", writerId: null, value: null },
      current: { kind: "current", basis: { sourceRevisionId, selectionId: null, revisionId: null, text: null }, nativeKey: "imported.target", sourceText: "Imported source" } }));
    await openImportWorkspace(opened);
    const search = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.searchEntries") });
    fireEvent.change(search, { target: { value: "previous search" } });
    fireEvent.submit(screen.getByRole("form", { name: i18n.t("workbenchV2.searchEntries") }));
    await waitFor(() => expect(location.hash).toContain("query=previous+search"));
    const filter = screen.getByRole("button", { name: i18n.t("workbenchV2.allEntries") }); filter.focus(); fireEvent.keyDown(filter, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: i18n.t("workbenchV2.unselectedEntries") }));
    await waitFor(() => expect(location.hash).toContain("preset=unselected"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.importTitle") }));
    await screen.findByRole("region", { name: i18n.t("workbenchV2.importTitle") });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.importOpenEntry") }));
    const input = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "imported.target" }) });
    expect(input).toBeVisible(); expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.searchEntries") })).toHaveValue("");
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ locale: "zh-CN", scopeId: "all-entry-scope", anchorUnitId: unitId }));
    expect(location.hash).toContain(`focus=${unitId}`); expect(location.hash).toContain("preset=all"); expect(location.hash).not.toContain("query=");
  });

  it("reveals a hidden unknown import with no tabs while preserving its original request and allowing recovery presentation to close", async () => {
    const snapshot = translationFixture.start.expectedSourceSnapshotId;
    vi.mocked(sourceCommands.scope).mockResolvedValue({ currentSnapshot: snapshot, revision: "1" });
    vi.spyOn(translationCommands, "selectPlugin").mockResolvedValue(translationSelectionFixture(snapshot));
    vi.spyOn(translationCommands, "preflightPlugin").mockImplementation(async request => translationCaptureFixture(request.attemptId, snapshot));
    let identity = 60; vi.spyOn(executionCommands, "identity").mockImplementation(async () => fixtureIdentity(identity++));
    const start = vi.spyOn(translationCommands, "startPlugin").mockRejectedValue(new Error("Lost start acknowledgement"));
    vi.spyOn(executionCommands, "pluginStartAction").mockResolvedValue(null);
    const { button, close } = await openImportWorkspace(); fireEvent.click(button);
    await screen.findByRole("region", { name: i18n.t("workbenchV2.importTitle") });
    const owner = importPresentation!.owners.imports;
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.importBack") }));
    await screen.findByRole("textbox", { name: i18n.t("workbenchV2.searchEntries") });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.viewName", { locale: "zh-CN" }) }) }));
    await screen.findByText(i18n.t("workbenchV2.noViews"));
    await act(async () => { await owner.chooseFolder(translationImportChoice(snapshot)); owner.setFile("zh.json"); owner.confirmLanguage(true);
      await owner.preflight(); owner.consentProducer(true); owner.confirmLanguage(true); await owner.start(); });
    const pending = structuredClone(owner.current().pendingStart); expect(pending).not.toBeNull();
    await act(async () => { expect(await controller.close()).toBe(false); });
    const recovery = await screen.findByRole("region", { name: i18n.t("workbenchV2.importTitle") });
    expect(importPresentation!.viewId).toBeNull(); expect(owner.current().pendingStart).toEqual(pending); expect(close).not.toHaveBeenCalled();
    fireEvent.compositionStart(recovery);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.importBack") })); expect(recovery).toBeVisible();
    fireEvent.compositionEnd(recovery);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.importBack") }));
    await screen.findByText(i18n.t("workbenchV2.noViews"));
    await openImportPalette(); expect(owner.current().pendingStart).toEqual(pending); expect(start).toHaveBeenCalledTimes(1);
  }, 15000);

});

describe("real-port workspace assembly", () => {
  it("opens through the project controller and keeps search input separate in two views sharing entry facts", async () => {
    const open = vi.fn().mockResolvedValue(project);
    controller = new ProjectLifecycle({ open });
    render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: project.locator } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
    expect(await screen.findByText("Actual source from the read port")).toBeVisible();
    expect(open).toHaveBeenCalledWith({ locator: project.locator });
    const search = screen.getByRole("textbox", { name: "查找条目" });
    fireEvent.change(search, { target: { value: "unsent view A search" } });
    await waitFor(() => expect(controller.getSnapshot().phase).toBe("idle"), { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "新建条目视图" })).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: "新建条目视图" })).toBeEnabled();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "新建条目视图" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "查找条目" })).toHaveValue(""));
    const tabs = within(screen.getByRole("navigation", { name: "工作视图" })).getAllByRole("button", { name: "条目 · zh-CN" });
    expect(tabs).toHaveLength(2); fireEvent.click(tabs[0]);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "查找条目" })).toHaveValue("unsent view A search"));
    expect(segmentCommands.page).toHaveBeenCalledTimes(1);
  });

  it("settles an open acknowledgement while keeping a folder typed during the request", async () => {
    let resolve!: (value: ProjectView) => void;
    const open = vi.fn().mockImplementation(() => new Promise<ProjectView>(done => { resolve = done; }));
    controller = new ProjectLifecycle({ open });
    render(<WorkbenchApp controller={controller} native />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
    const input = screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") });
    fireEvent.change(input, { target: { value: project.locator } }); fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "/synthetic/newer-folder" } });
    await act(async () => resolve(project));
    const dialog = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.openProject") });
    expect(within(dialog).getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") })).toHaveValue("/synthetic/newer-folder");
    expect(controller.getSnapshot().session?.project).toEqual(project);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("uses the original page cursor and starts a fresh scope when the selection filter changes", async () => {
    const read = vi.mocked(segmentCommands.page).mockImplementation(async request => {
      if (request.query.selection === "unselected") return { ...page, query: { ...request.query, status: request.query.status ?? "all" }, scopeId: "unselected-scope", total: 0, rows: [] };
      return request.cursor ? { ...page, total: 2, rows: [{ ...page.rows[0], protection: { ...page.rows[0].protection, unitId: "unit-two" }, content: { ...page.rows[0].content, unitId: "unit-two", sourcePreview: "Second page source" } }] }
        : { ...page, total: 2, nextCursor: "opaque-next" };
    });
    controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(project) });
    render(<WorkbenchApp controller={controller} native />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: project.locator } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
    fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByText("Second page source")).toBeVisible();
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ scopeId: "scope", cursor: "opaque-next" }));
    const filter = screen.getByRole("button", { name: "全部条目" });
    await waitFor(() => expect(filter).toBeEnabled());
    filter.focus(); fireEvent.keyDown(filter, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "尚未选用译文" }));
    expect(await screen.findByText("没有匹配的条目")).toBeVisible();
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ query: { text: "", selection: "unselected", status: "all" }, scopeId: null, cursor: null }));
    expect(read.mock.calls.filter(([request]) => request.query.selection === "unselected").every(([request]) => request.scopeId !== "scope")).toBe(true);
    expect(screen.queryByRole("button", { name: "回到首页" })).not.toBeInTheDocument();
  });

  it("keeps the first navigation permit current when the original task and knowledge owners arrive during it", async () => {
    let releaseExecution!: () => void, releaseKnowledge!: () => void, entered!: () => void, finish!: () => void;
    ownerLoad.execution = new Promise<void>(resolve => { releaseExecution = resolve; });
    ownerLoad.knowledge = new Promise<void>(resolve => { releaseKnowledge = resolve; });
    const guarding = new Promise<void>(resolve => { entered = resolve; }), continueNavigation = new Promise<void>(resolve => { finish = resolve; });
    const read = vi.mocked(segmentCommands.page).mockImplementation(async request => request.cursor
      ? { ...page, total: 2, rows: [{ ...page.rows[0], content: { ...page.rows[0].content, sourcePreview: "Second page source" } }] }
      : { ...page, total: 2, nextCursor: "opaque-next" });
    const close = vi.fn(async () => ({ closed: true }));
    controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(project), close });
    const lifecycle = controller, register = vi.spyOn(lifecycle, "register"), prepare = lifecycle.prepareLeave.bind(lifecycle);
    let paused = false;
    const leave = vi.spyOn(lifecycle, "prepareLeave").mockImplementation(async (intent, current) => {
      const permit = await prepare(intent, current);
      if (intent.kind === "navigate" && !paused) { paused = true; entered(); await continueNavigation; }
      return permit;
    });
    render(<WorkbenchApp controller={lifecycle} native/>);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: project.locator } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
    const next = await screen.findByRole("button", { name: i18n.t("workbenchV2.nextPage") }, { timeout: 5000 });
    await waitFor(() => expect(next).toBeEnabled());
    const tasks = register.mock.calls.find(([participant]) => participant.id === "execution-tasks")?.[0];
    const knowledge = register.mock.calls.find(([participant]) => participant.id === "knowledge-resources")?.[0];
    if (!tasks || !knowledge) throw new Error("Startup lifecycle registrations are required");
    const tasksBefore = tasks.inspect({ kind: "navigate" }), knowledgeBefore = knowledge.inspect({ kind: "navigate" });
    expect(tasks.inspect({ kind: "close-project" }).status).toBe("blocked");
    expect(knowledge.inspect({ kind: "close-project" }).status).toBe("blocked");
    await act(async () => { expect(await lifecycle.close()).toBe(false); });
    expect(lifecycle.getSnapshot().failure).toMatchObject({ code: "leave-blocked", ownerId: "execution-tasks" });
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(next); await act(async () => { await guarding; });
    await act(async () => { ownerLoad.execution = null; releaseExecution(); });
    await waitFor(() => expect(tasks.inspect({ kind: "close-project" }).status).toBe("ready"));
    expect(knowledge.inspect({ kind: "close-project" }).status).toBe("blocked");
    await act(async () => { ownerLoad.knowledge = null; releaseKnowledge(); });
    await waitFor(() => expect(knowledge.inspect({ kind: "close-project" }).status).toBe("ready"));
    expect(tasks.inspect({ kind: "navigate" })).toEqual(tasksBefore);
    expect(knowledge.inspect({ kind: "navigate" })).toEqual(knowledgeBefore);
    expect(register.mock.calls.filter(([participant]) => participant.id === "execution-tasks")).toHaveLength(1);
    expect(register.mock.calls.filter(([participant]) => participant.id === "knowledge-resources")).toHaveLength(1);
    await act(async () => { finish(); });
    expect(await screen.findByText("Second page source")).toBeVisible();
    expect(read.mock.calls.map(([request]) => request.cursor)).toEqual([null, "opaque-next"]);
    expect(leave.mock.calls.filter(([intent]) => intent.kind === "navigate")).toHaveLength(1);
    expect(lifecycle.getSnapshot().failure).toBeNull();
  });

  it("dispatches platform Save and returns focus when a saved candidate reuses the editor", async () => {
    const retained: unknown = structuredClone(draftFixture.responses.read);
    if (!validateResponseRead(retained) || !retained.head.value || retained.current.kind !== "current") throw new Error("Invalid editor save fixture");
    retained.head.value.pending = null;
    let head = retained.head;
    const current = retained.current, key = head.key, nativeKey = current.nativeKey;
    const opened = { ...project, metadata: { ...project.metadata, projectId: key.projectId } };
    const readPending = vi.fn(() => false);
    vi.mocked(draftCommands.list).mockResolvedValue({ items: Array.from({ length: 96 }, (_, index) => ({
      key: { ...key, unitId: fixtureIdentity(97000 + index) }, revision: "3", editSeq: "2",
      sourceRevisionId: current.basis.sourceRevisionId, get hasPending() { return readPending(); },
    })), next: null });
    const row = { ...structuredClone(page.rows[0]), protection: { ...page.rows[0].protection, unitId: key.unitId },
      content: { ...page.rows[0].content, unitId: key.unitId, sourceSnapshotId: translationFixture.start.expectedSourceSnapshotId,
        sourceRevisionId: current.basis.sourceRevisionId, nativeKey, selectionId: null, revisionId: null, translationPreview: null } };
    const captured = { ...page, projectId: key.projectId, sourceSnapshotId: row.content.sourceSnapshotId, rows: [row] };
    vi.mocked(sourceCommands.scope).mockResolvedValue({ currentSnapshot: captured.sourceSnapshotId, revision: "1" });
    vi.mocked(segmentCommands.page).mockResolvedValue(captured);
    vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => ({ projectId: key.projectId, locale: request.locale,
      scopeId: captured.scopeId, sourceSnapshotId: captured.sourceSnapshotId, query: captured.query, queryFingerprint: captured.queryFingerprint,
      epoch: captured.epoch, sequence: captured.sequence, total: 1, firstPosition: 0, previousUnitId: null, nextUnitId: null, rows: [row] }));
    vi.spyOn(draftCommands, "read").mockImplementation(async () => ({ head: structuredClone(head), current: structuredClone(current) }));
    vi.spyOn(draftCommands, "write").mockImplementation(async ({ write }) => {
      expect(write.key).toEqual(key); expect(write.expectedRevision).toBe(head.revision);
      const value: unknown = { key, writerId: write.writerId, revision: (BigInt(head.revision) + 1n).toString(), value: structuredClone(write.value) };
      if (!validateResponseWritten(value)) throw new Error("Invalid editor save write fixture");
      head = value; return structuredClone(head);
    });
    vi.spyOn(draftCommands, "clear").mockImplementation(async ({ clear }) => {
      expect(clear.key).toEqual(key); expect(clear.expectedRevision).toBe(head.revision);
      const value: unknown = { key, writerId: null, revision: (BigInt(head.revision) + 1n).toString(), value: null };
      if (!validateResponseCleared(value)) throw new Error("Invalid editor save clear fixture");
      head = value; return structuredClone(head);
    });
    vi.spyOn(executionCommands, "identity").mockResolvedValue(translationFixture.save.actionId);
    const save = vi.spyOn(translationCommands, "save").mockImplementation(async request => {
      const selection = { ...translationFixture.receipt.selection, actionId: request.actionId, unitId: request.unitId, locale: request.locale,
        previousEventId: request.expectedSelectionId ?? null, sequence: "1" };
      const receipt = validateSaveReceipt({ ...translationFixture.receipt, actionId: request.actionId, projectId: request.projectId, selection,
        revision: { ...translationFixture.receipt.revision, actionId: request.actionId, unitId: request.unitId, locale: request.locale, sourceRevisionId: request.sourceRevisionId, text: request.text },
        basis: { ...translationFixture.receipt.basis, sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId } }, request);
      current.basis = { sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId, revisionId: selection.revisionId, text: request.text };
      return receipt;
    });
    const candidate = { ...translationFixture.receipt.revision, unitId: key.unitId, locale: key.locale,
      sourceRevisionId: current.basis.sourceRevisionId, sourceSnapshotId: captured.sourceSnapshotId,
      revisionId: fixtureIdentity(98601), originKind: "ai" as const, text: "Saved candidate {{name}}", candidateDecision: null };
    const history = () => ({ unitId: key.unitId, locale: key.locale, current: { ...translationFixture.receipt.selection, unitId: key.unitId, locale: key.locale },
      currentText: current.basis.text, rows: [candidate], total: "1", nextOrdinal: null });
    vi.spyOn(translationCommands, "history").mockImplementation(async () => history());
    vi.spyOn(reviewCommands, "editorSnapshot").mockImplementation(async () => ({
      readVersion: "candidate-editor-read",
      target: reviewTargetFixture({ unitId: key.unitId, locale: key.locale, sourceSnapshotId: captured.sourceSnapshotId,
        sourceRevisionId: current.basis.sourceRevisionId, nativeKey, sourceText: current.sourceText,
        selectionId: current.basis.selectionId, revisionId: current.basis.revisionId, translationText: current.basis.text }),
      context: null,
      terms: { unitId: key.unitId, locale: key.locale, sourceRevisionId: current.basis.sourceRevisionId, entries: [] },
      translations: history(),
    }));
    const removeDesktopBehavior = installDesktopBehavior();
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
    try {
      await openImportWorkspace(opened);
      const edit = await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: nativeKey }) });
      await waitFor(() => expect(edit).toBeEnabled()); fireEvent.click(edit);
      const input = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: nativeKey }) });
      const text = "Save {{name}} — é 👩🏽‍💻\n第二行保持完整";
      expect(readPending).toHaveBeenCalled();
      readPending.mockClear();
      expect(input).toHaveFocus(); fireEvent.change(input, { target: { value: text } });
      await waitFor(() => expect(head.value?.text).toBe(text));
      expect(readPending.mock.calls.length).toBe(0);
      await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("workbenchV2.editorConfirm") })).toBeEnabled());
      const modifier = navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true };
      input.addEventListener("keydown", event => event.preventDefault(), { once: true });
      const cancelled = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true, ...modifier });
      fireEvent(input, cancelled);
      expect(cancelled.defaultPrevented).toBe(true); expect(save).not.toHaveBeenCalled(); expect(input).toHaveValue(text);
      const accepted = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true, ...modifier });
      fireEvent(input, accepted);
      expect(accepted.defaultPrevented).toBe(true);
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(save).toHaveBeenCalledWith({ ...key, sessionToken: opened.sessionToken, actionId: translationFixture.save.actionId,
        sourceRevisionId: retained.current.basis.sourceRevisionId, expectedSelectionId: null, text });
      await waitFor(() => expect(head.value).toBeNull());
      expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: nativeKey }) })).toBe(input);
      expect(input).toHaveValue(text); expect(input).toHaveFocus();

      fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: nativeKey }) }));
      const historyTab = await screen.findByRole("tab", { name: i18n.t("workbenchV2.history") });
      fireEvent.mouseDown(historyTab, { button: 0, ctrlKey: false });
      const stage = await screen.findByRole("button", { name: i18n.t("workbenchV2.candidateEdit") });
      await waitFor(() => expect(stage).toBeEnabled());
      stage.focus();
      expect(stage).toHaveFocus();
      fireEvent.click(stage);
      await waitFor(() => expect(input).toHaveValue(candidate.text));
      expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: nativeKey }) })).toBe(input);
      await waitFor(() => expect(input).toHaveFocus());
    } finally {
      if (width) Object.defineProperty(window, "innerWidth", width);
      removeDesktopBehavior();
    }
  });

  it("keeps the editor focused on a narrow workspace until details are explicitly requested", async () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 900 });
    const first = translationFixture.save.unitId, second = "66666666-6666-4666-8666-666666666667";
    const basis: DraftBasis = { sourceRevisionId: translationFixture.save.sourceRevisionId, selectionId: null, revisionId: null, text: null };
    const opened = { ...project, metadata: { ...project.metadata, projectId: translationFixture.save.projectId } };
    const firstNativeKey = "greeting.welcome", secondNativeKey = "greeting.next";
    const names = new Map([[first, firstNativeKey], [second, secondNativeKey]]);
    const disk = new Map<string, DraftHead>(), current = new Map<string, DraftBasis>();
    const rows = [first, second].map((unitId, index) => ({ ...structuredClone(page.rows[0]),
      protection: { ...page.rows[0].protection, unitId }, applicability: { ...page.rows[0].applicability, selectedSourceRevisionId: null, sourceBasisCurrent: null, capturedBasisCurrent: null },
      content: { ...page.rows[0].content, unitId, sourceSnapshotId: translationFixture.start.expectedSourceSnapshotId,
        sourceRevisionId: basis.sourceRevisionId, nativeKey: names.get(unitId)!, sourcePreview: `Narrow source ${index + 1}`,
        translationPreview: null, selectionId: null, revisionId: null, basis: "a".repeat(64) } }));
    const captured: SegmentPage = { ...page, projectId: opened.metadata.projectId, sourceSnapshotId: translationFixture.start.expectedSourceSnapshotId,
      scopeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", epoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      queryFingerprint: "c".repeat(64), readVersion: "b".repeat(64), rows, total: 2 };
    vi.mocked(sourceCommands.scope).mockResolvedValue({ currentSnapshot: captured.sourceSnapshotId, revision: "1" });
    vi.mocked(segmentCommands.page).mockResolvedValue(captured);
    vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => ({ projectId: opened.metadata.projectId, locale: request.locale,
      scopeId: captured.scopeId, sourceSnapshotId: captured.sourceSnapshotId, query: captured.query, queryFingerprint: captured.queryFingerprint,
      epoch: captured.epoch, sequence: "1", total: 2, firstPosition: 0, previousUnitId: null, nextUnitId: null, rows }));
    vi.spyOn(draftCommands, "read").mockImplementation(async ({ key }) => {
      const value: unknown = { head: structuredClone(disk.get(key.unitId) ?? { key, revision: "0", writerId: null, value: null }),
        current: { kind: "current", basis: structuredClone(current.get(key.unitId) ?? basis), nativeKey: names.get(key.unitId)!, sourceText: `Complete source ${names.get(key.unitId)}` } };
      if (!validateResponseRead(value)) throw new Error("Invalid narrow draft read fixture"); return value;
    });
    vi.spyOn(draftCommands, "write").mockImplementation(async ({ write }) => {
      expect(write.expectedRevision).toBe(disk.get(write.key.unitId)?.revision ?? "0");
      const head: unknown = { key: write.key, revision: (BigInt(write.expectedRevision) + 1n).toString(), writerId: write.writerId, value: structuredClone(write.value) };
      if (!validateResponseWritten(head)) throw new Error("Invalid narrow draft write fixture");
      disk.set(write.key.unitId, head); return structuredClone(head);
    });
    vi.spyOn(draftCommands, "clear").mockImplementation(async ({ clear }) => {
      expect(clear.expectedRevision).toBe(disk.get(clear.key.unitId)?.revision ?? "0");
      const head: unknown = { key: clear.key, revision: (BigInt(clear.expectedRevision) + 1n).toString(), writerId: null, value: null };
      if (!validateResponseCleared(head)) throw new Error("Invalid narrow draft clear fixture");
      disk.set(clear.key.unitId, head); return structuredClone(head);
    });
    vi.spyOn(executionCommands, "identity").mockResolvedValue(translationFixture.save.actionId);
    const save = vi.spyOn(translationCommands, "save").mockImplementation(async request => {
      const selection = { ...translationFixture.receipt.selection, actionId: request.actionId, unitId: request.unitId, locale: request.locale,
        previousEventId: request.expectedSelectionId ?? null, sequence: "1" };
      const receipt = validateSaveReceipt({ ...translationFixture.receipt, actionId: request.actionId, projectId: request.projectId, selection,
        revision: { ...translationFixture.receipt.revision, actionId: request.actionId, unitId: request.unitId, locale: request.locale, sourceRevisionId: request.sourceRevisionId, text: request.text },
        basis: { ...translationFixture.receipt.basis, sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId } }, request);
      current.set(request.unitId, { sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId, revisionId: selection.revisionId, text: request.text });
      return receipt;
    });
    vi.spyOn(reviewCommands, "editorSnapshot").mockRejectedValue(new Error("Details not part of this drawer fixture"));
    try {
      await openImportWorkspace(opened);
      const edit = await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: firstNativeKey }) });
      await waitFor(() => expect(edit).toBeEnabled()); fireEvent.click(edit);
      const input = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: firstNativeKey }) });
      expect(screen.queryByRole("dialog", { name: i18n.t("workbenchV2.agent") })).not.toBeInTheDocument();
      expect(input).toHaveFocus(); fireEvent.change(input, { target: { value: "Confirmed without opening the drawer" } });
      const confirm = screen.getByRole("button", { name: i18n.t("workbenchV2.confirmNext") });
      await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
      const next = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: secondNativeKey }) });
      expect(save).toHaveBeenCalledTimes(1); expect(next).toHaveFocus();
      expect(screen.queryByRole("dialog", { name: i18n.t("workbenchV2.agent") })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: secondNativeKey }) }));
      expect(await screen.findByRole("dialog", { name: i18n.t("workbenchV2.agent") })).toBeVisible();
    } finally {
      if (width) Object.defineProperty(window, "innerWidth", width);
    }
  });

  it("keeps initial presentation usable while draft hydration fails, and retries before allowing project exit", async () => {
    vi.mocked(draftCommands.list).mockRejectedValueOnce(new Error("Draft storage unavailable"));
    const close = vi.fn(async () => ({ closed: true }));
    controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(project), close });
    render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: project.locator } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
    expect(await screen.findByText("Actual source from the read port")).toBeVisible();
    expect(await screen.findByText(i18n.t("workbenchV2.draftIndexFailed"))).toBeVisible();
    await act(async () => { expect(await controller.close()).toBe(false); });
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.draftIndexRetry") }));
    await waitFor(() => expect(screen.queryByText(i18n.t("workbenchV2.draftIndexFailed"))).not.toBeInTheDocument());
    let permit: Awaited<ReturnType<ProjectLifecycle["prepareLeave"]>> = null;
    await act(async () => { permit = await controller.prepareLeave({ kind: "close-project" }); });
    expect(permit).not.toBeNull();
    act(() => { permit?.release(); });
  });

  it("reveals the original pending draft outside blocked routing and checks it through the current session", async () => {
    const retained: unknown = structuredClone(draftFixture.responses.read);
    if (!validateResponseRead(retained) || retained.head.value?.pending?.kind !== "save" || retained.current.kind !== "current") throw new Error("Invalid shared pending draft fixture");
    const pending = retained.head.value.pending, restored = { ...project, metadata: { ...project.metadata, projectId: retained.head.key.projectId } };
    const otherKey = { ...retained.head.key, unitId: fixtureIdentity(984) };
    const other = {
      head: { ...retained.head, key: otherKey, value: { ...retained.head.value, text: "Another retained draft", pending: null } },
      current: { ...retained.current, nativeKey: "greeting.farewell", sourceText: "Source for the second draft" },
    };
    vi.mocked(draftCommands.list).mockResolvedValue({
      items: [...draftFixture.responses.page.items, { ...draftFixture.responses.page.items[0], key: otherKey, hasPending: false }], next: null,
    });
    vi.spyOn(draftCommands, "read").mockImplementation(async ({ key }) => structuredClone(key.unitId === otherKey.unitId ? other : retained));
    const recover = vi.spyOn(translationCommands, "recoverSave").mockImplementation(async () => {
      const result = { request: structuredClone(pending.request), outcome: { kind: "pending" as const, replay: "explicit-same-request" as const } };
      if (!validateResponseRecoverSave(result)) throw new Error("Invalid shared recovery fixture");
      return result;
    });
    vi.mocked(segmentCommands.page).mockResolvedValue({ ...page, projectId: restored.metadata.projectId });
    const close = vi.fn(async () => ({ closed: true }));
    controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(restored), close });
    const register = vi.spyOn(controller, "register");
    render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: restored.locator } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
    await screen.findByText(i18n.t("workbenchV2.draftPendingSummary", { count: 1 }));
    // Exercise the pending translation's recovery once the other startup
    // owners are ready; their loading guards independently block project exit.
    await waitFor(() => {
      for (const id of ["execution-tasks", "knowledge-resources"]) {
        const participant = [...register.mock.calls].reverse().find(([value]) => value.id === id)?.[0];
        expect(participant?.inspect({ kind: "close-project" }).status).toBe("ready");
      }
    });
    await act(async () => { expect(await controller.close()).toBe(false); });
    const sheet = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
    const input = await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "greeting.welcome" }) });
    expect(input).toHaveValue(retained.head.value.text);
    expect(within(sheet).getByText("Welcome 👩🏽‍💻", { exact: false })).toBeVisible();

    const otherChoice = within(sheet).getByRole("button", { name: i18n.t("workbenchV2.draftRecoveryFallback", {
      locale: otherKey.locale, id: `${otherKey.unitId.slice(0, 8)}…${otherKey.unitId.slice(-6)}`,
    }) });
    fireEvent.click(otherChoice);
    expect(await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: other.current.nativeKey }) })).toHaveValue(other.head.value.text);
    expect(within(sheet).getByRole("button", { name: other.current.nativeKey })).toHaveAttribute("aria-current", "true");
    expect(within(sheet).getByText(other.current.sourceText)).toBeVisible();
    fireEvent.click(within(sheet).getByRole("button", { name: retained.current.nativeKey }));
    expect(await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: retained.current.nativeKey }) })).toHaveValue(retained.head.value.text);
    fireEvent.click(within(sheet).getByRole("button", { name: i18n.t("workbenchV2.editorCheckResult") }));
    await waitFor(() => expect(recover).toHaveBeenCalledWith({ ...pending.request, sessionToken: restored.sessionToken }));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("button", { name: i18n.t("workbenchV2.close") }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: i18n.t("workbenchV2.draftRecoveryTitle") })).not.toBeInTheDocument());
    expect(screen.getByText(i18n.t("workbenchV2.draftPendingSummary", { count: 1 }))).toBeVisible();
  });

  it("confirms a recovered draft after the last view closes without offering an advance action", async () => {
    const retained: unknown = structuredClone(draftFixture.responses.read);
    if (!validateResponseRead(retained) || !retained.head.value) throw new Error("Invalid ordinary recovery fixture");
    retained.head.value.pending = null;
    let head = retained.head;
    const restored = { ...project, metadata: { ...project.metadata, projectId: head.key.projectId } };
    vi.mocked(draftCommands.list).mockResolvedValue({ items: draftFixture.responses.page.items.map(item => ({ ...item, hasPending: false })), next: null });
    vi.spyOn(draftCommands, "read").mockImplementation(async () => ({ head: structuredClone(head), current: structuredClone(retained.current) }));
    vi.spyOn(draftCommands, "write").mockImplementation(async ({ write }) => {
      expect(write.expectedRevision).toBe(head.revision);
      const value: unknown = { key: write.key, writerId: write.writerId, revision: (BigInt(head.revision) + 1n).toString(), value: structuredClone(write.value) };
      if (!validateResponseWritten(value)) throw new Error("Invalid recovery write fixture");
      head = value; return structuredClone(head);
    });
    vi.mocked(segmentCommands.page).mockResolvedValue({ ...page, projectId: restored.metadata.projectId });
    vi.spyOn(executionCommands, "identity").mockResolvedValue(translationFixture.save.actionId);
    const save = vi.spyOn(translationCommands, "save").mockRejectedValue({ code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false });
    controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(restored) });
    render(<WorkbenchApp controller={controller} native />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
    fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: restored.locator } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
    const open = await screen.findByRole("button", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.viewName", { locale: "zh-CN" }) }) }));
    expect(await screen.findByText(i18n.t("workbenchV2.noViews"))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.draftRecoveryTitle") }));
    const sheet = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
    const input = await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "greeting.welcome" }) }, { timeout: 3000 });
    await waitFor(() => expect(input).toHaveFocus());
    expect(within(sheet).queryByRole("button", { name: i18n.t("workbenchV2.confirmNext") })).not.toBeInTheDocument();
    const modifier = navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(input, { key: "Enter", ...modifier });
    expect(save).not.toHaveBeenCalled();
    expect(within(sheet).getByRole("button", { name: i18n.t("workbenchV2.editorConfirm") })).toBeEnabled();
    fireEvent.keyDown(input, { key: "s", ...modifier });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ unitId: retained.head.key.unitId, text: retained.head.value.text, sessionToken: restored.sessionToken }));
    expect(sheet).toBeVisible();
  });

  it("opens ordinary local drafts without source metadata and keeps newer input when switching the recovery list", async () => {
    const first: unknown = { ...structuredClone(draftFixture.responses.read), current: { kind: "unavailable", reason: "source-missing" } };
    if (!validateResponseRead(first) || !first.head.value) throw new Error("Invalid ordinary draft fixture");
    first.head.value.pending = null;
    const second: unknown = structuredClone(first);
    if (!validateResponseRead(second) || !second.head.value) throw new Error("Invalid second draft fixture");
    second.head.key.unitId = "66666666-6666-4666-8666-666666666667";
    second.head.value.text = "Another retained draft";
    const restored = { ...project, metadata: { ...project.metadata, projectId: first.head.key.projectId } };
    vi.mocked(draftCommands.list).mockResolvedValue({ items: [first, second].map(value => ({ key: value.head.key, revision: value.head.revision,
      editSeq: value.head.value!.editSeq, sourceRevisionId: value.head.value!.basis.sourceRevisionId, hasPending: false })), next: null });
    vi.spyOn(draftCommands, "read").mockImplementation(async request => structuredClone(request.key.unitId === first.head.key.unitId ? first : second));
    vi.spyOn(draftCommands, "write").mockRejectedValue(new Error("Disk unavailable"));
    vi.mocked(segmentCommands.page).mockResolvedValue({ ...page, projectId: restored.metadata.projectId });
    const writeText = vi.fn(async () => {}), clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(restored) });
      render(<WorkbenchApp controller={controller} native />);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
      fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: restored.locator } });
      fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
      const entry = await screen.findByRole("button", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
      await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry);
      const sheet = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
      const input = await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: first.head.key.unitId }) });
      expect(input).toHaveValue(first.head.value.text);
      expect(within(sheet).getByText(i18n.t("workbenchV2.editorSourceMissing"))).toBeVisible();
      expect(within(sheet).getByTitle(first.head.key.unitId)).toHaveTextContent(`66666666…666666`);
      expect(within(sheet).getByTitle(second.head.key.unitId)).toHaveTextContent(`66666666…666667`);
      fireEvent.change(input, { target: { value: "Newer input kept while switching drafts" } });
      fireEvent.click(within(sheet).getByTitle(second.head.key.unitId));
      expect(await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: second.head.key.unitId }) })).toHaveValue("Another retained draft");
      fireEvent.click(within(sheet).getByTitle(first.head.key.unitId));
      expect(await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: first.head.key.unitId }) })).toHaveValue("Newer input kept while switching drafts");
      fireEvent.click(within(sheet).getByRole("button", { name: i18n.t("workbenchV2.editorCopy") }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("Newer input kept while switching drafts"));
      expect(screen.queryByText(i18n.t("workbenchV2.draftPendingSummary", { count: 1 }))).not.toBeInTheDocument();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});


describe("entry knowledge workflow assembly", () => {
  const target = reviewTargetFixture({ unitId: fixtureIdentity(98901), sourceRevisionId: fixtureIdentity(98902), sourceSnapshotId: fixtureIdentity(98903),
    nativeKey: "dialogue.original-context", sourceText: "Context source {{name}}", selectionId: null, revisionId: null, translationText: null });
  function sourcePage(locale: string): SourceContextPage {
    return { scope: { projectId: project.metadata.projectId, unitId: target.unitId, locale, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId },
      contentRevision: "1", sourceAttemptId: fixtureIdentity(98904), sourceResultId: fixtureIdentity(98905), sourceResultDigest: "a".repeat(64), sourceLocale: "en",
      localUnitId: "original-context", occurrenceCount: 1, after: 0, totalEntries: 1, nextAfter: null,
      observations: { missingBlocks: false, knownBlocks: 1, knownFacts: 1, emptyBlocks: 0, unknownBlocks: 0, unknownRequiredBlocks: 0, neighborOccurrences: 0, unknownSamples: [] },
      entries: [{ kind: "block", value: { blockIndex: 0, target: { kind: "occurrence", id: "original-local-occurrence" },
        schema: { id: "tsumugi.source-context-facts", schemaVersion: 1, behaviorVersion: 1 }, handling: "preserve", inRevisionBasis: true,
        facts: { facts: [{ id: "speaker", kind: "speaker", text: "Original speaker Mira", origin: { kind: "extracted",
          sources: [{ artifactId: "synthetic-source", range: { encoding: "utf8-byte", start: 0, end: 8 } }] } }] } } }] };
  }
  async function openContext() {
    const opened = { ...project, metadata: { ...project.metadata, targetLocales: ["ja", "zh-CN"] } };
    vi.mocked(sourceCommands.scope).mockResolvedValue({ currentSnapshot: target.sourceSnapshotId, revision: "1" });
    vi.mocked(segmentCommands.page).mockImplementation(async request => ({ ...page, locale: request.locale, query: { ...request.query, status: request.query.status ?? "all" },
      sourceSnapshotId: target.sourceSnapshotId, rows: [{ ...page.rows[0], protection: { ...page.rows[0].protection, unitId: target.unitId },
        content: { ...page.rows[0].content, unitId: target.unitId, locale: request.locale, sourceSnapshotId: target.sourceSnapshotId,
          sourceRevisionId: target.sourceRevisionId, nativeKey: target.nativeKey, sourcePreview: target.sourceText, translationPreview: null, selectionId: null, revisionId: null } }] }));
    vi.spyOn(conversationDraftCommands, "list").mockResolvedValue({ items: [], next: null });
    vi.spyOn(conversationCommands, "list").mockResolvedValue({ projectId: project.metadata.projectId, rows: [], nextAfter: null });
    vi.spyOn(draftCommands, "read").mockImplementation(async request => ({ head: { key: request.key, revision: "0", writerId: null, value: null },
      current: { kind: "current", basis: { sourceRevisionId: target.sourceRevisionId, selectionId: null, revisionId: null, text: null }, nativeKey: target.nativeKey, sourceText: target.sourceText } }));
    vi.spyOn(reviewCommands, "editorSnapshot").mockImplementation(async request => ({ readVersion: "entry-context-read", target: { ...target, locale: request.locale }, context: null,
      terms: { unitId: target.unitId, locale: request.locale, sourceRevisionId: target.sourceRevisionId, entries: [] },
      translations: { unitId: target.unitId, locale: request.locale, current: null, currentText: null, total: "0", rows: [], nextOrdinal: null } }));
    vi.spyOn(resourceCommands, "context").mockResolvedValue(null);
    vi.spyOn(resourceCommands, "resolve").mockImplementation(async request => ({ unitId: request.unitId, locale: request.locale, sourceRevisionId: target.sourceRevisionId, entries: [] }));
    vi.spyOn(resourceCommands, "resolveContextResources").mockImplementation(async request => ({ scope: request.scope, entries: [] }));
    const raw = vi.spyOn(sourceCommands, "sourceContext").mockImplementation(async request => sourcePage(request.locale));
    vi.spyOn(resourceCommands, "factDecisions").mockResolvedValue([]);
    const saveNote = vi.spyOn(resourceCommands, "saveContext"), saveFact = vi.spyOn(resourceCommands, "decideFact");
    await openImportWorkspace(opened);
    const language = await screen.findByRole("button", { name: "ja" }); language.focus(); fireEvent.keyDown(language, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "zh-CN" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "zh-CN" })).toBeVisible());
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: target.nativeKey }) }));
    const tab = await screen.findByRole("tab", { name: i18n.t("workbenchV2.entryContextTab") });
    await userEvent.setup().click(tab);
    const notes = await screen.findByRole("region", { name: i18n.t("resource.manualContext") });
    const facts = await screen.findByRole("region", { name: i18n.t("contextFacts.title") });
    await waitFor(() => expect(within(notes).getByRole("button", { name: i18n.t("resource.editFromEntry") })).toBeEnabled());
    await waitFor(() => expect(within(facts).getByRole("button", { name: i18n.t("contextFacts.replace") })).toBeEnabled());
    expect(within(facts).getByText("Original speaker Mira")).toBeVisible();
    expect(raw).toHaveBeenCalledWith(expect.objectContaining({ unitId: target.unitId, locale: "zh-CN", sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId }));
    return { notes, facts, saveNote, saveFact };
  }
  async function closeViewsAndRestore() {
    const drawer = screen.queryByRole("dialog", { name: i18n.t("workbenchV2.agent") });
    if (drawer) {
      fireEvent.click(within(drawer).getByRole("button", { name: i18n.t("workbenchV2.close") }));
      await waitFor(() => expect(drawer).not.toBeInTheDocument());
    }
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.viewName", { locale: "zh-CN" }) }) }));
    await screen.findByText(i18n.t("workbenchV2.noViews"));
    const restore = await screen.findByRole("button", { name: i18n.t("knowledge.backToDraft") });
    await waitFor(() => expect(restore).toBeEnabled()); fireEvent.click(restore);
    await waitFor(() => expect(location.hash).toContain(`focus=${target.unitId}`));
    expect(location.hash).toContain("locale=zh-CN");
    await screen.findByRole("tab", { name: i18n.t("workbenchV2.entryContextTab"), selected: true });
    expect(screen.queryByRole("heading", { name: i18n.t("knowledge.kinds.terms") })).not.toBeInTheDocument();
  }

  it("opens the real note and source-fact controls from entry context, then restores the original note B without opening Knowledge", async () => {
    const { notes, saveNote, saveFact } = await openContext();
    fireEvent.click(within(notes).getByRole("button", { name: i18n.t("resource.editFromEntry") }));
    const text = await within(notes).findByRole("textbox", { name: i18n.t("resource.manualContext") });
    fireEvent.change(text, { target: { value: "Original entry note B 🧵\nkeep {{name}}" } });
    fireEvent.change(within(notes).getByRole("textbox", { name: i18n.t("resource.reason") }), { target: { value: "Unfinished original reason B" } });
    await closeViewsAndRestore();
    const restored = within(await screen.findByRole("region", { name: i18n.t("resource.manualContext") }));
    expect(await restored.findByRole("textbox", { name: i18n.t("resource.manualContext") })).toHaveValue("Original entry note B 🧵\nkeep {{name}}");
    expect(restored.getByRole("textbox", { name: i18n.t("resource.reason") })).toHaveValue("Unfinished original reason B");
    expect(restored.getByRole("textbox", { name: i18n.t("resource.manualContext") })).not.toHaveAttribute("readonly");
    fireEvent.change(restored.getByRole("textbox", { name: i18n.t("resource.manualContext") }), { target: { value: "Continue original note B" } });
    expect(restored.getByRole("textbox", { name: i18n.t("resource.manualContext") })).toHaveValue("Continue original note B");
    expect(restored.getByText(i18n.t("contextFacts.scope", { key: target.nativeKey, locale: "zh-CN" }))).toBeVisible();
    expect(saveNote).not.toHaveBeenCalled(); expect(saveFact).not.toHaveBeenCalled();
  }, 15000);

  it("returns a retained source-fact replacement to its original entry and locale with all newer input intact", async () => {
    const { facts, saveNote, saveFact } = await openContext();
    fireEvent.click(within(facts).getByRole("button", { name: i18n.t("contextFacts.replace") }));
    const value = await within(facts).findByRole("textbox", { name: i18n.t("contextFacts.value") });
    fireEvent.change(value, { target: { value: "Manual source-fact B 👩🏽‍🚀" } });
    fireEvent.change(within(facts).getByRole("textbox", { name: i18n.t("contextFacts.actor") }), { target: { value: "Human B" } });
    fireEvent.change(within(facts).getByRole("textbox", { name: i18n.t("contextFacts.reason") }), { target: { value: "Original source evidence B" } });
    await closeViewsAndRestore();
    const restored = within(await screen.findByRole("region", { name: i18n.t("contextFacts.title") }));
    expect(await restored.findByRole("textbox", { name: i18n.t("contextFacts.value") })).toHaveValue("Manual source-fact B 👩🏽‍🚀");
    expect(restored.getByRole("textbox", { name: i18n.t("contextFacts.actor") })).toHaveValue("Human B");
    expect(restored.getByRole("textbox", { name: i18n.t("contextFacts.reason") })).toHaveValue("Original source evidence B");
    expect(restored.getByRole("textbox", { name: i18n.t("contextFacts.value") })).not.toHaveAttribute("readonly");
    fireEvent.change(restored.getByRole("textbox", { name: i18n.t("contextFacts.value") }), { target: { value: "Continue source-fact B" } });
    expect(restored.getByRole("textbox", { name: i18n.t("contextFacts.value") })).toHaveValue("Continue source-fact B");
    expect(saveNote).not.toHaveBeenCalled(); expect(saveFact).not.toHaveBeenCalled();
  }, 15000);
});

it("opens application settings and external query commands through the real workspace while retaining project language and query input", async ({ onTestFinished }) => {
  vi.stubGlobal("innerWidth", 900);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  document.documentElement.lang = "zh-CN";
  controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(project) });
  render(<WorkbenchApp controller={controller} native/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.projectFolder") }), { target: { value: project.locator } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.openProject") }));
  await screen.findByText("Actual source from the read port", {}, { timeout: 5000 });
  const settings = await screen.findByRole("button", { name: i18n.t("workbenchV2.settings") });
  await waitFor(() => expect(settings).toBeEnabled()); settings.focus(); fireEvent.click(settings);
  await screen.findByRole("dialog", { name: i18n.t("settingsWorkbench.title") });
  await act(async () => { fireEvent.change(screen.getByRole("combobox", { name: i18n.t("settingsWorkbench.language") }), { target: { value: "en-US" } }); });
  expect(document.documentElement.lang).toBe("en-US");
  expect(controller.getSnapshot().session?.project.metadata.targetLocales).toEqual(["zh-CN"]);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("settingsWorkbench.close") }));
  await waitFor(() => expect(settings).toHaveFocus());
  const dockTrigger = screen.getByRole("button", { name: i18n.t("workbenchV2.openAgent") });
  fireEvent.click(dockTrigger);
  await userEvent.setup().click(await screen.findByRole("tab", { name: i18n.t("workbenchV2.detail") }));
  const referenceEntry = await screen.findByRole("button", { name: i18n.t("toolQuery.title") });
  await waitFor(() => expect(referenceEntry).toBeEnabled()); fireEvent.click(referenceEntry);
  await screen.findByRole("textbox", { name: i18n.t("toolQuery.text", { position: "1" }) });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpWorkbench.close") }));
  await waitFor(() => expect(dockTrigger).toHaveFocus());

  vi.stubGlobal("innerWidth", 1440);
  fireEvent(window, new Event("resize"));
  const inlineEntry = await screen.findByRole("button", { name: i18n.t("toolQuery.title") });
  await userEvent.setup().click(inlineEntry);
  const inlineQuery = await screen.findByRole("textbox", { name: i18n.t("toolQuery.text", { position: "1" }) });
  vi.stubGlobal("innerWidth", 900);
  fireEvent(window, new Event("resize"));
  expect(inlineEntry.closest("[hidden]")).not.toBeNull();
  inlineQuery.focus();
  fireEvent.keyDown(inlineQuery, { key: "Escape" });
  await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());

  await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") }));
  const reference = await screen.findByRole("option", { name: i18n.t("toolQuery.title") });
  await waitFor(() => expect(reference).not.toHaveAttribute("aria-disabled", "true")); fireEvent.click(reference);
  const draft = await screen.findByRole("textbox", { name: i18n.t("toolQuery.text", { position: "1" }) });
  fireEvent.change(draft, { target: { value: "Retained local query B" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpWorkbench.close") }));
  await userEvent.setup().click(await screen.findByRole("button", { name: i18n.t("knowledge.backToDraft") }));
  expect(await screen.findByRole("textbox", { name: i18n.t("toolQuery.text", { position: "1" }) })).toHaveValue("Retained local query B");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpWorkbench.discardReference") }));
  const leave = await screen.findByRole("dialog", { name: i18n.t("toolQuery.leaveTitle") });
  fireEvent.keyDown(leave, { key: "o", ctrlKey: !navigator.platform.includes("Mac"), metaKey: navigator.platform.includes("Mac") });
  expect(screen.queryByRole("dialog", { name: i18n.t("workbenchV2.openProject") })).not.toBeInTheDocument();
  fireEvent.click(within(leave).getByRole("button", { name: i18n.t("resource.discardAndLeave") }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: i18n.t("toolQuery.leaveTitle") })).not.toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: i18n.t("toolQuery.text", { position: "1" }) })).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpWorkbench.close") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") })).toHaveFocus());
  await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") }));
  const query = await screen.findByRole("option", { name: i18n.t("settingsWorkbench.query") });
  await waitFor(() => expect(query).not.toHaveAttribute("aria-disabled", "true")); fireEvent.click(query);
  const endpoint = await screen.findByRole("textbox", { name: i18n.t("mcpRetrieval.endpoint") });
  fireEvent.change(endpoint, { target: { value: "https://example.invalid/mcp" } });
  expect(screen.getByRole("textbox", { name: i18n.t("mcpRetrieval.endpoint") })).toHaveValue("https://example.invalid/mcp");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpWorkbench.close") }));
  await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("workbenchV2.commandPlaceholder") }));
  fireEvent.click(await screen.findByRole("option", { name: i18n.t("settingsWorkbench.query") }));
  expect(await screen.findByRole("textbox", { name: i18n.t("mcpRetrieval.endpoint") })).toHaveValue("https://example.invalid/mcp");
}, 15000);

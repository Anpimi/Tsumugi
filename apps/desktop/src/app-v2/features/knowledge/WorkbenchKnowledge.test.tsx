import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import wire from "../../../../test/fixtures/resourceCommands.contract.json";
import segmentWire from "../../../../test/fixtures/segmentCommands.contract.json";
import { i18n } from "../../../i18n";
import { installResourceDraftFixture } from "../../../testSupport/resourceDraftFixture";
import { installSourceDraftPortsFixture } from "../../../testSupport/sourceDraftFixture";
import { installStrategyDraftFixture } from "../../../testSupport/strategyDraftFixture";
import { resourceDraftCommands } from "../../../resourceDraftCommands";
import type { knowledgeEn } from "../../../i18n/knowledge";
import type { workbenchEn } from "../../../i18n/workbench";
import { SessionReads } from "../../../sessionReads";
import { draftCommands } from "../../../draftCommands";
import { conversationDraftCommands } from "../../../conversationDraftCommands";
import { conversationCommands } from "../../../conversationCommands";
import { sourceCommands } from "../../../sourceCommands";
import { segmentCommands } from "../../../segmentCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands, type TermRevision } from "../../../resourceCommands";
import { translationMemoryEntryFixture } from "../../../testSupport/translationMemoryFixture";
import { validateResponseSegmentPage } from "../../../generated/review.validators";
import { ProjectLifecycle, type ProjectLifecyclePorts } from "../../platform/projectLifecycle";
import WorkbenchApp from "../../WorkbenchApp";

const invoke = vi.hoisted(() => vi.fn());
const ownerLoad = vi.hoisted(() => { const state: { wait: Promise<void> | null; fail: boolean } = { wait: null, fail: false }; return state; });
vi.mock("./KnowledgeOwnerHost", async original => {
  const module = await original<typeof import("./KnowledgeOwnerHost")>(), Actual = module.default;
  return { ...module, default: (props: ComponentProps<typeof Actual>) => {
    if (ownerLoad.fail) throw new Error("Synthetic initial knowledge load failed");
    if (ownerLoad.wait) throw ownerLoad.wait;
    return <Actual {...props}/>;
  } };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));
vi.mock("../../platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));
const project: ProjectView = { sessionToken: "synthetic-knowledge-workspace", locator: "/synthetic/knowledge-workspace", reconciliationState: "settled",
  metadata: { projectId: segmentWire.responses.segmentPage.projectId, displayName: "Knowledge workspace", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const term: TermRevision = { ...wire.responses.term, termId: "manual-term", source: "Barrel", target: "木桶", aliases: [], reason: "Saved reason", scopeUnitId: null,
  locale: "zh-CN", originKind: "manual", captureId: null, externalEntryId: null, previousRevisionId: null, removed: false };
let controller: ProjectLifecycle | undefined;
const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
type KnowledgeMessage = { [Key in keyof typeof knowledgeEn]: typeof knowledgeEn[Key] extends string ? Key : never }[keyof typeof knowledgeEn];
type WorkspaceMessage = { [Key in keyof typeof workbenchEn]: typeof workbenchEn[Key] extends string ? Key : never }[keyof typeof workbenchEn];
const w = (key: WorkspaceMessage) => i18n.t(`workbenchV2.${key}`), k = (key: KnowledgeMessage) => i18n.t(`knowledge.${key}`);
beforeEach(async () => {
  ownerLoad.wait = null; ownerLoad.fail = false;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  localStorage.clear(); history.replaceState(null, "", "/"); await i18n.changeLanguage("en-US");
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(draftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(conversationDraftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(conversationCommands, "list").mockResolvedValue({ projectId: project.metadata.projectId, rows: [], nextAfter: null });
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ revision: "1", currentSnapshot: segmentWire.responses.segmentPage.sourceSnapshotId });
  const page: unknown = structuredClone(segmentWire.responses.segmentPage);
  if (!validateResponseSegmentPage(page)) throw new Error("A complete synthetic entry page is required");
  vi.spyOn(segmentCommands, "page").mockResolvedValue(page);
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_terms") return [structuredClone(term)];
    if (command === "read_term_current") return structuredClone(term);
    if (command === "read_term_history") return [structuredClone(term)];
    if (command === "list_resource_captures") return [];
    throw new Error(`Unexpected synthetic workspace command: ${command}`);
  });
  installResourceDraftFixture();
  installSourceDraftPortsFixture(); installStrategyDraftFixture();
});
afterEach(() => { cleanup(); controller?.dispose(); controller = undefined; if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth); });

it("hydrates knowledge at project startup and retains the original draft across workspace tabs and closing", async () => {
  const close = vi.fn<ProjectLifecyclePorts["close"]>(async () => ({ closed: true }));
  controller = new ProjectLifecycle({ open: async () => project, close, status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  const register = vi.spyOn(controller, "register"), lifecycle = controller;
  render(<StrictMode><WorkbenchApp controller={lifecycle} native/></StrictMode>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  await user.type(screen.getByRole("textbox", { name: w("projectFolder") }), project.locator);
  await user.click(screen.getByRole("button", { name: w("openProject") }));
  const activity = await screen.findByRole("navigation", { name: w("activity") }, { timeout: 5000 });
  const loading = register.mock.calls.find(([participant]) => participant.id === "knowledge-resources")?.[0];
  expect(loading).toBeDefined();
  await waitFor(() => expect(loading?.inspect({ kind: "close-project" }).status).toBe("ready"), { timeout: 5000 });
  expect(loading?.inspect({ kind: "close-window" }).status).toBe("ready");
  await waitFor(() => {
    const knowledge = within(activity).getByRole("button", { name: w("knowledge") });
    expect(knowledge.tagName).toBe("BUTTON"); expect(knowledge).toBeEnabled(); expect(knowledge).not.toHaveAttribute("aria-disabled", "true");
  });
  await user.click(within(activity).getByRole("button", { name: w("knowledge") }));
  await user.click(await screen.findByRole("button", { name: "Barrel" }));
  const editor = await screen.findByRole("textbox", { name: k("targetTerm") });
  fireEvent.change(editor, { target: { value: "Keep my edit" } });
  await user.click(screen.getByRole("button", { name: i18n.t("knowledgeExchange.menu") }));
  await user.click(screen.getByRole("menuitem", { name: i18n.t("knowledgeExchange.tmx") }));
  const exchange = within(await screen.findByRole("region", { name: i18n.t("knowledgeExchange.title") }));
  expect(exchange.getByText(i18n.t("knowledgeExchange.readOnly"))).toBeVisible();
  await user.click(exchange.getByRole("button", { name: i18n.t("knowledgeExchange.close") }));
  expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("Keep my edit");
  await user.click(within(activity).getByRole("button", { name: w("entries") }));
  expect(await screen.findByRole("button", { name: k("backToDraft") })).toBeVisible();
  await user.click(screen.getByRole("button", { name: k("backToDraft") }));
  expect(await screen.findByRole("textbox", { name: k("targetTerm") })).toHaveValue("Keep my edit");
  expect(within(screen.getByRole("tablist", { name: w("dockTabs") })).getByRole("tab", { name: w("agent") })).toHaveAttribute("aria-selected", "true");
  await waitFor(async () => {
    const retained = await resourceDraftCommands.read({ sessionToken: project.sessionToken, key: { projectId: project.metadata.projectId } });
    expect(retained.value?.termDraft.target).toBe("Keep my edit"); expect(retained.value?.pending).toBeNull();
  });
  await act(async () => { expect(await lifecycle.close()).toBe(true); }); expect(close).toHaveBeenCalledOnce();
});

it("opens real saved translations from Knowledge and reads their exact details while the Agent dock remains the default", async () => {
  const donor = { ...translationMemoryEntryFixture(), projectId: project.metadata.projectId, sourceLocale: project.metadata.sourceLocale };
  vi.spyOn(resourceCommands, "translationMemoryPage").mockImplementation(async request => ({ projectId: project.metadata.projectId,
    filter: { ...request.filter, sourceText: request.filter.sourceText ?? null, translationText: request.filter.translationText ?? null, origin: request.filter.origin ?? null }, basis: "b".repeat(64), rows: [donor], nextCursor: null }));
  const read = vi.spyOn(resourceCommands, "translationMemoryEntry").mockResolvedValue(donor);
  controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }), status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  render(<WorkbenchApp controller={controller} native/>); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  await user.type(screen.getByRole("textbox", { name: w("projectFolder") }), project.locator);
  await user.click(screen.getByRole("button", { name: w("openProject") }));
  const activity = await screen.findByRole("navigation", { name: w("activity") });
  await waitFor(() => expect(within(activity).getByRole("button", { name: w("knowledge") }).tagName).toBe("BUTTON"));
  await user.click(within(activity).getByRole("button", { name: w("knowledge") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("knowledge.kinds.memory") }));
  const table = within(await screen.findByRole("table", { name: k("memoryTable") }));
  await user.click(table.getByRole("button", { name: donor.sourceLabel.nativeKey }));
  await screen.findByRole("region", { name: k("memoryComparison") });
  expect(within(screen.getByRole("tablist", { name: w("dockTabs") })).getByRole("tab", { name: w("agent") })).toHaveAttribute("aria-selected", "true");
  await user.click(table.getByRole("button", { name: k("details") }));
  expect(await screen.findByRole("region", { name: k("memoryDetails") })).toBeVisible();
  expect(read).toHaveBeenCalledWith({ projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    unitId: donor.revision.unitId, locale: donor.revision.locale, revisionId: donor.revision.revisionId });
});

it("does not steal focus or switch tabs when the user moves while the original knowledge host is loading", async () => {
  let resolve!: () => void; ownerLoad.wait = new Promise<void>(done => { resolve = done; });
  controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }), status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  const register = vi.spyOn(controller, "register"); render(<WorkbenchApp controller={controller} native/>); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  await user.type(screen.getByRole("textbox", { name: w("projectFolder") }), project.locator);
  await user.click(screen.getByRole("button", { name: w("openProject") }));
  const activity = await screen.findByRole("navigation", { name: w("activity") });
  await waitFor(() => { const button = within(activity).getByRole("button", { name: w("knowledge") }); expect(button.tagName).toBe("BUTTON"); expect(button).toBeEnabled(); });
  const originalTab = within(screen.getByRole("navigation", { name: w("views") })).getByRole("button", { current: "page" });
  const knowledge = within(activity).getByRole("button", { name: w("knowledge") }); await user.click(knowledge);
  const knowledgeActivity = knowledge.parentElement;
  await waitFor(() => expect(knowledgeActivity).toHaveAttribute("aria-busy", "true"));
  expect(activity).not.toHaveAttribute("aria-busy", "true");
  const entries = within(activity).getByRole("button", { name: w("entries") }); expect(entries.tagName).toBe("BUTTON"); expect(entries).toBeEnabled();
  await user.tab({ shift: true }); expect(entries).toHaveFocus();
  await waitFor(() => expect(knowledgeActivity).not.toHaveAttribute("aria-busy", "true"));
  await act(async () => { ownerLoad.wait = null; resolve(); });
  await waitFor(() => expect(register.mock.calls.find(([participant]) => participant.id === "knowledge-resources")?.[0].inspect({ kind: "close-project" }).status).toBe("ready"));
  expect(entries).toHaveFocus(); expect(originalTab).toHaveAttribute("aria-current", "page");
  expect(screen.queryByRole("navigation", { name: k("categories") })).toBeNull();
  await waitFor(() => { const button = within(activity).getByRole("button", { name: w("knowledge") }); expect(button.tagName).toBe("BUTTON"); expect(button).toBeEnabled(); });
  await user.click(within(activity).getByRole("button", { name: w("knowledge") })); expect(await screen.findByRole("navigation", { name: k("categories") })).toBeVisible();
});

it("recovers an initial knowledge host failure through an explicit retry of the original host", async () => {
  ownerLoad.fail = true; const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }), status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
    render(<WorkbenchApp controller={controller} native/>); const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
    await user.type(screen.getByRole("textbox", { name: w("projectFolder") }), project.locator);
    await user.click(screen.getByRole("button", { name: w("openProject") }));
    const activity = await screen.findByRole("navigation", { name: w("activity") });
    await waitFor(() => expect(within(activity).getByRole("button", { name: w("knowledge") }).tagName).toBe("BUTTON"));
    await user.click(within(activity).getByRole("button", { name: w("knowledge") }));
    const retry = await screen.findByRole("button", { name: k("retryLoad") });
    expect(await screen.findByText(w("actionFailed"))).toBeVisible();
    ownerLoad.fail = false; await user.click(retry);
    expect(await screen.findByRole("navigation", { name: k("categories") })).toBeVisible();
    expect(screen.queryByRole("button", { name: k("retryLoad") })).toBeNull();
    expect(screen.queryByText(w("actionFailed"))).toBeNull();
  } finally { errors.mockRestore(); }
});

it("opens a saved typed term proposal from the conversation and adopts an edited target through the original resource owner", async () => {
  const { termProposalFixture } = await import("../../../testSupport/termProposalFixture");
  const { fixtureIdentity } = await import("../../../testSupport/executionFixture");
  const { validateRequestDecision } = await import("../../../generated/resource.validators");
  const conversationId = fixtureIdentity(980), key = { projectId: project.metadata.projectId, conversationId };
  const fixture = termProposalFixture(key), preview = fixture.preview;
  vi.mocked(conversationCommands.list).mockResolvedValue({ projectId: key.projectId, rows: [{ ...key, title: "Terminology conversation", ordinal: "1" }], nextAfter: null });
  vi.spyOn(conversationDraftCommands, "read").mockImplementation(async request => ({ key: request.key, revision: "0", writerId: null, value: null }));
  vi.spyOn(conversationCommands, "messages").mockResolvedValue({ ...key, rows: fixture.run.preview.selectedMessages, nextAfter: null });
  vi.spyOn(conversationCommands, "planningAttempts").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "proposalRevisions").mockResolvedValue({ ...key, rows: [fixture.revision], nextAfter: null });
  vi.spyOn(conversationCommands, "proposalWorkPlans").mockResolvedValue({ ...key, rows: [], nextAfter: null });
  vi.spyOn(conversationCommands, "readProposal").mockResolvedValue(fixture.revision);
  vi.spyOn(conversationCommands, "readPlanning").mockResolvedValue(fixture.run);
  const original = invoke.getMockImplementation();
  invoke.mockImplementation((command, payload) => {
    if (command === "list_resource_captures") return Promise.resolve([preview.capture]);
    if (command === "read_resource_preview") return Promise.resolve(structuredClone(preview));
    if (command === "create_execution_identity") return Promise.resolve(fixtureIdentity(981));
    if (command === "decide_resource_entry") {
      if (!validateRequestDecision(payload.request)) throw new Error("Expected original term request");
      const request = payload.request.decision, row = preview.rows.find(value => value.entry.id === request.entryId);
      if (!row) throw new Error("Expected fixed terminology entry");
      return Promise.resolve({ request, actionId: request.actionId, decision: request.decision, revision: { ...term, revisionId: fixtureIdentity(982),
        termId: "conversation-term", originKind: "external", source: row.entry.source, target: request.editedTarget ?? row.entry.target,
        aliases: row.entry.aliases, protected: row.entry.protected, scopeUnitId: row.scopeUnitId, reason: row.entry.reason,
        captureId: request.captureId, externalEntryId: request.entryId, previousRevisionId: request.expectedRevisionId } });
    }
    return original?.(command, payload);
  });
  installResourceDraftFixture();
  controller = new ProjectLifecycle({ open: async () => project, close: async () => ({ closed: true }), status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  render(<WorkbenchApp controller={controller} native/>); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") }));
  await user.type(screen.getByRole("textbox", { name: w("projectFolder") }), project.locator);
  await user.click(screen.getByRole("button", { name: w("openProject") }));
  await screen.findByRole("navigation", { name: w("activity") });
  const picker = await screen.findByRole("button", { name: i18n.t("conversation.chooseThread") });
  await waitFor(() => expect(picker).toBeEnabled()); picker.focus(); fireEvent.keyDown(picker, { key: "ArrowDown" });
  await user.click(await screen.findByRole("menuitem", { name: "Terminology conversation" }));
  const open = await screen.findByRole("button", { name: i18n.t("conversation.termOpenReview") });
  await user.click(open);
  const panel = within(await screen.findByRole("region", { name: k("proposalTitle") }));
  await waitFor(() => expect(panel.getAllByRole("button", { name: k("proposalEdit") })[0]).toBeEnabled());
  expect(invoke.mock.calls.filter(([name]) => name === "decide_resource_entry")).toHaveLength(0);
  await user.click(panel.getAllByRole("button", { name: k("proposalEdit") })[0]);
  const target = panel.getByRole("textbox", { name: k("proposalEditedTarget") });
  await user.clear(target); await user.type(target, "Edited greeting");
  await user.click(panel.getByRole("button", { name: k("proposalAdoptEdited") }));
  await waitFor(() => expect(panel.queryByRole("textbox", { name: k("proposalEditedTarget") })).toBeNull());
  const decisions = invoke.mock.calls.filter(([name]) => name === "decide_resource_entry");
  expect(decisions).toHaveLength(1);
  expect(decisions[0][1].request.decision).toMatchObject({ captureId: fixture.revision.revisionId, entryId: "0", expectedRevisionId: null, decision: "adopt", editedTarget: "Edited greeting" });
  expect(invoke.mock.calls.some(([name]) => name === "save_term" || name === "start_conversation_planning" || name === "start_work_plan")).toBe(false);
});

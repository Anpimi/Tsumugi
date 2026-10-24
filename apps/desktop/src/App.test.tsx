import pluginInventory from "../test/fixtures/pluginInventory.contract.json";
import pluginCandidate from "../test/fixtures/pluginPackage.contract.json";
import { pluginBuildInventory, pluginBuildPackage, pluginBuildRequest, pluginBuildView, pluginBuildWorkflow, savedPluginBuild } from "./testSupport/pluginBuildFixture";
import { pluginSourceInventory, pluginSourcePackage, pluginSourceView } from "./testSupport/pluginSourceFixture";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { i18n, UI_LOCALE_STORAGE_KEY } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture, sourceImpactFixture } from "./testSupport/sourceFixture";
import releaseFixture from "../test/fixtures/releaseCommands.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import { reviewFindingViewFixture, reviewTargetFixture, reviewSummaryFor, reviewSummaryPageFixture, reviewCheckFixture } from "./testSupport/reviewFixture";
import { LAST_OPEN_PROJECT_STORAGE_KEY, readRecentProjects } from "./recentProjects";
import { defaultAiConfig, type AiItem, type AiPrepared, type AiView } from "./aiCommands";
import { aiAttempt, aiViewFixture, aiWorkPlanFixture, arenaViewFixture } from "./testSupport/aiFixture";
import type { WorkPlanView, WorkPlanStatusView, WorkPlanReceiptView, WorkProtection } from "./workPlanCommands";
import { validateRequestWorkPlanPrepare, validateRequestWorkPlanAuthorize, validateRequestWorkPlanStart, validateRequestWorkProtectionRead, validateRequestWorkProtectionSet } from "./generated/ai.validators";
import { validateRequestPluginBuild } from "./generated/release.validators";
import { validateRequestActivity, validateRequestApplicationShutdown } from "./generated/execution.validators";
import type { PluginBuildPrepareRequest } from "./releaseCommands";
import type { ArenaConfig, ArenaPrepared, ArenaView } from "./arenaCommands";
import type { SessionReads } from "./sessionReads";
import type { AttemptDetail, TaskActivity } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import type { ContentScope } from "./sourceCommands";
import { sourceKeys } from "./sourceQueries";
import { pluginRuleKeyFixture } from "./testSupport/textReviewFixture";
import { validateRequestFinding } from "./generated/review.validators";
import type { ReviewFindingDecision } from "./reviewCommands";
import type { Eligibility } from "./reviewCommands";
import { StrictMode } from "react";
import { connectionFixture } from "./testSupport/connectionFixture";
import type { ProjectMetadataReconcileCommandPayload, WorkbenchCommands } from "./workbenchCommands";
import { useWorkspaceView, type WorkbenchContextPresentation, type WorkspaceViewMemory } from "./WorkbenchFrame";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  join: vi.fn(),
  sep: vi.fn(),
  open: vi.fn(),
  onCloseRequested: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
  reads: null as SessionReads | null,
  commands: null as WorkbenchCommands | null,
  drafts: new Map<string, ReturnType<typeof import("./TranslationDraftSession").useTranslationDraftSession>>(),
  contextCallbacks: new Map<string, (value: WorkbenchContextPresentation) => void>(),
  memories: new Map<string, WorkspaceViewMemory>(),
}));

vi.mock("./workbenchCommands", async importOriginal => {
  const actual = await importOriginal<typeof import("./workbenchCommands")>();
  function CaptureCommands() { mocks.commands = actual.useWorkbenchCommands(); return null; }
  return { ...actual, WorkbenchCommandsProvider: (props: React.ComponentProps<typeof actual.WorkbenchCommandsProvider>) =>
    <actual.WorkbenchCommandsProvider {...props}><CaptureCommands />{props.children}</actual.WorkbenchCommandsProvider> };
});

// Composition tests isolate native notifications; the bridge has its own race tests.
vi.mock("./SessionReadProvider", async importOriginal => {
  const actual = await importOriginal<typeof import("./SessionReadProvider")>();
  function CaptureReads() { mocks.reads = actual.useSessionReads(); return null; }
  return { ...actual, SessionReadProvider: (props: React.ComponentProps<typeof actual.SessionReadProvider>) =>
    <actual.SessionReadProvider {...props} bridge={false}><CaptureReads />{props.children}</actual.SessionReadProvider> };
});
vi.mock("./TranslationDraftSession", async importOriginal => {
  const actual = await importOriginal<typeof import("./TranslationDraftSession")>();
  function CaptureDraft({ sessionToken }: { sessionToken: string }) {
    mocks.drafts.set(sessionToken, actual.useTranslationDraftSession()); return null;
  }
  return { ...actual, TranslationDraftSession: (props: React.ComponentProps<typeof actual.TranslationDraftSession>) =>
    <actual.TranslationDraftSession {...props}><CaptureDraft sessionToken={props.project.sessionToken} />{props.children}</actual.TranslationDraftSession> };
});
vi.mock("./ProjectSessionWorkbench", async importOriginal => {
  const actual = await importOriginal<typeof import("./ProjectSessionWorkbench")>();
  return { ...actual, ProjectSessionWorkbench: (props: React.ComponentProps<typeof actual.ProjectSessionWorkbench>) => {
    mocks.memories.set(props.project.sessionToken, useWorkspaceView().memory);
    if (props.onWorkContext) mocks.contextCallbacks.set(props.project.sessionToken, props.onWorkContext);
    return <actual.ProjectSessionWorkbench {...props} />;
  } };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/path", () => ({ join: mocks.join, sep: mocks.sep }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: mocks.onCloseRequested,
    close: mocks.close,
    destroy: mocks.destroy,
  }),
}));

const metadata = (displayName = "Demo", revision = "1") => ({
  projectId: "123e4567-e89b-42d3-a456-426614174000",
  displayName,
  sourceLocale: "en-US",
  targetLocales: ["zh-CN"],
  metadataRevision: revision,
});

const projectView = (
  displayName = "Demo",
  revision = "1",
  reconciliationState: "settled" | "committed" | "previous" = "settled",
) => ({
  sessionToken: "session-1",
  locator: "C:\\Projects\\demo",
  metadata: metadata(displayName, revision),
  reconciliationState,
});

function emptyTaskActivity(request: unknown) {
  if (!validateRequestActivity(request)) throw new Error("Invalid task activity read request");
  return { total: "0", active: "0", attention: "0", saved: "0", rows: [] };
}

async function renderApp() {
  const result = render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Create project" })).toBeInTheDocument());
  return result;
}

async function createProject(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Create project" }));
  await user.type(screen.getByLabelText(/Parent folder/), "C:\\Projects");
  const directoryName = screen.getByLabelText(/New folder name/);
  await user.clear(directoryName);
  await user.type(directoryName, "demo");
  await user.type(screen.getByLabelText(/Project name/), "Demo");
  await user.click(screen.getByRole("button", { name: "Create and open" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument());
}

async function openConnectionSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: i18n.t("nav.settings") }));
  const settings = screen.getByRole("dialog", { name: i18n.t("nav.settings") });
  await user.click(within(settings).getByRole("button", { name: i18n.t("connections.open") }));
  return screen.findByRole("dialog", { name: i18n.t("connections.title") });
}

function metadataRegistry() {
  if (!mocks.commands) throw new Error("Expected the actual App command owner");
  return mocks.commands;
}

async function prepareUnknownMetadata({ directory = false, navigation = false, strict = false, target = false } = {}) {
  const user = userEvent.setup(), view = strict ? render(<StrictMode><App /></StrictMode>) : await renderApp();
  await createProject(user);
  await user.click(screen.getByRole("button", { name: target ? "Edit target languages" : "Rename" }));
  const field = screen.getByRole("textbox", { name: target ? "Target locales" : "Project name" });
  await user.clear(field); await user.type(field, target ? "iw" : "Captured A");
  if (directory) await user.click(screen.getByRole("checkbox", { name: "Also rename the project folder" }));
  const original = mocks.invoke.getMockImplementation();
  if (!original) throw new Error("Expected the project fixture");
  mocks.invoke.mockImplementation((command: string, args) => {
    if (command === (target ? "set_target_locales" : "rename_project")) return Promise.reject(new Error("Save acknowledgement lost"));
    if (command === "read_project") return Promise.reject(new Error("Read acknowledgement lost"));
    return original(command, args);
  });
  if (navigation) {
    await user.click(screen.getByRole("button", { name: "Close project" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry read" })).toBeEnabled());
  } else {
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry read" })).toBeEnabled());
  }
  const payload: ProjectMetadataReconcileCommandPayload = { kind: "project-metadata-reconcile", previous: projectView(),
    form: { kind: target ? "target" : "rename", expectedRevision: "1" }, value: target ? "iw" : "Captured A", directoryName: directory ? "Captured A" : null };
  const scope = { projectId: payload.previous.metadata.projectId, sessionToken: payload.previous.sessionToken, area: "overview" as const };
  return { user, view, payload, scope, commands: metadataRegistry() };
}

async function prepareAiInApp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "AI work" }));
  expect(mocks.invoke.mock.calls).toContainEqual(["read_context_strategy_default", {
    request: { ...mocks.reads!.context, locale: "zh-CN" },
  }]);
  await user.selectOptions(screen.getByRole("combobox", { name: "Check and review" }), "manual");
  await user.type(screen.getByRole("textbox", { name: "Chat Completions URL" }), "http://127.0.0.1:4000/v1/chat/completions");
  await user.type(screen.getByRole("textbox", { name: "Model" }), "test-model");
  await user.clear(screen.getByRole("textbox", { name: "API key environment variable name" }));
  await user.click(await screen.findByRole("checkbox", { name: "first: Hello" }));
  await user.click(screen.getByRole("checkbox", { name: "Share applicable adopted terms" }));
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await screen.findByRole("heading", { name: "Data sharing preview" });
  await user.click(screen.getByRole("checkbox", { name: /I confirm sending/ }));
  expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeEnabled();
}

function installTranslationEditor() {
  const originalInvoke = mocks.invoke.getMockImplementation()!;
  const target = reviewTargetFixture({ unitId: fixtureIdentity(501), nativeKey: "first", sourceSnapshotId: fixtureIdentity(500), sourceRevisionId: fixtureIdentity(502), sourceText: "Hello", selectionId: null, revisionId: null, translationText: null, basis: "basis" });
  let text: string | null = null;
  let selection: { eventId: string; revisionId: string; unitId: string; locale: string; actionId: string; sequence: string; previousEventId: string | null } | null = null;
  const protections = new Map<string, WorkProtection>(), protectionReceipts = new Map<string, WorkProtection>();
  let onSave: (request: Record<string, unknown>, commit: () => unknown) => Promise<unknown> = async (_request, commit) => commit();
  const commit = (request: Record<string, unknown>) => {
    const sequence = (BigInt(selection?.sequence ?? "0") + 1n).toString();
    const actionId = String(request.actionId), unitId = String(request.unitId), locale = String(request.locale);
    const previousEventId = selection?.eventId ?? null;
    selection = { eventId: fixtureIdentity(502 + Number(sequence)), revisionId: fixtureIdentity(503 + Number(sequence)), unitId, locale, actionId, sequence, previousEventId };
    text = String(request.text);
    return { projectId: request.projectId, actionId,
      basis: { sourceSnapshotId: fixtureIdentity(500), sourceRevisionId: fixtureIdentity(502), selectionId: selection.eventId },
      selection,
      revision: { revisionId: selection.revisionId, unitId, locale, actionId, ordinal: sequence, text,
        sourceSnapshotId: fixtureIdentity(500), sourceRevisionId: fixtureIdentity(502), originKind: "manual", contributors: [],
        attemptId: null, resultId: null, itemId: null, artifactId: null, logicalPath: null, declaredLocale: null, nativeKey: null, fileDigest: null } };
  };
  mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const locale = String(args?.request?.locale ?? "zh-CN");
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: fixtureIdentity(500) };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: fixtureIdentity(500), scope: { revision: "2", currentSnapshot: fixtureIdentity(500) }, namespace: "Example.Mod", rows: [], total: 1 });
    if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor({ ...target, locale, selectionId: selection?.eventId ?? null, revisionId: selection?.revisionId ?? null, translationText: text })]);
    if (command === "read_review_findings") return reviewFindingViewFixture({ ...target, locale, selectionId: selection?.eventId ?? null, revisionId: selection?.revisionId ?? null, translationText: text });
    if (command === "read_review_editor_snapshot") return {
      target: { ...target, locale, selectionId: selection?.eventId ?? null, revisionId: selection?.revisionId ?? null, translationText: text },
      translations: { unitId: fixtureIdentity(501), locale, total: selection?.sequence ?? "0", rows: [], nextOrdinal: null, currentText: text, current: selection },
      terms: { unitId: fixtureIdentity(501), locale, sourceRevisionId: fixtureIdentity(502), entries: [] },
      context: null, readVersion: "view",
    };
    if (command === "create_execution_identity") return fixtureIdentity(1 + mocks.invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length);
    if (command === "read_work_protection") {
      if (!validateRequestWorkProtectionRead(args.request)) throw new Error("Invalid protection read request");
      return { ...(protections.get(`${args.request.projectId}:${args.request.sessionToken}:${args.request.unitId}:${args.request.locale}`)
        ?? { unitId: args.request.unitId, locale: args.request.locale, revision: "0", protected: false }) };
    }
    if (command === "set_work_protection") {
      if (!validateRequestWorkProtectionSet(args.request)) throw new Error("Invalid protection mutation request");
      const request = args.request, existing = protectionReceipts.get(request.actionId);
      if (existing) return { ...existing };
      const key = `${request.projectId}:${request.sessionToken}:${request.unitId}:${request.locale}`, previous = protections.get(key);
      expect(request.expectedRevision).toBe(previous?.revision ?? "0");
      const value = { unitId: request.unitId, locale: request.locale, revision: (BigInt(request.expectedRevision) + 1n).toString(), protected: request.protected };
      protections.set(key, value); protectionReceipts.set(request.actionId, value); return { ...value };
    }
    if (command === "save_translation_revision") return onSave(args.request, () => commit(args.request));
    if (command === "execution_status") return { active: false, quiescing: false, queryCount: 0, error: null };
    if (command === "list_execution_tasks") return [];
    if (command === "read_execution_task_activity") return emptyTaskActivity(args.request);
    if (command === "read_context_strategy_default") return originalInvoke(command, args);
    return projectView();
  });
  return { setSave: (handler: typeof onSave) => { onSave = handler; }, saves: () => mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision"),
    protections: () => mocks.invoke.mock.calls.filter(([command]) => command === "set_work_protection") };
}

async function editableDraft() {
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
  return editor;
}

function installAiPreparation() {
  const unitId = fixtureIdentity(501);
  let sourceVersion = 0;
  let resourceVersion = 0;
  let lastConfig = { ...defaultAiConfig };
  let prepared: WorkPlanView | null = null, authority: WorkPlanStatusView | null = null;
  const actions = new Map<string, WorkPlanReceiptView>();
  const item = (): AiItem => ({ unitId, sourceRevisionId: fixtureIdentity(502 + sourceVersion),
    sourceSnapshotId: fixtureIdentity(500 + sourceVersion), nativeKey: "first", sourceLocale: "en-US",
    sourceText: sourceVersion ? "Updated source" : "Hello", targetLocale: "zh-CN", terms: [], context: null, sourceContext: {kind:"not-selected"}, projectContext: {kind:"not-selected" as const},
    omissions: [], resourceBaseline: String(resourceVersion) });
  const originalInvoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: String(2 + sourceVersion), currentSnapshot: fixtureIdentity(500 + sourceVersion) };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: fixtureIdentity(500 + sourceVersion),
      scope: { revision: String(2 + sourceVersion), currentSnapshot: fixtureIdentity(500 + sourceVersion) },
      rows: [sourceRowFixture({ unitId, sourceRevisionId: fixtureIdentity(502 + sourceVersion) },
        { key: "first", text: sourceVersion ? "Updated source" : "Hello" })] });
    if (command === "read_terms" || command === "list_resource_captures") return [];
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "prepare_work_plan") {
      if (!validateRequestWorkPlanPrepare(args.request) || !args.request.config) throw new Error("Invalid assisted work-plan request");
      lastConfig = structuredClone(args.request.config);
      const capture: AiPrepared = { attemptId: aiAttempt, preview: {
        config: lastConfig, recipe: "direct-translation-1",
        digest: String(sourceVersion + resourceVersion).padStart(64, "d"),
        items: [item()],
      } };
      prepared = { ...aiWorkPlanFixture(capture, args.request.options), planId: fixtureIdentity(510 + sourceVersion + resourceVersion),
        digest: String(sourceVersion + resourceVersion).padStart(64, "e") };
      return structuredClone(prepared);
    }
    if (command === "create_execution_identity") return fixtureIdentity(600 + mocks.invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length);
    if (command === "authorize_work_plan") {
      if (!prepared || !validateRequestWorkPlanAuthorize(args.request)) throw new Error("Invalid work-plan authorization request");
      expect(args.request).toMatchObject({ planId: prepared.planId, digest: prepared.digest, confirmed: true,
        effects: ["save-candidate"], checkerExecutions: [], toolExecution: false });
      const receipt: WorkPlanReceiptView = { actionId: args.request.actionId, lease: { planId: prepared.planId, generation: "1" },
        state: "active", attemptId: prepared.attemptId, parentTask: null };
      actions.set(receipt.actionId, receipt);
      authority = { plan: structuredClone(prepared), lease: receipt.lease, state: "active", effects: args.request.effects,
        expiresAt: args.request.expiresAt, toolInvocations: null };
      return structuredClone(receipt);
    }
    if (command === "read_work_plan_status") return authority && structuredClone(authority);
    if (command === "read_work_plan_action") return actions.get(String(args.request.actionId)) ?? null;
    if (command === "start_work_plan") {
      if (!validateRequestWorkPlanStart(args.request)) throw new Error("Invalid work-plan start request");
      const receipt = actions.get(args.request.actionId); if (!receipt) throw new Error("Work-plan start has no original authorization");
      expect(args.request).toMatchObject({ planId: receipt.lease.planId, expectedGeneration: receipt.lease.generation });
      return receipt.attemptId;
    }
    if (command === "read_ai_translation") return view();
    return originalInvoke(command, args);
  });
  const view = (): AiView => {
    const captured = authority?.plan.preview, value = aiViewFixture(captured?.items[0] ?? item(), captured?.config ?? lastConfig);
    value.planId = authority?.plan.planId ?? null; value.planGeneration = authority?.lease.generation ?? null;
    return value;
  };
  return {
    changeSource: () => { sourceVersion++; },
    changeResources: () => { resourceVersion++; },
    view,
  };
}

function installArenaPreparation() {
  const facts = installAiPreparation(), original = mocks.invoke.getMockImplementation()!;
  let captured: ArenaPrepared;
  const view = (): ArenaView => {
    const value = arenaViewFixture(captured.preview.items[0].item,captured.preview.config);
    value.detail.attemptId = captured.attemptId; value.detail.recovery.attemptId = captured.attemptId; return value;
  };
  mocks.invoke.mockImplementation(async (command: string, args: {request: Record<string,unknown>}) => {
    if (command === "list_arena_comparisons") return [];
    if (command === "preview_arena_translation") {
      const config = args.request.config as ArenaConfig, item = facts.view().rows[0].item;
      captured = {attemptId:fixtureIdentity(560),preview:{config:structuredClone({...config,parentAttemptId:config.parentAttemptId ?? null}),
        digest:"arena-preview",items:config.variants.map((_,slot)=>({slot,sourceOrder:0,item:structuredClone(item)}))}};
      return captured;
    }
    if (command === "start_arena_translation") return args.request.attemptId;
    if (command === "read_arena_translation") return view();
    return original(command,args);
  });
  return {...facts,view};
}
async function prepareArenaInApp(user:ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button",{name:"Arena comparison"}));
  for (const number of [1,2]) {
    await user.type(screen.getByRole("textbox",{name:`Scheme ${number} · Chat Completions URL`}),"http://127.0.0.1:4000/v1/chat/completions");
    await user.type(screen.getByRole("textbox",{name:`Scheme ${number} · Model`}),`arena-model-${number}`);
  }
  await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
  await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
  await screen.findByRole("heading",{name:"Data sharing preview"});
  await user.click(screen.getByRole("checkbox",{name:/I confirm sending the shown/}));
}

describe("project lifecycle workbench", () => {
  it.each([
    { language: "en-US", hasProject: false }, { language: "zh-CN", hasProject: false },
    { language: "en-US", hasProject: true }, { language: "zh-CN", hasProject: true },
  ] as const)("opens the same connection draft from Settings and returns to its stable trigger ($language, project=$hasProject)", async ({ language, hasProject }) => {
    const user = userEvent.setup(); await renderApp(); const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "read_model_connections"
      ? Promise.resolve({ snapshot: { storeId: null, revision: "0", lastActionId: null, profiles: [] }, basis: { storeId: null, revision: "0", digest: "a".repeat(64) }, references: [] })
      : original(command, args));
    if (hasProject) await createProject(user);
    await act(async () => { await i18n.changeLanguage(language); });
    expect(screen.queryByRole("button", { name: i18n.t("connections.open") })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: i18n.t("nav.settings") });
    const dialog = await openConnectionSettings(user); await screen.findByText(i18n.t("connections.empty"));
    expect(screen.getAllByRole("dialog")).toEqual([dialog]);
    expect(screen.queryByRole("dialog", { name: i18n.t("nav.settings") })).not.toBeInTheDocument();
    await user.tab(); expect(dialog.contains(document.activeElement)).toBe(true);
    const text = "Retained connection B 日本語 مرحبا 👩🏽‍💻 é";
    await user.type(within(dialog).getByLabelText(i18n.t("connections.name")), text);
    if (hasProject) await user.keyboard("{Escape}");
    else await user.click(within(dialog).getByRole("button", { name: i18n.t("connections.close") }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (hasProject) {
      expect(screen.getByRole("heading", { name: "Demo" })).toBeVisible();
      expect(mocks.reads?.context.sessionToken).toBe("session-1");
    } else expect(screen.getByRole("button", { name: i18n.t("empty.create") })).toBeEnabled();
    const reopened = await openConnectionSettings(user);
    expect(screen.getAllByRole("dialog")).toEqual([reopened]);
    expect(within(reopened).getByLabelText(i18n.t("connections.name"))).toHaveValue(text);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "change_model_connections")).toBe(false);
  });
  it.each(["close", "escape"] as const)("changes only the interface from Settings without a project and returns focus on %s", async close => {
    const user = userEvent.setup(); await renderApp();
    const trigger = screen.getByRole("button", { name: "Settings" });
    expect(screen.queryByRole("combobox", { name: "Interface language" })).not.toBeInTheDocument();
    const calls = mocks.invoke.mock.calls.length;
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAccessibleDescription("Choose the interface language and manage model connection profiles for this application.");
    expect(within(dialog).getByRole("combobox", { name: "Interface language" })).toHaveAccessibleDescription("Changes apply immediately to the interface only. Project target languages and your text stay unchanged.");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Interface language" }), "zh-CN");
    expect(dialog).toHaveAccessibleName("设置");
    expect(localStorage.getItem(UI_LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    if (close === "escape") await user.keyboard("{Escape}");
    else await user.click(within(dialog).getByRole("button", { name: "关闭设置" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(mocks.invoke.mock.calls).toHaveLength(calls);
    await user.click(trigger);
    expect(within(screen.getByRole("dialog", { name: "设置" })).getByRole("combobox", { name: "界面语言" })).toHaveValue("zh-CN");
  });
  it("keeps a project form intact when Escape closes Settings", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Project name" });
    await user.type(input, " retained metadata");
    const trigger = screen.getByRole("button", { name: "Settings" }); await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(input).toHaveValue("Demo retained metadata");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "rename_project")).toBe(false);
  });
  it("closes Settings before the original native-close draft decision and preserves its focus and input", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); const fixture = installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    await user.type(await editableDraft(), "Retained original draft");
    const trigger = screen.getByRole("button", { name: "Settings" }); await user.click(trigger);
    const nativeClose = mocks.onCloseRequested.mock.calls.at(-1)?.[0]; if (!nativeClose) throw new Error("No native close handler");
    let closing!: Promise<void>;
    act(() => { closing = nativeClose({ preventDefault: vi.fn() }); });
    const dialog = await screen.findByRole("dialog", { name: "Leave with an unsaved translation?" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.tab(); expect(dialog.contains(document.activeElement)).toBe(true); expect(trigger).not.toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await act(async () => { await closing; });
    expect(await editableDraft()).toHaveValue("Retained original draft");
    expect(fixture.saves()).toHaveLength(0); expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "close_project")).toBe(false);
  });
  it.each(["en-US", "zh-CN"] as const)("reveals the unique background dock without leaving an unknown save or rebinding newer input (%s)", async language => {
    const user = userEvent.setup(); await renderApp();
    expect(screen.queryByRole("button", { name: "View background tasks" })).not.toBeInTheDocument();
    await createProject(user); const fixture = installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    await user.type(await editableDraft(), "A");
    fixture.setSave(async () => { throw new Error("Original save acknowledgement lost"); });
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(mocks.drafts.get("session-1")?.current()?.outcomeUnknown).toBe(true));
    const editor = screen.getByRole("textbox", { name: "Your draft" }) as HTMLTextAreaElement;
    await user.type(editor, " newer B 👩🏽‍💻 é");
    fireEvent.change(editor, { target: { value: `${editor.value}\n{name}` } }); editor.setSelectionRange(1, 4);
    const draft = mocks.drafts.get("session-1")!.current()!, memory = mocks.memories.get("session-1")!;
    const before = { text: draft.text, editSeq: draft.editSeq, request: structuredClone(draft.pending!.request),
      locale: memory.read("translation", "targetLocale"), query: memory.read("translation", "query"),
      applied: memory.read("translation", "appliedQuery"), selection: memory.read("translation", "contentSelection") };
    await act(async () => { await i18n.changeLanguage(language); });
    const dock = screen.getByRole("complementary", { name: i18n.t("execution.dock.title") });
    const summary = within(dock).getByText(i18n.t("execution.dock.title"), { selector: "summary", exact: false }), details = summary.closest("details")!;
    const trigger = screen.getByRole("button", { name: i18n.t("execution.dock.reveal") });
    trigger.focus(); const calls = mocks.invoke.mock.calls.length;
    await user.keyboard("{Enter}");
    expect(details).toHaveAttribute("open"); expect(summary).toHaveFocus();
    expect(screen.getAllByRole("complementary", { name: i18n.t("execution.dock.title") })).toHaveLength(1);
    fireEvent.click(trigger); expect(details).toHaveAttribute("open"); expect(summary).toHaveFocus();
    expect(mocks.invoke.mock.calls).toHaveLength(calls);
    expect(screen.getByRole("region", { name: i18n.t("translation.title") })).toBeVisible();
    expect(screen.getByRole("button", { name: i18n.t("translation.title") })).toHaveAttribute("aria-current", "page");
    expect(editor).toHaveValue(before.text); expect(editor.selectionStart).toBe(1); expect(editor.selectionEnd).toBe(4);
    expect(mocks.drafts.get("session-1")?.current()).toMatchObject({ text: before.text, editSeq: before.editSeq, pending: { request: before.request } });
    expect(memory.read("translation", "targetLocale")).toBe(before.locale); expect(memory.read("translation", "query")).toBe(before.query);
    expect(memory.read("translation", "appliedQuery")).toBe(before.applied); expect(memory.read("translation", "contentSelection")).toBe(before.selection);
    expect(fixture.saves()).toHaveLength(1);
    await user.click(summary); expect(details).not.toHaveAttribute("open");
    expect(editor).toHaveValue(before.text);
  });
  it("reveals the empty background dock without a target language or another IPC call", async () => {
    const user = userEvent.setup(), original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args) => command === "create_project"
      ? Promise.resolve({ ...projectView(), metadata: { ...metadata(), targetLocales: [] } }) : original(command, args));
    await renderApp(); await createProject(user); await screen.findByText("No tasks yet");
    const trigger = screen.getByRole("button", { name: "View background tasks" }); expect(trigger).toBeEnabled();
    const calls = mocks.invoke.mock.calls.length; fireEvent.click(trigger);
    const summary = screen.getByText("Background tasks", { selector: "summary", exact: false });
    expect(summary.closest("details")).toHaveAttribute("open"); expect(summary).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Demo" })).toBeVisible(); expect(mocks.invoke.mock.calls).toHaveLength(calls);
    expect(screen.getByRole("button", { name: "Find content" })).toBeDisabled();
  });
  it.each(["loading", "failure"] as const)("opens the original background %s and leaves its recovery with the Dock", async state => {
    const user = userEvent.setup(), original = mocks.invoke.getMockImplementation()!;
    let complete!: (value: ReturnType<typeof emptyTaskActivity>) => void, unavailable = true;
    mocks.invoke.mockImplementation((command: string, args) => {
      if (command !== "read_execution_task_activity") return original(command, args);
      if (state === "loading") return new Promise<ReturnType<typeof emptyTaskActivity>>(resolve => { complete = resolve; });
      return unavailable ? Promise.reject(new Error("Synthetic activity read unavailable")) : Promise.resolve(emptyTaskActivity(args.request));
    });
    await renderApp(); await createProject(user);
    await within(screen.getByText("Background tasks", { selector: "summary", exact: false })).findByText(state === "loading" ? "Loading tasks…" : "Status unavailable");
    const calls = mocks.invoke.mock.calls.length; fireEvent.click(screen.getByRole("button", { name: "View background tasks" }));
    const dock = screen.getByRole("complementary", { name: "Background tasks" });
    const summary = within(dock).getByText("Background tasks", { selector: "summary", exact: false });
    expect(summary.closest("details")).toHaveAttribute("open"); expect(summary).toHaveFocus(); expect(mocks.invoke.mock.calls).toHaveLength(calls);
    if (state === "loading") {
      await act(async () => { complete({ total: "0", active: "0", attention: "0", saved: "0", rows: [] }); });
    } else {
      expect(within(dock).getByRole("alert")).toHaveTextContent("Your current work is kept"); unavailable = false;
      await user.click(within(dock).getByRole("button", { name: "Refresh" }));
    }
    await screen.findByText("No tasks yet");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_execution_task_activity")).toHaveLength(state === "loading" ? 1 : 2);
    expect(screen.getByRole("heading", { name: "Demo" })).toBeVisible();
  });
  it.each(["en-US", "zh-CN"] as const)("opens the original content find from Tasks without rebinding an unknown save or its newer draft (%s)", async language => {
    const user = userEvent.setup(); await renderApp();
    expect(screen.queryByRole("button", { name: "Find content" })).not.toBeInTheDocument();
    await createProject(user); const fixture = installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    await user.type(await editableDraft(), "A");
    fixture.setSave(async () => { throw new Error("Original save acknowledgement lost"); });
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(mocks.drafts.get("session-1")?.current()?.outcomeUnknown).toBe(true));
    await user.type(screen.getByRole("textbox", { name: "Your draft" }), " newer B 👩🏽‍💻 é");
    await user.click(screen.getByText("Find and range actions", { exact: true }));
    await user.type(screen.getByRole("textbox", { name: "Find by key, source or translation" }), "Unsubmitted 日本語 é");
    const memory = mocks.memories.get("session-1")!, draft = mocks.drafts.get("session-1")!.current()!;
    const before = { locale: memory.read("translation", "targetLocale"), query: memory.read<string>("translation", "query"),
      applied: memory.read("translation", "appliedQuery"), selection: memory.read("translation", "contentSelection"),
      request: structuredClone(draft.pending!.request), text: draft.text, editSeq: draft.editSeq };
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByRole("region", { name: "Tasks" });
    await act(async () => { await i18n.changeLanguage(language); });
    await user.click(screen.getByRole("button", { name: i18n.t("workbench.findContent") }));
    const find = await screen.findByRole("textbox", { name: i18n.t("workbench.search") });
    await waitFor(() => expect(find).toHaveFocus());
    expect(find).toHaveValue(before.query);
    expect(screen.getByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(before.text);
    expect(memory.read("translation", "targetLocale")).toBe(before.locale);
    expect(memory.read("translation", "appliedQuery")).toBe(before.applied);
    expect(memory.read("translation", "contentSelection")).toBe(before.selection);
    expect(mocks.drafts.get("session-1")?.current()).toMatchObject({ text: before.text, editSeq: before.editSeq, pending: { request: before.request } });
    expect(fixture.saves()).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "read_review_summary_page" && args.request.query === before.query)).toHaveLength(0);
    await user.click(screen.getByText(i18n.t("workbench.findAndRange"), { exact: true }));
    expect(find.closest("details")).not.toHaveAttribute("open");
    await user.click(screen.getByRole("button", { name: i18n.t("workbench.backOverview") }));
    expect(screen.getByRole("heading", { name: "Demo" })).toBeVisible();
    expect(mocks.drafts.get("session-1")?.current()?.pending?.request).toEqual(before.request);
  });

  it.each(["success", "failure"] as const)("consumes find focus before a slow original source read completes with %s", async outcome => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); installTranslationEditor();
    const original = mocks.invoke.getMockImplementation()!;
    let complete!: (value: ContentScope) => void, fail!: (error: Error) => void;
    const pending = new Promise<ContentScope>((resolve, reject) => { complete = resolve; fail = reject; });
    mocks.invoke.mockImplementation((command: string, args) => command === "read_content_scope" ? pending : original(command, args));
    await user.click(screen.getByRole("button", { name: "Find content" }));
    const find = await screen.findByRole("textbox", { name: "Find by key, source or translation" });
    await waitFor(() => expect(find).toHaveFocus());
    const outside = screen.getByRole("button", { name: "Settings" }); outside.focus();
    await act(async () => outcome === "success" ? complete({ revision: "2", currentSnapshot: fixtureIdentity(500) }) : fail(new Error("Synthetic source read unavailable")));
    const reads = mocks.reads; if (!reads) throw new Error("No project read owner");
    await waitFor(() => expect(reads.client.getQueryState(reads.key(["translation-source-scope"]))?.status).toBe(outcome === "success" ? "success" : "error"));
    expect(outside).toHaveFocus(); expect(find).not.toHaveFocus();
    expect(mocks.memories.get("session-1")?.read("translation", "findFocus")).toBeNull();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "save_translation_revision")).toBe(false);
  });
  it.each(["focus", "collapse", "navigation"] as const)("abandons the one find frame after a newer user %s intent", async intent => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByRole("region", { name: "Tasks" });
    let next = 0; const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => { frames.delete(frame); });
    await user.click(screen.getByRole("button", { name: "Find content" }));
    const find = await screen.findByRole("textbox", { name: "Find by key, source or translation" });
    const memory = mocks.memories.get("session-1")!;
    expect(memory.read("translation", "findFocus")).not.toBeNull();
    if (intent === "focus") act(() => { screen.getByRole("button", { name: "Settings" }).focus(); });
    else if (intent === "collapse") await user.click(screen.getByText("Find and range actions", { exact: true }));
    else await user.click(screen.getByRole("button", { name: "Tasks" }));
    const focused = document.activeElement;
    const pending = [...frames.values()]; frames.clear(); act(() => { pending.forEach(callback => callback(performance.now())); });
    expect(document.activeElement).toBe(focused); expect(find).not.toHaveFocus();
    expect(memory.read("translation", "findFocus")).toBeNull();
    if (intent === "collapse") expect(find.closest("details")).not.toHaveAttribute("open");
    if (intent === "navigation") expect(screen.getByRole("region", { name: "Tasks" })).toBeVisible();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "save_translation_revision")).toBe(false);
  });
  it("keeps content find discoverable but unavailable without a project target language", async () => {
    const user = userEvent.setup(), original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args) => command === "create_project"
      ? Promise.resolve({ ...projectView(), metadata: { ...metadata(), targetLocales: [] } }) : original(command, args));
    await renderApp(); await createProject(user);
    const find = screen.getByRole("button", { name: "Find content" });
    expect(find).toBeDisabled(); expect(find).toHaveAccessibleDescription("Add a project target language to find content.");
    const calls = mocks.invoke.mock.calls.length; await user.click(find);
    expect(mocks.invoke.mock.calls.slice(calls).some(([command]) => ["read_content_scope", "read_source_content", "read_review_summary_page", "save_translation_revision"].includes(command))).toBe(false);
    expect(screen.getByRole("heading", { name: "Demo" })).toBeVisible();
  });
  it("cancels the old session's unconsumed find frame before opening another project", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); installTranslationEditor();
    let next = 0; const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => { frames.delete(frame); });
    await user.click(screen.getByRole("button", { name: "Find content" }));
    await screen.findByRole("textbox", { name: "Find by key, source or translation" });
    const oldMemory = mocks.memories.get("session-1")!, request = oldMemory.read<import("./sessionNavigation").TranslationFindFocusRequest>("translation", "findFocus")!;
    const original = mocks.invoke.getMockImplementation()!;
    const replacement = { ...projectView("Other"), sessionToken: "session-2", locator: "C:\\Projects\\other",
      metadata: { ...metadata("Other"), projectId: fixtureIdentity(900) } };
    mocks.invoke.mockImplementation((command: string, args) => command === "open_project" ? Promise.resolve(replacement) : original(command, args));
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    expect(request.current()).toBe(false);
    await user.click(screen.getByRole("button", { name: "Open another" }));
    await user.type(screen.getByRole("textbox", { name: /Project folder/ }), replacement.locator);
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findByRole("heading", { name: "Other" });
    const outside = screen.getByRole("button", { name: "Settings" }); act(() => { outside.focus(); });
    const pending = [...frames.values()]; frames.clear(); act(() => { pending.forEach(callback => callback(performance.now())); });
    expect(request.current()).toBe(false); expect(outside).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Find by key, source or translation" })).not.toBeInTheDocument();
    expect(mocks.memories.get("session-2")?.read("translation", "findFocus")).toBeUndefined();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_project")).toHaveLength(1);
  });
  it("projects actual working context independently of UI language and retains a newer draft after an unknown save", async () => {
    const user = userEvent.setup(), original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args) => command === "create_project"
      ? Promise.resolve({ ...projectView(), metadata: { ...metadata(), targetLocales: ["ja", "zh-CN"] } }) : original(command, args));
    await renderApp(); await createProject(user);
    const context = () => within(screen.getByRole("group", { name: i18n.t("workbench.context.label") }));
    expect(context().getByText("Project targets")).toBeVisible();
    expect(context().getByText(/\(ja\).*\(zh-CN\)/)).toBeVisible();
    expect(context().getByText("Project scope")).toBeVisible();
    const fixture = installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Target language" }), "zh-CN");
    await user.click(await screen.findByRole("button", { name: "first" }));
    const editor = await editableDraft();
    await user.type(editor, "A");
    expect(context().getByText("Working target")).toBeVisible();
    expect(context().getByText(/\(zh-CN\)/)).toBeVisible();
    expect(context().queryByText(/\(ja\)/)).not.toBeInTheDocument();
    expect(context().getByText("Entry: first")).toBeVisible();
    let release!: () => void;
    fixture.setSave(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      throw { code: "outcome-unknown", outcome: "unknown", stage: "save", recoveryRequired: true };
    });
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await user.type(editor, "B");
    await user.click(screen.getByText("Find and range actions", { exact: true }));
    await user.type(screen.getByRole("textbox", { name: "Find by key, source or translation" }), "Unsubmitted 日本語 é");
    const memory = mocks.memories.get("session-1")!, before = { locale: memory.read("translation", "targetLocale"),
      query: memory.read("translation", "query"), applied: memory.read("translation", "appliedQuery"), selection: memory.read("translation", "contentSelection") };
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = screen.getByRole("dialog", { name: "Settings" });
    await user.selectOptions(within(settings).getByRole("combobox", { name: "Interface language" }), "zh-CN");
    await user.click(within(settings).getByRole("button", { name: i18n.t("settings.close") }));
    await act(async () => release());
    await waitFor(() => expect(mocks.drafts.get("session-1")?.current()?.outcomeUnknown).toBe(true));
    expect(context().getByText("当前工作语言")).toBeVisible();
    expect(context().getByText(/（zh-CN）/)).toBeVisible();
    expect(context().getByText("条目：first")).toBeVisible();
    expect(screen.getByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue("AB");
    expect(mocks.drafts.get("session-1")?.current()?.pending?.request).toEqual(fixture.saves()[0][1].request);
    expect(fixture.saves()).toHaveLength(1);
    expect(fixture.saves()[0][1].request).toMatchObject({ text: "A", locale: "zh-CN" });
    expect(memory.read("translation", "targetLocale")).toBe(before.locale); expect(memory.read("translation", "query")).toBe(before.query);
    expect(memory.read("translation", "appliedQuery")).toBe(before.applied); expect(memory.read("translation", "contentSelection")).toBe(before.selection);
    expect(memory.read("translation", "query")).toBe("Unsubmitted 日本語 é");
    expect(mocks.reads?.context.sessionToken).toBe("session-1");
    expect(screen.getByRole("button", { name: i18n.t("translation.title") })).toHaveAttribute("aria-current", "page");
  });

  it("keeps a removed working language and original unknown action visible without making it the project target", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const fixture = installTranslationEditor(), original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args) => command === "set_target_locales"
      ? Promise.resolve({ ...projectView("Demo", "2"), metadata: { ...metadata("Demo", "2"), targetLocales: ["ja"] }, outcome: "changed", directoryChanged: false })
      : original(command, args));
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    await user.type(await editableDraft(), "Original A");
    fixture.setSave(async () => { throw { code: "outcome-unknown", outcome: "unknown", stage: "save", recoveryRequired: true }; });
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    await screen.findByRole("button", { name: "Retry the same action" });
    const request = structuredClone(fixture.saves()[0][1].request);
    // The draft owner checks its original request once after a lost save ACK.
    const lookups = () => mocks.invoke.mock.calls.filter(([command]) => command === "read_translation_save_action").map(([, args]) => args.request);
    expect(lookups()).toEqual([request]);
    const originalLookups = structuredClone(lookups());
    await user.type(screen.getByRole("textbox", { name: "Your draft" }), " plus B");
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    await user.click(screen.getByRole("button", { name: "Edit target languages" }));
    const targets = screen.getByRole("textbox", { name: "Target locales" });
    await user.clear(targets); await user.type(targets, "ja");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Target locales" })).not.toBeInTheDocument());
    const context = () => within(screen.getByRole("group", { name: "Current work context" }));
    expect(context().getByText("Project targets")).toBeVisible();
    expect(context().getByText(/\(ja\)/)).toBeVisible();
    expect(context().queryByText(/\(zh-CN\)/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(context().getByText("Working target")).toBeVisible();
    expect(context().getByText(/\(zh-CN\) — no longer a project target/)).toBeVisible();
    expect(context().getByText("Entry: first")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Original A plus B");
    expect(mocks.drafts.get("session-1")?.current()?.pending?.request).toEqual(request);
    expect(fixture.saves()).toHaveLength(1);
    expect(lookups()).toEqual(originalLookups);
  });

  it("rejects late context from an old session or workspace after a real App project switch", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const publishOld = mocks.contextCallbacks.get("session-1");
    if (!publishOld) throw new Error("The actual session context callback was not captured");
    const original = mocks.invoke.getMockImplementation()!;
    const other = { ...projectView("Other"), sessionToken: "session-2", locator: "C:\\Projects\\other",
      metadata: { ...metadata("Other"), projectId: fixtureIdentity(900), targetLocales: ["fr"] } };
    mocks.invoke.mockImplementation((command: string, args) => command === "open_project" ? Promise.resolve(other) : original(command, args));
    await user.click(screen.getByRole("button", { name: "Open another" }));
    await user.type(screen.getByRole("textbox", { name: /Project folder/ }), other.locator);
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findByRole("heading", { name: "Other" });
    const late: WorkbenchContextPresentation = { projectId: metadata().projectId, sessionToken: "session-1", metadataRevision: "1",
      area: "overview", targetKind: "working", locales: ["ja"], scope: { kind: "entry", name: "Old session entry" } };
    await act(async () => {
      publishOld(late);
      const publishCurrent = mocks.contextCallbacks.get("session-2");
      if (!publishCurrent) throw new Error("The new session context callback was not captured");
      publishCurrent({ ...late, projectId: other.metadata.projectId, sessionToken: other.sessionToken, area: "translation" });
      publishCurrent({ ...late, projectId: other.metadata.projectId, sessionToken: other.sessionToken, metadataRevision: "0" });
    });
    const context = within(screen.getByRole("group", { name: "Current work context" }));
    expect(context.getByText("Project overview")).toBeVisible();
    expect(context.getByText(/\(fr\)/)).toBeVisible();
    expect(context.getByText("Project scope")).toBeVisible();
    expect(context.queryByText(/Old session entry|\(ja\)/)).not.toBeInTheDocument();
  });

  it("uses the AI preparation action by default and retains its owner through the manual editor route", async () => {
    installTranslationEditor(); installAiPreparation();
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    await user.click(await screen.findByRole("button", { name: "Prepare AI localization" }));
    expect(await screen.findByRole("heading", { name: "AI work" })).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Model" }), "Unsent model choice");
    await user.click(screen.getByRole("button", { name: "Edit directly" }));
    expect(await screen.findByRole("heading", { name: "Translations" })).toBeVisible();
    expect(document.querySelector("section.ai-dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "AI work" }));
    expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("Unsent model choice");
    expect(mocks.invoke.mock.calls.some(([command]) => ["start_work_plan", "authorize_work_plan", "start_ai_translation"].includes(command))).toBe(false);
  });

  it("rewrites an AI candidate through session navigation and returns without losing either owner", async () => {
    installTranslationEditor(); installAiPreparation();
    const user = userEvent.setup(); await renderApp(); await createProject(user); await prepareAiInApp(user);
    await user.click(screen.getByRole("button", { name: "Send and generate candidates" }));
    await user.click(await screen.findByRole("button", { name: "Rewrite this candidate" }));
    const draft = await screen.findByRole("textbox", { name: "Your draft" });
    await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
    expect(draft).toHaveValue("你好");
    await user.type(draft, "改写");
    await user.click(screen.getByRole("button", { name: "Return to AI work" }));
    expect(await screen.findByRole("heading", { name: "Generated results" })).toBeVisible();
    expect(mocks.drafts.get("session-1")?.current()?.text).toBe("你好改写");
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("你好改写");
    expect(mocks.invoke.mock.calls.some(([command]) => ["adopt_execution", "save_translation_revision", "select_translation_revision"].includes(command))).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_work_plan")).toHaveLength(1);
  });

  it("keeps an accepted running AI task in the Dock while its panel closes for manual editing", async () => {
    const editorFixture = installTranslationEditor(), ai = installAiPreparation();
    const original = mocks.invoke.getMockImplementation()!;
    let started = false;
    function runningView(): AiView {
      const view = ai.view(), row = view.rows[0];
      const detail = view.detail.items.find(item => item.status.itemId === row.itemId)!;
      view.detail.progress = { total: 1, running: 1, queued: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0, adopted: 0 };
      Object.assign(row, { output: null, resultId: null, savedRevisionId: null, automation: null });
      detail.resultId = null;
      Object.assign(detail.status, { execution: "dispatched", validation: "absent", adoption: "unapplied",
        cancellationRequested: false, retrySafe: false, diagnostic: null });
      for (const unit of view.detail.recovery.units) Object.assign(unit, {
        remainingItemIds: [], resultIds: [], actions: [], blockedReason: "still-running", receiptId: null,
      });
      if (view.budget) view.budget.unresolved = 1;
      return view;
    }
    mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
      if (command === "start_work_plan") {
        const result = await original(command, args);
        started = true;
        return result;
      }
      if (command === "read_ai_translation") {
        expect(started).toBe(true);
        return runningView();
      }
      if (command === "read_execution_task_activity") {
        if (!validateRequestActivity(args.request)) throw new Error("Invalid task activity read request");
        if (!started) return emptyTaskActivity(args.request);
        const view = runningView();
        return { total: "1", active: "1", attention: "0", saved: "0", rows: [{
          taskId: view.detail.taskId, attemptId: view.detail.attemptId, operation: "ai-translation",
          sequence: "7", phase: "active", progress: { ...view.detail.progress },
        }] } satisfies TaskActivity;
      }
      if (command === "execution_status") return { ...executionFixture.status, active: started };
      return original(command, args);
    });
    const user = userEvent.setup(); await renderApp(); await createProject(user); await prepareAiInApp(user);
    await user.click(screen.getByRole("button", { name: "Send and generate candidates" }));
    await screen.findByRole("heading", { name: "Generated results" });
    const reads = mocks.reads!, key = reads.key(["aiCommands", aiAttempt]);
    const accepted = reads.client.getQueryData<AiView>(key)!;
    expect(accepted.detail.progress.running).toBe(1);
    expect(accepted.detail.items[0].status.execution).toBe("dispatched");
    expect(accepted.rows[0].output).toBeNull();
    const originalTask = { taskId: accepted.detail.taskId, attemptId: accepted.detail.attemptId };

    await user.click(screen.getByRole("button", { name: "Compare and select in editor" }));
    const draft = await editableDraft();
    expect(document.querySelector("section.ai-dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Translations" })).toBeVisible();
    const text = "Manual work continues 👩🏽‍💻 é";
    await user.type(draft, text);
    expect(draft).toHaveValue(text);
    expect(mocks.drafts.get("session-1")?.current()?.text).toBe(text);
    expect(editorFixture.saves()).toHaveLength(0);
    expect(mocks.reads).toBe(reads);

    const activityReads = () => mocks.invoke.mock.calls.filter(([command]) => command === "read_execution_task_activity").length;
    const beforeRefresh = activityReads();
    await act(async () => { reads.invalidate(["execution"]); });
    await waitFor(() => expect(activityReads()).toBeGreaterThan(beforeRefresh));
    await user.click(screen.getByRole("button", { name: "View background tasks" }));
    const dock = screen.getByRole("complementary", { name: "Background tasks" });
    await within(dock).findByText(/1 running · 0 queued · 0 of 1 outputs saved/);
    expect(within(dock).getByRole("button", { name: "AI work · Task 7" })).toBeVisible();
    const activity = reads.client.getQueryData<TaskActivity>(reads.key(["task-activity", 12]))!;
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]).toMatchObject({ ...originalTask, phase: "active", progress: { running: 1, cancelled: 0, succeeded: 0 } });
    expect(draft).toHaveValue(text);

    await user.click(screen.getByRole("button", { name: "Return to AI work" }));
    expect(await screen.findByRole("heading", { name: "Generated results" })).toBeVisible();
    expect(reads.client.getQueryData<AiView>(key)?.detail).toMatchObject({ ...originalTask, progress: { running: 1, cancelled: 0 } });
    expect(mocks.drafts.get("session-1")?.current()?.text).toBe(text);
    for (const command of ["prepare_work_plan", "authorize_work_plan", "start_work_plan"]) {
      expect(mocks.invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
    }
    expect(mocks.invoke.mock.calls.some(([command]) => command === "start_ai_translation"
      || command === "cancel_execution_task" || command === "quiesce_execution" || command === "control_work_plan"
      || command.startsWith("stop_"))).toBe(false);
    expect(editorFixture.saves()).toHaveLength(0);
  });

  it.each(["AI","Arena"] as const)("opens application connection settings from %s preparation and keeps its captured input through a changed current read",async area=>{
    const user=userEvent.setup();await renderApp();await createProject(user);
    if(area==="AI")installAiPreparation();else installArenaPreparation();
    const configs=[1,2].map(number=>({...defaultAiConfig,endpoint:"http://127.0.0.1:4000/v1/chat/completions",model:`Saved ${number}`,credentialEnv:"",
      connectionProfile:{storeId:fixtureIdentity(700),profileId:fixtureIdentity(700+number),revision:"1",digest:String(number).repeat(64)}}));
    let connections=connectionFixture(configs);
    const original=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command:string,args:unknown)=>command==="read_model_connections"?Promise.resolve(structuredClone(connections)):original(command,args));
    await user.click(screen.getByRole("button",{name:area==="AI"?"AI work":"Arena comparison"}));
    const label=area==="AI"?"Saved connection":"Saved connection for scheme 1";
    await waitFor(()=>expect(within(screen.getByRole("combobox",{name:label})).getByRole("option",{name:"Synthetic Saved 1 · Saved 1"})).toBeEnabled());
    await user.selectOptions(screen.getByRole("combobox",{name:label}),configs[0].connectionProfile.profileId);
    if(area==="Arena")await user.selectOptions(screen.getByRole("combobox",{name:"Saved connection for scheme 2"}),configs[1].connectionProfile.profileId);
    await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
    await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
    await screen.findByRole("heading",{name:"Data sharing preview"});
    await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));
    const manage=screen.getAllByRole("button",{name:"Manage saved connections"})[0];await user.click(manage);
    const panel=await screen.findByRole("dialog",{name:"Model connections"});
    expect(within(panel).getByRole("button",{name:"Synthetic Saved 1"})).toBeInTheDocument();
    await user.click(within(panel).getByRole("button",{name:"Close and keep draft"}));
    await waitFor(()=>expect(manage).toHaveFocus());
    expect(screen.getByRole("checkbox",{name:/I confirm sending/})).toBeChecked();
    expect(screen.getByRole("combobox",{name:label})).toHaveValue(configs[0].connectionProfile.profileId);
    const captured=structuredClone(mocks.invoke.mock.calls.find(([command])=>command===(area==="AI"?"prepare_work_plan":"preview_arena_translation"))![1].request);
    const selected=area==="AI"?captured.config:captured.config.variants[0];
    expect(selected.connectionProfile).toEqual(configs[0].connectionProfile);expect(selected.model).toBe("Saved 1");
    connections=structuredClone(connections);connections.snapshot.revision="2";connections.basis.revision="2";
    connections.snapshot.profiles[0].revision="2";connections.snapshot.profiles[0].connection.model="Saved newer";connections.references[0].revision="2";connections.references[0].digest="a".repeat(64);
    await user.click(screen.getAllByRole("button",{name:"Read current connections"})[0]);
    await screen.findByText(/The saved connection changed or is unavailable/);
    expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();
    expect(screen.getByRole("combobox",{name:label})).toHaveValue("captured");
    expect(screen.getByRole("option",{name:"Captured connection · Saved 1"})).toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command])=>["authorize_work_plan","start_work_plan","start_arena_translation","change_model_connections"].includes(command))).toHaveLength(0);
  });

  it.each(["empty", "failed"] as const)("refreshes Overview to %s after a semantic source change and recovers without a mutation", async next => {
    const user = userEvent.setup(), ready: ContentScope = { revision: "1", currentSnapshot: fixtureIdentity(500) };
    let readScope: () => Promise<ContentScope> = async () => ready;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args) => command === "read_content_scope" ? readScope() : original(command, args));
    await renderApp(); await createProject(user);
    const overview = () => within(screen.getByRole("region", { name: i18n.t("workbench.nextStep") }));
    expect(await overview().findByRole("button", { name: i18n.t("workbench.continue") })).toBeEnabled();
    const reads = mocks.reads!;
    let resolve!: (value: ContentScope) => void, reject!: (error: Error) => void;
    readScope = () => new Promise<ContentScope>((yes, no) => { resolve = yes; reject = no; });
    // Synthetic semantic notification, delivered to the real App session Query owner.
    await act(async () => { reads.invalidate(["source"]); });
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_content_scope")).toHaveLength(2));
    expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeDisabled();
    expect(overview().queryByRole("button", { name: i18n.t("workbench.continue") })).not.toBeInTheDocument();
    expect(overview().queryByRole("button", { name: i18n.t("release.title") })).not.toBeInTheDocument();
    await act(async () => {
      if (next === "empty") resolve({ revision: "2", currentSnapshot: null });
      else reject(new Error("Source read unavailable"));
    });
    await waitFor(() => expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeEnabled());
    expect(overview().queryByRole("heading", { name: i18n.t("workbench.continueTitle") })).not.toBeInTheDocument();
    if (next === "failed") {
      expect(overview().getByText(i18n.t("workbench.sourceFailed"))).toBeVisible();
      expect(reads.client.getQueryData(reads.key(sourceKeys.scope))).toEqual(ready);
    } else expect(overview().queryByText(i18n.t("workbench.sourceFailed"))).not.toBeInTheDocument();
    readScope = async () => ({ revision: "3", currentSnapshot: fixtureIdentity(600) });
    await act(async () => { reads.invalidate(["source"]); });
    expect(await overview().findByRole("button", { name: i18n.t("workbench.continue") })).toBeEnabled();
    expect(overview().queryByText(i18n.t("workbench.sourceFailed"))).not.toBeInTheDocument();
    const calls = mocks.invoke.mock.calls.filter(([command]) => command === "read_content_scope");
    expect(calls).toHaveLength(3);
    for (const [, args] of calls) expect(args).toEqual({ request: { projectId: metadata().projectId, sessionToken: "session-1" } });
    const strategyDefaults = mocks.invoke.mock.calls.filter(([command]) => command === "read_context_strategy_default");
    expect(strategyDefaults).toHaveLength(1);
    for (const [, args] of strategyDefaults) expect(args).toEqual({ request: {
      projectId: metadata().projectId, sessionToken: "session-1", locale: "zh-CN",
    } });
    expect(mocks.invoke.mock.calls.every(([command]) => command === "create_project" || command === "read_content_scope"
      || command === "read_execution_task_activity" || command === "read_context_strategy_default")).toBe(true);
    const activity = mocks.invoke.mock.calls.filter(([command]) => command === "read_execution_task_activity");
    expect(activity.length).toBeGreaterThan(0);
    for (const [, args] of activity) expect(args).toEqual({ request: { projectId: metadata().projectId, sessionToken: "session-1", limit: 12 } });
    expect(reads.client.getQueryCache().findAll({ queryKey: reads.key(sourceKeys.scope), exact: true })).toHaveLength(1);
  });

  it("stops Overview reads while hidden and waits for a fresh return and reset instead of cached readiness", async () => {
    const user = userEvent.setup(), ready: ContentScope = { revision: "1", currentSnapshot: fixtureIdentity(500) };
    let readScope: () => Promise<ContentScope> = async () => ready;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args) => {
      if (command === "read_content_scope") return readScope();
      if (command === "execution_status") return Promise.resolve(executionFixture.status);
      if (command === "list_execution_tasks") return Promise.resolve([]);
      return original(command, args);
    });
    await renderApp(); await createProject(user);
    const overview = () => within(screen.getByRole("region", { name: i18n.t("workbench.nextStep") }));
    expect(await overview().findByRole("button", { name: i18n.t("workbench.continue") })).toBeEnabled();
    const reads = mocks.reads!;
    await user.click(screen.getByRole("button", { name: i18n.t("execution.title") }));
    await screen.findByRole("heading", { name: i18n.t("execution.title") });
    expect(reads.client.getQueryCache().find({ queryKey: reads.key(sourceKeys.scope), exact: true })?.getObserversCount()).toBe(0);
    await act(async () => { reads.invalidate(["source"]); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_content_scope")).toHaveLength(1);
    let reject!: (error: Error) => void;
    readScope = () => new Promise<ContentScope>((_, no) => { reject = no; });
    await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("workbench.backOverview") })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: i18n.t("workbench.backOverview") }));
    await waitFor(() => expect(reject).toBeTypeOf("function"));
    expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeDisabled();
    expect(overview().queryByRole("button", { name: i18n.t("workbench.continue") })).not.toBeInTheDocument();
    await act(async () => { reject(new Error("Fresh Overview read unavailable")); });
    expect(await overview().findByText(i18n.t("workbench.sourceFailed"))).toBeVisible();
    expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeEnabled();
    let resolve!: (value: ContentScope) => void;
    readScope = () => new Promise<ContentScope>(yes => { resolve = yes; });
    let reset!: Promise<void>;
    act(() => { reset = reads.client.resetQueries({ queryKey: reads.key(sourceKeys.scope), exact: true }); });
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeDisabled();
    expect(overview().queryByText(i18n.t("workbench.sourceFailed"))).not.toBeInTheDocument();
    await act(async () => { resolve({ revision: "2", currentSnapshot: fixtureIdentity(600) }); await reset; });
    expect(await overview().findByRole("button", { name: i18n.t("workbench.continue") })).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_content_scope")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: i18n.t("execution.title") }));
    await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("workbench.backOverview") })).toBeEnabled());
    let resolveReturn!: (value: ContentScope) => void;
    readScope = () => new Promise<ContentScope>(yes => { resolveReturn = yes; });
    // An ordinary hide/return must also recheck; no source event is sent here.
    await user.click(screen.getByRole("button", { name: i18n.t("workbench.backOverview") }));
    await waitFor(() => expect(resolveReturn).toBeTypeOf("function"));
    expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeDisabled();
    expect(overview().queryByRole("button", { name: i18n.t("workbench.continue") })).not.toBeInTheDocument();
    await act(async () => { resolveReturn({ revision: "3", currentSnapshot: null }); });
    await waitFor(() => expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeEnabled());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_content_scope")).toHaveLength(4);
  });

  it("withdraws cached Overview readiness in the same turn as an exact Query reset", async () => {
    const user = userEvent.setup();
    let readScope: () => Promise<ContentScope> = async () => ({ revision: "1", currentSnapshot: fixtureIdentity(500) });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args) => command === "read_content_scope" ? readScope() : original(command, args));
    await renderApp(); await createProject(user);
    const overview = () => within(screen.getByRole("region", { name: i18n.t("workbench.nextStep") }));
    expect(await overview().findByRole("button", { name: i18n.t("workbench.continue") })).toBeEnabled();
    const reads = mocks.reads!;
    let resolve!: (value: ContentScope) => void;
    readScope = () => new Promise<ContentScope>(yes => { resolve = yes; });
    let reset!: Promise<void>;
    act(() => { reset = reads.client.resetQueries({ queryKey: reads.key(sourceKeys.scope), exact: true }); });
    expect(resolve).toBeTypeOf("function");
    expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeDisabled();
    expect(overview().queryByRole("button", { name: i18n.t("workbench.continue") })).not.toBeInTheDocument();
    expect(overview().queryByRole("button", { name: i18n.t("release.title") })).not.toBeInTheDocument();
    await act(async () => { resolve({ revision: "2", currentSnapshot: null }); await reset; });
    await waitFor(() => expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeEnabled());
    expect(overview().queryByRole("button", { name: i18n.t("workbench.continue") })).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_content_scope")).toHaveLength(2);
  });

  it.each(["success", "failure"] as const)("ignores another project session's late Overview %s after an actual project replacement", async outcome => {
    const user = userEvent.setup(), originalProject = projectView();
    const otherProject = { ...projectView("Other"), sessionToken: "session-2", locator: "C:\\Projects\\other",
      metadata: { ...metadata("Other"), projectId: fixtureIdentity(900) } };
    let resolveOld!: (value: ContentScope) => void, rejectOld!: (error: Error) => void;
    const oldRead = new Promise<ContentScope>((yes, no) => { resolveOld = yes; rejectOld = no; });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: { request: { sessionToken: string } }) => {
      if (command === "read_content_scope") return args.request.sessionToken === "session-1" ? oldRead
        : Promise.resolve({ revision: "2", currentSnapshot: null } satisfies ContentScope);
      if (command === "open_project") return Promise.resolve(otherProject);
      return original(command, args);
    });
    await renderApp(); await createProject(user);
    const overview = () => within(screen.getByRole("region", { name: i18n.t("workbench.nextStep") }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("read_content_scope", {
      request: { projectId: originalProject.metadata.projectId, sessionToken: originalProject.sessionToken },
    }));
    expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open another" }));
    await user.type(screen.getByRole("textbox", { name: /Project folder/ }), otherProject.locator);
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findByRole("heading", { name: "Other" });
    await waitFor(() => expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeEnabled());
    const reads = mocks.reads!;
    await act(async () => {
      // A foreign exact key cannot provide the current project's presentation either.
      reads.client.setQueryData([originalProject.metadata.projectId, originalProject.sessionToken, ...sourceKeys.scope],
        { revision: "3", currentSnapshot: fixtureIdentity(500) } satisfies ContentScope);
      if (outcome === "success") resolveOld({ revision: "3", currentSnapshot: fixtureIdentity(500) });
      else rejectOld(new Error("Previous project's source read failed"));
    });
    expect(reads.context).toEqual({ projectId: otherProject.metadata.projectId, sessionToken: otherProject.sessionToken });
    expect(overview().getByRole("heading", { name: i18n.t("workbench.importTitle") })).toBeVisible();
    expect(overview().getByRole("button", { name: i18n.t("workbench.import") })).toBeEnabled();
    expect(overview().queryByRole("button", { name: i18n.t("workbench.continue") })).not.toBeInTheDocument();
    expect(overview().queryByText(i18n.t("workbench.sourceFailed"))).not.toBeInTheDocument();
    expect(reads.client.getQueryData(reads.key(sourceKeys.scope))).toEqual({ revision: "2", currentSnapshot: null });
    expect(mocks.invoke).toHaveBeenCalledWith("read_content_scope", {
      request: { projectId: otherProject.metadata.projectId, sessionToken: otherProject.sessionToken },
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_project")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(0);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("routes metadata reconciliation through the exact original Registry capture and refuses other scopes and payloads", async () => {
    const { user, payload, scope, commands, view } = await prepareUnknownMetadata({ directory: true, strict: true });
    expect(commands.describe("project.metadata.reconcile", scope, payload)).toMatchObject({
      nameKey: "action.retry", category: "project", binding: null, risk: "reconciles-project", confirmation: "none", availability: { enabled: true },
    });
    const reads = () => mocks.invoke.mock.calls.filter(([command]) => command === "read_project");
    const changed: ProjectMetadataReconcileCommandPayload[] = [
      { ...payload, previous: { ...payload.previous, sessionToken: "other-session" } },
      { ...payload, previous: { ...payload.previous, metadata: { ...payload.previous.metadata, projectId: fixtureIdentity(990) } } },
      { ...payload, previous: { ...payload.previous, locator: "C:\\Projects\\other" } },
      { ...payload, previous: { ...payload.previous, metadata: { ...payload.previous.metadata, targetLocales: ["fr"] } } },
      { ...payload, previous: { ...payload.previous, reconciliationState: "committed" } },
      { ...payload, form: { ...payload.form, kind: "target" } },
      { ...payload, form: { ...payload.form, expectedRevision: "2" } },
      { ...payload, value: "Another request" }, { ...payload, directoryName: null },
    ];
    changed.forEach(value => {
      expect(commands.describe("project.metadata.reconcile", scope, value)?.availability.enabled).toBe(false);
      expect(commands.dispatch("project.metadata.reconcile", scope, value)).toBe(false);
    });
    expect(commands.dispatch("project.metadata.reconcile", { ...scope, sessionToken: "other-session" }, payload)).toBe(false);
    expect(commands.dispatch("project.metadata.reconcile", { ...scope, projectId: fixtureIdentity(990) }, payload)).toBe(false);
    expect(commands.dispatch("project.metadata.reconcile", { ...scope, area: "tasks" }, payload)).toBe(false);
    expect(reads()).toHaveLength(1);
    const dispatch = vi.spyOn(commands, "dispatch");
    mocks.invoke.mockImplementation(async (command: string) => command === "read_project"
      ? { ...projectView("Captured A", "2", "committed"), locator: "C:\\Projects\\Captured A" } : projectView());
    await user.click(screen.getByRole("button", { name: "Retry read" }));
    await screen.findByText("The change was confirmed.");
    expect(dispatch).toHaveBeenCalledWith("project.metadata.reconcile", scope, payload);
    expect(reads()).toHaveLength(2);
    expect(reads().map(([, args]) => args.request)).toEqual([
      { sessionToken: "session-1", expectedRevision: "1" }, { sessionToken: "session-1", expectedRevision: "1" },
    ]);
    expect(commands.describe("project.metadata.reconcile", scope, payload)?.availability).toEqual({ enabled: false, reason: "hidden" });
    expect(commands.dispatch("project.metadata.reconcile", scope, payload)).toBe(false);
    view.unmount();
    expect(commands.describe("project.metadata.reconcile", scope, payload)).toBeUndefined();
    expect(commands.dispatch("project.metadata.reconcile", scope, payload)).toBe(false);
    expect(reads()).toHaveLength(2);
  });

  it.each(["text", "checkbox", "both"] as const)("settles the original metadata read once and retains newer %s edits as dirty against the confirmed basis", async change => {
    const { user, payload, scope, commands } = await prepareUnknownMetadata({ directory: true });
    let resolveRead!: (value: ProjectView) => void;
    mocks.invoke.mockImplementation((command: string) => command === "read_project"
      ? new Promise<ProjectView>(resolve => { resolveRead = resolve; }) : Promise.resolve(projectView()));
    act(() => {
      expect(commands.dispatch("project.metadata.reconcile", scope, payload)).toBe(true);
      expect(commands.dispatch("project.metadata.reconcile", scope, payload)).toBe(false);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry read" })).toBeDisabled());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_project")).toHaveLength(2);
    const text = screen.getByRole("textbox", { name: "Project name" });
    const checkbox = screen.getByRole("checkbox", { name: "Also rename the project folder" });
    expect(text).toBeEnabled(); expect(checkbox).toBeEnabled();
    expect(screen.getByRole("button", { name: i18n.t("editor.save") })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close project" })).toBeDisabled();
    const newerText = change === "checkbox" ? "Captured A" : "Newer B";
    if (change !== "checkbox") { await user.clear(text); await user.type(text, newerText); }
    if (change !== "text") await user.click(checkbox);
    await act(async () => resolveRead({ ...projectView("Captured A", "2", "committed"), locator: "C:\\Projects\\Captured A" }));
    await screen.findByText("The original change was confirmed. Your newer edits remain unsaved.");
    expect(text).toHaveValue(newerText); expect(checkbox).toHaveProperty("checked", change === "text");
    expect(screen.getByText(i18n.t("editor.basis", { revision: "2" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(1);
    expect(readRecentProjects().map(row => row.locator)).toEqual(["C:\\Projects\\Captured A"]);
    mocks.invoke.mockImplementation(async (command: string) => command === "rename_project"
      ? { ...projectView(newerText, change === "checkbox" ? "2" : "3"), locator: change === "text" ? "C:\\Projects\\Newer B" : "C:\\Projects\\Captured A",
        outcome: change === "checkbox" ? "unchanged" : "changed", directoryChanged: change === "text" } : projectView());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(2));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project").at(-1)?.[1].request).toEqual({
      sessionToken: "session-1", expectedRevision: "2", displayName: newerText,
      ...(change === "text" ? { directoryName: newerText } : {}),
    });
  });

  it("retains the original metadata request and newer input across unknown and failed reads until explicit previous-state confirmation", async () => {
    const { user, payload, scope, commands } = await prepareUnknownMetadata();
    const text = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(text); await user.type(text, "Newer B");
    let reads = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== "read_project") return projectView();
      reads++;
      if (reads === 1) return projectView("Unrelated", "3");
      if (reads === 2) throw new Error("Read result lost again");
      return projectView("Demo", "1", "previous");
    });
    for (let index = 0; index < 3; index++) {
      await waitFor(() => expect(screen.getByRole("button", { name: "Retry read" })).toBeEnabled());
      expect(commands.describe("project.metadata.reconcile", scope, payload)?.availability.enabled).toBe(true);
      await user.click(screen.getByRole("button", { name: "Retry read" }));
      if (index < 2) {
        await screen.findByText(index === 0 ? i18n.t("feedback.unknown") : i18n.t("feedback.reconcileFailed"));
        expect(text).toHaveValue("Newer B"); expect(screen.getByRole("button", { name: i18n.t("editor.save") })).toBeDisabled();
        expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
      }
    }
    await screen.findByText("The uncertain save was not committed. Your draft remains here.");
    expect(text).toHaveValue("Newer B"); expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(commands.dispatch("project.metadata.reconcile", scope, payload)).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_project").map(([, args]) => args.request))
      .toEqual(Array.from({ length: 4 }, () => ({ sessionToken: "session-1", expectedRevision: "1" })));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(1);
  });

  it("preserves a newer raw target-language draft when the original canonicalized change is confirmed and keeps presets locked during the read", async () => {
    const { user, payload, scope, commands } = await prepareUnknownMetadata({ target: true });
    let resolveRead!: (value: ProjectView) => void;
    mocks.invoke.mockImplementation((command: string) => command === "read_project"
      ? new Promise<ProjectView>(resolve => { resolveRead = resolve; }) : Promise.resolve(projectView()));
    act(() => { expect(commands.dispatch("project.metadata.reconcile", scope, payload)).toBe(true); });
    const field = screen.getByRole("textbox", { name: "Target locales" });
    expect(field).toBeEnabled();
    expect(screen.getByRole("combobox", { name: i18n.t("editor.targetPreset") })).toBeDisabled();
    await user.clear(field); await user.type(field, "iw, fr");
    await act(async () => resolveRead({ ...projectView("Demo", "2", "committed"), metadata: { ...metadata("Demo", "2"), targetLocales: ["he"] } }));
    await screen.findByText("The original change was confirmed. Your newer edits remain unsaved.");
    expect(field).toHaveValue("iw, fr");
    expect(screen.getByText(i18n.t("editor.basis", { revision: "2" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_target_locales").map(([, args]) => args.request))
      .toEqual([{ sessionToken: "session-1", expectedRevision: "1", targetLocales: ["iw"] }]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_project").map(([, args]) => args.request))
      .toEqual([{ sessionToken: "session-1", expectedRevision: "1" }, { sessionToken: "session-1", expectedRevision: "1" }]);
  });

  it("keeps a save-and-continue metadata recovery open when a delayed confirmation settles A after newer B", async () => {
    const { user } = await prepareUnknownMetadata({ navigation: true });
    let resolveRead!: (value: ProjectView) => void;
    mocks.invoke.mockImplementation((command: string) => command === "read_project"
      ? new Promise<ProjectView>(resolve => { resolveRead = resolve; }) : Promise.resolve(projectView()));
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Retry read" }));
    // Model a queued editor event while the modal owns focus; ordinary recovery
    // editing above is exercised through real user input outside this dialog.
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Queued B" } });
    await act(async () => resolveRead(projectView("Captured A", "2", "committed")));
    await waitFor(() => expect(dialog.getByRole("button", { name: "Save and continue" })).toBeEnabled());
    expect(dialog.getByText("The original change was confirmed. Your newer edits remain unsaved.")).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Queued B");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(0);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("disposes metadata recovery on App replacement and ignores its old-session late result and recent-location update", async () => {
    const { view, payload, scope, commands } = await prepareUnknownMetadata({ directory: true });
    let resolveRead!: (value: ProjectView) => void;
    mocks.invoke.mockImplementation((command: string) => command === "read_project"
      ? new Promise<ProjectView>(resolve => { resolveRead = resolve; }) : Promise.resolve(projectView()));
    act(() => { expect(commands.dispatch("project.metadata.reconcile", scope, payload)).toBe(true); });
    view.unmount();
    expect(commands.dispatch("project.metadata.reconcile", scope, payload)).toBe(false);
    localStorage.clear();
    const replacement = { ...projectView(), sessionToken: "session-2", locator: "C:\\Projects\\second",
      metadata: { ...metadata(), projectId: fixtureIdentity(990) } };
    mocks.join.mockResolvedValue(replacement.locator);
    mocks.invoke.mockImplementation(async () => replacement);
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.type(screen.getByRole("textbox", { name: "Project name" }), " replacement draft");
    const recents = readRecentProjects();
    await act(async () => resolveRead({ ...projectView("Captured A", "2", "committed"), locator: "C:\\Projects\\Captured A" }));
    expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Demo replacement draft");
    expect(readRecentProjects()).toEqual(recents);
    expect(metadataRegistry().dispatch("project.metadata.reconcile", scope, payload)).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_project")).toHaveLength(2);
  });

  it("settles a same-session open acknowledgement while preserving metadata entered during the RPC", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: "Project name" });
    await user.click(screen.getByRole("button", { name: "Open another" }));
    await user.type(screen.getByRole("textbox", { name: /Project folder/ }), "C:\\Projects\\alias");
    const original = mocks.invoke.getMockImplementation()!;
    let finish!: (view: ProjectView) => void;
    mocks.invoke.mockImplementation((command: string, args) => command === "open_project"
      ? new Promise<ProjectView>(resolve => { finish = resolve; }) : original(command, args));
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(nameInput, { target: { value: "Newer metadata" } });
    const acknowledged = { ...projectView("Confirmed name", "2"), locator: "C:\\Projects\\canonical-demo" };
    await act(async () => finish(acknowledged));
    await screen.findByRole("heading", { name: "Confirmed name" });
    expect(nameInput).toHaveValue("Newer metadata"); expect(nameInput).toBeEnabled();
    expect(readRecentProjects()[0].locator).toBe(acknowledged.locator);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_project")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(0);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
  it("settles a same-session open acknowledgement without clearing a late original owner draft", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); installTranslationEditor();
    const owner = mocks.drafts.get("session-1"); if (!owner) throw new Error("No translation owner");
    await user.click(screen.getByRole("button", { name: "Open another" }));
    await user.type(screen.getByRole("textbox", { name: /Project folder/ }), "C:\\Projects\\alias");
    const original = mocks.invoke.getMockImplementation()!;
    let finish!: (view: ProjectView) => void;
    mocks.invoke.mockImplementation((command: string, args) => command === "open_project"
      ? new Promise<ProjectView>(resolve => { finish = resolve; }) : original(command, args));
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => {
      expect(owner.begin({ unitId: fixtureIdentity(501), locale: "zh-CN", sourceRevisionId: fixtureIdentity(502), key: "first", sourceText: "Hello" }, null, null)).toBe(true);
      owner.edit("Late original draft");
    });
    await act(async () => finish(projectView("Confirmed name", "2")));
    await screen.findByRole("heading", { name: "Confirmed name" });
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Late original draft");
    expect(owner.current()?.text).toBe("Late original draft");
    expect(screen.getByRole("button", { name: "Find content" })).toBeEnabled();
    expect(mocks.drafts.get("session-1")?.current()?.text).toBe("Late original draft");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_project")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision")).toHaveLength(0);
  });
  it.each(["open", "close"] as const)("settles a deferred %s acknowledgement and retains newer metadata without permitting another lifecycle RPC", async kind => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Project name" });
    const replacement = { ...projectView("Other"), sessionToken: "session-2", locator: "C:\\Projects\\other",
      metadata: { ...metadata("Other"), projectId: fixtureIdentity(900) } };
    const original = mocks.invoke.getMockImplementation()!;
    let finish!: (value: ProjectView | { closed: boolean }) => void;
    mocks.invoke.mockImplementation((command: string, args) => command === `${kind}_project`
      ? new Promise<ProjectView | { closed: boolean }>(resolve => { finish = resolve; }) : original(command, args));
    let nativeRequest: Promise<void> | undefined;
    if (kind === "open") {
      await user.click(screen.getByRole("button", { name: "Open another" }));
      await user.type(screen.getByRole("textbox", { name: /Project folder/ }), replacement.locator);
      await user.click(screen.getByRole("button", { name: "Open project" }));
    } else {
      const nativeClose = mocks.onCloseRequested.mock.calls.at(-1)?.[0]; if (!nativeClose) throw new Error("No native close handler");
      await act(async () => { nativeRequest = nativeClose({ preventDefault: vi.fn() }); });
    }
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(input, { target: { value: "Metadata after dispatch" } });
    await act(async () => { finish(kind === "open" ? replacement : { closed: true }); await nativeRequest; });
    await screen.findByRole("heading", { name: kind === "open" ? "Other" : "No project open" });
    const retained = screen.getByRole("textbox", { name: "Project name" });
    expect(retained).toHaveValue("Metadata after dispatch"); expect(retained).toHaveAttribute("readonly");
    expect(mocks.drafts.has("session-2")).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === `${kind}_project`)).toHaveLength(1);
    if (kind === "close") expect(mocks.invoke).toHaveBeenCalledWith("close_project", { request: { sessionToken: "session-1" } });
    await user.keyboard("{Control>}s{/Control}");
    await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === `${kind}_project`)).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(0);
    expect(mocks.destroy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: i18n.t("workbench.retiredDraftDiscard") }));
    expect(screen.queryByDisplayValue("Metadata after dispatch")).not.toBeInTheDocument();
    if (kind === "open") {
      await waitFor(() => expect(mocks.drafts.get("session-2")).toBeDefined());
      await user.click(screen.getByRole("button", { name: "Rename" }));
      expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Other");
    } else {
      await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
      expect(mocks.destroy).toHaveBeenCalledOnce();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(1);
    }
  });
  it.each(["open", "close"] as const)("settles a deferred %s acknowledgement while preserving and retiring the original owner", async kind => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); installTranslationEditor();
    const owner = mocks.drafts.get("session-1"); if (!owner) throw new Error("No translation owner");
    const replacement = { ...projectView("Other"), sessionToken: "session-2", locator: "C:\\Projects\\other",
      metadata: { ...metadata("Other"), projectId: fixtureIdentity(900) } };
    const original = mocks.invoke.getMockImplementation()!;
    let finish!: (value: ProjectView | { closed: boolean }) => void;
    mocks.invoke.mockImplementation((command: string, args) => command === `${kind}_project`
      ? new Promise<ProjectView | { closed: boolean }>(resolve => { finish = resolve; }) : original(command, args));
    let nativeRequest: Promise<void> | undefined;
    if (kind === "open") {
      await user.click(screen.getByRole("button", { name: "Open another" }));
      await user.type(screen.getByRole("textbox", { name: /Project folder/ }), replacement.locator);
      await user.click(screen.getByRole("button", { name: "Open project" }));
    } else {
      const nativeClose = mocks.onCloseRequested.mock.calls.at(-1)?.[0]; if (!nativeClose) throw new Error("No native close handler");
      await act(async () => { nativeRequest = nativeClose({ preventDefault: vi.fn() }); });
    }
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => {
      expect(owner.begin({ unitId: fixtureIdentity(501), locale: "zh-CN", sourceRevisionId: fixtureIdentity(502), key: "first", sourceText: "Hello" }, null, null)).toBe(true);
      owner.edit("Late original draft");
    });
    const originalDraft = structuredClone(owner.current());
    await act(async () => { finish(kind === "open" ? replacement : { closed: true }); await nativeRequest; });
    await screen.findByRole("heading", { name: kind === "open" ? "Other" : "No project open" });
    const recovery = screen.getByRole("textbox", { name: i18n.t("workbench.retiredDraftData") });
    expect(recovery).toHaveAttribute("readonly");
    if (kind === "open") {
      expect(screen.getByRole("button", { name: "Find content" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "View background tasks" })).toBeDisabled();
    } else {
      expect(screen.queryByRole("button", { name: "Find content" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "View background tasks" })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();
    if (!(recovery instanceof HTMLTextAreaElement)) throw new Error("Recovery details must be copyable text");
    const preserved = JSON.parse(recovery.value);
    expect(preserved.translation).toEqual(originalDraft);
    expect(preserved.translation).toMatchObject({ unitId: fixtureIdentity(501), locale: "zh-CN", sourceRevisionId: fixtureIdentity(502),
      key: "first", sourceText: "Hello", text: "Late original draft", baseSelectionId: null, baseRevisionId: null,
      baseText: null, pending: null, pendingSelection: null });
    expect(mocks.reads?.context).toMatchObject({ projectId: metadata().projectId, sessionToken: "session-1" });
    expect(owner.current()?.text).toBe("Late original draft");
    expect(mocks.drafts.get("session-1")?.current()?.text).toBe("Late original draft");
    expect(mocks.drafts.has("session-2")).toBe(false);
    await act(async () => { expect((await owner.save()).saved).toBe(false); });
    await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === `${kind}_project`)).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision" || command === "create_execution_identity")).toHaveLength(0);
    expect(mocks.destroy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: i18n.t("workbench.retiredDraftDiscard") }));
    expect(recovery).not.toBeInTheDocument();
    await act(async () => { expect((await owner.save()).saved).toBe(false); });
    if (kind === "open") {
      await waitFor(() => expect(mocks.drafts.get("session-2")).toBeDefined());
      expect(mocks.drafts.get("session-2")?.current()).toBeNull();
    }
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision" || command === "create_execution_identity")).toHaveLength(0);
  });
  it("opens a fixed source-impact destination before the translation consumer exists and releases the source consumer", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); installTranslationEditor();
    const original = mocks.invoke.getMockImplementation()!, base = sourceImpactFixture();
    mocks.invoke.mockImplementation((command: string, args) => {
      if (command === "read_plugin_inventory") return Promise.resolve(pluginSourceInventory);
      if (command === "read_plugin_package") return Promise.resolve(pluginSourcePackage);
      if (command === "read_plugin_source") return Promise.resolve(pluginSourceView);
      if (command === "read_source_impact") return Promise.resolve(sourceImpactFixture({ snapshotId: fixtureIdentity(500), rows: base.rows.map(row => ({ ...row,
        current: { ...row.current, unitId: fixtureIdentity(501), sourceRevisionId: fixtureIdentity(502), occurrence: sourceRowFixture({}, { ...row.current.occurrence, key: "first", text: "Hello" }).occurrence } })) }));
      return original(command, args);
    });
    await user.click(screen.getByRole("button", { name: i18n.t("source.title") }));
    await user.click(await screen.findByRole("button", { name: "Edit this key" }));
    expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("");
    expect(mocks.invoke).toHaveBeenCalledWith("read_review_editor_snapshot", { request: {
      projectId: projectView().metadata.projectId, sessionToken: "session-1", unitId: fixtureIdentity(501), locale: "zh-CN",
    } });
    const reads = mocks.reads; if (!reads) throw new Error("No project reads");
    expect(reads.client.getQueryCache().find({ queryKey: reads.key(["source-scope"]), exact: true })?.getObserversCount()).toBe(0);
    await editableDraft();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision")).toHaveLength(0);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_work_protection").map(([, args]) => args.request)).toEqual([{
      projectId: metadata().projectId, sessionToken: "session-1", unitId: fixtureIdentity(501), locale: "zh-CN",
      sourceRevisionId: fixtureIdentity(502), selectionId: null, expectedRevision: "0", actionId: fixtureIdentity(2), protected: true, confirmedRelease: false,
    }]);
    expect(mocks.invoke.mock.calls.findIndex(([command]) => command === "read_work_protection"))
      .toBeLessThan(mocks.invoke.mock.calls.findIndex(([command]) => command === "set_work_protection"));
  });
  it("unmounts the actual hidden translation consumer, releases its query observer, and restores its scoped inputs", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const fixture = installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    const editor = await editableDraft();
    await user.type(editor, "A");
    await user.click(screen.getByText("Find and range actions", { exact: true }));
    await user.type(screen.getByRole("textbox", { name: "Find by key, source or translation" }), "retained range");
    let finish!: () => void;
    fixture.setSave(async (_request, commit) => { await new Promise<void>(resolve => { finish = resolve; }); return commit(); });
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await user.type(editor, "B");
    const reads = mocks.reads; if (!reads) throw new Error("The App session reads were not captured");
    const query = reads.client.getQueryCache().find({ queryKey: reads.key(["translation-source-content", "2", fixtureIdentity(500), 0, 1]), exact: true });
    expect(query?.getObserversCount()).toBe(1);
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    expect(query?.getObserversCount()).toBe(0);
    await act(async () => finish());
    await user.keyboard("{Control>}s{/Control}");
    expect(fixture.saves()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("AB");
    expect(screen.getByRole("textbox", { name: "Find by key, source or translation" })).toHaveValue("retained range");
    await waitFor(() => expect(query?.getObserversCount()).toBe(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(fixture.saves()).toHaveLength(2));
    expect(fixture.saves()[0][1].request).toMatchObject({ text: "A", unitId: fixtureIdentity(501), locale: "zh-CN" });
    expect(fixture.saves()[1][1].request).toMatchObject({ text: "AB", expectedSelectionId: fixtureIdentity(503) });
    expect(fixture.protections()).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(3);
  });
  it("blocks both project replacement and native close on a hidden original unknown save without allocating another action", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); const fixture = installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
    await user.type(await editableDraft(), "Original request");
    fixture.setSave(async () => { throw { code: "outcome-unknown", outcome: "unknown", stage: "save", recoveryRequired: true }; });
    await user.click(screen.getByRole("button", { name: "Save revision" })); await screen.findByRole("button", { name: "Retry the same action" });
    const original = structuredClone(fixture.saves()[0][1].request);
    const identities = mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity").length;
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    await user.click(screen.getByRole("button", { name: "Open another" }));
    await user.type(screen.getByRole("textbox", { name: /Project folder/ }), "C:\\Projects\\other");
    await user.click(screen.getByRole("button", { name: "Open project" }));
    expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Original request");
    expect(screen.getByText(i18n.t("workbench.exitBlocked"))).toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_project")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    const nativeClose = mocks.onCloseRequested.mock.calls.at(-1)?.[0]; if (!nativeClose) throw new Error("No native close handler");
    await act(async () => { await nativeClose({ preventDefault: vi.fn() }); });
    await screen.findByRole("button", { name: "Retry the same action" });
    expect(screen.getByText(i18n.t("workbench.exitBlocked"))).toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(0);
    expect(mocks.destroy).not.toHaveBeenCalled(); expect(fixture.saves()).toHaveLength(1);
    expect(fixture.saves()[0][1].request).toEqual(original);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(identities);
    expect(fixture.protections()).toHaveLength(1);
    expect(identities).toBe(2);
  });
  it("keeps newer input after an explicit save-and-exit and permits a fresh exit intent after cancellation", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); const fixture = installTranslationEditor();
    const originalInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args) => command === "close_project" ? Promise.resolve({ closed: true }) : originalInvoke(command, args));
    await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
    await user.type(await editableDraft(), "A");
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close project" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Close project" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave with an unsaved translation?" });
    let finish!: () => void;
    fixture.setSave(async (_request, commit) => { await new Promise<void>(resolve => { finish = resolve; }); return commit(); });
    await user.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("Your draft"), { target: { value: "B" } });
    await act(async () => finish());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(0);
    expect(screen.getByLabelText("Your draft")).toHaveValue("B");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Keep editing" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Project overview" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close project" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Close project" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Leave with an unsaved translation?" })).getByRole("button", { name: "Discard draft and continue" }));
    await screen.findByRole("heading", { name: "No project open" });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(1);
  });
  it("assembles the existing shared translation reservation above Tasks and settles the original application through real App navigation", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const original = mocks.invoke.getMockImplementation()!;
    const projectId = metadata().projectId, detail: AttemptDetail = structuredClone(executionFixture.detail) as AttemptDetail;
    Object.assign(detail.items[0].status, { execution: "succeeded", validation: "valid", cancellationRequested: false });
    detail.items[0].resultId = executionFixture.prepare.resultIds[0];
    Object.assign(detail.progress, { succeeded: 1, unknown: 0 });
    Object.assign(detail.recovery.units[0], { actions: ["adopt-result"], resultIds: [...executionFixture.prepare.resultIds], remainingItemIds: [], blockedReason: null });
    const receipt = { ...executionFixture.receipt, projectId };
    const action = { ...executionFixture.action, projectId, parameters: null };
    let adoptionReads = 0;
    mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
      if (command === "execution_status") return executionFixture.status;
      if (command === "list_execution_tasks") return [{ ...executionFixture.task, projectId, sequence: "1" }];
      if (command === "read_execution_task") return [executionFixture.summary];
      if (command === "read_execution_task_view") return { ...executionFixture.task, projectId };
      if (command === "read_execution_continuations") return { receipts: [], next: null };
      if (command === "read_execution_attempt") return detail;
      if (command === "create_execution_identity") return executionFixture.prepare.actionId;
      if (command === "prepare_execution_adoption") return { ...executionFixture.action, projectId, parameters: null };
      if (command === "adopt_execution") throw new Error("Original application ACK lost");
      if (command === "read_execution_adoption_action") {
        expect(args.request).toEqual({ ...executionFixture.prepare, projectId });
        if (++adoptionReads === 1) throw new Error("Original application lookup ACK lost");
        return { action, receipt };
      }
      if (command === "read_execution_receipt") return receipt;
      return original(command, args);
    });
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await user.click(await screen.findByRole("button", { name: /Sample update/ }));
    await user.click(await screen.findByRole("button", { name: "Apply saved results" }));
    await user.click(within(screen.getByRole("dialog", { name: "Apply saved results" })).getByRole("button", { name: "Apply saved results" }));
    await screen.findByText(i18n.t("execution.adoptionUnknown"));
    await user.click(screen.getByRole("button", { name: "Keep output and return" }));
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await user.click(screen.getByRole("button", { name: "Close project" }));
    await screen.findByText(i18n.t("execution.adoptionUnknown"));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Check recorded outcome" }));
    await screen.findByRole("heading", { name: "Recorded changes" });
    expect(adoptionReads).toBe(2);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "prepare_execution_adoption").map(([, payload]) => payload.request))
      .toEqual([{ ...executionFixture.prepare, projectId }]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "adopt_execution").map(([, payload]) => payload.request))
      .toEqual([{ ...executionFixture.adopt, projectId }]);
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await user.click(screen.getByRole("button", { name: "Close project" }));
    await screen.findByRole("heading", { name: "No project open" });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
  });
  function installReleasePreparation() {
    const original = mocks.invoke.getMockImplementation()!;
    let captured: PluginBuildPrepareRequest | null = null;
    mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
      if (command === "read_plugin_inventory") return pluginBuildInventory;
      if (command === "read_plugin_package") return pluginBuildPackage;
      if (command === "read_plugin_build") return pluginBuildView;
      if (command === "read_content_scope") return { revision: "1", currentSnapshot: releaseFixture.responses.releases[0].sourceSnapshotId };
      if (command === "read_review_eligibility") return { ready: true, basis: pluginBuildWorkflow.prepare.expectedEligibilityBasis,
        policyVersion: "balanced-1", sourceSnapshotId: releaseFixture.responses.releases[0].sourceSnapshotId,
        locales: [{ locale: "zh-CN", ready: true, blockers: [], exceptions: [], checkedUnits: 2, blockerCount: 0, exceptionCount: 0 }] };
      if (command === "list_releases" || command === "list_execution_tasks") return [];
      if (command === "execution_status") return { active: false, quiescing: false, queryCount: 0, error: null };
      if (command === "create_execution_identity") return fixtureIdentity(700 + mocks.invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length);
      if (command === "prepare_plugin_build") {
        if (!validateRequestPluginBuild(args.request)) throw new Error("Invalid fixed plugin build request");
        captured = structuredClone(args.request);
        return { ...pluginBuildWorkflow.review, attemptId: captured.attemptId, choices: captured.choices, build: pluginBuildView,
          sourceSnapshotId: releaseFixture.responses.releases[0].sourceSnapshotId, eligibilityBasis: captured.expectedEligibilityBasis };
      }
      if (command === "start_plugin_build") return args.request.attemptId;
      if (command === "cancel_plugin_build_preparation") return true;
      if (command === "read_execution_attempt") {
        if (!captured || args.request.attemptId !== captured.attemptId) throw new Error("No exact captured build attempt");
        const status = { ...executionFixture.detail.items[0].status, execution: "succeeded" as const, validation: "pending" as const,
          cancellationRequested: false, diagnostic: null };
        return { ...executionFixture.detail, attemptId: captured.attemptId, operation: "locale-build",
          progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
          items: [{ scope: { kind: "release-build", id: releaseFixture.responses.releases[0].sourceSnapshotId, locale: "zh-CN" }, status, resultId: executionFixture.prepare.resultIds[0] }],
          recovery: { attemptId: captured.attemptId, units: [] } };
      }
      return original(command, args);
    });
  }
  async function prepareReleaseInApp(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Build and export" }));
    await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
    await user.type(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) }), "deliverables/zh-CN.json");
    await user.click(screen.getByRole("button", { name: "Check build readiness" }));
    await screen.findByText(i18n.t("release.ready", { count: 0 }));
  }
  it("retains release preparation through registered navigation and asks before discarding it on project close", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); installReleasePreparation();
    await prepareReleaseInApp(user);
    const name = screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) });
    await user.clear(name); await user.type(name, "my-file.json");
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.queryByRole("dialog", { name: i18n.t("release.unsaved") })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Build and export" }));
    expect(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) })).toHaveValue("my-file.json");
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await user.click(screen.getByRole("button", { name: "Close project" }));
    let dialog = await screen.findByRole("dialog", { name: i18n.t("release.unsaved") });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: i18n.t("source.keep") }));
    expect(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) })).toHaveValue("my-file.json");
    await user.click(screen.getByRole("button", { name: "Back to overview" })); await user.click(screen.getByRole("button", { name: "Close project" }));
    dialog = await screen.findByRole("dialog", { name: i18n.t("release.unsaved") });
    await user.click(within(dialog).getByRole("button", { name: i18n.t("source.leave") }));
    await screen.findByRole("heading", { name: "No project open" });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_plugin_build")).toHaveLength(0);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "prepare_plugin_build" || command === "create_execution_identity")).toHaveLength(0);
  });
  it("keeps an unknown build recoverable across real App navigation and blocks project close until exact confirmation", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user); installReleasePreparation();
    await prepareReleaseInApp(user);
    await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.capture") }));
    await screen.findByText(i18n.t("releasePlugin.fixedBuild"));
    const consent = screen.getByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") });
    expect(consent).not.toBeChecked();
    expect(screen.getByRole("button", { name: i18n.t("release.build") })).toBeDisabled();
    await user.click(consent);
    const original = mocks.invoke.getMockImplementation()!;
    let lost = true, startReads = 0;
    mocks.invoke.mockImplementation((command: string, args) => {
      if (command === "start_plugin_build" && lost) { lost = false; return Promise.reject(new Error("Lost build ACK")); }
      if (command === "read_plugin_execution_start") {
        if (++startReads === 1) return Promise.reject(new Error("Lost original start lookup ACK"));
        return Promise.resolve(null);
      }
      return original(command, args);
    });
    await user.click(screen.getByRole("button", { name: i18n.t("release.build") })); await screen.findByText(i18n.t("releasePlugin.unknown"));
    const request = structuredClone(mocks.invoke.mock.calls.find(([command]) => command === "start_plugin_build")![1]);
    const identities = mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity").length;
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByRole("region", { name: "Tasks" });
    await user.click(screen.getByRole("button", { name: "Back to overview" })); await user.click(screen.getByRole("button", { name: "Close project" }));
    await screen.findByText(i18n.t("releasePlugin.unknown"));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: i18n.t("execution.checkPluginStart") }));
    await screen.findByText(i18n.t("execution.pluginStartMissing"));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_plugin_execution_start").map(([, args]) => args.request)).toEqual([
      { projectId: metadata().projectId, sessionToken: "session-1", attemptId: request.request.attemptId,
        inputDigest: request.request.inputDigest, operation: "locale-build" },
      { projectId: metadata().projectId, sessionToken: "session-1", attemptId: request.request.attemptId,
        inputDigest: request.request.inputDigest, operation: "locale-build" },
    ]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_plugin_build").map(([, args]) => args)).toEqual([request]);
    await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("execution.retryPluginStart") })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await user.click(screen.getByRole("button", { name: "Close project" }));
    await screen.findByText(i18n.t("releasePlugin.unknown"));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(0);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_plugin_build").map(([, args]) => args)).toEqual([request]);
    expect(startReads).toBe(2);
    await user.click(screen.getByRole("button", { name: i18n.t("execution.retryPluginStart") }));
    await screen.findByText(i18n.t("release.started", { id: request.request.attemptId }));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_plugin_build").map(([, args]) => args)).toEqual([request, request]);
    expect(startReads).toBe(2);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "prepare_plugin_build")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.find(([command]) => command === "prepare_plugin_build")![1].request).toEqual({
      projectId: metadata().projectId, sessionToken: "session-1", attemptId: fixtureIdentity(701), build: pluginBuildRequest,
      choices: [{ locale: "zh-CN", configuration: [], outputPaths: ["deliverables/zh-CN.json"] }],
      expectedEligibilityBasis: pluginBuildWorkflow.prepare.expectedEligibilityBasis,
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(identities);
    expect(request.request).toMatchObject({ inputDigest: pluginBuildWorkflow.review.inputDigest, grantId: fixtureIdentity(702), unsandboxedExecution: true });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("read_execution_attempt", { request: {
      projectId: metadata().projectId, sessionToken: "session-1", attemptId: request.request.attemptId, offset: 0, limit: 100,
    } }));
  });
  it("keeps the Arena owner in real App assembly while registered navigation hides its consumer",async()=>{
    const user=userEvent.setup();await renderApp();await createProject(user);installArenaPreparation();
    await prepareArenaInApp(user);
    await user.click(screen.getByRole("button",{name:"Glossary and context"}));
    await screen.findByRole("region",{name:"Glossary and context"});
    expect(screen.queryByRole("region",{name:"Compare translation candidates"})).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog",{name:"Keep your Arena draft?"})).not.toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Arena comparison"}));
    expect(screen.getByRole("textbox",{name:"Scheme 2 · Model"})).toHaveValue("arena-model-2");
    expect(screen.getByRole("checkbox",{name:"first: Hello"})).toBeChecked();
    expect(screen.getByRole("checkbox",{name:/I confirm sending the shown/})).toBeChecked();
    expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([command])=>command==="preview_arena_translation")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command])=>command==="start_arena_translation")).toHaveLength(0);
  });
  it.each(["source","resources"] as const)("revokes Arena consent across hidden App views after %s changes",async scope=>{
    const user=userEvent.setup();await renderApp();await createProject(user);const facts=installArenaPreparation();
    await prepareArenaInApp(user);await user.click(screen.getByRole("button",{name:"Glossary and context"}));
    if(scope==="source")facts.changeSource();else facts.changeResources();
    await act(async()=>{mocks.reads!.invalidate([scope]);});
    await user.click(screen.getByRole("button",{name:"Arena comparison"}));
    expect(screen.getByRole("textbox",{name:"Scheme 1 · Model"})).toHaveValue("arena-model-1");
    expect(await screen.findByRole("checkbox",{name:scope==="source"?"first: Updated source":"first: Hello"})).toBeChecked();
    expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command])=>command==="start_arena_translation")).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
    await screen.findByRole("heading",{name:"Data sharing preview"});
    expect(screen.getByRole("checkbox",{name:/I confirm sending the shown/})).not.toBeChecked();
    expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeDisabled();
  });
  it("keeps late Arena reads from project A out of project B after an actual App project switch",async()=>{
    const user=userEvent.setup();await renderApp();await createProject(user);const facts=installArenaPreparation();
    const original=mocks.invoke.getMockImplementation()!;
    const other={...projectView("Other"),sessionToken:"session-2",locator:"C:\\Projects\\other",metadata:{...metadata("Other"),projectId:fixtureIdentity(900)}};
    let finish!:(value:ArenaView)=>void;
    mocks.invoke.mockImplementation((command:string,args:{request:Record<string,unknown>})=>{
      if(command==="read_arena_translation"&&args.request.sessionToken==="session-1")return new Promise<ArenaView>(resolve=>{finish=resolve;});
      if(command==="open_project")return Promise.resolve(other);return original(command,args);
    });
    await prepareArenaInApp(user);await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
    await waitFor(()=>expect(finish).toBeDefined());await user.click(screen.getByRole("button",{name:"Back to overview"}));
    await user.click(screen.getByRole("button",{name:"Open another"}));
    await user.type(screen.getByRole("textbox",{name:/Project folder/}),"C:\\Projects\\other");
    await user.click(screen.getByRole("button",{name:"Open project"}));await screen.findByRole("heading",{name:"Other"});
    await act(async()=>finish(facts.view()));await user.click(screen.getByRole("button",{name:"Arena comparison"}));
    expect(screen.getByRole("textbox",{name:"Scheme 2 · Model"})).toHaveValue("");
    expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();
    expect(screen.queryByRole("heading",{name:"Candidate A"})).not.toBeInTheDocument();
    expect(mocks.reads?.context.sessionToken).toBe("session-2");
  });

  it("preserves AI configuration, scope, preview, and consent through registered resource navigation", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    installAiPreparation();
    await prepareAiInApp(user);
    expect(document.querySelector("section.ai-dialog")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Glossary and context" }));
    await screen.findByRole("region", { name: "Glossary and context" });
    expect(document.querySelector("section.ai-dialog")).toBeNull();
    expect(screen.queryByRole("dialog", { name: /unsaved/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "AI work" }));
    expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("test-model");
    expect(screen.getByRole("checkbox", { name: "first: Hello" })).toBeChecked();
    expect(screen.getByRole("heading", { name: "Data sharing preview" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /I confirm sending/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_work_plan")).toHaveLength(0);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "authorize_work_plan" || command === "create_execution_identity")).toHaveLength(0);
  });

  it.each(["source", "resources", "sharing"] as const)(
    "keeps AI setup but requires fresh preview and consent after %s changes across areas", async change => {
      const user = userEvent.setup(); await renderApp(); await createProject(user);
      const facts = installAiPreparation();
      await prepareAiInApp(user);
      await user.click(screen.getByRole("button", { name: "Glossary and context" }));
      await screen.findByRole("region", { name: "Glossary and context" });
      if (change !== "sharing") {
        if (change === "source") facts.changeSource(); else facts.changeResources();
        await act(async () => { mocks.reads!.invalidate([change]); });
      }
      await user.click(screen.getByRole("button", { name: "AI work" }));
      if (change === "sharing") await user.click(screen.getByRole("checkbox", { name: "Share applicable adopted terms" }));
      expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("test-model");
      expect(await screen.findByRole("checkbox", { name: change === "source" ? "first: Updated source" : "first: Hello" })).toBeChecked();
      expect(screen.queryByRole("heading", { name: "Data sharing preview" })).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: /I confirm sending/ })).not.toBeInTheDocument();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_work_plan")).toHaveLength(0);
      if (change === "source") {
        expect(screen.getByRole("button", { name: "Preview what will be sent" })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Clear old selection and use current source" }));
        await user.click(screen.getByRole("checkbox", { name: "first: Updated source" }));
      }
      await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
      await screen.findByRole("heading", { name: "Data sharing preview" });
      expect(screen.getByRole("checkbox", { name: /I confirm sending/ })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeDisabled();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "prepare_work_plan")).toHaveLength(2);
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "authorize_work_plan" || command === "create_execution_identity")).toHaveLength(0);
    },
  );

  it("does not revive an in-flight AI preview after its resource basis changes", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const facts = installAiPreparation();
    const original = mocks.invoke.getMockImplementation()!;
    let finishOldPreview: (() => void) | undefined;
    let previews = 0;
    mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
      if (command === "prepare_work_plan" && previews++ === 0) {
        const oldPreview: WorkPlanView = await original(command, args);
        return new Promise<WorkPlanView>(resolve => { finishOldPreview = () => resolve(oldPreview); });
      }
      return original(command, args);
    });
    await user.click(screen.getByRole("button", { name: "AI work" }));
    await user.type(screen.getByRole("textbox", { name: "Chat Completions URL" }), "http://127.0.0.1:4000/v1/chat/completions");
    await user.type(screen.getByRole("textbox", { name: "Model" }), "test-model");
    await user.click(await screen.findByRole("checkbox", { name: "first: Hello" }));
    await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
    await waitFor(() => expect(finishOldPreview).toBeDefined());
    facts.changeResources();
    await act(async () => { mocks.reads!.invalidate(["resources"]); finishOldPreview!(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview what will be sent" })).toBeEnabled());
    expect(screen.queryByRole("heading", { name: "Data sharing preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("test-model");
    await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
    await screen.findByRole("heading", { name: "Data sharing preview" });
    expect(screen.getByRole("checkbox", { name: /I confirm sending/ })).not.toBeChecked();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_work_plan")).toHaveLength(0);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "authorize_work_plan" || command === "create_execution_identity")).toHaveLength(0);
  });

  it("keeps a late AI result from project A out of project B after an actual project switch", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const facts = installAiPreparation();
    const originalInvoke = mocks.invoke.getMockImplementation()!;
    const otherProject = { ...projectView("Other"), sessionToken: "session-2", locator: "C:\\Projects\\other",
      metadata: { ...metadata("Other"), projectId: fixtureIdentity(900) } };
    let finishOldRead!: (value: AiView) => void;
    mocks.invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
      if (command === "read_ai_translation" && args.request.sessionToken === "session-1")
        return new Promise<AiView>(resolve => { finishOldRead = resolve; });
      if (command === "open_project") return Promise.resolve(otherProject);
      return originalInvoke(command, args);
    });

    await prepareAiInApp(user);
    await user.click(screen.getByRole("button", { name: "Send and generate candidates" }));
    await waitFor(() => expect(finishOldRead).toBeDefined());
    const authorization = mocks.invoke.mock.calls.filter(([command]) => command === "authorize_work_plan");
    const starts = mocks.invoke.mock.calls.filter(([command]) => command === "start_work_plan");
    expect(authorization).toHaveLength(1); expect(starts).toHaveLength(1);
    expect(starts[0][1].request).toEqual({ projectId: metadata().projectId, sessionToken: "session-1", planId: authorization[0][1].request.planId,
      actionId: authorization[0][1].request.actionId, expectedGeneration: "1" });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await user.click(screen.getByRole("button", { name: "Open another" }));
    await user.type(screen.getByRole("textbox", { name: /Project folder/ }), "C:\\Projects\\other");
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findByRole("heading", { name: "Other" });
    await act(async () => finishOldRead(facts.view()));
    await user.click(screen.getByRole("button", { name: "AI work" }));
    expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("");
    expect(screen.queryByRole("heading", { name: "Data sharing preview" })).not.toBeInTheDocument();
    expect(screen.queryByText("test-model")).not.toBeInTheDocument();
    expect(mocks.reads?.context.sessionToken).toBe("session-2");
    expect(mocks.reads?.client.getQueryCache().getAll().every(query =>
      query.queryKey[0] === otherProject.metadata.projectId && query.queryKey[1] === otherProject.sessionToken)).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "authorize_work_plan")).toEqual(authorization);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_work_plan")).toEqual(starts);
  });

  it("revokes a hidden Review assessment when a language is removed and does not revive or expand it when restored", async () => {
    const user = userEvent.setup();
    const original = mocks.invoke.getMockImplementation()!;
    let current = { ...projectView(), metadata: { ...metadata(), targetLocales: ["zh-CN", "ja"] } };
    let assessments = 0;
    mocks.invoke.mockImplementation(async (command: string, args: { request: { targetLocales?: string[]; locales?: string[] } }) => {
      if (command === "create_project") return current;
      if (command === "set_target_locales") {
        if (!args.request.targetLocales) throw new Error("Missing target languages");
        current = { ...current, metadata: { ...current.metadata, metadataRevision: String(Number(current.metadata.metadataRevision) + 1),
          targetLocales: [...args.request.targetLocales] } };
        return { ...current, outcome: "changed", directoryChanged: false };
      }
      if (command === "read_review_summary_page") return reviewSummaryPageFixture([]);
      if (command === "read_review_eligibility") {
        if (!args.request.locales) throw new Error("Missing assessed languages");
        const marker = `explicit-${++assessments}`;
        return { policyVersion: "balanced-1", sourceSnapshotId: fixtureIdentity(600), basis: marker, ready: false,
          locales: args.request.locales.map(locale => ({ locale, ready: false, checkedUnits: 1, blockerCount: 1, exceptionCount: 0,
            blockers: [{ unitId: fixtureIdentity(501), nativeKey: marker, code: "qa-missing-or-stale", reference: null }], exceptions: [] })) } satisfies Eligibility;
      }
      return original(command, args);
    });
    await renderApp(); await createProject(user);
    await user.click(screen.getByRole("button", { name: "Review and QA" }));
    await user.click(await screen.findByRole("tab", { name: "Build readiness" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Assess build readiness" })).toBeEnabled());
    expect(screen.getByRole("checkbox", { name: "zh-CN" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "ja" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
    expect(await screen.findAllByText("explicit-1: Run the current checks")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit target languages" })).toBeEnabled());
    expect(screen.queryByRole("tab", { name: "Build readiness" })).not.toBeInTheDocument();
    for (const locales of ["zh-CN", "zh-CN, ja"]) {
      await user.click(screen.getByRole("button", { name: "Edit target languages" }));
      const input = screen.getByRole("textbox", { name: "Target locales" });
      await user.clear(input); await user.type(input, locales);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("textbox", { name: "Target locales" })).not.toBeInTheDocument());
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_review_eligibility")).toHaveLength(1);
    }
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_target_locales").map(([, payload]) => payload.request))
      .toEqual([{ sessionToken: "session-1", expectedRevision: "1", targetLocales: ["zh-CN"] },
        { sessionToken: "session-1", expectedRevision: "2", targetLocales: ["zh-CN", "ja"] }]);
    await user.click(screen.getByRole("button", { name: "Review and QA" }));
    await user.click(await screen.findByRole("tab", { name: "Build readiness" }));
    expect(await screen.findByText("Assess the selected languages to see their current build readiness.")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "zh-CN" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "ja" })).not.toBeChecked();
    expect(screen.queryByText("explicit-1: Run the current checks")).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_review_eligibility")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Assess build readiness" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
    expect(await screen.findByText("explicit-2: Run the current checks")).toBeVisible();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_review_eligibility").map(([, payload]) => payload.request))
      .toEqual([{ projectId: metadata().projectId, sessionToken: "session-1", locales: ["zh-CN", "ja"] },
        { projectId: metadata().projectId, sessionToken: "session-1", locales: ["zh-CN"] }]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity" || command === "write_review_decision")).toHaveLength(0);
  });
  it("returns hidden Review history to the current page after a semantic notification through actual App assembly", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const original = mocks.invoke.getMockImplementation()!;
    const target = reviewTargetFixture({ unitId: fixtureIdentity(501), nativeKey: "first", sourceSnapshotId: fixtureIdentity(500),
      sourceRevisionId: fixtureIdentity(502), sourceText: "Hello", selectionId: null, revisionId: null, translationText: null, basis: "basis" });
    let currentHistory = "initial-current-history";
    mocks.invoke.mockImplementation(async (command: string, args: { request: { offset?: number } }) => {
      if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(target)]);
      if (command === "read_review_target") return target;
      if (command === "read_review_findings") return reviewFindingViewFixture(target);
      if (command === "read_review_history") return { decisions: [],
        checks: [reviewCheckFixture(target, fixtureIdentity(650), "completed", { runId: fixtureIdentity(651),
          validatorVersion: args.request.offset === 20 ? "older-history-page" : currentHistory })],
        waivers: [], fallbacks: [], nextOffset: args.request.offset === 20 ? null : 20 };
      return original(command, args);
    });
    await user.click(screen.getByRole("button", { name: "Review and QA" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    await user.click(await screen.findByText("Decision and check history"));
    expect(await screen.findByText(/initial-current-history/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "More history" }));
    expect(await screen.findByText(/older-history-page/)).toBeVisible();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_review_history").map(([, payload]) => payload.request.offset))
      .toEqual([0, 20]);
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close project" })).toBeEnabled());
    expect(screen.queryByText("Decision and check history")).not.toBeInTheDocument();
    const reads = mocks.reads; if (!reads) throw new Error("No App session reads");
    const beforeNotification = mocks.invoke.mock.calls.length;
    await act(async () => { currentHistory = "latest-current-history"; reads.invalidate(["review"]); });
    expect(mocks.invoke.mock.calls.slice(beforeNotification).filter(([command]) => command === "read_review_history")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Review and QA" }));
    await user.click(await screen.findByText("Decision and check history"));
    expect(await screen.findByText(/latest-current-history/)).toBeVisible();
    expect(screen.queryByText(/older-history-page/)).not.toBeInTheDocument();
    const returnedReads = mocks.invoke.mock.calls.slice(beforeNotification).filter(([command]) => command === "read_review_history");
    expect(returnedReads.length).toBeGreaterThan(0);
    expect(returnedReads.map(([, payload]) => payload.request)).toEqual(returnedReads.map(() => ({
      projectId: metadata().projectId, sessionToken: "session-1", unitId: target.unitId, locale: "zh-CN", offset: 0, limit: 20,
    })));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity" || command === "write_review_decision")).toHaveLength(0);
  });
  it("rebases a clean translation selection after the project's target language changes in the same session", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const fixture = installTranslationEditor();
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) =>
      command === "set_target_locales"
        ? { ...projectView("Demo", "2"), metadata: { ...metadata("Demo", "2"), targetLocales: ["ja-JP"] }, outcome: "changed", directoryChanged: false }
        : original(command, args));

    await user.click(screen.getByRole("button", { name: "Translations" }));
    await screen.findByRole("button", { name: "first" });
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("zh-CN");
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await user.click(screen.getByRole("button", { name: "Edit target languages" }));
    const targets = screen.getByRole("textbox", { name: "Target locales" });
    await user.clear(targets); await user.type(targets, "ja-JP");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Target locales" })).not.toBeInTheDocument());

    const afterChange = mocks.invoke.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(await screen.findByRole("combobox", { name: "Target language" })).toHaveValue("ja-JP");
    await user.click(await screen.findByRole("button", { name: "first" }));
    await user.type(await editableDraft(), "New language draft");
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(fixture.saves()).toHaveLength(1));

    const scopedCalls = mocks.invoke.mock.calls.slice(afterChange)
      .filter(([, args]) => typeof args?.request?.locale === "string");
    expect(scopedCalls.map(([command]) => command)).toEqual(expect.arrayContaining(["read_review_summary_page", "read_review_editor_snapshot", "save_translation_revision"]));
    expect(new Set(scopedCalls.map(([, args]) => args.request.locale))).toEqual(new Set(["ja-JP"]));
    expect(fixture.saves()[0][1].request).toMatchObject({ locale: "ja-JP", text: "New language draft", unitId: fixtureIdentity(501) });
  });

  it("confirms stopping active work before closing and permits returning without cancellation", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    let stopped = false;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "close_project") {
        if (!stopped) throw { code: "busy", outcome: "rejected", stage: "close", recoveryRequired: false };
        return { closed: true };
      }
      if (command === "quiesce_execution") { stopped = true; return { active: false, quiescing: false, queryCount: 0, error: null }; }
      return projectView();
    });
    await user.click(screen.getByRole("button", { name: "Close project" }));
    let dialog = await screen.findByRole("dialog", { name: "Stop background work?" });
    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(mocks.invoke.mock.calls.some(([command]) => command === "quiesce_execution")).toBe(false);
    expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close project" }));
    dialog = await screen.findByRole("dialog", { name: "Stop background work?" });
    await user.click(within(dialog).getByRole("button", { name: "Stop work and continue" }));
    await screen.findByRole("heading", { name: "No project open" });
    expect(stopped).toBe(true);
  });

  it("retains metadata drafts when entering and leaving Tasks", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: /Project name/ });
    await user.clear(input); await user.type(input, "Unsaved draft");
    mocks.invoke.mockImplementation(async (command: string) => command === "list_execution_tasks" ? [] : projectView());
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    expect(screen.getByRole("textbox", { name: /Project name/ })).toHaveValue("Unsaved draft");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "rename_project")).toBe(false);
  });

  it("preserves an unsaved translation across area navigation and saves it after returning from Tasks", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const fixture = installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "first" }));
    const editor = await editableDraft();
    await user.type(editor, "Draft");
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    expect(screen.queryByRole("textbox", { name: "Your draft", hidden: true })).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Translations" }));
    const restored = await editableDraft();
    expect(restored).toHaveValue("Draft");
    await user.click(restored); await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Draft");
    expect(screen.getByRole("button", { name: "first" })).toHaveAttribute("aria-current", "true");
    expect(fixture.saves()).toHaveLength(1);
    expect(fixture.protections()).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2);
  });

  it("keeps an unfinished review across area navigation and still confirms project leave", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const target = reviewTargetFixture({ unitId: fixtureIdentity(701), nativeKey: "first", sourceSnapshotId: fixtureIdentity(700),
      sourceRevisionId: fixtureIdentity(702), sourceText: "Hello", selectionId: fixtureIdentity(703),
      revisionId: fixtureIdentity(704), translationText: "你好", basis: "review-basis" });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(target)]);
      if (command === "read_review_target") return target;
      if (command === "read_review_findings") return reviewFindingViewFixture(target);
      if (command === "read_review_history") return { decisions: [], checks: [], waivers: [], fallbacks: [], nextOffset: null };
      if (command === "execution_status") return { active: false, quiescing: false, queryCount: 0, error: null };
      if (command === "list_execution_tasks") return [];
      return projectView();
    });
    await user.click(screen.getByRole("button", { name: "Review and QA" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
    await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep for later");
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    expect(screen.queryByRole("dialog", { name: "Leave with an unfinished review?" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review and QA" }));
    expect(await screen.findByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep for later");
    expect(screen.getByRole("textbox", { name: "Reviewer name" })).toHaveValue("Reviewer A");
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    await user.click(screen.getByRole("button", { name: "Close project" }));
    expect(await screen.findByRole("dialog", { name: "Leave with an unfinished review?" })).toBeVisible();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "close_project")).toBe(false);
  });

  it("keeps unknown finding recovery reachable through actual App navigation and native close", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const original = mocks.invoke.getMockImplementation()!;
    const target = reviewTargetFixture({ basis: "a".repeat(64) });
    const finding = { issueId: "b".repeat(64), rule: "plugin:synthetic-advisory", code: "same-code", detail: "App advisory evidence", severity: "warning", waivable: false };
    const requirement = { key: pluginRuleKeyFixture("synthetic-advisory"), inputDigest: "c".repeat(64), scopeDigest: "d".repeat(64), targets: [target.unitId], mandatory: false, waivable: false, notApplicable: null };
    target.currentCheck = reviewCheckFixture(target, fixtureIdentity(1100), "completed", { runId: fixtureIdentity(1101), rules: [{ rule: finding.rule, key: requirement.key, mandatory: false, status: "findings", reason: null, findings: [finding] }] });
    let saved: ReviewFindingDecision | null = null, findingReads = 0;
    mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
      if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(target)]);
      if (command === "read_review_target") return target;
      if (command === "read_review_findings") return { ...reviewFindingViewFixture(target), findings: [{ runId: target.currentCheck!.runId, purpose: "qa", aiOrigin: null, finding, requirement, decision: saved }], history: saved ? [saved] : [] };
      if (command === "read_review_history") return { decisions: [], checks: [], waivers: [], fallbacks: [], nextOffset: null };
      if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
      if (command === "create_execution_identity") return fixtureIdentity(1102);
      if (command === "write_review_finding") {
        if (!validateRequestFinding(args.request)) throw new Error("Invalid finding request");
        saved = { purpose: "qa", aiOrigin: null, decisionId: fixtureIdentity(1103), request: structuredClone({ ...args.request.finding, expectedDecisionId: args.request.finding.expectedDecisionId ?? null }), basisEvidence: target.basisEvidence, requirement, finding, createdAt: "2026-10-16T00:00:00Z" };
        throw new Error("Lost response after commit");
      }
      if (command === "read_review_finding_action") {
        expect(args.request).toEqual({ projectId: metadata().projectId, sessionToken: "session-1", actionId: fixtureIdentity(1102) });
        if (++findingReads === 1) throw new Error("Original finding lookup ACK lost");
        return saved;
      }
      return original(command, args);
    });
    await user.click(screen.getByRole("button", { name: "Review and QA" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    const findingsPanel = await screen.findByRole("region", { name: "Advisory findings" });
    await within(findingsPanel).findByText("App advisory evidence", { exact: false });
    await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
    await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Reason A");
    await user.click(screen.getByRole("button", { name: "Reject as false positive" }));
    await screen.findByRole("region", { name: "Original finding action awaiting confirmation" });
    await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), " plus B");
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByRole("region", { name: "Original finding action awaiting confirmation" })).toBeVisible();
    const nativeClose = mocks.onCloseRequested.mock.calls.at(-1)?.[0]; if (!nativeClose) throw new Error("No native close handler");
    await act(async () => { await nativeClose({ preventDefault: vi.fn() }); });
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([name]) => name === "close_project")).toBe(false);
    await user.click(screen.getByRole("button", { name: i18n.t("review.checkSaved") }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Original finding action awaiting confirmation" })).toBeNull());
    expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason A plus B");
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "write_review_finding")).toHaveLength(1);
    expect(findingReads).toBe(2);
    expect(mocks.invoke.mock.calls.find(([name]) => name === "write_review_finding")?.[1].request.finding)
      .toMatchObject({ actionId: fixtureIdentity(1102), actor: "Reviewer A", reason: "Reason A" });
  });

  it("keeps resource edits during ordinary navigation and confirms real project close", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, payload: unknown) => {
      if (command === "read_content_scope") return { revision: "2", currentSnapshot: fixtureIdentity(750) };
      if (command === "read_source_content") return sourcePageFixture({ snapshotId: fixtureIdentity(750), scope: { revision: "2", currentSnapshot: fixtureIdentity(750) }, rows: [] });
      if (command === "read_terms" || command === "list_resource_captures" || command === "list_execution_tasks") return [];
      if (command === "execution_status") return { active: false, quiescing: false, queryCount: 0, error: null };
      if (command === "close_project") return { closed: true };
      return original(command, payload);
    });
    await user.click(screen.getByRole("button", { name: "Glossary and context" }));
    await user.type(screen.getByRole("textbox", { name: "Source term" }), "Barrel");
    await user.type(screen.getByRole("textbox", { name: "Source aliases, separated by commas" }), "Cask,  Drum");
    await user.type(screen.getByRole("textbox", { name: "Preferred target form" }), "Keep this draft");
    await user.type(screen.getByRole("textbox", { name: "Reason or source note" }), "Reviewed");
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved resource edits?" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Glossary and context" }));
    expect(screen.getByRole("textbox", { name: "Preferred target form" })).toHaveValue("Keep this draft");
    expect(screen.getByRole("textbox", { name: "Source aliases, separated by commas" })).toHaveValue("Cask,  Drum");
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await user.click(screen.getByRole("button", { name: "Close project" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave with unsaved resource edits?" });
    expect(mocks.invoke.mock.calls.some(([name]) => name === "close_project")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Stay and keep edits" }));
    expect(screen.getByRole("textbox", { name: "Preferred target form" })).toHaveValue("Keep this draft");
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await user.click(screen.getByRole("button", { name: "Close project" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Leave with unsaved resource edits?" })).getByRole("button", { name: "Discard edits and leave" }));
    await screen.findByRole("heading", { name: "No project open" });
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "close_project")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.some(([name]) => name === "save_term")).toBe(false);
  });

  it("saves the visible translation from list and reference focus without replaying an in-flight save", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const fixture = installTranslationEditor();
    let releaseFirst!: () => void;
    let first = true;
    fixture.setSave(async (_request, commit) => {
      if (first) {
        first = false;
        await new Promise<void>(resolve => { releaseFirst = resolve; });
      }
      return commit();
    });
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    const editor = await editableDraft();
    await user.type(editor, "A");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());

    screen.getByRole("button", { name: "first" }).focus();
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(fixture.saves()).toHaveLength(1));
    expect(fixture.saves()[0][1].request).toMatchObject({ text: "A", locale: "zh-CN", unitId: fixtureIdentity(501) });
    await user.type(editor, "B");
    await user.keyboard("{Control>}s{/Control}");
    expect(fixture.saves()).toHaveLength(1);

    await act(async () => releaseFirst());
    expect(await screen.findByText(i18n.t("translation.savedNewerDraft"))).toBeInTheDocument();
    expect(editor).toHaveValue("AB");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
    const references = screen.getByText("Terms, context and history");
    await user.click(references);
    references.focus();
    await user.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(fixture.saves()).toHaveLength(2));
    expect(fixture.saves()[1][1].request).toMatchObject({ text: "AB", expectedSelectionId: fixtureIdentity(503) });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());

    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    await user.keyboard("{Control>}s{/Control}");
    expect(fixture.saves()).toHaveLength(2);
  });

  it("does not save during composition, a leave dialog, or unknown-outcome recovery", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const fixture = installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    const editor = await editableDraft();
    await user.type(editor, "A");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
    const activityTrigger = screen.getByRole("button", { name: "View background tasks" });
    const settingsTrigger = screen.getByRole("button", { name: "Settings" });
    const dock = screen.getByText("Background tasks", { selector: "summary", exact: false }).closest("details")!;

    fireEvent.compositionStart(editor);
    fireEvent.click(settingsTrigger); expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    fireEvent.click(activityTrigger); expect(dock).not.toHaveAttribute("open"); expect(editor).toHaveFocus();
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true, isComposing: false });
    await act(async () => {});
    expect(fixture.saves()).toHaveLength(0);
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: "s", metaKey: true, isComposing: true });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true, altKey: true });
    await act(async () => {});
    expect(fixture.saves()).toHaveLength(0);

    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close project" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Close project" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Leave with an unsaved translation?");
    fireEvent.click(settingsTrigger); expect(screen.getAllByRole("dialog")).toEqual([dialog]);
    fireEvent.click(activityTrigger); expect(dock).not.toHaveAttribute("open"); expect(dialog).toBeVisible();
    await user.keyboard("{Control>}s{/Control}");
    expect(fixture.saves()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    const restoredEditor = await editableDraft();
    expect(restoredEditor).toHaveValue("A");

    fixture.setSave(async () => { throw { code: "outcome-unknown", outcome: "unknown", stage: "save", recoveryRequired: true }; });
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(fixture.saves()).toHaveLength(1));
    await screen.findByRole("alert");
    const identitiesAtUnknown = mocks.invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length;
    await user.click(restoredEditor);
    await user.keyboard("{Control>}s{/Control}");
    expect(fixture.saves()).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(identitiesAtUnknown);
    expect(identitiesAtUnknown).toBe(2);
    expect(fixture.protections()).toHaveLength(1);
    expect(restoredEditor).toHaveValue("A");
  });








  it("clears a rejected create result after explicitly discarding the draft", async () => {
    const user = userEvent.setup();
    await renderApp();
    mocks.invoke.mockRejectedValueOnce({ code: "destination-conflict", outcome: "rejected", stage: "create", context: {} });
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.type(screen.getByLabelText(/Parent folder/), "C:\\Projects");
    await user.type(screen.getByLabelText(/Project name/), "Occupied");
    await user.click(screen.getByRole("button", { name: "Create and open" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No project open" })).toBeInTheDocument();
  });

  it.each([false, true])("replaces the previous recent locator after a confirmed move (reconciled: %s)", async (reconciled) => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox", { name: "Project name" }));
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Moved");
    await user.click(screen.getByRole("checkbox", { name: "Also rename the project folder" }));
    const moved = { ...projectView("Moved", "2", "committed"), locator: "C:\\Projects\\Moved" };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "rename_project") {
        if (reconciled) throw new Error("acknowledgement lost");
        return { ...moved, outcome: "changed", directoryChanged: true };
      }
      return moved;
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "Moved" });
    expect(readRecentProjects().map((item) => item.locator)).toEqual([moved.locator]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(1);
  });

  it("clears a corrected folder conflict without removing the existing recent locator", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox", { name: "Project name" }));
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Occupied");
    await user.click(screen.getByRole("checkbox", { name: "Also rename the project folder" }));
    mocks.invoke.mockRejectedValueOnce({ code: "destination-conflict", outcome: "rejected", stage: "rename", recoveryRequired: false });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    expect(readRecentProjects().map((item) => item.locator)).toEqual([projectView().locator]);
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Also rename the project folder" })).toBeChecked();
  });

  it("destroys the native window only after releasing the project and preserves the restore candidate", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    mocks.invoke.mockResolvedValueOnce({ closed: true });
    const event = { preventDefault: vi.fn() };
    await mocks.onCloseRequested.mock.calls.at(-1)![0](event);
    await waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce());
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("close_project", { request: { sessionToken: "session-1" } });
    const closedAt = mocks.invoke.mock.calls.findIndex(([command]) => command === "close_project");
    const stoppedAt = mocks.invoke.mock.calls.findIndex(([command]) => command === "stop_application_plugin_instances");
    expect(stoppedAt).toBeGreaterThan(closedAt);
    expect(localStorage.getItem(LAST_OPEN_PROJECT_STORAGE_KEY)).not.toBeNull();
  });

  it("preserves folder synchronization after a rejected save and navigation retry", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox", { name: "Project name" }));
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Occupied");
    const checkbox = screen.getByRole("checkbox", { name: "Also rename the project folder" });
    await user.click(checkbox);
    let rejectSave!: (reason: unknown) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(checkbox).toBeDisabled());
    rejectSave({ code: "destination-conflict", outcome: "rejected", stage: "rename", recoveryRequired: false });
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(checkbox).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Close project" }));
    mocks.invoke.mockRejectedValueOnce({ code: "destination-conflict", outcome: "rejected", stage: "rename", recoveryRequired: false });
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("rename_project", {
      request: { sessionToken: "session-1", expectedRevision: "1", displayName: "Occupied", directoryName: "Occupied" },
    }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("reads authoritative state after an unstructured save rejection without replaying", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox", { name: "Project name" }));
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Committed");
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "rename_project") throw new Error("response lost");
      if (command === "read_project") return projectView("Committed", "2", "settled");
      return projectView();
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("The change was confirmed.")).toBeInTheDocument());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_project")).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenLastCalledWith("read_project", { request: { sessionToken: "session-1", expectedRevision: "1" } });
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("uses runtime confirmation for canonicalized target tags after a lost response", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Edit target languages" }));
    await user.clear(screen.getByRole("textbox", { name: "Target locales" }));
    await user.type(screen.getByRole("textbox", { name: "Target locales" }), "iw");
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "set_target_locales") throw new Error("response lost");
      return { ...projectView("Demo", "2", "committed"), metadata: { ...metadata("Demo", "2"), targetLocales: ["he"] } };
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("The change was confirmed.");
    expect(screen.queryByRole("textbox", { name: "Target locales" })).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "set_target_locales")).toHaveLength(1);
  });

  it("blocks navigation until a lost acknowledgement is reconciled, including a lost read response", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox", { name: "Project name" }));
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Committed");
    let reads = 0;
    mocks.invoke.mockImplementation(async (command: string, args?: { request?: unknown }) => {
      if (command === "rename_project") throw { code: "outcome-unknown", outcome: "unknown", stage: "rename", recoveryRequired: true };
      if (command === "read_project") {
        reads += 1;
        if (reads === 1) throw new Error("read acknowledgement lost");
        return reads === 2 ? projectView("Unrelated", "3") : projectView("Committed", "2");
      }
      if (command === "close_project") return { closed: true };
      if (command === "stop_application_plugin_instances") return { actionId: (args?.request as { actionId: string }).actionId, state: "stopped" };
      return projectView();
    });
    await user.click(screen.getByRole("button", { name: "Close project" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "Retry read" })).toBeEnabled());
    expect(dialog.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    // Another close request must not replace the only actionable recovery feedback.
    await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() });
    await user.click(dialog.getByRole("button", { name: "Retry read" }));
    expect(dialog.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "Retry read" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(1);
  });

  it("keeps the same application stop action through pending and unknown exit acknowledgements", async () => {
    await renderApp();
    const original = mocks.invoke.getMockImplementation()!;
    let stops = 0;
    mocks.invoke.mockImplementation(async (command: string, args: { request: { actionId: string } }) => {
      if (command !== "stop_application_plugin_instances") return original(command, args);
      stops++;
      if (stops === 1) return { actionId: args.request.actionId, state: "stopping" };
      if (stops === 2) throw new Error("Original shutdown acknowledgement lost");
      return { actionId: args.request.actionId, state: "stopped" };
    });
    for (const notice of ["errors.applicationStopPending", "errors.applicationStopUnknown"] as const) {
      await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
      await screen.findByText(i18n.t(notice));
      expect(mocks.destroy).not.toHaveBeenCalled();
    }
    await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    expect(mocks.destroy).toHaveBeenCalledOnce();
    const requests = mocks.invoke.mock.calls.filter(([command]) => command === "stop_application_plugin_instances").map(([, args]) => args.request);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toEqual(requests[0]);
  });

  it("awaits application cleanup after project close before destroying the window", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const original = mocks.invoke.getMockImplementation()!;
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    mocks.invoke.mockImplementation(async (command: string, args: { request: { actionId: string } }) => {
      if (command !== "stop_application_plugin_instances") return original(command, args);
      await held; return { actionId: args.request.actionId, state: "stopped" };
    });
    let closing!: Promise<unknown>;
    act(() => { closing = mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "stop_application_plugin_instances")).toBe(true));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(1);
    expect(mocks.destroy).not.toHaveBeenCalled();
    await act(async () => { finish(); await closing; });
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("locks metadata during application stop-all and preserves later B through admission recovery and another exit", async () => {
    const user = userEvent.setup(); await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));
    const input = screen.getByRole("textbox", { name: /Project name/ });
    expect(input).toBeEnabled();
    expect(input).toHaveValue("");
    const original = mocks.invoke.getMockImplementation()!;
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    mocks.invoke.mockImplementation(async (command: string, args: { request: { actionId: string } }) => {
      if (command === "resume_application_plugin_instances") {
        if (!validateRequestApplicationShutdown(args.request)) throw new Error("Invalid application admission recovery request");
        return { actionId: args.request.actionId, state: "resumed" };
      }
      if (command !== "stop_application_plugin_instances") return original(command, args);
      if (!validateRequestApplicationShutdown(args.request)) throw new Error("Invalid application shutdown request");
      await held; return { actionId: args.request.actionId, state: "stopped" };
    });
    mocks.destroy.mockRejectedValueOnce(new Error("native destroy rejected"));
    let closing!: Promise<unknown>;
    act(() => { closing = mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "stop_application_plugin_instances")).toBe(true));
    expect(input).toBeDisabled();
    await user.type(input, "Blocked while closing");
    expect(input).toHaveValue("");
    expect(mocks.destroy).not.toHaveBeenCalled();
    await act(async () => { finish(); await closing; });
    await screen.findByText(i18n.t("errors.windowCloseFailed"));
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(input).toBeEnabled();
    await user.type(input, "Newer metadata B");
    expect(input).toHaveValue("Newer metadata B");
    await user.click(screen.getByRole("button", { name: "Allow new shared instances" }));
    await screen.findByText(i18n.t("feedback.applicationAdmissionRestored"));
    expect(input).toHaveValue("Newer metadata B");
    expect(input).toBeEnabled();
    const stops = mocks.invoke.mock.calls.filter(([command]) => command === "stop_application_plugin_instances");
    const recoveries = mocks.invoke.mock.calls.filter(([command]) => command === "resume_application_plugin_instances");
    expect(stops).toHaveLength(1);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0][1]).toEqual(stops[0][1]);
    await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    const blocker = await screen.findByRole("dialog", { name: i18n.t("dialog.createTitle") });
    expect(within(blocker).getByText(i18n.t("dialog.createWindowCloseMessage"))).toBeInTheDocument();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "stop_application_plugin_instances")).toHaveLength(1);
    await user.click(within(blocker).getByRole("button", { name: "Keep editing" }));
    expect(input).toHaveValue("Newer metadata B");
    expect(input).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_project")).toHaveLength(0);
  });

  it("explicitly restores admission with its original uncertain action before a new exit", async () => {
    await renderApp();
    mocks.destroy.mockRejectedValueOnce(new Error("native destroy rejected"));
    await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    const original = mocks.invoke.getMockImplementation()!;
    let resumes = 0;
    mocks.invoke.mockImplementation(async (command: string, args: { request: { actionId: string } }) => {
      if (command !== "resume_application_plugin_instances") return original(command, args);
      resumes++;
      if (resumes === 1) throw new Error("Admission recovery acknowledgement lost");
      return { actionId: args.request.actionId, state: "resumed" };
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Allow new shared instances" }));
    const retry = await screen.findByRole("button", { name: "Check original admission recovery" });
    const stopCount = mocks.invoke.mock.calls.filter(([command]) => command === "stop_application_plugin_instances").length;
    await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "stop_application_plugin_instances")).toHaveLength(stopCount);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    await user.click(retry);
    await screen.findByText(i18n.t("feedback.applicationAdmissionRestored"));
    expect(screen.queryByRole("button", { name: "Allow new shared instances" })).toBeNull();
    const recoveries = mocks.invoke.mock.calls.filter(([command]) => command === "resume_application_plugin_instances");
    expect(recoveries).toHaveLength(2); expect(recoveries[1][1]).toEqual(recoveries[0][1]);
    await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    const stops = mocks.invoke.mock.calls.filter(([command]) => command === "stop_application_plugin_instances");
    expect(stops).toHaveLength(2); expect(stops[1][1].request.actionId).not.toBe(stops[0][1].request.actionId);
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });

  it("reports native close failures and permits a subsequent close request", async () => {
    await renderApp();
    mocks.destroy.mockRejectedValueOnce(new Error("native destroy rejected"));
    const event = { preventDefault: vi.fn() };
    await mocks.onCloseRequested.mock.calls.at(-1)![0](event);
    await screen.findByText("The window could not close. Your saved project is safe. Try closing the window again.");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await mocks.onCloseRequested.mock.calls.at(-1)![0](event);
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });

  it("locks submitted create fields until creation finishes and retains a rejected draft", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.type(screen.getByLabelText(/Parent folder/), "C:\\Projects");
    await user.type(screen.getByLabelText(/Project name/), "Submitted");
    let rejectCreate!: (reason: unknown) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((_, reject) => { rejectCreate = reject; }));
    await user.click(screen.getByRole("button", { name: "Create and open" }));
    await waitFor(() => expect(rejectCreate).toBeDefined());
    expect(screen.getByLabelText(/Project name/)).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Common source languages" })).toBeDisabled();
    rejectCreate({ code: "destination-conflict", outcome: "rejected", stage: "create", recoveryRequired: false });
    await waitFor(() => expect(screen.getByLabelText(/Project name/)).toBeEnabled());
    expect(screen.getByLabelText(/Project name/)).toHaveValue("Submitted");
  });

  it("clears corrected field feedback and keeps create cancellation free of validation errors", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.click(screen.getByRole("button", { name: "Create and open" }));
    await user.type(screen.getByLabelText(/Project name/), "Valid name");
    expect(screen.getByLabelText(/Project name/)).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("Enter a project name.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows removable language names for the complete target selection", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Common target languages" }), "ja-JP");
    await user.click(screen.getByRole("button", { name: /Remove.*Simplified Chinese/ }));
    expect(screen.getByLabelText("Target locales")).toHaveValue("ja-JP");
    expect(screen.getByRole("button", { name: /Remove.*Japanese/ })).toBeInTheDocument();
  });

  it("shows real language names and separates codes without duplicating unnamed tags", async () => {
    const user = userEvent.setup();
    await renderApp();
    mocks.invoke.mockResolvedValueOnce({ ...projectView(), metadata: { ...metadata(), targetLocales: ["ss", "sss", "x-example"] } });
    await createProject(user);
    expect(screen.getByText("Swati")).toHaveTextContent("Swati (ss)");
    expect(screen.getByText("Sô")).toHaveTextContent("Sô (sss)");
    expect(screen.getByText("x-example", { selector: ".locale-chip" })).toHaveTextContent(/^x-example$/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = screen.getByRole("dialog", { name: "Settings" });
    await user.selectOptions(within(settings).getByRole("combobox", { name: "Interface language" }), "zh-CN");
    await user.click(within(settings).getByRole("button", { name: "关闭设置" }));
    expect(screen.getByText("斯瓦蒂语")).toHaveTextContent("斯瓦蒂语 (ss)");
    expect(screen.getByText("Sô")).toHaveTextContent("Sô (sss)");
  });
  it("edits the complete target scope and retains rejected drafts", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Edit target languages" }));
    const field = screen.getByRole("textbox", { name: "Target locales" });
    expect(field).toHaveValue("zh-CN");
    await user.clear(field);
    await user.type(field, "ssss");
    mocks.invoke.mockRejectedValueOnce({ code: "invalid-input", outcome: "rejected", stage: "set-target-locales", field: "targetLocales", recoveryRequired: false });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveValue("ssss");
    await user.clear(field);
    await user.type(field, "fr-FR");
    mocks.invoke.mockResolvedValueOnce({ sessionToken: "session-1", locator: "C:\\Projects\\demo", metadata: { ...metadata("Demo", "2"), targetLocales: ["fr-FR"] }, outcome: "changed", directoryChanged: false });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Target locales" })).not.toBeInTheDocument());
    expect(mocks.invoke).toHaveBeenLastCalledWith("set_target_locales", { request: { sessionToken: "session-1", expectedRevision: "1", targetLocales: ["fr-FR"] } });
    await user.click(screen.getByRole("button", { name: "Edit target languages" }));
    expect(screen.getByRole("textbox", { name: "Target locales" })).toHaveValue("fr-FR");
  });

  it("suggests the project name as the folder until the folder is edited", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));
    const name = screen.getByLabelText(/Project name/);
    const folder = screen.getByLabelText(/New folder name/);
    await user.type(name, "Demo 项目");
    expect(folder).toHaveValue("Demo 项目");
    expect(name.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.clear(folder);
    await user.type(folder, "custom-folder");
    await user.type(name, " renamed");
    expect(folder).toHaveValue("custom-folder");
  });

  it("routes Escape through create cancellation and retains the draft when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.type(screen.getByLabelText(/Project name/), "Draft");
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/Project name/)).toHaveValue("Draft");
  });

  it("cancels an editor with Escape without saving its draft", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.type(screen.getByRole("textbox", { name: /Project name/ }), " draft");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: /Project name/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Demo" })).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("rename_project", expect.anything());
  });

  it("uses the rename form's required and trim validation for Ctrl+S", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(nameInput);
    await user.type(nameInput, "   ");
    await user.keyboard("{Control>}s{/Control}");
    const form = nameInput.closest("form")!;
    expect(await within(form).findByText("Enter a project name.")).toBeVisible();
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(nameInput).toHaveValue("   ");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(within(form).getByText("Enter a project name.")).toBeVisible();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(0);
  });

  it("does not send an empty project name through Meta+S", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(nameInput);
    await user.keyboard("{Meta>}s{/Meta}");
    expect(await within(nameInput.closest("form")!).findByText("Enter a project name.")).toBeVisible();
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(nameInput).toHaveValue("");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(0);
  });

  it.each([
    { editor: "Rename", field: "Project name", command: "rename_project", error: "Enter a project name." },
    { editor: "Edit target languages", field: "Target locales", command: "set_target_locales",
      error: "Enter at least one valid target language tag, such as zh-Hans. Remove duplicate languages." },
  ])("validates a blank $field before Save and continue without leaving the project", async ({ editor, field, command, error }) => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: editor }));
    const input = screen.getByRole("textbox", { name: field });
    await user.clear(input);
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Close project" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    expect(await within(dialog).findByText(error)).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveValue("   ");
    expect(mocks.invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(0);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "close_project")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(input).toHaveValue("   ");
    expect(input).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(0);
  });

  it("saves hidden metadata from the window-close dialog after entering Tasks", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(input);
    await user.type(input, "Hidden draft");
    mocks.invoke.mockImplementation(async (command: string, args?: { request?: unknown }) => {
      if (command === "list_execution_tasks") return [];
      if (command === "rename_project") return {
        sessionToken: "session-1", locator: "C:\\Projects\\demo",
        metadata: metadata("Hidden draft", "2"), outcome: "changed", directoryChanged: false,
      };
      if (command === "close_project") return { closed: true };
      if (command === "stop_application_plugin_instances") return { actionId: (args?.request as { actionId: string }).actionId, state: "stopped" };
      return projectView();
    });
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    await user.keyboard("{Control>}s{/Control}");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(0);
    const event = { preventDefault: vi.fn() };
    await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0](event); });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(1));
    expect(mocks.invoke).toHaveBeenCalledWith("rename_project", {
      request: { sessionToken: "session-1", expectedRevision: "1", displayName: "Hidden draft" },
    });
    await waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(1);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    { editor: "Rename", field: "Project name", command: "rename_project", error: "Enter a project name." },
    { editor: "Edit target languages", field: "Target locales", command: "set_target_locales",
      error: "Enter at least one valid target language tag, such as zh-Hans. Remove duplicate languages." },
  ])("validates hidden metadata $field from the window-close dialog after entering Tasks", async ({ editor, field, command, error }) => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: editor }));
    const input = screen.getByRole("textbox", { name: field });
    await user.clear(input);
    await user.type(input, "   ");
    mocks.invoke.mockImplementation(async (name: string) => name === "list_execution_tasks" ? [] : projectView());
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    await user.keyboard("{Control>}s{/Control}");
    expect(mocks.invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(0);
    await act(async () => { await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault: vi.fn() }); });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    expect(await within(dialog).findByText(error)).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(mocks.invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(0);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "close_project")).toHaveLength(0);
    expect(mocks.destroy).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    expect(screen.getByRole("textbox", { name: field })).toHaveValue("   ");
    expect(input).toBeEnabled();
  });

  it("optionally synchronizes the project folder when saving a rename", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed project");
    await user.click(screen.getByRole("checkbox", { name: "Also rename the project folder" }));
    mocks.invoke.mockResolvedValueOnce({
      sessionToken: "session-1",
      locator: "C:\\Projects\\Renamed project",
      metadata: metadata("Renamed project", "2"),
      outcome: "changed",
      directoryChanged: true,
    });

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Renamed project" })).toBeInTheDocument());
    expect(mocks.invoke).toHaveBeenCalledWith("rename_project", {
      request: {
        sessionToken: "session-1",
        expectedRevision: "1",
        displayName: "Renamed project",
        directoryName: "Renamed project",
      },
    });
    expect(screen.getByText("Project name and folder saved.")).toBeInTheDocument();
  });

  beforeEach(async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    localStorage.clear();
    mocks.reads = null;
    mocks.commands = null;
    mocks.drafts.clear();
    mocks.contextCallbacks.clear();
    mocks.memories.clear();
    await i18n.changeLanguage("en-US");
    mocks.join.mockResolvedValue("C:\\Projects\\demo");
    mocks.sep.mockReturnValue("\\");
    mocks.open.mockResolvedValue(null);
    mocks.onCloseRequested.mockResolvedValue(() => undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.destroy.mockResolvedValue(undefined);
    mocks.invoke.mockImplementation(async (command: string, args?: { request?: unknown }) => {
      if (command === "read_execution_task_activity") return emptyTaskActivity(args?.request);
      if (command === "read_context_strategy_default") {
        expect(mocks.reads).not.toBeNull();
        expect(args?.request).toEqual({
          projectId: mocks.reads!.context.projectId,
          sessionToken: mocks.reads!.context.sessionToken,
          locale: expect.stringMatching(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/),
        });
        return null;
      }
      if (command === "create_project") return projectView();
      if (command === "close_project") return { closed: true };
      if (command === "stop_application_plugin_instances") return { actionId: (args?.request as { actionId: string }).actionId, state: "stopped" };
      return projectView();
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.resetAllMocks();
  });

  it.each([
    ["en-US", "unsupported-schema", "storage-mode", "errors.unsupportedStorage"],
    ["zh-CN", "unsupported-schema", "storage-mode", "errors.unsupportedStorage"],
    ["en-US", "unsupported-schema", undefined, "errors.unsupportedSchema"],
    ["en-US", "corrupt-project", undefined, "errors.corruptProject"],
  ] as const)("current storage refusal %s %s %s stays actionable", async (language, code, reason, message) => {
    const user = userEvent.setup();
    await renderApp();
    await i18n.changeLanguage(language);
    await user.click(screen.getByRole("button", { name: i18n.t("empty.open") }));
    const directory = screen.getByRole("textbox", { name: new RegExp(i18n.t("open.destination")) });
    await user.type(directory, "C:\\Projects\\unsupported");
    mocks.invoke.mockRejectedValueOnce({ code, ...(reason ? { reason } : {}), stage: "open", outcome: "rejected", recoveryRequired: false });
    await user.click(screen.getByRole("button", { name: i18n.t("open.submit") }));
    expect(await screen.findByText(i18n.t(message))).toBeInTheDocument();
    expect(directory).toHaveValue("C:\\Projects\\unsupported");
    expect(screen.getByRole("button", { name: i18n.t("open.submit") })).toBeEnabled();
    await user.clear(directory);
    await user.type(directory, "C:\\Projects\\supported");
    await user.click(screen.getByRole("button", { name: i18n.t("open.submit") }));
    expect(await screen.findByRole("heading", { name: "Demo" })).toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_project")).toHaveLength(2);
  });

  it("uses the native picker to fill paths without inventing a command success", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));
    mocks.open.mockResolvedValue("C:\\Projects");
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(screen.getByLabelText(/Parent folder/)).toHaveValue("C:\\Projects");
    expect(mocks.invoke).not.toHaveBeenCalledWith("create_project", expect.anything());
  });

  it("shows human-readable locale presets while keeping custom locale tags available", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));

    const sourcePreset = screen.getByRole("combobox", { name: "Common source languages" });
    const targetPreset = screen.getByRole("combobox", { name: "Common target languages" });
    expect(within(sourcePreset).getByRole("option", { name: "Simplified Chinese" })).toBeInTheDocument();
    expect(within(sourcePreset).getByRole("option", { name: "Traditional Chinese" })).toBeInTheDocument();

    await user.selectOptions(sourcePreset, "zh-Hans");
    expect(screen.getByRole("textbox", { name: /Source locale/ })).toHaveValue("zh-Hans");
    await user.selectOptions(targetPreset, "ja-JP");
    expect(screen.getByRole("textbox", { name: /Target locales/ })).toHaveValue("zh-Hans, ja-JP");
  });

  it("protects an unfinished create form when the user cancels it", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.type(screen.getByLabelText(/Project name/), "Draft project");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Your new project is not created yet.");
    expect(within(dialog).getByRole("button", { name: "Keep editing" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText(/Project name/)).toHaveValue("Draft project");
  });

  it.each(["C:\\Projects\\demo", "\\\\?\\C:\\Projects\\demo"])("keeps a draft when reopening the active locator %s", async (locator) => {
    const user = userEvent.setup();
    await renderApp();
    mocks.invoke.mockResolvedValueOnce({ ...projectView(), locator });
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const editor = screen.getByRole("textbox", { name: /Project name/ });
    await user.type(editor, " draft");
    await user.click(screen.getByRole("button", { name: "Open another" }));
    await user.type(screen.getByRole("textbox", { name: /Project folder/ }), "C:/Projects/./demo");
    await user.click(screen.getByRole("button", { name: "Open project" }));

    expect(await screen.findByText("This project is already open.")).toBeInTheDocument();
    expect(editor).toHaveValue("Demo draft");
    expect(mocks.invoke).not.toHaveBeenCalledWith("open_project", expect.anything());
  });

  it("asks before restoring the last project after restart", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      LAST_OPEN_PROJECT_STORAGE_KEY,
      JSON.stringify({ locator: "C:\\Projects\\demo", lastOpenedAt: 1 }),
    );
    await renderApp();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Open your last project?")).toBeInTheDocument();
    const settingsTrigger = screen.getByText("Settings", { selector: ".app-settings-trigger span" }).closest("button")!;
    fireEvent.click(settingsTrigger); expect(screen.getAllByRole("dialog")).toEqual([dialog]);
    await user.click(within(dialog).getByRole("button", { name: "Start without opening" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create project" })).toBeInTheDocument();
  });

  it("keeps a failed draft and translates an existing feedback key at render time", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: /Project name/ });
    await user.clear(nameInput);
    await user.type(nameInput, "Failed draft");
    mocks.invoke.mockRejectedValueOnce({ code: "storage-failed", outcome: "rejected", stage: "rename", recoveryRequired: false });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("The project could not be read or saved. Your current draft is still here.")).toBeInTheDocument());
    expect(nameInput).toHaveValue("Failed draft");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = screen.getByRole("dialog", { name: "Settings" });
    await user.selectOptions(within(settings).getByRole("combobox", { name: "Interface language" }), "zh-CN");
    await user.click(within(settings).getByRole("button", { name: "关闭设置" }));
    await waitFor(() => expect(screen.getByText("项目无法读取或保存。当前草稿仍保留在这里。")).toBeInTheDocument());
  });

  it("traps dialog focus, cancels on Escape and restores the initiating control", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.type(screen.getByRole("textbox", { name: /Project name/ }), " draft");
    const closeButton = screen.getByRole("button", { name: "Close project" });
    await user.click(closeButton);
    const dialog = await screen.findByRole("dialog");
    const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancelButton).toHaveFocus());
    await user.tab();
    expect(within(dialog).getByRole("button", { name: /Discard/ })).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancelButton).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(closeButton).toHaveFocus();
    expect(screen.getByRole("textbox", { name: /Project name/ })).toHaveValue("Demo draft");
  });

  it("discards a dirty draft before closing when the dialog choice requests it", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.type(screen.getByRole("textbox", { name: /Project name/ }), " draft");
    await user.click(screen.getByRole("button", { name: "Close project" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Discard/ }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Demo" })).not.toBeInTheDocument());
    expect(mocks.invoke).toHaveBeenCalledWith("close_project", { request: { sessionToken: "session-1" } });
  });

  it("saves a dirty draft before closing when the dialog choice requests it", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.type(screen.getByRole("textbox", { name: /Project name/ }), " draft");
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "rename_project") {
        return { sessionToken: "session-1", locator: "C:\\Projects\\demo", metadata: metadata("Demo draft", "2"), outcome: "changed", directoryChanged: false };
      }
      if (command === "close_project") return { closed: true };
      return projectView();
    });
    await user.click(screen.getByRole("button", { name: "Close project" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Demo draft" })).not.toBeInTheDocument());
    expect(mocks.invoke).toHaveBeenCalledWith("rename_project", {
      request: { sessionToken: "session-1", expectedRevision: "1", displayName: "Demo draft" },
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenCalledWith("close_project", { request: { sessionToken: "session-1" } });
  });

  it("reconciles an uncertain save exactly once before clearing the draft", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: /Project name/ });
    await user.clear(nameInput);
    await user.type(nameInput, "Committed");
    mocks.invoke.mockImplementationOnce(async (command: string) => {
      if (command === "rename_project") throw { code: "outcome-unknown", outcome: "unknown", stage: "rename", recoveryRequired: true };
      return projectView();
    }).mockImplementationOnce(async (command: string) => {
      if (command === "read_project") return projectView("Committed", "2", "committed");
      return projectView();
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("The change was confirmed.")).toBeInTheDocument());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "rename_project")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_project")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("keeps uncertain saves recoverable when the first reconciliation sees the previous state", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: /Project name/ });
    await user.clear(nameInput);
    await user.type(nameInput, "Not committed");
    mocks.invoke.mockImplementationOnce(async (command: string) => {
      if (command === "rename_project") throw { code: "outcome-unknown", outcome: "unknown", stage: "rename", recoveryRequired: true };
      return projectView();
    }).mockImplementationOnce(async (command: string) => {
      if (command === "read_project") return projectView("Demo", "1", "previous");
      return projectView();
    });

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("The uncertain save was not committed. Your draft remains here.")).toBeInTheDocument());
    // PL-04: a confirmed previous state is settled; retaining the draft allows
    // a new explicit save, rather than repeatedly reading an already known result.
    expect(screen.queryByRole("button", { name: "Retry read" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(nameInput).toHaveValue("Not committed");
  });


  it.each([false, true])("routes the exact saved plugin build through the App owner while preserving a dirty mapping: %s", async dirty => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const saved = { ...structuredClone(savedPluginBuild), projectId: metadata().projectId };
    const locale = saved.locales[0];
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "read_plugin_inventory") return pluginInventory.empty;
      if (command === "list_releases") return [];
      if (command === "execution_status") return executionFixture.status;
      if (command === "list_execution_tasks") return [{ ...executionFixture.task, projectId: saved.projectId, taskId: saved.taskId, operation: "locale-build" }];
      if (command === "read_execution_task") return [{ attemptId: saved.attemptId, sequence: "1" }];
      if (command === "read_execution_task_view") return { ...executionFixture.task, projectId: saved.projectId, taskId: saved.taskId, operation: "locale-build" };
      if (command === "read_execution_continuations") return { receipts: [], next: null };
      if (command === "read_execution_attempt") return { ...executionFixture.detail, taskId: saved.taskId, attemptId: saved.attemptId, operation: "locale-build",
        progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
        items: [{ scope: { kind: "release-build", id: saved.sourceSnapshotId, locale: "zh-CN" }, status: locale.status, resultId: locale.result!.resultId }],
        recovery: { attemptId: saved.attemptId, units: [] } };
      if (command === "read_saved_plugin_build") return saved;
      throw new Error(`Unexpected command: ${command}`);
    });
    if (dirty) {
      await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
      await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
      await user.type(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) }), "deliverables/original-draft.txt");
    }
    await user.click(screen.getByRole("button", { name: i18n.t("execution.title") }));
    await user.click(await screen.findByRole("button", { name: `${i18n.t("release.title")} · ${i18n.t("execution.taskNumber", { number: executionFixture.task.sequence })}` }));
    await user.click(await screen.findByRole("button", { name: i18n.t("releasePlugin.savedOpen") }));
    if (dirty) {
      expect(await screen.findByText(i18n.t("execution.savedBuildBlocked"))).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: i18n.t("execution.title") })).toBeVisible();
      expect(mocks.invoke.mock.calls.some(([command]) => command === "read_saved_plugin_build")).toBe(false);
      await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
      expect(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) })).toHaveValue("deliverables/original-draft.txt");
    } else {
      expect(await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") })).toHaveTextContent(i18n.t("releasePlugin.savedReadOnly"));
      expect(screen.getByRole("heading", { name: i18n.t("release.title") })).toBeVisible();
      expect(mocks.invoke).toHaveBeenCalledWith("read_saved_plugin_build", { request: { sessionToken: "session-1", projectId: saved.projectId, attemptId: saved.attemptId } });
      expect(screen.queryByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") })).not.toBeInTheDocument();
    }
    expect(mocks.invoke.mock.calls.some(([command]) => ["prepare_plugin_build", "start_plugin_build", "prepare_artifact_check", "start_artifact_check", "adopt_execution", "create_execution_identity"].includes(command))).toBe(false);
  });

  it.each([["/", "/synthetic/projects/", "/synthetic/projects/demo"], ["/", "/", "/demo"], ["\\", "C:\\Projects\\", "C:\\Projects\\demo"]])("previews a new project with the native separator %s under %s", async (separator, parent, destination) => {
    mocks.sep.mockReturnValue(separator);
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.type(screen.getByLabelText(/Parent folder/), parent);
    const directoryName = screen.getByLabelText(/New folder name/);
    await user.clear(directoryName);
    await user.type(directoryName, "demo");
    expect(screen.getByText(destination, { selector: "code" })).toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_project")).toBe(false);
  });

  it("guards area navigation and restores the saved editor after returning from Tasks", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const fixture = installTranslationEditor();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "first" }));
    const editor = await editableDraft();
    await user.type(editor, "Draft");
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
    expect(fixture.saves()).toHaveLength(0);
    await user.keyboard("{Control>}s{/Control}");
    expect(fixture.saves()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Translations" }));
    const restored = await editableDraft(); expect(restored).toHaveValue("Draft");
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close project" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Close project" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave with an unsaved translation?" });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_project")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Translations", hidden: true })).toHaveAttribute("aria-current", "page");
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    const continued = await editableDraft(); expect(continued).toHaveValue("Draft");
    await user.click(continued); await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Draft");
    expect(screen.getByRole("button", { name: "first" })).toHaveAttribute("aria-current", "true");
    expect(fixture.saves()).toHaveLength(1);
    expect(fixture.protections()).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2);
  });

  it("isolates extension shortcuts and preserves a project draft during an unknown package change", async () => {
    const user = userEvent.setup();
    await renderApp();
    await createProject(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const draft = screen.getByRole("textbox", { name: /Project name/ });
    await user.type(draft, " draft");
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "read_plugin_inventory") return pluginInventory.empty;
      if (command === "select_plugin_package") return pluginCandidate;
      if (command === "install_plugin_package") throw { code: "outcome-unknown", stage: "plugin-install", outcome: "unknown", recoveryRequired: true, reason: "plugin-result-unconfirmed" };
      return projectView();
    });
    await user.click(screen.getByRole("button", { name: "Extensions" }));
    await screen.findByRole("button", { name: "Choose plugin folder" });
    await user.keyboard("{Control>}s{/Control}");
    expect(mocks.invoke).not.toHaveBeenCalledWith("rename_project", expect.anything());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(draft).toHaveValue("Demo draft");
    await user.click(screen.getByRole("button", { name: "Extensions" }));
    await user.click(await screen.findByRole("button", { name: "Choose plugin folder" }));
    await user.click(await screen.findByRole("checkbox", { name: /I trust this exact/ }));
    await user.click(screen.getByRole("button", { name: "Approve and install" }));
    await screen.findByRole("button", { name: "Retry original operation" });
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.keyboard("{Control>}s{/Control}");
    expect(mocks.invoke).not.toHaveBeenCalledWith("rename_project", expect.anything());
    expect(draft).toHaveValue("Demo draft");
    const preventDefault = vi.fn();
    await mocks.onCloseRequested.mock.calls.at(-1)![0]({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
  it("connection draft survives project creation and closing in the actual App assembly", async () => {
    const user=userEvent.setup();await renderApp();const original=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command,args)=>command === "read_model_connections" ? Promise.resolve({snapshot:{storeId:null,revision:"0",lastActionId:null,profiles:[]},basis:{storeId:null,revision:"0",digest:"a".repeat(64)},references:[]}) : original(command,args));
    await openConnectionSettings(user);await screen.findByText(i18n.t("connections.empty"));
    await user.type(screen.getByLabelText(i18n.t("connections.name")),"Application draft B 日本語 مرحبا 👩🏽‍💻 é");
    await user.click(screen.getByRole("button",{name:i18n.t("connections.close")}));await createProject(user);
    await user.click(screen.getByRole("button",{name:"Close project"}));await screen.findByRole("button",{name:"Create project"});
    await openConnectionSettings(user);
    expect(screen.getByLabelText(i18n.t("connections.name"))).toHaveValue("Application draft B 日本語 مرحبا 👩🏽‍💻 é");
    expect(mocks.invoke.mock.calls.filter(([command])=>command === "change_model_connections")).toHaveLength(0);
  });
  it("connection window exit waits for a checked application-draft decision without a project", async () => {
    const user=userEvent.setup();await renderApp();mocks.invoke.mockImplementation(async (command: string, args?: { request?: unknown })=>{
      if(command === "read_model_connections")return {snapshot:{storeId:null,revision:"0",lastActionId:null,profiles:[]},basis:{storeId:null,revision:"0",digest:"a".repeat(64)},references:[]};
      if(command === "stop_application_plugin_instances") {
        const request = args?.request;
        if (!validateRequestApplicationShutdown(request)) throw new Error("Invalid application shutdown request");
        return { actionId: request.actionId, state: "stopped" };
      }
      throw new Error(command);
    });
    await openConnectionSettings(user);await screen.findByText(i18n.t("connections.empty"));
    await user.type(screen.getByLabelText(i18n.t("connections.name")),"Unsaved A");await user.click(screen.getByRole("button",{name:i18n.t("connections.close")}));
    let close!:Promise<unknown>;act(()=>{close=mocks.onCloseRequested.mock.calls.at(-1)![0]({preventDefault:vi.fn()});});
    await screen.findByRole("heading",{name:i18n.t("connections.exitTitle")});expect(mocks.destroy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button",{name:i18n.t("connections.continueEditing")}));await close;expect(screen.getByLabelText(i18n.t("connections.name"))).toHaveValue("Unsaved A");
    expect(mocks.invoke.mock.calls.filter(([command])=>command === "stop_application_plugin_instances")).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:i18n.t("connections.close")}));act(()=>{close=mocks.onCloseRequested.mock.calls.at(-1)![0]({preventDefault:vi.fn()});});
    await screen.findByRole("heading",{name:i18n.t("connections.exitTitle")});await user.click(screen.getByRole("button",{name:i18n.t("connections.discardAndExit")}));await close;
    await waitFor(()=>expect(mocks.destroy).toHaveBeenCalledOnce());
    expect(mocks.invoke.mock.calls.filter(([command])=>command === "stop_application_plugin_instances")).toHaveLength(1);
  });
  it("connection discard permission also protects the actual project close before native destroy", async () => {
    const user=userEvent.setup();await renderApp();await createProject(user);const original=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command,args)=>command === "read_model_connections" ? Promise.resolve({snapshot:{storeId:null,revision:"0",lastActionId:null,profiles:[]},basis:{storeId:null,revision:"0",digest:"a".repeat(64)},references:[]}) : original(command,args));
    await openConnectionSettings(user);
    await screen.findByText(i18n.t("connections.empty"));
    await user.type(screen.getByLabelText(i18n.t("connections.name")), "Application A");
    await user.click(screen.getByRole("button", { name: i18n.t("connections.close") }));
    let close!:Promise<unknown>;act(()=>{close=mocks.onCloseRequested.mock.calls.at(-1)![0]({preventDefault:vi.fn()});});await screen.findByRole("heading",{name:i18n.t("connections.exitTitle")});
    expect(mocks.invoke.mock.calls.filter(([command])=>command === "close_project")).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:i18n.t("connections.discardAndExit")}));await close;await waitFor(()=>expect(mocks.destroy).toHaveBeenCalledOnce());
    expect(mocks.invoke).toHaveBeenCalledWith("close_project",{request:{sessionToken:"session-1"}});
  });
  it("connection unknown result remains recoverable inside the actual window-close blocker", async () => {
    const user=userEvent.setup();await renderApp();mocks.invoke.mockImplementation(async command=>{if(command === "read_model_connections")return {snapshot:{storeId:null,revision:"0",lastActionId:null,profiles:[]},basis:{storeId:null,revision:"0",digest:"a".repeat(64)},references:[]};throw {code:"outcome-unknown",stage:"model-connections",outcome:"unknown",recoveryRequired:true};});
    await openConnectionSettings(user);await screen.findByText(i18n.t("connections.empty"));
    await user.type(screen.getByLabelText(i18n.t("connections.name")),"Unknown A");await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));await screen.findByRole("button",{name:i18n.t("connections.reconcile")});
    const write = mocks.invoke.mock.calls.find(([command]) => command === "change_model_connections");
    if (!write) throw new Error("No original connection write");
    const request = structuredClone(write[1].request);
    await user.click(screen.getByRole("button", { name: i18n.t("connections.close") }));
    await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("nav.settings") })).toHaveFocus());
    const reopened = await openConnectionSettings(user);
    expect(screen.getAllByRole("dialog")).toEqual([reopened]);
    expect(within(reopened).getByLabelText(i18n.t("connections.name"))).toHaveValue("Unknown A");
    expect(within(reopened).getByRole("button", { name: i18n.t("connections.reconcile") })).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "change_model_connections")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.find(([command]) => command === "change_model_connections")?.[1].request).toEqual(request);
    await user.click(screen.getByRole("button",{name:i18n.t("connections.close")}));await act(async()=>{await mocks.onCloseRequested.mock.calls.at(-1)![0]({preventDefault:vi.fn()});});
    expect(mocks.destroy).not.toHaveBeenCalled();expect(screen.getByRole("button",{name:i18n.t("connections.reconcile")})).toBeEnabled();expect(screen.getByLabelText(i18n.t("connections.name"))).toHaveValue("Unknown A");
    await screen.findByText(i18n.t("connections.notices.exit-blocked"));
  });

});

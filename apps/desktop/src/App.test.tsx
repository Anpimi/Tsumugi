import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { reviewTargetFixture, reviewSummaryFor, reviewSummaryPageFixture } from "./testSupport/reviewFixture";
import { LAST_OPEN_PROJECT_STORAGE_KEY, readRecentProjects } from "./recentProjects";
import { defaultAiConfig, type AiItem, type AiPrepared, type AiView } from "./aiCommands";
import { aiViewFixture } from "./testSupport/aiFixture";
import type { SessionReads } from "./sessionReads";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  join: vi.fn(),
  open: vi.fn(),
  onCloseRequested: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
  reads: null as SessionReads | null,
}));

// Composition tests isolate native notifications; the bridge has its own race tests.
vi.mock("./SessionReadProvider", async importOriginal => {
  const actual = await importOriginal<typeof import("./SessionReadProvider")>();
  function CaptureReads() { mocks.reads = actual.useSessionReads(); return null; }
  return { ...actual, SessionReadProvider: (props: React.ComponentProps<typeof actual.SessionReadProvider>) =>
    <actual.SessionReadProvider {...props} bridge={false}><CaptureReads />{props.children}</actual.SessionReadProvider> };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/path", () => ({ join: mocks.join }));
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

async function prepareAiInApp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "AI translation" }));
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
  const target = reviewTargetFixture({ unitId: fixtureIdentity(501), nativeKey: "first", sourceSnapshotId: fixtureIdentity(500), sourceRevisionId: fixtureIdentity(502), sourceText: "Hello", selectionId: null, revisionId: null, translationText: null, basis: "basis" });
  let text: string | null = null;
  let selection: { eventId: string; revisionId: string; unitId: string; locale: string; actionId: string; sequence: string; previousEventId: string | null } | null = null;
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
    if (command === "read_review_editor_snapshot") return {
      target: { ...target, locale, selectionId: selection?.eventId ?? null, revisionId: selection?.revisionId ?? null, translationText: text },
      translations: { unitId: fixtureIdentity(501), locale, total: selection?.sequence ?? "0", rows: [], nextOrdinal: null, currentText: text, current: selection },
      terms: { unitId: fixtureIdentity(501), locale, sourceRevisionId: fixtureIdentity(502), entries: [] },
      context: null, readVersion: "view",
    };
    if (command === "create_execution_identity") return fixtureIdentity(1 + mocks.invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length);
    if (command === "save_translation_revision") return onSave(args.request, () => commit(args.request));
    if (command === "execution_status") return { active: false, quiescing: false, queryCount: 0, error: null };
    if (command === "list_execution_tasks") return [];
    return projectView();
  });
  return { setSave: (handler: typeof onSave) => { onSave = handler; }, saves: () => mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision") };
}

function installAiPreparation() {
  const unitId = fixtureIdentity(501);
  let sourceVersion = 0;
  let resourceVersion = 0;
  let lastConfig = { ...defaultAiConfig };
  const item = (): AiItem => ({ unitId, sourceRevisionId: fixtureIdentity(502 + sourceVersion),
    sourceSnapshotId: fixtureIdentity(500 + sourceVersion), nativeKey: "first", sourceLocale: "en-US",
    sourceText: sourceVersion ? "Updated source" : "Hello", targetLocale: "zh-CN", terms: [], context: null,
    omissions: [], resourceBaseline: String(resourceVersion) });
  const originalInvoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: String(2 + sourceVersion), currentSnapshot: fixtureIdentity(500 + sourceVersion) };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: fixtureIdentity(500 + sourceVersion),
      scope: { revision: String(2 + sourceVersion), currentSnapshot: fixtureIdentity(500 + sourceVersion) },
      rows: [sourceRowFixture({ unitId, sourceRevisionId: fixtureIdentity(502 + sourceVersion) },
        { key: "first", text: sourceVersion ? "Updated source" : "Hello" })] });
    if (command === "read_terms" || command === "list_resource_captures") return [];
    if (command === "preview_ai_translation") {
      lastConfig = args.request.config as typeof defaultAiConfig;
      return { attemptId: fixtureIdentity(510 + sourceVersion + resourceVersion), preview: {
        config: lastConfig, recipe: "direct-translation-1",
        digest: `preview-${sourceVersion}-${resourceVersion}-${Number(lastConfig.shareTerms)}-${Number(lastConfig.shareContext)}`,
        items: [item()],
      } } satisfies AiPrepared;
    }
    if (command === "start_ai_translation") return args.request.attemptId;
    if (command === "read_ai_translation") return aiViewFixture(item(), lastConfig);
    return originalInvoke(command, args);
  });
  return {
    changeSource: () => { sourceVersion++; },
    changeResources: () => { resourceVersion++; },
    view: (): AiView => aiViewFixture(item(), lastConfig),
  };
}

describe("project lifecycle workbench", () => {
  it("preserves AI configuration, scope, preview, and consent through registered resource navigation", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    installAiPreparation();
    await prepareAiInApp(user);
    expect(document.querySelector("section.ai-dialog")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Glossary and context" }));
    await screen.findByRole("region", { name: "Glossary and context" });
    expect(document.querySelector("section.ai-dialog")).toBeNull();
    expect(screen.queryByRole("dialog", { name: /unsaved/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "AI translation" }));
    expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("test-model");
    expect(screen.getByRole("checkbox", { name: "first: Hello" })).toBeChecked();
    expect(screen.getByRole("heading", { name: "Data sharing preview" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /I confirm sending/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_ai_translation")).toHaveLength(0);
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
      await user.click(screen.getByRole("button", { name: "AI translation" }));
      if (change === "sharing") await user.click(screen.getByRole("checkbox", { name: "Share applicable adopted terms" }));
      expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("test-model");
      expect(await screen.findByRole("checkbox", { name: change === "source" ? "first: Updated source" : "first: Hello" })).toBeChecked();
      expect(screen.queryByRole("heading", { name: "Data sharing preview" })).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: /I confirm sending/ })).not.toBeInTheDocument();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_ai_translation")).toHaveLength(0);
      await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
      await screen.findByRole("heading", { name: "Data sharing preview" });
      expect(screen.getByRole("checkbox", { name: /I confirm sending/ })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeDisabled();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "preview_ai_translation")).toHaveLength(2);
    },
  );

  it("does not revive an in-flight AI preview after its resource basis changes", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const facts = installAiPreparation();
    const original = mocks.invoke.getMockImplementation()!;
    let finishOldPreview: (() => void) | undefined;
    let previews = 0;
    mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
      if (command === "preview_ai_translation" && previews++ === 0) {
        const oldPreview = await original(command, args) as AiPrepared;
        return new Promise<AiPrepared>(resolve => { finishOldPreview = () => resolve(oldPreview); });
      }
      return original(command, args);
    });
    await user.click(screen.getByRole("button", { name: "AI translation" }));
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
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "start_ai_translation")).toHaveLength(0);
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
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await user.click(screen.getByRole("button", { name: "Open another" }));
    await user.type(screen.getByRole("textbox", { name: /Project folder/ }), "C:\\Projects\\other");
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await screen.findByRole("heading", { name: "Other" });
    await act(async () => finishOldRead(facts.view()));
    await user.click(screen.getByRole("button", { name: "AI translation" }));
    expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("");
    expect(screen.queryByRole("heading", { name: "Data sharing preview" })).not.toBeInTheDocument();
    expect(screen.queryByText("test-model")).not.toBeInTheDocument();
    expect(mocks.reads?.context.sessionToken).toBe("session-2");
    expect(mocks.reads?.client.getQueryCache().getAll().every(query =>
      query.queryKey[0] === otherProject.metadata.projectId && query.queryKey[1] === otherProject.sessionToken)).toBe(true);
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
    await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "New language draft");
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
    const target = reviewTargetFixture({ unitId: fixtureIdentity(501), nativeKey: "first", sourceSnapshotId: fixtureIdentity(500), sourceRevisionId: fixtureIdentity(502), sourceText: "Hello", selectionId: null, revisionId: null, translationText: null, basis: "basis" });
    let text: string | null = null;
    mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
      if (command === "read_content_scope") return { revision: "2", currentSnapshot: fixtureIdentity(500) };
      if (command === "read_source_content") return sourcePageFixture({ snapshotId: fixtureIdentity(500), scope: { revision: "2", currentSnapshot: fixtureIdentity(500) }, namespace: "Example.Mod", rows: [], total: 1 });
      if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor({ ...target, translationText: text })]);
      if (command === "read_review_editor_snapshot") return {
        target: { ...target, translationText: text },
        translations: { unitId: fixtureIdentity(501), locale: "zh-CN", total: "0", rows: [], nextOrdinal: null,
          currentText: text, current: text === null ? null : { eventId: fixtureIdentity(503), revisionId: fixtureIdentity(504), unitId: fixtureIdentity(501), locale: "zh-CN", actionId: fixtureIdentity(1), sequence: "1", previousEventId: null } },
        terms: { unitId: fixtureIdentity(501), locale: "zh-CN", sourceRevisionId: fixtureIdentity(502), entries: [] },
        context: null, readVersion: "view",
      };
      if (command === "read_review_target") return { ...target, translationText: text };
      if (command === "read_translation_history") return { unitId: fixtureIdentity(501), locale: "zh-CN", total: "0", rows: [], nextOrdinal: null, currentText: text, current: text === null ? null : { eventId: fixtureIdentity(503), revisionId: fixtureIdentity(504), unitId: fixtureIdentity(501), locale: "zh-CN", actionId: fixtureIdentity(1), sequence: "1", previousEventId: null } };
      if (command === "resolve_terms") return { unitId: fixtureIdentity(501), locale: "zh-CN", sourceRevisionId: fixtureIdentity(502), entries: [] };
      if (command === "read_context_revision") return null;
      if (command === "create_execution_identity") return fixtureIdentity(1);
      if (command === "save_translation_revision") {
        text = String(args.request.text);
        const actionId = args.request.actionId, unitId = args.request.unitId, locale = args.request.locale;
        return { projectId: args.request.projectId, actionId,
          basis: { sourceSnapshotId: fixtureIdentity(500), sourceRevisionId: fixtureIdentity(502), selectionId: fixtureIdentity(503) },
          selection: { eventId: fixtureIdentity(503), revisionId: fixtureIdentity(504), unitId, locale, actionId, sequence: "1", previousEventId: null },
          revision: { revisionId: fixtureIdentity(504), unitId, locale, actionId, ordinal: "1", text,
            sourceSnapshotId: fixtureIdentity(500), sourceRevisionId: fixtureIdentity(502), originKind: "manual", contributors: [],
            attemptId: null, resultId: null, itemId: null, artifactId: null, logicalPath: null, declaredLocale: null, nativeKey: null, fileDigest: null } };
      }
      if (command === "execution_status") return { active: false, quiescing: false, queryCount: 0, error: null };
      if (command === "list_execution_tasks") return [];
      return projectView();
    });
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "first" }));
    const editor = await screen.findByRole("textbox", { name: "Your draft" });
    await user.type(editor, "Draft");
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    expect(screen.queryByRole("textbox", { name: "Your draft", hidden: true })).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Translations" }));
    const restored = await screen.findByRole("textbox", { name: "Your draft" });
    expect(restored).toHaveValue("Draft");
    await user.click(restored); await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Draft");
    expect(screen.getByRole("button", { name: "first" })).toHaveAttribute("aria-current", "true");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision")).toHaveLength(1);
  });

  it("keeps an unfinished review across area navigation and still confirms project leave", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const target = reviewTargetFixture({ unitId: fixtureIdentity(701), nativeKey: "first", sourceSnapshotId: fixtureIdentity(700),
      sourceRevisionId: fixtureIdentity(702), sourceText: "Hello", selectionId: fixtureIdentity(703),
      revisionId: fixtureIdentity(704), translationText: "你好", basis: "review-basis" });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(target)]);
      if (command === "read_review_target") return target;
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
    const editor = await screen.findByRole("textbox", { name: "Your draft" });
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
    expect(await screen.findByText(/Your newer draft is still here/)).toBeInTheDocument();
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
    const editor = await screen.findByRole("textbox", { name: "Your draft" });
    await user.type(editor, "A");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());

    fireEvent.compositionStart(editor);
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
    await user.click(screen.getByRole("button", { name: "Close project" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Leave with an unsaved translation?");
    await user.keyboard("{Control>}s{/Control}");
    expect(fixture.saves()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    const restoredEditor = await screen.findByRole("textbox", { name: "Your draft" });
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
    expect(mocks.invoke).toHaveBeenLastCalledWith("close_project", { request: { sessionToken: "session-1" } });
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
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "rename_project") throw { code: "outcome-unknown", outcome: "unknown", stage: "rename", recoveryRequired: true };
      if (command === "read_project") {
        reads += 1;
        if (reads === 1) throw new Error("read acknowledgement lost");
        return reads === 2 ? projectView("Unrelated", "3") : projectView("Committed", "2");
      }
      if (command === "close_project") return { closed: true };
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
    await user.selectOptions(screen.getByRole("combobox", { name: /language/i }), "zh-CN");
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
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_execution_tasks") return [];
      if (command === "rename_project") return {
        sessionToken: "session-1", locator: "C:\\Projects\\demo",
        metadata: metadata("Hidden draft", "2"), outcome: "changed", directoryChanged: false,
      };
      if (command === "close_project") return { closed: true };
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
    localStorage.clear();
    mocks.reads = null;
    await i18n.changeLanguage("en-US");
    mocks.join.mockResolvedValue("C:\\Projects\\demo");
    mocks.open.mockResolvedValue(null);
    mocks.onCloseRequested.mockResolvedValue(() => undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.destroy.mockResolvedValue(undefined);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "create_project") return projectView();
      if (command === "close_project") return { closed: true };
      return projectView();
    });
  });

  afterEach(() => {
    cleanup();
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

    await user.selectOptions(screen.getByRole("combobox"), "zh-CN");
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
});

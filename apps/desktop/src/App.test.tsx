import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture } from "./testSupport/sourceFixture";
import { LAST_OPEN_PROJECT_STORAGE_KEY, readRecentProjects } from "./recentProjects";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  join: vi.fn(),
  open: vi.fn(),
  onCloseRequested: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
}));

// Composition tests isolate native notifications; the bridge has its own race tests.
vi.mock("./SessionReadProvider", async importOriginal => {
  const actual = await importOriginal<typeof import("./SessionReadProvider")>();
  return { ...actual, SessionReadProvider: (props: React.ComponentProps<typeof actual.SessionReadProvider>) => <actual.SessionReadProvider {...props} bridge={false}/> };
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

describe("project lifecycle workbench", () => {
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

  it("guards area navigation and restores the saved editor after returning from Tasks", async () => {
    const user = userEvent.setup(); await renderApp(); await createProject(user);
    const target = { unitId: fixtureIdentity(501), locale: "zh-CN", nativeKey: "first", sourceSnapshotId: fixtureIdentity(500), sourceRevisionId: fixtureIdentity(502), sourceText: "Hello", selectionId: null, revisionId: null, translationText: null, basis: "basis", termConflict: false, currentDecision: null, currentCheck: null, currentFallback: null, currentWaivers: [] };
    let text: string | null = null;
    mocks.invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
      if (command === "read_content_scope") return { revision: "2", currentSnapshot: fixtureIdentity(500) };
      if (command === "read_source_content") return sourcePageFixture({ snapshotId: fixtureIdentity(500), scope: { revision: "2", currentSnapshot: fixtureIdentity(500) }, namespace: "Example.Mod", rows: [], total: 1 });
      if (command === "read_review_summary_page") return { rows: [{ ...target, sourcePreview: target.sourceText, translationPreview: text }], total: 1, nextOrdinal: null, scopeId: "read-scope", sourceSnapshotId: fixtureIdentity(500), readVersion: "view" };
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
    expect(await screen.findByRole("dialog")).toHaveTextContent("Leave with an unsaved translation?");
    expect(screen.getByRole("button", { name: "Translations", hidden: true })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(editor).toHaveValue("Draft");
    await user.click(editor); await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByText(/No tasks in this project/);
    await user.click(screen.getByRole("button", { name: "Translations" }));
    expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Draft");
    expect(screen.getByRole("button", { name: "first" })).toHaveAttribute("aria-current", "true");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "save_translation_revision")).toHaveLength(1);
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

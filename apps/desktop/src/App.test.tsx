import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { i18n } from "./i18n";
import { LAST_OPEN_PROJECT_STORAGE_KEY } from "./recentProjects";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  join: vi.fn(),
  open: vi.fn(),
  onCloseRequested: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/path", () => ({ join: mocks.join }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: mocks.onCloseRequested,
    close: mocks.close,
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
  it("shows real language names and separates codes without duplicating unnamed tags", async () => {
    const user = userEvent.setup();
    await renderApp();
    mocks.invoke.mockResolvedValueOnce({ ...projectView(), metadata: { ...metadata(), targetLocales: ["ss", "sss", "x-example"] } });
    await createProject(user);
    expect(screen.getByText("Swati")).toHaveTextContent("Swati (ss)");
    expect(screen.getByText("Sô")).toHaveTextContent("Sô (sss)");
    expect(screen.getByText("x-example")).toHaveTextContent(/^x-example$/);
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
    mocks.invoke.mockRejectedValueOnce({ code: "invalid-input", stage: "set-target-locales", field: "targetLocales", recoveryRequired: false });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveValue("ssss");
    await user.clear(field);
    await user.type(field, "fr-FR");
    mocks.invoke.mockResolvedValueOnce({ sessionToken: "session-1", metadata: { ...metadata("Demo", "2"), targetLocales: ["fr-FR"] }, outcome: "changed" });
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
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en-US");
    mocks.join.mockResolvedValue("C:\\Projects\\demo");
    mocks.open.mockResolvedValue(null);
    mocks.onCloseRequested.mockResolvedValue(() => undefined);
    mocks.close.mockResolvedValue(undefined);
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

  it("treats opening the active project again as a no-op and keeps an editor draft", async () => {
    const user = userEvent.setup();
    await renderApp();
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
    mocks.invoke.mockRejectedValueOnce({ code: "storage-failed", stage: "rename", recoveryRequired: false });
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
        return { sessionToken: "session-1", metadata: metadata("Demo draft", "2"), outcome: "changed" };
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
      if (command === "rename_project") throw { code: "outcome-unknown", stage: "rename", recoveryRequired: true };
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
      if (command === "rename_project") throw { code: "outcome-unknown", stage: "rename", recoveryRequired: true };
      return projectView();
    }).mockImplementationOnce(async (command: string) => {
      if (command === "read_project") return projectView("Demo", "1", "previous");
      return projectView();
    });

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("The uncertain save was not committed. Your draft remains here.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Retry read" })).toBeEnabled();
    expect(nameInput).toHaveValue("Not committed");
  });
});

import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualProjectPlan from "./ManualProjectPlan";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { InteractionGate } from "../../workspace/interactionGate";
import type { CreateProjectRequest, ProjectView } from "../../../projectCommands";
import { i18n } from "../../../i18n";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { startupCommands, type StartupClaimRequest, type StartupPreflight } from "../../../startupCommands";
import { pluginSourceInventory, pluginSourcePackage, pluginSourceRequest, pluginSourceWorkflow } from "../../../testSupport/pluginSourceFixture";

const { picker, invoke } = vi.hoisted(() => ({ picker: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: picker }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/path", () => ({ sep: () => "/", join: async (...parts: string[]) => parts.join("/") }));
const project: ProjectView = { sessionToken: "created-session", locator: "/synthetic/projects/new-project", reconciliationState: "settled",
  metadata: { projectId: "11111111-1111-4111-8111-111111111111", displayName: "A human project", sourceLocale: "en-US", targetLocales: ["zh-Hans"], metadataRevision: "1" } };
type LabelKey = "name" | "parent" | "folder" | "source" | "target" | "addTarget" | "create" | "title" | "createFailed" | "unknown" | "openDestination" | "chooseParent" | "discardTitle" | "keep" | "discard"
  | "chooseSourceFolder" | "sourceFormat" | "sourceRuntime" | "checkSource" | "sourceReady" | "sourceMissing" | "sourceCheckFailed" | "sourceSelectionFailed" | "sourceNeedsCheck" | "sourceSelectionExpired" | "useManual" | "noSourceRuntime" | "refreshSourceOptions";
const t = (key: LabelKey) => i18n.t(`startup.${key}`);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function fixture(options: { drop?: { dropTicket: string; folderName: string } | null } = {}) {
  const ports = { create: vi.fn(async (_request: CreateProjectRequest) => project), open: vi.fn(async (_request: { locator: string }) => project),
    stopCleanup: vi.fn(async ({ actionId }: { actionId: string }) => ({ actionId, state: "stopped" as const })) };
  const controller = new ProjectLifecycle(ports), gate = new InteractionGate();
  const onCreated = vi.fn((_request: StartupClaimRequest) => {}), onDropConsumed = vi.fn();
  let setDrop!: (drop: { dropTicket: string; folderName: string } | null) => void, setVisible!: (visible: boolean) => void;
  function Harness() {
    const [open, setOpen] = useState(true), [drop, changeDrop] = useState(options.drop ?? null);
    setDrop = changeDrop; setVisible = setOpen;
    return <ManualProjectPlan controller={controller} gate={gate} open={open} onOpenChange={setOpen} native drop={drop} onDropConsumed={onDropConsumed} onCreated={onCreated}/>;
  }
  render(<ApplicationReadProvider><Harness/></ApplicationReadProvider>); return { controller, ports, onCreated, onDropConsumed, setDrop: (drop: { dropTicket: string; folderName: string } | null) => setDrop(drop), setVisible: (open: boolean) => setVisible(open) };
}
async function fill() {
  const user = userEvent.setup();
  for (const [key, value] of [["name", "A human project"], ["parent", "/synthetic/projects"], ["folder", "new-project"], ["source", "en-US"], ["target", "zh-Hans"]] as const) {
    fireEvent.change(screen.getByRole(key === "source" || key === "target" ? "combobox" : "textbox", { name: t(key) }), { target: { value } });
  }
  await user.click(screen.getByRole("button", { name: t("addTarget") })); return user;
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); picker.mockReset(); invoke.mockReset(); invoke.mockImplementation(() => { throw new Error("Unexpected native operation"); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["en-US", "zh-CN"] as const)("creates only after explicit %s confirmation and keeps input, focus and selection through a language change", async language => {
  await i18n.changeLanguage(language); const { controller, ports } = fixture(), user = await fill();
  expect(ports.create).not.toHaveBeenCalled();
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: t("name") });
  fireEvent.change(field, { target: { value: "人工项目 👩🏽‍💻 é" } });
  act(() => { field.focus(); field.setSelectionRange(2, 5, "backward"); });
  fireEvent.compositionStart(field);
  await act(async () => { await i18n.changeLanguage(language === "en-US" ? "zh-CN" : "en-US"); });
  expect(screen.getByRole("textbox", { name: t("name") })).toBe(field); expect(field).toHaveFocus();
  expect(field).toHaveValue("人工项目 👩🏽‍💻 é"); expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(5);
  expect(screen.getByText(language === "en-US" ? "请确认原文使用的语言，项目创建后不能更改。" : "Confirm the language of the original text. It cannot be changed after creation.")).toBeVisible();
  fireEvent.submit(field.closest("form")!); expect(ports.create).not.toHaveBeenCalled(); fireEvent.compositionEnd(field);
  await user.click(screen.getByRole("button", { name: t("create") }));
  await waitFor(() => expect(controller.getSnapshot().session?.project).toEqual(project));
  expect(ports.create).toHaveBeenCalledExactlyOnceWith({ destination: project.locator, displayName: "人工项目 👩🏽‍💻 é", sourceLocale: "en-US", targetLocales: ["zh-Hans"] });
  expect(screen.queryByRole("dialog", { name: t("title") })).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled(); controller.dispose();
});

it("keeps the plan after a destination conflict and never runs import as part of creation", async () => {
  const { controller, ports } = fixture(), user = await fill();
  ports.create.mockRejectedValueOnce({ code: "destination-conflict", stage: "create", outcome: "rejected", recoveryRequired: false, field: "destination" });
  await user.click(screen.getByRole("button", { name: t("create") }));
  await screen.findByText(t("createFailed"));
  expect(screen.getByRole("textbox", { name: t("parent") })).toHaveValue("/synthetic/projects");
  expect(screen.getByRole("textbox", { name: t("parent") })).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("A human project"); expect(invoke).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: t("parent") }), { target: { value: "/synthetic/new-location" } });
  expect(screen.getByRole("textbox", { name: t("parent") })).not.toHaveAttribute("aria-invalid");
  expect(controller.getSnapshot().session).toBeNull(); controller.dispose();
});

it("does not describe a failed project open as a failed creation", async () => {
  const { controller, ports } = fixture();
  ports.open.mockRejectedValueOnce({ code: "missing-project", stage: "open", outcome: "rejected", recoveryRequired: false });
  await act(async () => { expect(await controller.open("/synthetic/missing")).toBe(false); });
  expect(controller.getSnapshot().failure?.code).toBe("command-failed");
  expect(screen.queryByText(t("createFailed"))).not.toBeInTheDocument(); expect(ports.create).not.toHaveBeenCalled(); controller.dispose();
});

it("keeps an uncertain creation and opens only the original destination when explicitly requested", async () => {
  const { controller, ports } = fixture(), user = await fill(); ports.create.mockRejectedValueOnce(new Error("Lost acknowledgement"));
  await user.click(screen.getByRole("button", { name: t("create") }));
  await screen.findByText(t("unknown")); expect(ports.open).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: t("create") })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: t("parent") })).toHaveAttribute("readonly");
  await user.click(screen.getByRole("button", { name: t("openDestination") }));
  await waitFor(() => expect(controller.getSnapshot().pending).toBeNull());
  expect(ports.open).toHaveBeenCalledExactlyOnceWith({ locator: project.locator }); expect(ports.create).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("A human project"); controller.dispose();
});

it("does not let a late folder chooser overwrite a newer location", async () => {
  const { controller } = fixture(), user = userEvent.setup(), selected = deferred<string>(); picker.mockReturnValueOnce(selected.promise);
  await user.click(screen.getByRole("button", { name: t("chooseParent") }));
  fireEvent.change(screen.getByRole("textbox", { name: t("parent") }), { target: { value: "/synthetic/newer-B" } });
  await act(async () => { selected.resolve("/synthetic/older-A"); });
  expect(screen.getByRole("textbox", { name: t("parent") })).toHaveValue("/synthetic/newer-B"); controller.dispose();
});

it("protects a new project draft during native exit and discards only after explicit review", async () => {
  const { controller } = fixture(); await fill(); const destroy = vi.fn(async () => {}), user = userEvent.setup();
  let closing!: Promise<boolean>; act(() => { closing = controller.closeWindow(destroy); });
  let dialog = await screen.findByRole("dialog", { name: t("discardTitle") });
  expect(within(dialog).getByText("The project has not been created. Discard these settings and exit the app?")).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: t("keep") }));
  expect(await closing).toBe(false); expect(destroy).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("A human project");
  act(() => { closing = controller.closeWindow(destroy); }); dialog = await screen.findByRole("dialog", { name: t("discardTitle") });
  await user.click(within(dialog).getByRole("button", { name: t("discard") }));
  expect(await closing).toBe(true); expect(destroy).toHaveBeenCalledOnce(); controller.dispose();
});

const directory = { selectionId: pluginSourceWorkflow.selection.selectionId, folderName: "Synthetic source 日本語" };
const sourcePreview: StartupPreflight = { directory, source: pluginSourceWorkflow.selection.source, complete: true,
  materials: pluginSourceWorkflow.selection.source.declaration.materials.map(file => ({ ...file, byteLength: 1, sha256: "a".repeat(64) })) };
function nativeSourceReads({ preview = sourcePreview, approved = true }: { preview?: StartupPreflight; approved?: boolean } = {}) {
  invoke.mockImplementation(async command => {
    if (command === "read_plugin_inventory") return approved ? pluginSourceInventory : { ...pluginSourceInventory, runtimeDecisions: [] };
    if (command === "read_plugin_package") return pluginSourcePackage;
    if (command === "select_startup_source_directory" || command === "select_dropped_startup_source_directory") return directory;
    if (command === "read_startup_source_preflight") return preview;
    throw new Error(`Unexpected source operation: ${command}`);
  });
}
async function chooseSource(user: ReturnType<typeof userEvent.setup>, withRuntime = true) {
  await user.click(screen.getByRole("button", { name: t("chooseSourceFolder") }));
  const format = await screen.findByRole("combobox", { name: t("sourceFormat") });
  await waitFor(() => expect(format).toBeEnabled());
  await user.selectOptions(format, `${pluginSourceRequest.package.packageDigest}:${pluginSourceRequest.resourceId}`);
  if (withRuntime) await user.selectOptions(screen.getByRole("combobox", { name: t("sourceRuntime") }), pluginSourceRequest.environmentDigest);
}
async function checkedSource(user: ReturnType<typeof userEvent.setup>) {
  await chooseSource(user); await user.click(screen.getByRole("button", { name: t("checkSource") }));
  await screen.findByText(t("sourceReady"));
}

it.each(["en-US", "zh-CN"] as const)("checks declared native files without execution and hands the exact source to the new project in %s", async language => {
  await i18n.changeLanguage(language); nativeSourceReads(); const { controller, ports, onCreated } = fixture(), user = await fill();
  await checkedSource(user);
  expect(screen.getByText(language === "en-US"
    ? "This check reads only the files declared by the selected source format. It does not run a plugin, contact a model, or import content."
    : "这里只读取所选源格式声明的文件，不运行插件、不联系模型，也不导入内容。")).toBeVisible();
  expect(screen.getByRole("combobox", { name: t("source") })).toHaveValue("en-US");
  expect(screen.getByText(language === "en-US" ? "Present: materials/raw.txt" : "已找到：materials/raw.txt")).toBeVisible();
  expect(screen.getByText(language === "en-US" ? "Up to 131,072 bytes" : "最多 131,072 字节")).toBeVisible();
  expect(invoke).toHaveBeenCalledWith("read_startup_source_preflight", { request: { selectionId: directory.selectionId, source: pluginSourceRequest } });
  expect(ports.create).not.toHaveBeenCalled(); await user.click(screen.getByRole("button", { name: t("create") }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith({ selectionId: directory.selectionId, source: pluginSourceRequest,
    projectId: project.metadata.projectId, sessionToken: project.sessionToken }));
  expect(ports.create).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["select_startup_source_directory", "read_plugin_inventory", "read_plugin_package", "read_startup_source_preflight"]);
  controller.dispose();
});

it("keeps all settings when declared files are missing and allows an explicit empty project", async () => {
  nativeSourceReads({ preview: { ...sourcePreview, complete: false, materials: sourcePreview.materials.map((file, index) => index ? file : { ...file, byteLength: null, sha256: null }) } });
  const { controller, ports, onCreated } = fixture(), user = await fill(); await chooseSource(user);
  await user.click(screen.getByRole("button", { name: t("checkSource") })); await screen.findByText(t("sourceMissing"));
  expect(screen.getByText("Missing: materials/raw.txt")).toBeVisible(); expect(screen.getByRole("button", { name: t("create") })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("A human project");
  await user.click(screen.getByRole("button", { name: t("useManual") })); await user.click(screen.getByRole("button", { name: t("create") }));
  await waitFor(() => expect(ports.create).toHaveBeenCalledOnce()); expect(onCreated).not.toHaveBeenCalled(); controller.dispose();
});

it("offers no unapproved runtime and keeps the editable project plan", async () => {
  nativeSourceReads({ approved: false }); const { controller, ports } = fixture(), user = await fill(); await chooseSource(user, false);
  expect(screen.getByText(t("noSourceRuntime"))).toBeVisible();
  expect(within(screen.getByRole("combobox", { name: t("sourceRuntime") })).getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("button", { name: t("checkSource") })).toBeDisabled(); expect(screen.getByRole("button", { name: t("create") })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: t("source") })).toHaveValue("en-US"); expect(ports.create).not.toHaveBeenCalled(); controller.dispose();
});

it("rejects a preflight from a different runtime and keeps the source plan for retry", async () => {
  nativeSourceReads({ preview: { ...sourcePreview, source: { ...sourcePreview.source, environmentDigest: "f".repeat(64) } } });
  const { controller, ports } = fixture(), user = await fill(); await chooseSource(user);
  await user.click(screen.getByRole("button", { name: t("checkSource") })); await screen.findByText(t("sourceCheckFailed"));
  expect(screen.queryByText(t("sourceReady"))).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: t("create") })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: t("parent") })).toHaveValue("/synthetic/projects"); expect(ports.create).not.toHaveBeenCalled(); controller.dispose();
});

it("uses an opaque native drop ticket and removes an older preflight even when the new drop fails", async () => {
  nativeSourceReads(); const { controller, setDrop, onDropConsumed } = fixture(), user = await fill(); await checkedSource(user);
  vi.spyOn(startupCommands, "droppedDirectory").mockRejectedValueOnce(new Error("Selection expired"));
  act(() => setDrop({ dropTicket: "00000000-0000-4000-8000-000000002222", folderName: "New folder B" }));
  await screen.findByText(t("sourceSelectionFailed"));
  expect(startupCommands.droppedDirectory).toHaveBeenCalledExactlyOnceWith({ dropTicket: "00000000-0000-4000-8000-000000002222" });
  expect(onDropConsumed).toHaveBeenCalledOnce(); expect(screen.queryByText(t("sourceReady"))).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: t("create") })).toBeDisabled(); expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("A human project"); controller.dispose();
});

it("keeps newer B input when a native selection or preflight for A returns later", async () => {
  nativeSourceReads(); const { controller } = fixture(), user = await fill(); await checkedSource(user);
  const selected = deferred<typeof directory>(); vi.spyOn(startupCommands, "chooseDirectory").mockReturnValueOnce(selected.promise);
  await user.click(screen.getByRole("button", { name: t("chooseSourceFolder") }));
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Newer B 人工" } });
  await act(async () => selected.resolve({ ...directory, folderName: "Late folder A" }));
  expect(screen.getByText(t("sourceSelectionExpired"))).toBeVisible(); expect(screen.queryByText(t("sourceReady"))).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("Newer B 人工");
  await user.click(screen.getByRole("button", { name: t("chooseSourceFolder") }));
  const checked = deferred<StartupPreflight>(); vi.spyOn(startupCommands, "preflight").mockReturnValueOnce(checked.promise);
  await user.click(screen.getByRole("button", { name: t("checkSource") }));
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Newest B 👩🏽‍💻" } });
  await act(async () => checked.resolve(sourcePreview));
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("Newest B 👩🏽‍💻");
  expect(screen.queryByText(t("sourceReady"))).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: t("create") })).toBeDisabled(); controller.dispose();
});

it("does not apply a hidden preflight after the plan reopens", async () => {
  nativeSourceReads(); const { controller, setVisible } = fixture(), user = await fill(); await chooseSource(user);
  const checked = deferred<StartupPreflight>(); vi.spyOn(startupCommands, "preflight").mockReturnValueOnce(checked.promise);
  await user.click(screen.getByRole("button", { name: t("checkSource") })); act(() => setVisible(false));
  await act(async () => checked.resolve(sourcePreview)); act(() => setVisible(true));
  expect(screen.queryByText(t("sourceReady"))).not.toBeInTheDocument(); expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("A human project"); controller.dispose();
});

it("retains newer B settings after A creates a project and does not hand A to Source", async () => {
  nativeSourceReads(); const { controller, ports, onCreated } = fixture(), user = await fill(); await checkedSource(user);
  const created = deferred<ProjectView>(); ports.create.mockReturnValueOnce(created.promise);
  await user.click(screen.getByRole("button", { name: t("create") })); await waitFor(() => expect(ports.create).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Newer B while creating" } });
  await act(async () => created.resolve(project));
  expect(controller.getSnapshot().session?.project).toEqual(project); expect(onCreated).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("Newer B while creating"); expect(ports.create).toHaveBeenCalledOnce(); controller.dispose();
});

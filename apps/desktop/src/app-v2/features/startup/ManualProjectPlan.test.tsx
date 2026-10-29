import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualProjectPlan from "./ManualProjectPlan";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { InteractionGate } from "../../workspace/interactionGate";
import type { CreateProjectRequest, ProjectView } from "../../../projectCommands";
import { i18n } from "../../../i18n";

const { picker, invoke } = vi.hoisted(() => ({ picker: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: picker }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/path", () => ({ sep: () => "/", join: async (...parts: string[]) => parts.join("/") }));
const project: ProjectView = { sessionToken: "created-session", locator: "/synthetic/projects/new-project", reconciliationState: "settled",
  metadata: { projectId: "11111111-1111-4111-8111-111111111111", displayName: "A human project", sourceLocale: "en-US", targetLocales: ["zh-Hans"], metadataRevision: "1" } };
type LabelKey = "name" | "parent" | "folder" | "source" | "target" | "addTarget" | "create" | "title" | "createFailed" | "unknown" | "openDestination" | "chooseParent" | "discardTitle" | "keep" | "discard";
const t = (key: LabelKey) => i18n.t(`startup.${key}`);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function fixture() {
  const ports = { create: vi.fn(async (_request: CreateProjectRequest) => project), open: vi.fn(async (_request: { locator: string }) => project),
    stopCleanup: vi.fn(async ({ actionId }: { actionId: string }) => ({ actionId, state: "stopped" as const })) };
  const controller = new ProjectLifecycle(ports), gate = new InteractionGate();
  function Harness() {
    const [open, setOpen] = useState(true);
    return <ManualProjectPlan controller={controller} gate={gate} open={open} onOpenChange={setOpen} native/>;
  }
  render(<Harness/>); return { controller, ports };
}
async function fill() {
  const user = userEvent.setup();
  for (const [key, value] of [["name", "A human project"], ["parent", "/synthetic/projects"], ["folder", "new-project"], ["source", "en-US"], ["target", "zh-Hans"]] as const) {
    await user.type(screen.getByRole(key === "source" || key === "target" ? "combobox" : "textbox", { name: t(key) }), value);
  }
  await user.click(screen.getByRole("button", { name: t("addTarget") })); return user;
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); picker.mockReset(); invoke.mockReset(); invoke.mockImplementation(() => { throw new Error("Unexpected native operation"); }); });
afterEach(cleanup);

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

import { Button } from "../../../design-system/Button";
import { useLayoutEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { i18n } from "../../../i18n";
import { COMMAND_BINDINGS_STORAGE_KEY } from "../../../commandBindings";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { mcpProject } from "../../../testSupport/mcpSharingFixture";
import type { SessionExitPermit } from "../../../sessionNavigation";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { InteractionGate } from "../../workspace/interactionGate";
import type { ProjectReferenceHandle } from "./ProjectReferenceHost";
import { ApplicationSettingsProvider, useApplicationSettings } from "./ApplicationSettings";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));
const label = (key: "title" | "connections" | "shortcuts" | "close" | "apply" | "discardShortcuts" | "query" | "needsProject") => i18n.t(`settingsWorkbench.${key}`);
function Launcher({ mcp }: { mcp?: ProjectReferenceHandle }) {
  const settings = useApplicationSettings();
  useLayoutEffect(() => mcp ? settings.registerMcp(mcp) : undefined, [settings.registerMcp, mcp]);
  return <Button onClick={() => settings.open()}>{label("title")}</Button>;
}
function harness(lifecycle = new ProjectLifecycle(), mcp?: ProjectReferenceHandle, children?: ReactNode) {
  const gate = new InteractionGate();
  const ui = render(<ApplicationReadProvider><ApplicationSettingsProvider lifecycle={lifecycle} gate={gate} native><Launcher mcp={mcp}/>{children}</ApplicationSettingsProvider></ApplicationReadProvider>);
  return { ...ui, lifecycle, gate };
}
beforeEach(async () => {
  localStorage.clear(); await i18n.changeLanguage("en-US"); invoke.mockReset().mockImplementation(async command => {
    if (command === "read_model_connections") return connectionFixture([]);
    throw new Error(`Unexpected native command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function open() { fireEvent.click(screen.getByRole("button", { name: label("title") })); await screen.findByRole("dialog", { name: label("title") }); }

it("persists the editor text size across remounts and language changes without replacing unfinished input", async () => {
  const h = harness(undefined, undefined, <textarea aria-label="Entry draft" defaultValue="Draft A"/>);
  const draft = screen.getByRole("textbox", { name: "Entry draft" });
  fireEvent.change(draft, { target: { value: "Draft B 🧵\n第二行" } });
  await open(); fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  const size = screen.getByRole("combobox", { name: "Editor text size" });
  expect(size).toHaveValue("15");
  fireEvent.change(size, { target: { value: "20" } });
  expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("20px");
  expect(localStorage.getItem("tsumugi.editorFontSize")).toBe("20");
  fireEvent.click(screen.getByRole("button", { name: label("close") }));
  expect(screen.getByRole("textbox", { name: "Entry draft" })).toBe(draft);
  expect(draft).toHaveValue("Draft B 🧵\n第二行");
  h.unmount(); harness(); await open();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  fireEvent.click(screen.getByRole("button", { name: "外观" }));
  const restored = screen.getByRole("combobox", { name: "编辑正文字号" });
  expect(restored).toHaveValue("20");
  fireEvent.change(restored, { target: { value: "14" } });
  expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("14px");
  expect(localStorage.getItem("tsumugi.editorFontSize")).toBe("14");
});

it("keeps the chosen size usable when local storage fails and lets the user retry saving it", async () => {
  harness(); await open(); fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  const original = Storage.prototype.setItem;
  let unavailable = true;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === "tsumugi.editorFontSize" && unavailable) throw new Error("Storage unavailable");
    original.call(this, key, value);
  });
  const size = screen.getByRole("combobox", { name: "Editor text size" });
  fireEvent.change(size, { target: { value: "20" } });
  expect(size).toHaveValue("20");
  expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("20px");
  expect(localStorage.getItem("tsumugi.editorFontSize")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved on this device");
  unavailable = false; fireEvent.click(screen.getByRole("button", { name: "Try saving again" }));
  expect(localStorage.getItem("tsumugi.editorFontSize")).toBe("20");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("retains a connection draft across settings close and project navigation, and obtains a held discard permit for window exit", async () => {
  const h = harness(); await open(); fireEvent.click(screen.getByRole("button", { name: label("connections") }));
  const name = await screen.findByRole("textbox", { name: i18n.t("connections.name") });
  fireEvent.change(name, { target: { value: "Connection B" } });
  fireEvent.click(screen.getByRole("button", { name: label("close") }));
  let navigation: SessionExitPermit | null = null;
  await act(async () => { navigation = await h.lifecycle.prepareLeave({ kind: "open-project" }); });
  expect(navigation).not.toBeNull(); act(() => navigation?.release());
  await open(); fireEvent.click(screen.getByRole("button", { name: label("connections") }));
  expect(screen.getByRole("textbox", { name: i18n.t("connections.name") })).toHaveValue("Connection B");
  fireEvent.click(screen.getByRole("button", { name: label("close") }));
  let closing!: Promise<SessionExitPermit | null>;
  act(() => { closing = h.lifecycle.prepareLeave({ kind: "close-window" }); });
  await screen.findByRole("heading", { name: i18n.t("connections.exitTitle") });
  expect(screen.getByRole("button", { name: label("close") })).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("connections.discardAndExit") }));
  let permit: SessionExitPermit | null = null;
  await act(async () => { permit = await closing; }); expect(permit).not.toBeNull();
  expect(screen.getByRole("textbox", { name: i18n.t("connections.name") })).toBeDisabled();
  act(() => permit?.release());
  await waitFor(() => expect(screen.getByRole("textbox", { name: i18n.t("connections.name") })).toBeEnabled());
  expect(invoke.mock.calls.every(([command]) => command === "read_model_connections")).toBe(true);
});

it("keeps unapplied shortcut input through close and language changes, blocks exit, and persists only an applied valid binding", async () => {
  const h = harness(); await open(); fireEvent.click(screen.getByRole("button", { name: label("shortcuts") }));
  const shortcutName = () => i18n.t("settingsWorkbench.shortcutLabel", { command: i18n.t("workbenchV2.openProject") });
  let input = screen.getByRole("textbox", { name: shortcutName() });
  fireEvent.change(input, { target: { value: "Mod+Alt+P" } });
  fireEvent.click(screen.getByRole("button", { name: label("close") }));
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  let permit: SessionExitPermit | null = null;
  await act(async () => { permit = await h.lifecycle.prepareLeave({ kind: "close-window" }); });
  expect(permit).toBeNull(); expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settingsWorkbench.unapplied"));
  input = screen.getByRole("textbox", { name: shortcutName() }); expect(input).toHaveValue("Mod+Alt+P");
  fireEvent.compositionStart(input); fireEvent.submit(screen.getByRole("form", { name: shortcutName() }));
  expect(localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY)).toBeNull();
  fireEvent.compositionEnd(input);
  fireEvent.click(within(screen.getByRole("form", { name: shortcutName() })).getByRole("button", { name: label("apply") }));
  expect(JSON.parse(localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY)!)).toEqual({ "workspace.open-project": "Mod+Alt+P" });
  await act(async () => { permit = await h.lifecycle.prepareLeave({ kind: "close-window" }); });
  expect(permit).not.toBeNull(); act(() => permit?.release());
  h.unmount(); harness(); await open(); fireEvent.click(screen.getByRole("button", { name: label("shortcuts") }));
  expect(screen.getByRole("textbox", { name: shortcutName() })).toHaveValue("Mod+Alt+P");
});

it("hands MCP off after closing settings and retains the real trigger as the return point", async () => {
  const lifecycle = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(mcpProject) }); await lifecycle.open(mcpProject.locator);
  const mcp = { open: vi.fn(), revealQuery: vi.fn(() => false) }, h = harness(lifecycle, mcp);
  const trigger = screen.getByRole("button", { name: label("title") }); trigger.focus(); await open();
  expect(mcp.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: label("query") }));
  await waitFor(() => expect(mcp.open).toHaveBeenCalledExactlyOnceWith("query", trigger));
  expect(h.gate.getSnapshot().dialogs).toEqual([]);
});

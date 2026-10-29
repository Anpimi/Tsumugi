import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PluginManager, type PluginManagerHandle } from "./PluginManager";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { validateResponseInventory, validateResponsePackage, validateResponseCandidate } from "./generated/plugins.validators";
import type { PluginInventoryView } from "./pluginCommands";
import { i18n } from "./i18n";
import inventory from "../test/fixtures/pluginInventory.contract.json";
import candidate from "../test/fixtures/pluginPackage.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const onBusy = vi.fn();
const empty = { ...inventory.empty, runtimeOffers: [] };
if (!validateResponseInventory(empty)) throw new Error("Invalid plugin inventory fixture");
const installed: PluginInventoryView = { ...empty, settingsRevision: "1", lastSettingsAction: "00000000-0000-4000-8000-000000000020",
  packages: [{ originalInstallAction: "00000000-0000-4000-8000-000000000001", plugin: candidate.manifest.plugin, packageDigest: candidate.packageDigest, origin: { sourceId: "manual-local", publisherId: "manual-approval" }, state: "sealed" }],
  packageDecisions: [{ plugin: candidate.manifest.plugin, packageDigest: candidate.packageDigest, origin: { sourceId: "manual-local", publisherId: "manual-approval" }, enabled: false }],
};
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onBusy.mockReset();
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return inventory.empty;
    if (command === "select_plugin_package") return candidate;
    if (command === "install_plugin_package") return installed;
    throw new Error(command);
  });
});
afterEach(cleanup);

it.each([["en-US", "Extensions", "Select plugin folder", "I trust this local package", "Approve and install", "Enable"],
  ["zh-CN", "扩展", "选择插件文件夹", "我信任此本地插件包", "批准并安装", "启用"]])("requires explicit local trust and keeps installation disabled in %s", async (locale, entry, choose, consent, install, enable) => {
  await i18n.changeLanguage(locale);
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: entry }));
  await user.click(await screen.findByRole("button", { name: choose }));
  const approve = await screen.findByRole("button", { name: install });
  expect(approve).toBeDisabled();
  expect(screen.getByText(/no verified publisher signature|没有经过验证的发布者签名/)).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: new RegExp(consent) }));
  await user.click(approve);
  const button = await screen.findByRole("button", { name: enable });
  expect(button).toBeEnabled();
  expect(invoke.mock.calls.filter(([command]) => command === "set_plugin_enabled")).toHaveLength(0);
  const request = invoke.mock.calls.find(([command]) => command === "install_plugin_package")?.[1].request;
  expect(request).toEqual({ ticket: candidate.ticket, expectedRevision: "0", actionId: expect.any(String) });
  expect(request).not.toHaveProperty("directory");
  expect(request).not.toHaveProperty("origin");
});

it("retains an unknown original request across panel close and confirms that same action", async () => {
  let installedAttempts = 0;
  let latest: PluginInventoryView = empty;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return latest;
    if (command === "select_plugin_package") return candidate;
    if (command === "install_plugin_package") {
      installedAttempts += 1;
      latest = installed;
      if (installedAttempts === 1) throw { code: "outcome-unknown", stage: "plugin-install", outcome: "unknown", recoveryRequired: true, reason: "plugin-result-unconfirmed" };
      return installed;
    }
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Select plugin folder" }));
  await user.click(await screen.findByRole("checkbox", { name: /I trust this local package/ }));
  await user.click(screen.getByRole("button", { name: "Approve and install" }));
  expect(await screen.findByRole("button", { name: "Retry original operation" })).toBeEnabled();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
  expect(screen.getByRole("button", { name: "Select plugin folder" })).toBeDisabled();
  expect(onBusy).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await screen.findByRole("button", { name: "Retry original operation" });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
  await user.click(await screen.findByRole("button", { name: "Retry original operation" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled());
  const calls = invoke.mock.calls.filter(([command]) => command === "install_plugin_package");
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toEqual(calls[0][1]);
  expect(onBusy).toHaveBeenLastCalledWith(false);
});

it("keeps a settings conflict distinct from an empty installation list", async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return installed;
    if (command === "set_plugin_enabled") throw { code: "stale-revision", stage: "plugin-settings", outcome: "rejected", recoveryRequired: false, reason: "plugin-settings-changed" };
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Enable" }));
  expect(await screen.findByText(/Plugin settings changed/)).toBeInTheDocument();
  expect(screen.getByText(candidate.manifest.plugin.id)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Refresh current state" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled());
  expect(invoke.mock.calls.filter(([command]) => command === "set_plugin_enabled")).toHaveLength(1);
});

it("does not close the panel or duplicate installation while an accepted request is pending", async () => {
  let finish: ((value: unknown) => void) | undefined;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return inventory.empty;
    if (command === "select_plugin_package") return candidate;
    if (command === "install_plugin_package") return new Promise(resolve => { finish = resolve; });
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Select plugin folder" }));
  await user.click(await screen.findByRole("checkbox", { name: /I trust this local package/ }));
  await user.click(screen.getByRole("button", { name: "Approve and install" }));
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "install_plugin_package")).toHaveLength(1);
  await act(async () => finish?.(installed));
  expect(await screen.findByRole("button", { name: "Enable" })).toBeEnabled();
});

it("preserves the last observation and blocks mutations after a failed refresh", async () => {
  let reads = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") { if (++reads === 1) return installed; throw { code: "storage-failed", stage: "read", outcome: "rejected", recoveryRequired: false }; }
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  expect(await screen.findByRole("button", { name: "Enable" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Refresh state" }));
  expect(await screen.findByText(/last successful check/)).toBeInTheDocument();
  expect(screen.getByText(candidate.manifest.plugin.id)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Select plugin folder" })).toBeDisabled();
});

it.each([["en-US", "Package permissions"], ["zh-CN", "包级权限"]])("shows package and capability permission origins in installed details in %s", async (locale, packageLabel) => {
  await i18n.changeLanguage(locale);
  const program = "synthetic-helper-木桶";
  const details: unknown = { enabled: false, packageDigest: candidate.packageDigest,
    manifest: { ...candidate.manifest, permissions: [...candidate.manifest.permissions, { kind: "process", program }] } };
  if (!validateResponsePackage(details)) throw new Error("Invalid installed permission fixture");
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return installed;
    if (command === "read_plugin_package") return details;
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.open") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("plugins.details") }));
  const inspected = await screen.findByRole("region", { name: i18n.t("plugins.details") });
  const packagePermissions = within(inspected).getByRole("group", { name: packageLabel });
  const capabilityPermissions = within(inspected).getByRole("group", { name: i18n.t("plugins.capability", { name: "query" }) });
  expect(within(packagePermissions).getByText(program)).toBeVisible();
  expect(within(capabilityPermissions).getByText(i18n.t("plugins.permissions.captured-input"))).toBeVisible();
  expect(within(capabilityPermissions).queryByText(program)).not.toBeInTheDocument();
  expect(invoke.mock.calls.find(([command]) => command === "read_plugin_package")?.[1].request)
    .toEqual({ plugin: candidate.manifest.plugin, packageDigest: candidate.packageDigest });
  expect(invoke.mock.calls.every(([command]) => command === "read_plugin_inventory" || command === "read_plugin_package")).toBe(true);
});


it.each(["en-US", "zh-CN"])("keeps local package consent across workbench tabs and panel close in %s", async locale => {
  await i18n.changeLanguage(locale);
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return empty;
    if (command === "read_plugin_repositories") return { sources: [] };
    if (command === "select_plugin_package") return candidate;
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy} presentation="workbench"/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.open") }));
  expect(await screen.findByRole("tab", { name: i18n.t("plugins.installedTab") })).toHaveAttribute("aria-selected", "true");
  await user.click(screen.getByRole("tab", { name: i18n.t("plugins.discoverTab") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("plugins.choose") }));
  await user.click(await screen.findByRole("checkbox", { name: i18n.t("plugins.consent") }));
  await user.click(screen.getByRole("tab", { name: i18n.t("plugins.sourcesTab") }));
  expect(await screen.findByRole("button", { name: i18n.t("plugins.repositoryChoose") })).toBeEnabled();
  expect(screen.queryByRole("button", { name: i18n.t("plugins.install") })).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: i18n.t("plugins.discoverTab") }));
  expect(screen.getByRole("checkbox", { name: i18n.t("plugins.consent") })).toBeChecked();
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.close") }));
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.open") }));
  expect(await screen.findByRole("checkbox", { name: i18n.t("plugins.consent") })).toBeChecked();
  expect(invoke.mock.calls.filter(([command]) => command === "select_plugin_package")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "install_plugin_package")).toBe(false);
});

it("reports a synchronous exit reservation and retains the original unknown action outside its tab", async () => {
  const ref = createRef<PluginManagerHandle>();
  const onOpenChange = vi.fn();
  let rejectInstall: ((reason: unknown) => void) | undefined;
  let attempt = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return empty;
    if (command === "read_plugin_repositories") return { sources: [] };
    if (command === "select_plugin_package") return candidate;
    if (command === "install_plugin_package") {
      attempt += 1;
      if (attempt === 1) return new Promise((_resolve, reject) => { rejectInstall = reject; });
      return installed;
    }
    throw new Error(command);
  });
  const user = userEvent.setup();
  const trigger = document.createElement("button");
  document.body.append(trigger);
  render(<PluginManager ref={ref} disabled={false} onBusyChange={onBusy} hideTrigger presentation="workbench" onOpenChange={onOpenChange}/>, { wrapper: ApplicationReadProvider });
  act(() => ref.current?.open(trigger));
  await user.click(await screen.findByRole("tab", { name: i18n.t("plugins.discoverTab") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("plugins.choose") }));
  await user.click(await screen.findByRole("checkbox", { name: i18n.t("plugins.consent") }));
  const before = ref.current?.exitState();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("plugins.install") }));
  expect(ref.current?.exitState().blocked).toBe(true);
  expect(ref.current?.exitState().revision).not.toBe(before?.revision);
  await waitFor(() => expect(rejectInstall).toBeDefined());
  await user.click(screen.getByRole("tab", { name: i18n.t("plugins.installedTab") }));
  await act(async () => rejectInstall?.({ code: "outcome-unknown", stage: "plugin-install", outcome: "unknown", recoveryRequired: true, reason: "plugin-result-unconfirmed" }));
  expect(await screen.findByRole("button", { name: i18n.t("plugins.retryOriginal") })).toBeEnabled();
  const unknownState = ref.current?.exitState();
  expect(unknownState?.blocked).toBe(true);
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.close") }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(ref.current?.exitState()).toEqual(unknownState);
  act(() => ref.current?.open(trigger));
  await user.click(await screen.findByRole("button", { name: i18n.t("plugins.retryOriginal") }));
  await waitFor(() => expect(ref.current?.exitState().blocked).toBe(false));
  const requests = invoke.mock.calls.filter(([command]) => command === "install_plugin_package");
  expect(requests).toHaveLength(2);
  expect(requests[1][1]).toEqual(requests[0][1]);
  expect(ref.current?.exitState().revision).not.toBe(unknownState?.revision);
  expect(onOpenChange.mock.calls).toEqual([[true], [false], [true]]);
  trigger.remove();
});

it("ignores composed navigation and approval keys in the workbench presentation", async () => {
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy} presentation="workbench"/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.open") }));
  const installedTab = await screen.findByRole("tab", { name: i18n.t("plugins.installedTab") });
  fireEvent.keyDown(installedTab, { key: "ArrowRight", isComposing: true, keyCode: 229 });
  expect(installedTab).toHaveAttribute("aria-selected", "true");
  await user.click(screen.getByRole("tab", { name: i18n.t("plugins.discoverTab") }));
  const choose = await screen.findByRole("button", { name: i18n.t("plugins.choose") });
  fireEvent.compositionStart(choose);
  fireEvent.click(choose, { detail: 0 });
  expect(invoke.mock.calls.some(([command]) => command === "select_plugin_package")).toBe(false);
  fireEvent.compositionEnd(choose);
  await user.click(choose);
  expect(await screen.findByRole("button", { name: i18n.t("plugins.install") })).toBeDisabled();
});


it.each([true, false])("uses only a readable exact approved package as the permission comparison basis: %s", async approved => {
  const selected: unknown = { ...candidate, packageDigest: "d".repeat(64), manifest: {
    ...candidate.manifest, plugin: { ...candidate.manifest.plugin, version: "0.2.0" },
    permissions: [...candidate.manifest.permissions, { kind: "network", destination: "https://new.example.test" }],
  } };
  if (!validateResponseCandidate(selected) || selected === null) throw new Error("Invalid candidate fixture");
  const previous = { enabled: false, packageDigest: candidate.packageDigest, manifest: candidate.manifest };
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return { ...installed, packageDecisions: approved ? installed.packageDecisions : [] };
    if (command === "select_plugin_package") return selected;
    if (command === "read_plugin_package") return previous;
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy} presentation="workbench"/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.open") }));
  await user.click(await screen.findByRole("tab", { name: i18n.t("plugins.discoverTab") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("plugins.choose") }));
  const review = await screen.findByRole("region", { name: i18n.t("plugins.candidate") });
  const permissions = within(review).getByRole("group", { name: i18n.t("plugins.packagePermissions") });
  if (approved) {
    await within(review).findByText(i18n.t("plugins.permissionComparison", { version: "0.1.0" }));
    expect(within(permissions).getByText(i18n.t("plugins.permissionPreviouslyApproved"))).toBeVisible();
    expect(within(permissions).getByText(i18n.t("plugins.permissionNew"))).toBeVisible();
    expect(invoke.mock.calls.find(([command]) => command === "read_plugin_package")?.[1].request)
      .toEqual({ plugin: candidate.manifest.plugin, packageDigest: candidate.packageDigest });
  } else {
    expect(within(permissions).getAllByText(i18n.t("plugins.permissionNeedsApproval"))).toHaveLength(2);
    expect(invoke.mock.calls.some(([command]) => command === "read_plugin_package")).toBe(false);
  }
  expect(invoke.mock.calls.some(([command]) => command === "install_plugin_package")).toBe(false);
});


it("keeps an approved package review when application shutdown disables new work, then installs only after work resumes", async () => {
  const ui = render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("plugins.open") }));
  const choose = await screen.findByRole("button", { name: i18n.t("plugins.choose") });
  await waitFor(() => expect(choose).toBeEnabled()); fireEvent.click(choose);
  fireEvent.click(await screen.findByRole("checkbox", { name: i18n.t("plugins.consent") }));
  ui.rerender(<PluginManager disabled onBusyChange={onBusy}/>);
  const install = screen.getByRole("button", { name: i18n.t("plugins.install") });
  expect(install).toBeDisabled(); fireEvent.click(install);
  expect(invoke.mock.calls.filter(([command]) => command === "install_plugin_package")).toHaveLength(0);
  expect(screen.getByRole("checkbox", { name: i18n.t("plugins.consent") })).toBeChecked();
  ui.rerender(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("plugins.install") }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "install_plugin_package")).toHaveLength(1));
});

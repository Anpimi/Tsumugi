import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PluginManager } from "./PluginManager";
import type { PluginInventoryView } from "./pluginCommands";
import { i18n } from "./i18n";
import inventory from "../test/fixtures/pluginInventory.contract.json";
import candidate from "../test/fixtures/pluginPackage.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const onBusy = vi.fn();
const empty: PluginInventoryView = { ...inventory.empty, runtimeOffers: [] };
const installed: PluginInventoryView = { ...empty, settingsRevision: "1", lastSettingsAction: "00000000-0000-4000-8000-000000000020",
  packages: [{ plugin: candidate.manifest.plugin, packageDigest: candidate.packageDigest, origin: { sourceId: "manual-local", publisherId: "manual-approval" }, state: "sealed" }],
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

it.each([["en-US", "Extensions", "Choose plugin folder", "I trust this exact", "Approve and install", "Enable"],
  ["zh-CN", "扩展", "选择插件目录", "我信任此准确", "批准并安装", "启用"]])("requires explicit local trust and keeps installation disabled in %s", async (locale, entry, choose, consent, install, enable) => {
  await i18n.changeLanguage(locale);
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: entry }));
  await user.click(await screen.findByRole("button", { name: choose }));
  const approve = await screen.findByRole("button", { name: install });
  expect(approve).toBeDisabled();
  expect(screen.getByText(/no authenticated publisher|没有经过认证/)).toBeInTheDocument();
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
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Choose plugin folder" }));
  await user.click(await screen.findByRole("checkbox", { name: /I trust this exact/ }));
  await user.click(screen.getByRole("button", { name: "Approve and install" }));
  expect(await screen.findByRole("button", { name: "Retry original operation" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Choose plugin folder" })).toBeDisabled();
  expect(onBusy).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
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
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Enable" }));
  expect(await screen.findByText(/Plugin settings changed/)).toBeInTheDocument();
  expect(screen.getByText(candidate.manifest.plugin.id)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Review current state" }));
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
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Choose plugin folder" }));
  await user.click(await screen.findByRole("checkbox", { name: /I trust this exact/ }));
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
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  expect(await screen.findByRole("button", { name: "Enable" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Read current state" }));
  expect(await screen.findByText(/last successful read/)).toBeInTheDocument();
  expect(screen.getByText(candidate.manifest.plugin.id)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Choose plugin folder" })).toBeDisabled();
});

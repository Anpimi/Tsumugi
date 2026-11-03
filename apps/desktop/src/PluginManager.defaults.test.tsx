import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginManager } from "./PluginManager";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { validateResponseInventory } from "./generated/plugins.validators";
import { i18n } from "./i18n";
import inventory from "../test/fixtures/pluginInventory.contract.json";
import runtime from "../test/fixtures/pluginRuntime.contract.json";
import defaults from "../test/fixtures/pluginDefaults.contract.json";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const onBusy = vi.fn();
function bundled(availability = "available", installed = false, digest = defaults.selectionDigest) {
  const view = { ...inventory.empty, settingsRevision: installed ? "1" : "0", defaultsOffer: { ...defaults, availability, selectionDigest: digest }, runtimeOffers: [runtime],
    packages: installed ? [{ originalInstallAction: "00000000-0000-4000-8000-000000000001", plugin: defaults.packages[0].plugin, packageDigest: defaults.packages[0].packageDigest, origin: runtime.origin, state: "sealed" }] : [],
    packageDecisions: installed ? [{ plugin: defaults.packages[0].plugin, packageDigest: defaults.packages[0].packageDigest, origin: runtime.origin, enabled: true }] : [],
    runtimes: installed ? [{ environment: runtime.environment, environmentDigest: runtime.environmentDigest, origin: runtime.origin, state: "sealed" }] : [],
    runtimeDecisions: installed ? [{ environment: runtime.environment, environmentDigest: runtime.environmentDigest, origin: runtime.origin }] : [],
  };
  if (!validateResponseInventory(view)) throw new Error("Invalid defaults fixture");
  return view;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset(); onBusy.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return bundled();
    if (command === "install_plugin_defaults") return bundled("available", true);
    throw new Error(command);
  });
});
afterEach(cleanup);
it.each([["en-US", "Extensions", "Install bundled extensions", "I approve installing the bundled extensions"], ["zh-CN", "扩展", "安装内置扩展", "我批准安装内置扩展"]])("reviews the exact included set and shows confirmed installation in %s", async (locale, entry, action, consent) => {
  await i18n.changeLanguage(locale); const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: entry })); const button = await screen.findByRole("button", { name: action });
  expect(button).toBeDisabled(); await user.click(screen.getByRole("checkbox", { name: new RegExp(consent) })); await user.click(button);
  await screen.findByRole("button", { name: locale === "en-US" ? "Disable" : "停用" });
  const requests = invoke.mock.calls.filter(([command]) => command === "install_plugin_defaults"); expect(requests).toHaveLength(1);
  expect(requests[0][1].request).toEqual({ id: defaults.id, selectionDigest: defaults.selectionDigest, expectedRevision: "0", actionId: expect.any(String) });
  expect(invoke.mock.calls.some(([command]) => ["select_plugin_package", "install_plugin_package", "install_plugin_runtime", "start_plugin_source"].includes(command))).toBe(false);
});
it("retains the original complete selection after unknown setup and panel close", async () => {
  let attempts = 0; invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return bundled();
    if (command === "install_plugin_defaults") {
      if (++attempts === 1) throw { code: "outcome-unknown", stage: "plugin-install", outcome: "unknown", recoveryRequired: true, reason: "plugin-result-unconfirmed" };
      return bundled("available", true);
    }
    throw new Error(command);
  });
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" })); await user.click(await screen.findByRole("checkbox", { name: /I approve installing the bundled extensions/ }));
  await user.click(screen.getByRole("button", { name: "Install bundled extensions" })); await screen.findByRole("button", { name: "Retry original operation" });
  await user.click(screen.getByRole("button", { name: "Close" })); await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Retry original operation" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled());
  const calls = invoke.mock.calls.filter(([command]) => command === "install_plugin_defaults"); expect(calls).toHaveLength(2); expect(calls[1][1]).toEqual(calls[0][1]);
});
it("explains unavailable bundled files without offering approval or setup", async () => {
  invoke.mockResolvedValue(bundled("resources-unavailable")); const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" })); await screen.findByText(/Bundled extension files are unavailable/);
  expect(screen.queryByRole("button", { name: "Install bundled extensions" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /I approve installing the bundled extensions/ })).not.toBeInTheDocument();
});
it("a refreshed included selection cannot inherit old consent", async () => {
  let reads = 0; invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return bundled("available", false, ++reads === 1 ? defaults.selectionDigest : "b".repeat(64));
    throw new Error(command);
  });
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" })); await user.click(await screen.findByRole("checkbox", { name: /I approve installing the bundled extensions/ }));
  expect(screen.getByRole("button", { name: "Install bundled extensions" })).toBeEnabled(); await user.click(screen.getByRole("button", { name: "Refresh state" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Install bundled extensions" })).toBeDisabled());
});

it.each([
  ["en-US", "Extensions", "AI member resources", "Review included setup", /AI member files are missing or incompatible/, /files are present/],
  ["zh-CN", "扩展", "AI 成员资源", "核对随附资源安装", /AI 成员文件缺失或不兼容/, /AI 成员文件齐全/],
])("explains member resources and reaches existing setup without implicit writes in %s", async (locale, entry, title, setup, missing, present) => {
  await i18n.changeLanguage(locale);
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy} presentation="workbench"/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: entry }));
  const region = await screen.findByRole("region", { name: title });
  expect(region).toHaveTextContent(missing);
  await user.click(screen.getByRole("button", { name: setup }));
  expect(screen.getByRole("checkbox", { name: locale === "en-US" ? /I approve installing the bundled extensions/ : /我批准安装内置扩展/ })).not.toBeChecked();
  expect(invoke.mock.calls.every(([command]) => command === "read_plugin_inventory")).toBe(true);
  invoke.mockResolvedValue({ ...bundled(), memberArtifactAvailability: "available" });
  await user.click(screen.getByRole("button", { name: locale === "en-US" ? "Refresh state" : "刷新状态" }));
  await user.click(screen.getByRole("tab", { name: locale === "en-US" ? "Installed" : "已安装" }));
  await waitFor(() => expect(screen.getByRole("region", { name: title })).toHaveTextContent(present));
  expect(invoke.mock.calls.every(([command]) => command === "read_plugin_inventory")).toBe(true);
});

it("explains a source build without offering an invented bundled installation", async () => {
  invoke.mockResolvedValue(inventory.empty);
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await screen.findByText(/This build has no included extension set/);
  expect(screen.queryByRole("button", { name: "Install bundled extensions" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select plugin folder" })).toBeEnabled();
  expect(invoke.mock.calls.every(([command]) => command === "read_plugin_inventory")).toBe(true);
});

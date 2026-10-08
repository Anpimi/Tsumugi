import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginManager } from "./PluginManager";
import { i18n } from "./i18n";
import type { PluginInventoryView, PluginUninstallRequest } from "./pluginCommands";
import { validateResponseInventory } from "./generated/plugins.validators";
import inventory from "../test/fixtures/pluginInventory.contract.json";
import candidate from "../test/fixtures/pluginPackage.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const onBusy = vi.fn();
const empty = { ...inventory.empty, runtimeOffers: [] };
if (!validateResponseInventory(empty)) throw new Error("Invalid plugin inventory fixture");
const installed: PluginInventoryView = { ...empty, settingsRevision: "1",
  packages: [{ originalInstallAction: "00000000-0000-4000-8000-000000000001", plugin: candidate.manifest.plugin,
    packageDigest: candidate.packageDigest, origin: { sourceId: "manual-local", publisherId: "manual-approval" }, state: "sealed" }],
  packageDecisions: [{ plugin: candidate.manifest.plugin, packageDigest: candidate.packageDigest,
    origin: { sourceId: "manual-local", publisherId: "manual-approval" }, enabled: false }],
};
const withdrawn: PluginInventoryView = { ...installed, settingsRevision: "2", packageDecisions: [] };
function confirmed(request: PluginUninstallRequest, current = withdrawn): PluginInventoryView {
  return { ...current, packages: [], uninstallations: [{ actionId: request.actionId, settingsRevision: request.expectedRevision,
    state: "sealed", installation: { ...installed.packages[0], originalInstallAction: request.originalInstallAction } }] };
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); onBusy.mockReset(); });
afterEach(cleanup);

it.each(["en-US", "zh-CN"])("requires separate reviewed revocation and exact installation removal in %s", async locale => {
  await i18n.changeLanguage(locale);
  let current = installed;
  invoke.mockImplementation(async (command: string, args: { request: PluginUninstallRequest }) => {
    if (command === "read_plugin_inventory") return current;
    if (command === "remove_plugin_approval") { current = { ...withdrawn, lastSettingsAction: args.request.actionId }; return current; }
    if (command === "uninstall_plugin_package") { current = confirmed(args.request, current); return current; }
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.open") }));
  const remove = await screen.findByRole("button", { name: i18n.t("plugins.uninstall") });
  expect(remove).toBeDisabled();
  const revoke = screen.getByRole("button", { name: i18n.t("plugins.revoke") });
  await user.click(revoke);
  expect(screen.getByRole("heading", { name: i18n.t("plugins.revokeTitle", { name: candidate.manifest.plugin.id, version: candidate.manifest.plugin.version }) })).toHaveFocus();
  const confirm = screen.getByRole("button", { name: i18n.t("plugins.confirmRevoke") });
  expect(confirm).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "remove_plugin_approval")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.cancelCleanup") }));
  expect(revoke).toHaveFocus();
  await user.click(revoke);
  await user.click(screen.getByRole("checkbox", { name: i18n.t("plugins.revokeConsent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.confirmRevoke") }));
  await screen.findByText(i18n.t("plugins.approvalRemoved"));
  expect(screen.getByText(candidate.manifest.plugin.id)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.uninstall") }));
  expect(screen.getByRole("button", { name: i18n.t("plugins.confirmUninstall") })).toBeDisabled();
  expect(screen.getByText(i18n.t("plugins.uninstallEffect"))).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("plugins.uninstallConsent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.confirmUninstall") }));
  await screen.findByText(i18n.t("plugins.installationRemoved"));
  expect(screen.getByText(i18n.t("plugins.empty"))).toBeInTheDocument();
  const revokeRequest = invoke.mock.calls.find(([command]) => command === "remove_plugin_approval")?.[1].request;
  const uninstallRequest = invoke.mock.calls.find(([command]) => command === "uninstall_plugin_package")?.[1].request;
  expect(revokeRequest.expectedRevision).toBe("1");
  expect(uninstallRequest).toEqual({ package: { plugin: candidate.manifest.plugin, packageDigest: candidate.packageDigest },
    origin: installed.packages[0].origin, originalInstallAction: installed.packages[0].originalInstallAction,
    expectedRevision: "2", actionId: expect.any(String) });
  expect(uninstallRequest.actionId).not.toBe(revokeRequest.actionId);
  expect(onBusy).toHaveBeenLastCalledWith(false);
});

it.each([
  { code: "busy", stage: "plugin-install", outcome: "rejected", recoveryRequired: true, recoveryGuidance: "reconcile-original" },
  { code: "outcome-unknown", stage: "plugin-install", outcome: "unknown", recoveryRequired: true, recoveryGuidance: "reconcile-original" },
])("retains the original removal across close and newer inventory after $code", async error => {
  let current = withdrawn;
  let attempts = 0;
  invoke.mockImplementation(async (command: string, args: { request: PluginUninstallRequest }) => {
    if (command === "read_plugin_inventory") return current;
    if (command === "uninstall_plugin_package") {
      if (++attempts === 1) throw error;
      return { ...confirmed(args.request, current), packages: current.packages };
    }
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Uninstall this installation" }));
  await user.click(screen.getByRole("checkbox", { name: /I approve removing this exact installation/ }));
  await user.click(screen.getByRole("button", { name: "Confirm installation removal" }));
  await screen.findByRole("button", { name: "Retry original operation" });
  expect(onBusy).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("button", { name: "Review current state" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose plugin folder" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Keep current approval and installation" })).toBeDisabled();
  const laterInstall = { ...installed.packages[0], originalInstallAction: "00000000-0000-4000-8000-000000000002" };
  current = { ...installed, settingsRevision: "9", packages: [laterInstall] };
  await user.click(screen.getByRole("button", { name: "Read current state" }));
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Retry original operation" }));
  await screen.findByText(i18n.t("plugins.installationRemoved"));
  const calls = invoke.mock.calls.filter(([command]) => command === "uninstall_plugin_package");
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toEqual(calls[0][1]);
  expect(calls[1][1].request.expectedRevision).toBe("2");
  expect(calls[1][1].request.originalInstallAction).toBe(installed.packages[0].originalInstallAction);
  expect(screen.getByRole("button", { name: "Revoke approval" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Uninstall this installation" })).toBeDisabled();
  expect(onBusy).toHaveBeenLastCalledWith(false);
});

it("keeps a reviewed request fixed across refresh and permits review after a preflight rejection", async () => {
  let current = withdrawn;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return current;
    if (command === "uninstall_plugin_package") throw { code: "stale-revision", stage: "plugin-install", outcome: "rejected", recoveryRequired: false, recoveryGuidance: "review-current" };
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Uninstall this installation" }));
  await user.click(screen.getByRole("checkbox", { name: /I approve removing this exact/ }));
  current = { ...withdrawn, settingsRevision: "7" };
  await user.click(screen.getByRole("button", { name: "Read current state" }));
  await user.click(screen.getByRole("button", { name: "Confirm installation removal" }));
  await screen.findByRole("button", { name: "Review current state" });
  expect(invoke.mock.calls.find(([command]) => command === "uninstall_plugin_package")?.[1].request.expectedRevision).toBe("2");
  expect(onBusy).toHaveBeenLastCalledWith(false);
  await user.click(screen.getByRole("button", { name: "Review current state" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Uninstall this installation" })).toBeEnabled());
  expect(screen.queryByRole("checkbox", { name: /I approve removing this exact/ })).not.toBeInTheDocument();
});

it("offers approval revocation when installed bytes are missing or need recovery", async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return { ...installed, packages: [{ ...installed.packages[0], state: "recovery-required" }] };
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  expect(await screen.findByRole("button", { name: "Revoke approval" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Uninstall this installation" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Read current state" }));
  // The following read still uses a real inventory shape with approval only.
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return { ...installed, packages: [] };
    throw new Error(command);
  });
  await user.click(screen.getByRole("button", { name: "Read current state" }));
  await screen.findByText(/is approved, but its package is not installed/);
  expect(screen.getByRole("button", { name: "Revoke approval" })).toBeEnabled();
});

it("reconstructs the original removal fields from a retained observation without confirming it on read", async () => {
  const original: PluginUninstallRequest = { package: { plugin: installed.packages[0].plugin, packageDigest: installed.packages[0].packageDigest },
    origin: installed.packages[0].origin, originalInstallAction: installed.packages[0].originalInstallAction,
    expectedRevision: "2", actionId: "00000000-0000-4000-8000-000000000010" };
  const observed: PluginInventoryView = { ...confirmed(original), settingsRevision: "10", uninstallations: [{ ...confirmed(original).uninstallations[0], state: "recovery-required", installation: { ...installed.packages[0], state: "recovery-required" } }] };
  invoke.mockImplementation(async (command: string, args: { request: PluginUninstallRequest }) => {
    if (command === "read_plugin_inventory") return observed;
    if (command === "uninstall_plugin_package") return confirmed(args.request);
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  const summary = await screen.findByText("Previous installation removals", { selector: "summary" });
  await user.click(summary);
  expect(screen.getByText("This original removal needs confirmation.")).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "uninstall_plugin_package")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Review and confirm original removal" }));
  await user.click(screen.getByRole("checkbox", { name: /I approve continuing this original removal/ }));
  await user.click(screen.getByRole("button", { name: "Confirm original removal" }));
  await screen.findByText(i18n.t("plugins.installationRemoved"));
  expect(invoke.mock.calls.find(([command]) => command === "uninstall_plugin_package")?.[1].request).toEqual(original);
});

it("retains an ordinary partially approved installation when the backend requires its original request", async () => {
  let attempts = 0;
  let current: PluginInventoryView = empty;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return current;
    if (command === "select_plugin_package") return candidate;
    if (command === "install_plugin_package") {
      if (++attempts === 1) {
        current = { ...installed, packages: [] };
        throw { code: "storage-failed", stage: "plugin-install", outcome: "rejected", recoveryRequired: true, recoveryGuidance: "reconcile-original" };
      }
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
  await screen.findByText(i18n.t("plugins.pending"));
  expect(screen.queryByText(i18n.t("plugins.cleanupPending"))).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Review current state" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose plugin folder" })).toBeDisabled();
  expect(onBusy).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Read current state" }));
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Retry original operation" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled());
  const calls = invoke.mock.calls.filter(([command]) => command === "install_plugin_package");
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toEqual(calls[0][1]);
  expect(calls[1][1].request.expectedRevision).toBe("0");
  expect(onBusy).toHaveBeenLastCalledWith(false);
});

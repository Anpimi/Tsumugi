import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginManager } from "./PluginManager";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { validateResponseInventory } from "./generated/plugins.validators";
import { i18n } from "./i18n";
import inventory from "../test/fixtures/pluginInventory.contract.json";
import runtime from "../test/fixtures/pluginRuntime.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const onBusy = vi.fn();
function bundled(availability = "available", installed = false) {
  const view = { ...inventory.empty, settingsRevision: installed ? "1" : "0", runtimeOffers: [{ ...runtime, availability }],
    runtimes: installed ? [{ environment: runtime.environment, environmentDigest: runtime.environmentDigest, origin: runtime.origin, state: "sealed" }] : [],
    runtimeDecisions: installed ? [{ environment: runtime.environment, environmentDigest: runtime.environmentDigest, origin: runtime.origin }] : [],
  };
  if (!validateResponseInventory(view)) throw new Error("Invalid runtime fixture");
  return view;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); onBusy.mockReset();
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return bundled();
    if (command === "install_plugin_runtime") return bundled("available", true);
    if (command === "lookup_plugin_runtime") return runtime.environment;
    throw new Error(command);
  });
});
afterEach(cleanup);

it.each([["en-US", "Extensions", "Approve and install runtime", "I approve this exact bundled runtime", "Verify installed environment"],
  ["zh-CN", "扩展", "批准并安装运行环境", "我批准此准确随附运行环境", "核验已安装环境"]])("requires separate exact runtime consent and verifies actual selection in %s", async (locale, entry, install, consent, verify) => {
  await i18n.changeLanguage(locale);
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: entry }));
  const installButton = await screen.findByRole("button", { name: install });
  expect(installButton).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: new RegExp(consent) }));
  await user.click(installButton);
  const verifyButton = await screen.findByRole("button", { name: verify });
  const request = invoke.mock.calls.find(([command]) => command === "install_plugin_runtime")?.[1].request;
  expect(request).toEqual({ id: runtime.id, environmentDigest: runtime.environmentDigest, expectedRevision: "0", actionId: expect.any(String) });
  expect(invoke.mock.calls.some(([command]) => command === "set_plugin_enabled" || command === "install_plugin_package")).toBe(false);
  await user.click(verifyButton);
  await screen.findByText(/No worker was started|没有启动 Worker/);
  expect(invoke).toHaveBeenLastCalledWith("lookup_plugin_runtime", { request: { environmentDigest: runtime.environmentDigest } });
});

it("retains the same original runtime approval after an unknown result and panel close", async () => {
  let attempts = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return bundled();
    if (command === "install_plugin_runtime") {
      if (++attempts === 1) throw { code: "outcome-unknown", stage: "plugin-install", outcome: "unknown", recoveryRequired: true, reason: "plugin-result-unconfirmed" };
      return bundled("available", true);
    }
    throw new Error(command);
  });
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("checkbox", { name: /I approve this exact bundled runtime/ }));
  await user.click(screen.getByRole("button", { name: "Approve and install runtime" }));
  await screen.findByRole("button", { name: "Retry original operation" });
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Retry original operation" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Verify installed environment" })).toBeEnabled());
  const calls = invoke.mock.calls.filter(([command]) => command === "install_plugin_runtime");
  expect(calls).toHaveLength(2); expect(calls[1][1]).toEqual(calls[0][1]);
});

it("explains unsupported runtime availability without permitting installation", async () => {
  invoke.mockResolvedValue(bundled("system-too-old"));
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await screen.findByText(/Update macOS to the stated minimum/);
  expect(screen.queryByRole("button", { name: "Approve and install runtime" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

it("does not clear an earlier unknown runtime outcome after a rejected retry", async () => {
  let attempts = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return bundled();
    if (command === "install_plugin_runtime") {
      if (++attempts === 1) throw { code: "outcome-unknown", stage: "plugin-install", outcome: "unknown", recoveryRequired: true, reason: "plugin-result-unconfirmed" };
      throw { code: "busy", stage: "plugin-install", outcome: "rejected", recoveryRequired: false, reason: "plugin-store-busy" };
    }
    throw new Error(command);
  });
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("checkbox", { name: /I approve this exact bundled runtime/ }));
  await user.click(screen.getByRole("button", { name: "Approve and install runtime" }));
  await user.click(await screen.findByRole("button", { name: "Retry original operation" }));
  await screen.findByText(/Keep this request until confirmation/);
  expect(onBusy).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("button", { name: "Review current state" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose plugin folder" })).toBeDisabled();
});

it.each([["en-US", "Extensions", "Recorded approval for native application"],
  ["zh-CN", "扩展", "已记录原生应用"]])("shows Native approval separately from installed Node trees in %s", async (locale, entry, label) => {
  await i18n.changeLanguage(locale);
  const environment = { protocolVersion: 1, platform: runtime.environment.platform,
    sdkVersion: "0.1.0-alpha.1", processProtocol: 2, profile: "native-application-host-v1",
    hostVersion: "0.2.0-alpha.1", executable: { kind: "darwin-code-directory-hash-v1", value: "a".repeat(40) } };
  const view = { ...inventory.empty, runtimeDecisions: [{ environment, environmentDigest: "b".repeat(64), origin: runtime.origin }] };
  expect(validateResponseInventory(view)).toBe(true);
  invoke.mockResolvedValue(view);
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: entry }));
  await screen.findByText(new RegExp(label));
  expect(screen.queryByText(/Node .*has an approved environment that is not installed|Node .*已批准但尚未安装/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Verify installed environment|核验已安装环境/ })).not.toBeInTheDocument();
  expect(invoke.mock.calls.every(([command]) => command === "read_plugin_inventory")).toBe(true);
});

const nativeEnvironment = { protocolVersion: 1, platform: runtime.environment.platform,
  sdkVersion: "0.1.0-alpha.1", processProtocol: 2, profile: "native-application-host-v1",
  hostVersion: "0.2.0-alpha.1", executable: { kind: "darwin-code-directory-hash-v1", value: "a".repeat(40) } };
function nativeView(approved = false, availability = "available") {
  const node = bundled("available", true);
  const offer = { availability: "available", environment: nativeEnvironment, environmentDigest: "b".repeat(64), origin: runtime.origin };
  const view = { ...node, settingsRevision: approved ? "2" : "1", nativeHostOffer: availability === "available" ? offer : { availability: "unavailable", reason: availability },
    runtimeDecisions: [...node.runtimeDecisions, ...(approved ? [{ environment: nativeEnvironment, environmentDigest: offer.environmentDigest, origin: offer.origin }] : [])] };
  if (!validateResponseInventory(view)) throw new Error("Invalid Native offer fixture");
  return view;
}

it.each([["en-US", "Extensions", "Approve application Host", "I approve this exact application Host identity", "Revoke application Host approval"],
  ["zh-CN", "扩展", "批准应用 Host", "我批准此准确应用 Host 身份", "撤销应用 Host 批准"]])("requires exact independent Native approval and revokes without Node installation in %s", async (locale, entry, approve, consent, revoke) => {
  await i18n.changeLanguage(locale);
  invoke.mockImplementation(async (command: string, args: { request: { approved: boolean } }) => {
    if (command === "read_plugin_inventory") return nativeView();
    if (command === "set_plugin_native_host_approval") return nativeView(args.request.approved);
    throw new Error(command);
  });
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: entry }));
  const button = await screen.findByRole("button", { name: approve });
  expect(button).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: new RegExp(consent) }));
  await user.click(button);
  const revokeButton = await screen.findByRole("button", { name: revoke });
  expect(invoke.mock.calls.find(([command]) => command === "set_plugin_native_host_approval")?.[1].request)
    .toEqual({ environmentDigest: "b".repeat(64), approved: true, expectedRevision: "1", actionId: expect.any(String) });
  await user.click(revokeButton);
  await waitFor(() => expect(screen.getByRole("button", { name: approve })).toBeDisabled());
  const calls = invoke.mock.calls.filter(([command]) => command === "set_plugin_native_host_approval");
  expect(calls).toHaveLength(2);
  expect(calls[1][1].request).toEqual({ environmentDigest: "b".repeat(64), approved: false, expectedRevision: "2", actionId: expect.any(String) });
  expect(calls[1][1].request.actionId).not.toBe(calls[0][1].request.actionId);
  expect(invoke.mock.calls.every(([command]) => command === "read_plugin_inventory" || command === "set_plugin_native_host_approval")).toBe(true);
  expect(screen.getByRole("button", { name: /Verify installed environment|核验已安装环境/ })).toBeEnabled();
});

it("keeps the original Native action through an unknown result, rejected retry and panel close", async () => {
  let attempts = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_plugin_inventory") return nativeView();
    if (command === "set_plugin_native_host_approval") {
      if (++attempts === 1) throw { code: "outcome-unknown", stage: "plugin-settings", outcome: "unknown", recoveryRequired: true, reason: "plugin-result-unconfirmed" };
      if (attempts === 2) throw { code: "busy", stage: "plugin-settings", outcome: "rejected", recoveryRequired: false, reason: "plugin-store-busy" };
      return nativeView(true);
    }
    throw new Error(command);
  });
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("checkbox", { name: /I approve this exact application Host identity/ }));
  await user.click(screen.getByRole("button", { name: "Approve application Host" }));
  await user.click(await screen.findByRole("button", { name: "Retry original operation" }));
  await screen.findByText(/Keep this request until confirmation/);
  expect(onBusy).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("button", { name: "Review current state" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Retry original operation" }));
  await screen.findByRole("button", { name: "Revoke application Host approval" });
  const calls = invoke.mock.calls.filter(([command]) => command === "set_plugin_native_host_approval");
  expect(calls).toHaveLength(3);
  expect(calls[1][1]).toEqual(calls[0][1]); expect(calls[2][1]).toEqual(calls[0][1]);
});

it.each(["unsupported-platform", "identity-unavailable"])("allows removing an obsolete Native approval while current Host is %s", async reason => {
  invoke.mockImplementation(async (command: string) => command === "read_plugin_inventory" ? nativeView(true, reason) : nativeView(false, reason));
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  const revoke = await screen.findByRole("button", { name: "Revoke application Host approval" });
  expect(screen.queryByRole("button", { name: "Approve application Host" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /I approve this exact application Host identity/ })).not.toBeInTheDocument();
  await user.click(revoke);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke application Host approval" })).not.toBeInTheDocument());
  expect(invoke).toHaveBeenLastCalledWith("set_plugin_native_host_approval", { request: { environmentDigest: "b".repeat(64), approved: false, expectedRevision: "2", actionId: expect.any(String) } });
});

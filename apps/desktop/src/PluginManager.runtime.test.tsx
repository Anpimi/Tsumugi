import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginManager } from "./PluginManager";
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
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
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
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
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
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
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
  const user = userEvent.setup(); render(<PluginManager disabled={false} onBusyChange={onBusy}/>);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("checkbox", { name: /I approve this exact bundled runtime/ }));
  await user.click(screen.getByRole("button", { name: "Approve and install runtime" }));
  await user.click(await screen.findByRole("button", { name: "Retry original operation" }));
  await screen.findByText(/Keep this request until confirmation/);
  expect(onBusy).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("button", { name: "Review current state" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose plugin folder" })).toBeDisabled();
});

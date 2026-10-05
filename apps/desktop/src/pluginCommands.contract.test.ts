import { expect, it, vi } from "vitest";
import fixture from "../test/fixtures/pluginInventory.contract.json";
import candidate from "../test/fixtures/pluginPackage.contract.json";
import { validateRequestInventory, validateResponseInventory, validateResponseCandidate, validateRequestInstall, validateRequestEnable, validateRequestRuntimeInstall, validateRequestRuntimeLookup } from "./generated/plugins.validators";
import { pluginCommands } from "./pluginCommands";
import runtime from "../test/fixtures/pluginRuntime.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("keeps the shared Serde fixture's installation and approval observations separate", () => {
  expect(validateRequestInventory(fixture.request)).toBe(true);
  expect(validateResponseInventory(fixture.empty)).toBe(true);
  expect(validateResponseInventory(fixture.rich)).toBe(true);
  expect(fixture.rich.settingsRevision).toBe("18446744073709551615");
  expect(fixture.rich.packages[0].plugin.id).not.toBe(fixture.rich.packageDecisions[0].plugin.id);
  expect(fixture.rich.runtimes[0].state).toBe("recovery-required");
});

it("keeps runtime installation exact and rejects caller approval, resources and execution permission", async () => {
  const request = { id: runtime.id, environmentDigest: runtime.environmentDigest, expectedRevision: "0", actionId: "00000000-0000-4000-8000-000000000030" };
  expect(validateRequestRuntimeInstall(request)).toBe(true);
  for (const field of ["directory", "origin", "environment", "approved", "allowUnsandboxedExecution"]) expect(validateRequestRuntimeInstall({ ...request, [field]: true })).toBe(false);
  expect(validateRequestRuntimeLookup({ environmentDigest: runtime.environmentDigest })).toBe(true);
  expect(validateRequestRuntimeLookup({ environmentDigest: runtime.environmentDigest, launcherPath: "/untrusted" })).toBe(false);
  expect(validateResponseInventory({ ...fixture.empty, runtimeOffers: [runtime] })).toBe(true);
  expect(validateResponseInventory({ ...fixture.empty, runtimeOffers: [runtime, runtime] })).toBe(false);
  expect(validateResponseInventory({ ...fixture.empty, runtimeOffers: [{ ...runtime, availability: "runnable" }] })).toBe(false);
  invoke.mockResolvedValueOnce(fixture.empty);
  await expect(pluginCommands.installRuntime(request)).resolves.toEqual(fixture.empty);
  expect(invoke).toHaveBeenLastCalledWith("install_plugin_runtime", { request });
});

it("rejects caller paths, authority, lossy revisions and unrecognized metadata", () => {
  expect(validateRequestInventory({ directory: "/untrusted" })).toBe(false);
  expect(validateRequestInventory({ approved: true })).toBe(false);
  for (const settingsRevision of [0, 1, "00", "18446744073709551616", "-1"]) {
    expect(validateResponseInventory({ ...fixture.empty, settingsRevision })).toBe(false);
  }
  expect(validateResponseInventory({ ...fixture.empty, permissionGranted: true })).toBe(false);
  expect(validateResponseInventory({ ...fixture.rich, packages: [{ ...fixture.rich.packages[0], state: "runnable" }] })).toBe(false);
  expect(validateResponseInventory({ ...fixture.rich, packageDecisions: [{ ...fixture.rich.packageDecisions[0], enabled: "true" }] })).toBe(false);
  expect(validateResponseInventory({ ...fixture.rich, runtimeDecisions: [{ ...fixture.rich.runtimeDecisions[0], environment: { ...fixture.rich.runtimeDecisions[0].environment, profile: "system-path-fallback" } }] })).toBe(false);
});

it("enforces the Host owner's separate metadata capacities", () => {
  for (const key of ["packages", "runtimes", "packageDecisions", "runtimeDecisions"] as const) {
    expect(validateResponseInventory({ ...fixture.rich, [key]: Array(128).fill(fixture.rich[key][0]) })).toBe(true);
    expect(validateResponseInventory({ ...fixture.rich, [key]: Array(129).fill(fixture.rich[key][0]) })).toBe(false);
  }
});

it("reads through the shared adapter with an empty application request", async () => {
  invoke.mockResolvedValueOnce(fixture.empty);
  await expect(pluginCommands.inventory()).resolves.toEqual(fixture.empty);
  expect(invoke).toHaveBeenLastCalledWith("read_plugin_inventory", { request: {} });
  invoke.mockResolvedValueOnce({ ...fixture.empty, settingsRevision: 0 });
  await expect(pluginCommands.inventory()).rejects.toThrow("Invalid IPC response: read_plugin_inventory");
});

it("uses strict local selection and mutation contracts without caller trust or launcher paths", async () => {
  expect(validateResponseCandidate(candidate)).toBe(true);
  expect(validateResponseCandidate(null)).toBe(true);
  const request = { ticket: candidate.ticket, expectedRevision: "0", actionId: "00000000-0000-4000-8000-000000000011" };
  expect(validateRequestInstall(request)).toBe(true);
  expect(validateRequestInstall({ ...request, directory: "/untrusted" })).toBe(false);
  expect(validateRequestInstall({ ...request, origin: { sourceId: "forged" } })).toBe(false);
  expect(validateRequestEnable({ package: { plugin: candidate.manifest.plugin, packageDigest: candidate.packageDigest }, enabled: true, expectedRevision: "0", actionId: request.actionId })).toBe(true);
  invoke.mockResolvedValueOnce(candidate);
  await expect(pluginCommands.select()).resolves.toEqual(candidate);
  expect(invoke).toHaveBeenLastCalledWith("select_plugin_package", { request: {} });
  invoke.mockResolvedValueOnce(fixture.empty);
  await expect(pluginCommands.install(request)).resolves.toEqual(fixture.empty);
  expect(invoke).toHaveBeenLastCalledWith("install_plugin_package", { request });
});

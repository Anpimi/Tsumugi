import { expect, it, vi } from "vitest";
import fixture from "../test/fixtures/pluginInventory.contract.json";
import { validateRequestInventory, validateResponseInventory } from "./generated/plugins.validators";
import { pluginCommands } from "./pluginCommands";

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

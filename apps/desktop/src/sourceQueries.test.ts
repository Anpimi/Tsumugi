import { expect, it, vi } from "vitest";
import { sourceReads } from "./sourceQueries";
import { pluginSourceInventory, pluginSourcePackage } from "./testSupport/pluginSourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("discovers current binary recipes and supported text recipes, rejecting unknown profiles", async () => {
  const value = structuredClone(pluginSourcePackage);
  const resource = value.manifest.contributions.find(entry => entry.contribution.kind === "resource"
    && entry.contribution.schema.id === "tsumugi.source-import-declaration")!;
  if (resource.contribution.kind !== "resource") throw new Error("Missing source resource");
  const variants = [[2, 2], [3, 2], [4, 2], [3, 3], [1, 1]] as const;
  invoke.mockImplementation(async command => {
    if (command === "read_plugin_inventory") return pluginSourceInventory;
    if (command === "read_plugin_package") return value;
    throw new Error(`Unexpected read: ${command}`);
  });
  for (const [schemaVersion, behaviorVersion] of variants) {
    resource.contribution.schema = { ...resource.contribution.schema, schemaVersion, behaviorVersion };
    const inventory = await sourceReads.inventory(0).read();
    expect(inventory.choices.some(choice => choice.resourceId === resource.id)).toBe(schemaVersion === 2 && behaviorVersion === 2 || schemaVersion === 3 && behaviorVersion === 2);
  }
  expect(invoke.mock.calls.every(([command]) => command === "read_plugin_inventory" || command === "read_plugin_package")).toBe(true);
});

import { expect, it, vi } from "vitest";
import fixture from "../test/fixtures/pluginGenerationComponent.contract.json";
import { pluginCommands } from "./pluginCommands";
import { validateRequestGenerationComponent, validateResponseGenerationComponent } from "./generated/plugins.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("uses an explicit data-only installed generation selection without execution authority", async () => {
  expect(validateRequestGenerationComponent(fixture.request)).toBe(true);
  expect(validateResponseGenerationComponent(fixture.view)).toBe(true);
  expect(validateRequestGenerationComponent({ ...fixture.request, profile: null })).toBe(true);
  const { profile: _profile, ...implicit } = fixture.request;
  expect(validateRequestGenerationComponent(implicit)).toBe(false);
  for (const key of ["scopeId", "grantId", "lease", "model", "confirmed", "directory", "approved"]) {
    expect(validateRequestGenerationComponent({ ...fixture.request, [key]: true })).toBe(false);
    expect(validateResponseGenerationComponent({ ...fixture.view, [key]: true })).toBe(false);
  }
  expect(validateResponseGenerationComponent({ ...fixture.view, settingsRevision: 1 })).toBe(false);
  invoke.mockResolvedValueOnce(fixture.view);
  await expect(pluginCommands.generationComponent(fixture.request)).resolves.toEqual(fixture.view);
  expect(invoke).toHaveBeenLastCalledWith("read_plugin_generation_component", { request: fixture.request });
  const independent = { ...fixture.view, profile: null,
    binding: { ...fixture.view.binding, declaration: { ...fixture.view.binding.declaration, profiles: [] } } };
  expect(validateResponseGenerationComponent(independent)).toBe(true);
  invoke.mockResolvedValueOnce(independent);
  await expect(pluginCommands.generationComponent({ ...fixture.request, profile: null })).resolves.toEqual(independent);
});

it("rejects a validly shaped reply for another provider, profile or environment", async () => {
  for (const field of ["publisher", "id", "version"] as const) {
    const changed = structuredClone(fixture.view);
    changed.binding.provider.plugin[field] = field === "version" ? "0.2.0" : "different";
    expect(validateResponseGenerationComponent(changed)).toBe(true);
    invoke.mockResolvedValueOnce(changed);
    await expect(pluginCommands.generationComponent(fixture.request)).rejects.toThrow("acknowledgement");
  }
  for (const field of ["packageDigest", "componentId", "contributionId"] as const) {
    const changed = structuredClone(fixture.view);
    changed.binding.provider[field] = field === "packageDigest" ? "d".repeat(64) : "different";
    expect(validateResponseGenerationComponent(changed)).toBe(true);
    invoke.mockResolvedValueOnce(changed);
    await expect(pluginCommands.generationComponent(fixture.request)).rejects.toThrow("acknowledgement");
  }
  for (const profile of [null, { ...fixture.view.profile, id: "example.different" },
    { ...fixture.view.profile, schemaVersion: 2 }, { ...fixture.view.profile, behaviorVersion: 2 }]) {
    invoke.mockResolvedValueOnce({ ...fixture.view, profile });
    await expect(pluginCommands.generationComponent(fixture.request)).rejects.toThrow("acknowledgement");
  }
  invoke.mockResolvedValueOnce({ ...fixture.view, environmentDigest: "e".repeat(64) });
  await expect(pluginCommands.generationComponent(fixture.request)).rejects.toThrow("acknowledgement");
  invoke.mockResolvedValueOnce(fixture.view);
  await expect(pluginCommands.generationComponent({ ...fixture.request, profile: null })).rejects.toThrow("acknowledgement");
  invoke.mockResolvedValueOnce({ ...fixture.view, runtimeOrigin: undefined });
  await expect(pluginCommands.generationComponent(fixture.request)).rejects.toThrow("Invalid IPC response");
});

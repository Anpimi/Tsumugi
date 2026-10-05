import { expect, it, vi } from "vitest";
import fixture from "../test/fixtures/pluginInventory.contract.json";
import candidate from "../test/fixtures/pluginPackage.contract.json";
import { validateRequestInventory, validateResponseInventory, validateResponseCandidate, validateRequestInstall, validateRequestEnable, validateRequestRuntimeInstall, validateRequestRuntimeLookup, validateRequestSource, validateResponseSource, validateRequestBuild, validateResponseBuild } from "./generated/plugins.validators";
import { pluginCommands } from "./pluginCommands";
import runtime from "../test/fixtures/pluginRuntime.contract.json";
import source from "../test/fixtures/pluginSource.contract.json";
import build from "../test/fixtures/pluginBuild.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("keeps the shared source recipe, exact providers and installed environment in one read snapshot", () => {
  expect(validateRequestSource(source.request)).toBe(true);
  expect(validateResponseSource(source.view)).toBe(true);
  expect(source.view.extractor.provider.plugin).toEqual(source.request.package.plugin);
  expect(source.view.checker.provider.packageDigest).toBe(source.request.package.packageDigest);
  expect(source.view.extractor.provider.contributionId).not.toBe(source.view.checker.provider.contributionId);
  expect(source.view.environmentDigest).toBe(source.request.environmentDigest);
  expect(source.view.declaration.materials.map(material => material.logicalPath)).toEqual(["materials/raw.txt", "metadata/header.txt"]);
});

it("refuses caller source paths or grants and incomplete or unrecognized source observations", () => {
  for (const field of ["directory", "origin", "environment", "approved", "grantId", "allowUnsandboxedExecution"]) {
    expect(validateRequestSource({ ...source.request, [field]: true })).toBe(false);
  }
  expect(validateRequestSource({ ...source.request, package: { ...source.request.package, approved: true } })).toBe(false);
  expect(validateResponseSource({ ...source.view, settingsRevision: 1 })).toBe(false);
  expect(validateResponseSource({ ...source.view, settingsRevision: "01" })).toBe(false);
  expect(validateResponseSource({ ...source.view, permissionGranted: true })).toBe(false);
  expect(validateResponseSource({ ...source.view, checker: undefined })).toBe(false);
  expect(validateResponseSource({ ...source.view, environment: { ...source.view.environment, launcherPath: "/untrusted" } })).toBe(false);
});

it("reads an exact source environment through the shared adapter and rejects malformed replies", async () => {
  invoke.mockResolvedValueOnce(source.view);
  await expect(pluginCommands.source(source.request)).resolves.toEqual(source.view);
  expect(invoke).toHaveBeenLastCalledWith("read_plugin_source", { request: source.request });
  invoke.mockResolvedValueOnce({ ...source.view, runtimeOrigin: undefined });
  await expect(pluginCommands.source(source.request)).rejects.toThrow("Invalid IPC response: read_plugin_source");
});

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

it("keeps the complete build declaration and exact provider pair in the shared Serde snapshot", () => {
  expect(validateRequestBuild(build.request)).toBe(true);
  expect(validateResponseBuild(build.view)).toBe(true);
  expect(build.view.builder.provider.plugin).toEqual(build.request.package.plugin);
  expect(build.view.checker.provider.packageDigest).toBe(build.request.package.packageDigest);
  expect(build.view.builder.provider.contributionId).not.toBe(build.view.checker.provider.contributionId);
  expect(build.view.declaration.artifactRules).toHaveLength(1);
  expect(build.view.declaration.outputLimits.maxArtifacts).toBe(2);
  expect(build.view.environmentDigest).toBe(build.request.environmentDigest);
});

it("refuses caller build authority and incomplete recipe or runtime observations", () => {
  for (const field of ["directory", "origin", "environment", "approved", "grantId", "allowUnsandboxedExecution"]) {
    expect(validateRequestBuild({ ...build.request, [field]: true })).toBe(false);
  }
  expect(validateRequestBuild({ ...build.request, package: { ...build.request.package, approved: true } })).toBe(false);
  expect(validateResponseBuild({ ...build.view, settingsRevision: 1 })).toBe(false);
  expect(validateResponseBuild({ ...build.view, settingsRevision: "01" })).toBe(false);
  expect(validateResponseBuild({ ...build.view, permissionGranted: true })).toBe(false);
  expect(validateResponseBuild({ ...build.view, checker: undefined })).toBe(false);
  expect(validateResponseBuild({ ...build.view, declaration: { ...build.view.declaration, outputLimits: undefined } })).toBe(false);
  expect(validateResponseBuild({ ...build.view, environment: { ...build.view.environment, launcherPath: "/untrusted" } })).toBe(false);
});

it("reads the installed build recipe through the shared adapter and rejects malformed replies", async () => {
  invoke.mockResolvedValueOnce(build.view);
  await expect(pluginCommands.build(build.request)).resolves.toEqual(build.view);
  expect(invoke).toHaveBeenLastCalledWith("read_plugin_build", { request: build.request });
  invoke.mockResolvedValueOnce({ ...build.view, runtimeOrigin: undefined });
  await expect(pluginCommands.build(build.request)).rejects.toThrow("Invalid IPC response: read_plugin_build");
});

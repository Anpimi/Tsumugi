import { expect, it, vi } from "vitest";
import fixture from "../test/fixtures/pluginInventory.contract.json";
import candidate from "../test/fixtures/pluginPackage.contract.json";
import { validateRequestApprovalRemoval, validateRequestUninstall, validateRequestNativeHostApproval, validateRequestInventory, validateResponseInventory, validateResponseCandidate, validateRequestInstall, validateRequestEnable, validateRequestRuntimeInstall, validateRequestRuntimeLookup, validateRequestSource, validateResponseSource, validateRequestBuild, validateResponseBuild, validateRequestTranslation, validateResponseTranslation } from "./generated/plugins.validators";
import { pluginCommands } from "./pluginCommands";
import runtime from "../test/fixtures/pluginRuntime.contract.json";
import source from "../test/fixtures/pluginSource.contract.json";
import translation from "../test/fixtures/pluginTranslation.contract.json";
import build from "../test/fixtures/pluginBuild.contract.json";
import { textReviewViewFixture } from "./testSupport/textReviewFixture";
import { validateRequestTextReview, validateResponseTextReview, validateResponseTextReviews } from "./generated/plugins.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("reads text declarations without a grant and preserves an unavailable Resource observation", async () => {
  const view = textReviewViewFixture();
  const request = { package: { plugin: view.binding.checker.provider.plugin, packageDigest: view.binding.checker.provider.packageDigest },
    resourceId: view.resourceId, environmentDigest: view.environmentDigest };
  expect(validateRequestTextReview(request)).toBe(true);
  expect(validateRequestTextReview({ ...request, permissionGranted: true })).toBe(false);
  expect(validateResponseTextReview(view)).toBe(true);
  const missing = { settingsRevision: "1", entries: [{ package: request.package, resourceId: request.resourceId, environmentDigest: null,
    availability: { kind: "unavailable", error: { code: "dependency-conflict", stage: "read", outcome: "rejected", recoveryRequired: false, reason: "plugin-runtime-missing" } } }] };
  expect(validateResponseTextReviews(missing)).toBe(true);
  invoke.mockResolvedValueOnce(missing);
  expect(await pluginCommands.textReviews()).toEqual(missing);
  expect(invoke).toHaveBeenLastCalledWith("read_plugin_text_reviews", { request: undefined });
  invoke.mockResolvedValueOnce(view);
  expect(await pluginCommands.textReview(request)).toEqual(view);
  expect(invoke).toHaveBeenLastCalledWith("read_plugin_text_review", { request });
  invoke.mockResolvedValueOnce({ ...view, resourceId: "another-profile" });
  await expect(pluginCommands.textReview(request)).rejects.toThrow("acknowledgement");
  expect(validateResponseTextReview({ ...view, resourcePins: undefined })).toBe(false);
});

it("keeps the shared source recipe, exact providers and installed environment in one read snapshot", () => {
  expect(validateRequestSource(source.request)).toBe(true);
  expect(validateResponseSource(source.view)).toBe(true);
  expect(source.view.extractor.provider.plugin).toEqual(source.request.package.plugin);
  expect(source.view.checker.provider.packageDigest).toBe(source.request.package.packageDigest);
  expect(source.view.extractor.provider.contributionId).not.toBe(source.view.checker.provider.contributionId);
  expect(source.view.declaration.reviewResource).toBe("review-profile");
  expect(source.view.review.checker.provider.plugin).toEqual(source.request.package.plugin);
  expect(source.view.review.checker.provider.packageDigest).toBe(source.request.package.packageDigest);
  expect(source.view.review.declaration.profile).toEqual(source.view.declaration.profile);
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
  expect(validateResponseSource({ ...source.view, review: undefined })).toBe(false);
  expect(validateResponseSource({ ...source.view, review: { ...source.view.review, checker: undefined } })).toBe(false);
  expect(validateResponseSource({ ...source.view, declaration: { ...source.view.declaration, reviewResource: undefined } })).toBe(false);
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


it("reads a declared translation pair and preserves metadata without accepting filesystem or execution grants", async () => {
  expect(validateRequestTranslation(translation.request)).toBe(true);
  expect(validateResponseTranslation(translation.view)).toBe(true);
  for (const field of ["directory", "origin", "environment", "approved", "grantId", "allowUnsandboxedExecution"]) {
    expect(validateRequestTranslation({ ...translation.request, [field]: true })).toBe(false);
  }
  expect(validateResponseTranslation({ ...translation.view, checker: undefined })).toBe(false);
  expect(validateResponseTranslation({ ...translation.view, permissionGranted: true })).toBe(false);
  expect(validateResponseTranslation({ ...translation.view, settingsRevision: "01" })).toBe(false);
  invoke.mockResolvedValueOnce(translation.view);
  await expect(pluginCommands.translation(translation.request)).resolves.toEqual(translation.view);
  expect(invoke).toHaveBeenLastCalledWith("read_plugin_translation", { request: translation.request });
  invoke.mockResolvedValueOnce({ ...translation.view, runtimeOrigin: undefined });
  await expect(pluginCommands.translation(translation.request)).rejects.toThrow("Invalid IPC response: read_plugin_translation");
});


it("reads strict Native decisions without treating them as installed Node environments", async () => {
  const environment = { protocolVersion: 1, platform: runtime.environment.platform,
    sdkVersion: "0.1.0-alpha.1", processProtocol: 3, profile: "native-application-host-v1",
    hostVersion: "0.2.0-alpha.1", executable: { kind: "darwin-code-directory-hash-v1", value: "a".repeat(40) } };
  const decision = { environment, environmentDigest: "b".repeat(64), origin: runtime.origin };
  const view = { ...fixture.empty, runtimeDecisions: [decision] };
  expect(validateResponseInventory(view)).toBe(true);
  expect(validateResponseInventory({ ...view, runtimes: [{ ...decision, state: "sealed" }] })).toBe(false);
  for (const changed of [{ ...environment, tool: runtime.environment.tool },
    { ...environment, host: runtime.environment.host }, { ...environment, executable: undefined }]) {
    expect(validateResponseInventory({ ...view, runtimeDecisions: [{ ...decision, environment: changed }] })).toBe(false);
  }
  invoke.mockResolvedValueOnce(view);
  await expect(pluginCommands.inventory()).resolves.toEqual(view);
  expect(invoke).toHaveBeenLastCalledWith("read_plugin_inventory", { request: {} });
  invoke.mockResolvedValueOnce({ ...view, runtimeDecisions: [{ ...decision, environment: { ...environment, toolVersion: "26.10.0" } }] });
  await expect(pluginCommands.inventory()).rejects.toThrow("Invalid IPC response: read_plugin_inventory");
});

it("keeps current Native offers separate from installed Node files and refuses polluted offers", () => {
  const environment = { protocolVersion: 1, platform: runtime.environment.platform,
    sdkVersion: "0.1.0-alpha.1", processProtocol: 3, profile: "native-application-host-v1",
    hostVersion: "0.2.0-alpha.1", executable: { kind: "darwin-code-directory-hash-v1", value: "a".repeat(40) } };
  const offer = { availability: "available", environment, environmentDigest: "b".repeat(64), origin: runtime.origin };
  expect(validateResponseInventory({ ...fixture.empty, nativeHostOffer: offer })).toBe(true);
  for (const altered of [{ ...offer, fileCount: 1 }, { ...offer, environment: runtime.environment }, { ...offer, environmentDigest: undefined },
    { availability: "unavailable", reason: "identity-unavailable", environment }, { availability: "unavailable", reason: "ready" }]) {
    expect(validateResponseInventory({ ...fixture.empty, nativeHostOffer: altered })).toBe(false);
  }
  expect(validateResponseInventory({ ...fixture.empty, nativeHostOffer: undefined })).toBe(false);
});

it("uses the strict Native approval request and existing inventory decoder", async () => {
  const request = { environmentDigest: "b".repeat(64), approved: true, expectedRevision: "0", actionId: "00000000-0000-4000-8000-000000000031" };
  expect(validateRequestNativeHostApproval(request)).toBe(true);
  expect(validateRequestNativeHostApproval({ ...request, approved: false })).toBe(true);
  for (const field of ["directory", "origin", "environment", "grantId", "allowUnsandboxedExecution"]) {
    expect(validateRequestNativeHostApproval({ ...request, [field]: true })).toBe(false);
  }
  expect(validateRequestNativeHostApproval({ ...request, expectedRevision: 0 })).toBe(false);
  expect(validateRequestNativeHostApproval({ ...request, approved: undefined })).toBe(false);
  invoke.mockResolvedValueOnce(fixture.empty);
  await expect(pluginCommands.nativeHostApproval(request)).resolves.toEqual(fixture.empty);
  expect(invoke).toHaveBeenLastCalledWith("set_plugin_native_host_approval", { request });
  invoke.mockResolvedValueOnce({ ...fixture.empty, nativeHostOffer: undefined });
  await expect(pluginCommands.nativeHostApproval(request)).rejects.toThrow("Invalid IPC response: set_plugin_native_host_approval");
});

it("requires the complete original installation and confirms only its exact removal receipt", async () => {
  invoke.mockReset();
  const installation = fixture.rich.packages[0];
  const original = fixture.rich.uninstallations[0];
  const request = { package: { plugin: installation.plugin, packageDigest: installation.packageDigest },
    origin: installation.origin, originalInstallAction: installation.originalInstallAction,
    expectedRevision: original.settingsRevision, actionId: original.actionId };
  expect(validateRequestUninstall(request)).toBe(true);
  const { originalInstallAction: _omitted, ...incomplete } = request;
  expect(validateRequestUninstall(incomplete)).toBe(false);
  expect(validateRequestUninstall({ ...request, expectedRevision: 0 })).toBe(false);
  expect(validateRequestUninstall({ ...request, approved: true })).toBe(false);
  const sealed = { ...original, state: "sealed", installation: { ...original.installation, state: "sealed" } };
  const confirmed = { ...fixture.rich, uninstallations: [sealed] };
  invoke.mockResolvedValueOnce(confirmed);
  await expect(pluginCommands.uninstall(request)).resolves.toEqual(confirmed);
  for (const wrong of [
    { ...sealed, actionId: "00000000-0000-4000-8000-000000000004" },
    { ...sealed, settingsRevision: "0" },
    { ...sealed, state: "recovery-required" },
    { ...sealed, installation: { ...sealed.installation, state: "recovery-required" } },
    { ...sealed, installation: { ...sealed.installation, originalInstallAction: sealed.actionId } },
    { ...sealed, installation: { ...sealed.installation, origin: { ...installation.origin, publisherId: "different-source" } } },
    { ...sealed, installation: { ...sealed.installation, packageDigest: "4".repeat(64) } },
    { ...sealed, installation: { ...sealed.installation, plugin: { ...installation.plugin, version: "0.2.0" } } },
  ]) {
    invoke.mockResolvedValueOnce({ ...confirmed, uninstallations: [wrong] });
    await expect(pluginCommands.uninstall(request)).rejects.toThrow("Invalid IPC acknowledgement: uninstall");
  }
  invoke.mockResolvedValueOnce({ ...confirmed, uninstallations: [] });
  await expect(pluginCommands.uninstall(request)).rejects.toThrow("Invalid IPC acknowledgement: uninstall");
});

it("confirms approval withdrawal separately from installation removal", async () => {
  invoke.mockReset();
  const installation = fixture.rich.packages[0];
  const request = { package: { plugin: installation.plugin, packageDigest: installation.packageDigest },
    origin: installation.origin, expectedRevision: "0", actionId: "00000000-0000-4000-8000-000000000004" };
  expect(validateRequestApprovalRemoval(request)).toBe(true);
  expect(validateRequestApprovalRemoval({ ...request, enabled: false })).toBe(false);
  const confirmed = { ...fixture.empty, packages: [installation], settingsRevision: "1", lastSettingsAction: request.actionId };
  invoke.mockResolvedValueOnce(confirmed);
  await expect(pluginCommands.removeApproval(request)).resolves.toEqual(confirmed);
  for (const wrong of [
    { ...confirmed, settingsRevision: "2" },
    { ...confirmed, lastSettingsAction: null },
    { ...confirmed, packageDecisions: [{ ...request.package, origin: request.origin, enabled: false }] },
  ]) {
    invoke.mockResolvedValueOnce(wrong);
    await expect(pluginCommands.removeApproval(request)).rejects.toThrow("Invalid IPC acknowledgement: approval removal");
  }
});

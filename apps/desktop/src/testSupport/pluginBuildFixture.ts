import contract from "../../test/fixtures/pluginBuild.contract.json";
import workflow from "../../test/fixtures/pluginBuildWorkflow.contract.json";
import packageFixture from "../../test/fixtures/pluginPackage.contract.json";
import type { PluginBuildView, PluginInventoryView, PluginPackageDetailsView } from "../pluginCommands";
import { validateResponseBuild, validateResponseInventory, validateResponsePackage } from "../generated/plugins.validators";
import type { SavedPluginBuildView } from "../releaseCommands";
import { validateResponseSavedPluginBuild } from "../generated/release.validators";

if (!validateResponseBuild(contract.view)) throw new Error("Invalid canonical build fixture");
export const pluginBuildView: PluginBuildView = contract.view;
const nodeEnvironment = pluginBuildView.environment;
if (nodeEnvironment.profile !== "node-system-libraries-v1") throw new Error("Expected the canonical Node environment");
export const pluginBuildRequest = contract.request;
export const pluginBuildWorkflow = workflow;
if (!validateResponseSavedPluginBuild(workflow.savedBuild)) throw new Error("Invalid canonical saved build fixture");
export const savedPluginBuild: SavedPluginBuildView = workflow.savedBuild;
export const pluginBuildInventory: PluginInventoryView = {
  uninstallations: [],
  settingsRevision: "1", lastSettingsAction: null, runtimeOffers: [], defaultsOffer: null,
  nativeHostOffer: { availability: "unavailable", reason: "identity-unavailable" },
  packages: [{ originalInstallAction: "00000000-0000-4000-8000-000000000001", ...contract.request.package, origin: contract.view.packageOrigin, state: "sealed" }],
  packageDecisions: [{ ...contract.request.package, origin: contract.view.packageOrigin, enabled: true }],
  runtimes: [{ environment: nodeEnvironment, environmentDigest: contract.view.environmentDigest, origin: contract.view.runtimeOrigin, state: "sealed" }],
  runtimeDecisions: [{ environment: nodeEnvironment, environmentDigest: contract.view.environmentDigest, origin: contract.view.runtimeOrigin }],
};
export const pluginBuildPackage: PluginPackageDetailsView = {
  enabled: true, packageDigest: contract.request.package.packageDigest,
  manifest: { ...(packageFixture.manifest as PluginPackageDetailsView["manifest"]), plugin: contract.request.package.plugin,
    contributions: [{ id: contract.request.resourceId, componentId: packageFixture.manifest.components[0].id,
      contribution: { kind: "resource", path: "profiles/build.json", schema: { id: "tsumugi.build-declaration", schemaVersion: 1, behaviorVersion: 1 } } }],
  },
};
// Canonical Rust views and synthetic combinations pass the actual IPC validators.
if (!validateResponseBuild(pluginBuildView) || !validateResponseInventory(pluginBuildInventory) || !validateResponsePackage(pluginBuildPackage)) throw new Error("Invalid plugin build fixture");

import contract from "../../test/fixtures/pluginBuild.contract.json";
import workflow from "../../test/fixtures/pluginBuildWorkflow.contract.json";
import packageFixture from "../../test/fixtures/pluginPackage.contract.json";
import type { PluginBuildView, PluginInventoryView, PluginPackageDetailsView } from "../pluginCommands";
import { validateResponseBuild, validateResponseInventory, validateResponsePackage } from "../generated/plugins.validators";

export const pluginBuildView = contract.view as PluginBuildView;
export const pluginBuildRequest = contract.request;
export const pluginBuildWorkflow = workflow;
export const pluginBuildInventory: PluginInventoryView = {
  settingsRevision: "1", lastSettingsAction: null, runtimeOffers: [], defaultsOffer: null,
  nativeHostOffer: { availability: "unavailable", reason: "identity-unavailable" },
  packages: [{ ...contract.request.package, origin: contract.view.packageOrigin, state: "sealed" }],
  packageDecisions: [{ ...contract.request.package, origin: contract.view.packageOrigin, enabled: true }],
  runtimes: [{ environment: pluginBuildView.environment, environmentDigest: contract.view.environmentDigest, origin: contract.view.runtimeOrigin, state: "sealed" }],
  runtimeDecisions: [{ environment: pluginBuildView.environment, environmentDigest: contract.view.environmentDigest, origin: contract.view.runtimeOrigin }],
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

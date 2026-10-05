import source from "../../test/fixtures/pluginSource.contract.json";
import workflow from "../../test/fixtures/pluginSourceWorkflow.contract.json";
import packageFixture from "../../test/fixtures/pluginPackage.contract.json";
import type { PluginInventoryView, PluginPackageDetailsView, PluginSourceView } from "../pluginCommands";

export const pluginSourceView = source.view as PluginSourceView;
export const pluginSourceRequest = source.request;
export const pluginSourceWorkflow = workflow;
export const pluginSourceInventory: PluginInventoryView = {
  settingsRevision: "1", lastSettingsAction: null, runtimeOffers: [], defaultsOffer: null,
  packages: [{ plugin: source.request.package.plugin, packageDigest: source.request.package.packageDigest, origin: source.view.packageOrigin, state: "sealed" }],
  packageDecisions: [{ plugin: source.request.package.plugin, packageDigest: source.request.package.packageDigest, origin: source.view.packageOrigin, enabled: true }],
  runtimes: [{ environment: pluginSourceView.environment, environmentDigest: source.view.environmentDigest, origin: source.view.runtimeOrigin, state: "sealed" }],
  runtimeDecisions: [{ environment: pluginSourceView.environment, environmentDigest: source.view.environmentDigest, origin: source.view.runtimeOrigin }],
};
export const pluginSourcePackage: PluginPackageDetailsView = {
  enabled: true, packageDigest: source.request.package.packageDigest,
  manifest: { ...(packageFixture.manifest as PluginPackageDetailsView["manifest"]), plugin: source.request.package.plugin,
    contributions: [{ id: source.request.resourceId, componentId: packageFixture.manifest.components[0].id,
      contribution: { kind: "resource", path: "profiles/source-import.json", schema: { id: "tsumugi.source-import-declaration", schemaVersion: 1, behaviorVersion: 1 } } }],
  },
};

// Every synthetic view is checked by the same generated validators as IPC.
import { validateResponseSource, validateResponseInventory, validateResponsePackage } from "../generated/plugins.validators";
if (!validateResponseSource(pluginSourceView) || !validateResponseInventory(pluginSourceInventory) || !validateResponsePackage(pluginSourcePackage)) throw new Error("Invalid plugin source fixture");

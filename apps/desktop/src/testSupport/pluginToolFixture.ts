import workflow from "../../test/fixtures/pluginToolWorkflow.contract.json";
import declaration from "../../../../crates/plugin-sdk/tests/fixtures/tool.query.json";
import { pluginBuildPackage } from "./pluginBuildFixture";
import type { PluginInventoryView, PluginPackageDetailsView, PluginToolView } from "../pluginCommands";
import { validateResponseInventory, validateResponsePackage, validateResponseTool } from "../generated/plugins.validators";

const claim = { ...workflow.view, binding: { ...workflow.view.binding, declaration,
  capability: { ...workflow.view.binding.capability, declaration: { ...workflow.view.binding.capability.declaration,
    inputSchema: declaration.query.inputSchema, outputSchema: declaration.query.outputSchema, profiles: [declaration.profile] } },
  resources: [{ ...workflow.view.binding.resources[0], contributionId: "terms" }] } };
if (!validateResponseTool(claim)) throw new Error("Invalid synthetic text query fixture");
export const toolQueryView: PluginToolView = claim;
const nodeEnvironment = toolQueryView.environment;
if (nodeEnvironment.profile !== "node-system-libraries-v1") throw new Error("Expected the synthetic Node query environment");
const provider = toolQueryView.binding.capability.provider;
export const toolQueryPackage: PluginPackageDetailsView = { ...pluginBuildPackage, packageDigest: provider.packageDigest,
  manifest: { ...pluginBuildPackage.manifest, plugin: provider.plugin,
    components: pluginBuildPackage.manifest.components.map(component => ({ ...component, runtime: "javascript" })),
    contributions: [{ id: toolQueryView.resourceId, componentId: pluginBuildPackage.manifest.components[0].id,
      contribution: { kind: "resource", path: "resources/query.json", schema: { id: "tsumugi.capability-tool-declaration", schemaVersion: 1, behaviorVersion: 1 } } }] } };
export const toolQueryInventory: PluginInventoryView = { settingsRevision: "1", lastSettingsAction: null, runtimeOffers: [], defaultsOffer: null,
  nativeHostOffer: { availability: "unavailable", reason: "identity-unavailable" },
  packages: [{ plugin: provider.plugin, packageDigest: provider.packageDigest, origin: toolQueryView.packageOrigin, state: "sealed" }],
  packageDecisions: [{ plugin: provider.plugin, packageDigest: provider.packageDigest, origin: toolQueryView.packageOrigin, enabled: true }],
  runtimes: [{ environment: nodeEnvironment, environmentDigest: toolQueryView.environmentDigest, origin: toolQueryView.runtimeOrigin, state: "sealed" }],
  runtimeDecisions: [{ environment: toolQueryView.environment, environmentDigest: toolQueryView.environmentDigest, origin: toolQueryView.runtimeOrigin }],
};
if (!validateResponseInventory(toolQueryInventory) || !validateResponsePackage(toolQueryPackage)) throw new Error("Invalid synthetic query inventory/package fixture");

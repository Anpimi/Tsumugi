import fixture from "../../test/fixtures/workPlanGenerationComponent.contract.json";
import type { PluginInventoryView, PluginPackageDetailsView } from "../pluginCommands";
import { validateResponseGenerationComponent, validateResponseInventory, validateResponsePackage } from "../generated/plugins.validators";

const component: unknown = fixture.preflight.component;
if (!validateResponseGenerationComponent(component)) throw new Error("Invalid synthetic generation component fixture");
export const generationComponent = component;
const environment = component.environment;
if (environment.profile !== "node-system-libraries-v1") throw new Error("Expected synthetic JavaScript environment");
const provider = component.binding.provider;
export const generationPackage: PluginPackageDetailsView = { enabled: true, packageDigest: provider.packageDigest,
  manifest: { protocolVersion: 1, plugin: provider.plugin, permissions: component.binding.declaration.permissions,
    components: [{ id: provider.componentId, scope: component.componentScope, runtime: "javascript", entrypoint: "component.mjs",
      dependencies: [{ contract: { id: "tsumugi.work-plan-generation", schemaVersion: 1, behaviorVersion: 1 }, required: true, selection: "single" }],
      exit: { stopTimeoutMs: 300, cleanupTimeoutMs: 500 } }],
    contributions: [{ id: provider.contributionId, componentId: provider.componentId, contribution: { kind: "capability", declaration: component.binding.declaration } }] } };
export const generationInventory: PluginInventoryView = { uninstallations: [], settingsRevision: component.settingsRevision, lastSettingsAction: null,
  defaultsOffer: null, runtimeOffers: [], nativeHostOffer: { availability: "unavailable", reason: "identity-unavailable" },
  packages: [{ originalInstallAction: "00000000-0000-4000-8000-000000000001", plugin: provider.plugin, packageDigest: provider.packageDigest, origin: component.packageOrigin, state: "sealed" }],
  packageDecisions: [{ plugin: provider.plugin, packageDigest: provider.packageDigest, origin: component.packageOrigin, enabled: true }],
  runtimes: [{ environment, environmentDigest: component.environmentDigest, origin: component.runtimeOrigin, state: "sealed" }],
  runtimeDecisions: [{ environment, environmentDigest: component.environmentDigest, origin: component.runtimeOrigin }] };
if (!validateResponseInventory(generationInventory) || !validateResponsePackage(generationPackage)) throw new Error("Invalid synthetic generation installation fixture");

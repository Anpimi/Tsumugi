import capture from "../../test/fixtures/pluginTranslationCapture.contract.json";
import workflow from "../../test/fixtures/pluginTranslationExecution.contract.json";
import packageFixture from "../../test/fixtures/pluginPackage.contract.json";
import { validateResponsePluginPreflight, validateResponsePluginSelection, validateResponseCheckReview, validateResponseProjectionReview } from "../generated/translation.validators";
import { validateResponseInventory, validateResponsePackage } from "../generated/plugins.validators";
import type { PluginInventoryView, PluginPackageDetailsView } from "../pluginCommands";

function checked<T>(value: unknown, validate: (value: unknown) => value is T): T {
  if (!validate(value)) throw new Error("Invalid canonical translation fixture");
  return value;
}
export const translationSelection = checked(capture.selection, validateResponsePluginSelection);
if (!translationSelection) throw new Error("Expected a canonical selected folder");
export const translationCapture = checked(capture.preflight, validateResponsePluginPreflight);
export const translationCheck = checked(workflow.checkReview, validateResponseCheckReview);
export const translationProjection = checked(workflow.projectionReview, validateResponseProjectionReview);
export const translationView = translationCapture.translation;
const packageRequest = { plugin: translationView.extractor.provider.plugin, packageDigest: translationView.extractor.provider.packageDigest };
export const translationInventory: PluginInventoryView = checked({
  uninstallations: [],
  settingsRevision: "1", lastSettingsAction: null, runtimeOffers: [], defaultsOffer: null,
  nativeHostOffer: { availability: "unavailable", reason: "identity-unavailable" },
  packages: [{ originalInstallAction: "00000000-0000-4000-8000-000000000001", ...packageRequest, origin: translationView.packageOrigin, state: "sealed" }],
  packageDecisions: [{ ...packageRequest, origin: translationView.packageOrigin, enabled: true }],
  runtimes: [{ environment: translationView.environment, environmentDigest: translationView.environmentDigest, origin: translationView.runtimeOrigin, state: "sealed" }],
  runtimeDecisions: [{ environment: translationView.environment, environmentDigest: translationView.environmentDigest, origin: translationView.runtimeOrigin }],
}, validateResponseInventory);
export const translationPackage: PluginPackageDetailsView = checked({
  enabled: true, packageDigest: packageRequest.packageDigest,
  manifest: { ...packageFixture.manifest, plugin: packageRequest.plugin,
    contributions: [{ id: translationView.resourceId, componentId: packageFixture.manifest.components[0].id,
      contribution: { kind: "resource", path: "profiles/translation.json", schema: { id: "tsumugi.translation-import-declaration", schemaVersion: 1, behaviorVersion: 1 } } }],
  },
}, validateResponsePackage);

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
  settingsRevision: "1", lastSettingsAction: null, runtimeOffers: [], defaultsOffer: null, memberArtifactAvailability: "resources-unavailable",
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

/** Synthetic paired selection for UI consent tests, never execution evidence. */
export function pairedTranslationFixture() {
  const { material, ...declaration } = translationView.declaration;
  const { file, ...preflight } = translationCapture;
  const selected = translationSelection;
  if (!material || !file || !selected) throw new Error("Expected the original single-file fixture");
  const fileSets = [{ id: "translations", displayName: "Translated files", role: "translation", encoding: "binary" as const,
    extensions: ["esp", "strings"], minFiles: 1, maxFiles: 2, maxBytes: 2097152 }];
  const view = { ...translationView, declaration: { ...declaration, fileSets, maxTotalBytes: 2097152 },
    extractor: { ...translationView.extractor, declaration: { ...translationView.extractor.declaration,
      inputSchema: { ...translationView.extractor.declaration.inputSchema, schemaVersion: 3 },
      outputSchema: { ...translationView.extractor.declaration.outputSchema, schemaVersion: 3 },
      limits: { ...translationView.extractor.declaration.limits, maxInputBytes: 6291456, maxOutputBytes: 8388608 } } },
    checker: { ...translationView.checker, declaration: { ...translationView.checker.declaration,
      inputSchema: { ...translationView.checker.declaration.inputSchema, schemaVersion: 3 },
      limits: { ...translationView.checker.declaration.limits, maxInputBytes: 16777216 } } } };
  const pairedPackage: PluginPackageDetailsView = { ...translationPackage, manifest: { ...translationPackage.manifest,
    contributions: translationPackage.manifest.contributions.map(item => item.contribution.kind === "resource" ? {
      ...item, contribution: { ...item.contribution, schema: { ...item.contribution.schema, schemaVersion: 2 } } } : item) } };
  const files = [{ ...file, logicalPath: "Example.esp", role: "translation", byteLength: 3 },
    { ...file, logicalPath: "Strings/Example.strings", role: "translation", byteLength: 4 }];
  const selection = { ...selected, translation: view, fileSets: [{ id: "translations", logicalPaths: files.map(file => file.logicalPath) }] };
  return { package: pairedPackage, view, selection, preflight: { ...preflight, translation: view, files,
    pairedSourceFiles: [{ ...file, logicalPath: "Original.esp", role: "source", byteLength: 100 }] } };
}

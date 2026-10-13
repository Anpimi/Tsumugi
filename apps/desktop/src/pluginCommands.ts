import { checkedInvoke } from "./ipc";
import { validateResponseInventory, validateResponseCandidate, validateResponsePackage, validateResponseBinding, validateResponseRuntime, validateResponseSource, validateResponseBuild, validateResponseTranslation, validateResponseTool, validateResponseTextReview, validateResponseTextReviews } from "./generated/plugins.validators";
import type { PluginApprovalRemovalRequest, PluginUninstallRequest, PluginInstallRequest, PluginEnableRequest, PluginPackageRequest, PluginLookupRequest, PluginNativeHostApprovalRequest, PluginRuntimeInstallRequest, PluginDefaultsInstallRequest, PluginRuntimeLookupRequest, PluginSourceRequest, PluginBuildRequest, PluginTranslationRequest, PluginToolRequest, PluginTextReviewRequest } from "./generated/plugins.requests";
import type { ReviewCheckRequest } from "./generated/review.requests";
import type { PluginInventoryView, PluginPackageDetailsView } from "./generated/plugins.responses";
import { validateResponseGenerationComponent } from "./generated/plugins.validators";
import type { PluginGenerationComponentRequest } from "./generated/plugins.requests";
export type { PluginGenerationComponentRequest } from "./generated/plugins.requests";
export type { PluginGenerationComponentView } from "./generated/plugins.responses";
export type PluginTextReviewSelection = ReviewCheckRequest["advisoryChecks"][number];
export type { PluginTextReviewRequest } from "./generated/plugins.requests";
export type { PluginTextReviewView, PluginTextReviewListView, PluginTextReviewListEntry } from "./generated/plugins.responses";
export type { PluginApprovalRemovalRequest, PluginUninstallRequest, PluginInstallRequest, PluginEnableRequest, PluginPackageRequest, PluginLookupRequest, PluginNativeHostApprovalRequest, PluginRuntimeInstallRequest, PluginDefaultsInstallRequest, PluginRuntimeLookupRequest, PluginSourceRequest, PluginBuildRequest, PluginTranslationRequest, PluginToolRequest } from "./generated/plugins.requests";
export type { PluginInventoryView, PluginCandidateView, PluginPackageDetailsView, PluginRuntimeOfferView, PermissionRequest, PluginSourceView, PluginBuildView, PluginTranslationView, PluginToolView } from "./generated/plugins.responses";

export const pluginCommands = {
  inventory: () => checkedInvoke("read_plugin_inventory", {}, validateResponseInventory),
  select: () => checkedInvoke("select_plugin_package", {}, validateResponseCandidate),
  install: (request: PluginInstallRequest) => checkedInvoke("install_plugin_package", request, validateResponseInventory),
  removeApproval: async (request: PluginApprovalRemovalRequest) => {
    const view = await checkedInvoke("remove_plugin_approval", request, validateResponseInventory);
    if (view.lastSettingsAction !== request.actionId || BigInt(view.settingsRevision) !== BigInt(request.expectedRevision) + 1n
      || view.packageDecisions.some(item => samePackage(item, request.package) && sameOrigin(item.origin, request.origin))) {
      throw new Error("Invalid IPC acknowledgement: approval removal");
    }
    return view;
  },
  uninstall: async (request: PluginUninstallRequest) => {
    const view = await checkedInvoke("uninstall_plugin_package", request, validateResponseInventory);
    if (!view.uninstallations.some(item => item.actionId === request.actionId && item.settingsRevision === request.expectedRevision
      && item.state === "sealed" && item.installation.state === "sealed" && samePackage(item.installation, request.package)
      && sameOrigin(item.installation.origin, request.origin) && item.installation.originalInstallAction === request.originalInstallAction)) {
      throw new Error("Invalid IPC acknowledgement: uninstall");
    }
    return view;
  },
  enable: (request: PluginEnableRequest) => checkedInvoke("set_plugin_enabled", request, validateResponseInventory),
  package: (request: PluginPackageRequest) => checkedInvoke("read_plugin_package", request, validateResponsePackage),
  lookup: (request: PluginLookupRequest) => checkedInvoke("lookup_plugin_capability", request, validateResponseBinding),
  installDefaults: (request: PluginDefaultsInstallRequest) => checkedInvoke("install_plugin_defaults", request, validateResponseInventory),
  nativeHostApproval: (request: PluginNativeHostApprovalRequest) => checkedInvoke("set_plugin_native_host_approval", request, validateResponseInventory),
  installRuntime: (request: PluginRuntimeInstallRequest) => checkedInvoke("install_plugin_runtime", request, validateResponseInventory),
  lookupRuntime: (request: PluginRuntimeLookupRequest) => checkedInvoke("lookup_plugin_runtime", request, validateResponseRuntime),
  build: (request: PluginBuildRequest) => checkedInvoke("read_plugin_build", request, validateResponseBuild),
  translation: (request: PluginTranslationRequest) => checkedInvoke("read_plugin_translation", request, validateResponseTranslation),
  source: (request: PluginSourceRequest) => checkedInvoke("read_plugin_source", request, validateResponseSource),
  tool: (request: PluginToolRequest) => checkedInvoke("read_plugin_tool", request, validateResponseTool),
  generationComponent: async (request: PluginGenerationComponentRequest) => {
    const view = await checkedInvoke("read_plugin_generation_component", request, validateResponseGenerationComponent);
    const expected = request.provider;
    const provider = view.binding.provider;
    const profile = request.profile;
    if (provider.plugin.publisher !== expected.plugin.publisher || provider.plugin.id !== expected.plugin.id
      || provider.plugin.version !== expected.plugin.version || provider.packageDigest !== expected.packageDigest
      || provider.componentId !== expected.componentId || provider.contributionId !== expected.contributionId
      || view.environmentDigest !== request.environmentDigest || (view.profile === null) !== (profile === null)
      || (view.profile !== null && profile !== null && (view.profile.id !== profile.id
        || view.profile.schemaVersion !== profile.schemaVersion || view.profile.behaviorVersion !== profile.behaviorVersion))) {
      throw new Error("Invalid IPC acknowledgement: generation component");
    }
    return view;
  },
  textReview: async (request: PluginTextReviewRequest) => {
    const view = await checkedInvoke("read_plugin_text_review", request, validateResponseTextReview);
    const provider = view.binding.checker.provider;
    if (view.resourceId !== request.resourceId || view.environmentDigest !== request.environmentDigest
      || provider.packageDigest !== request.package.packageDigest
      || provider.plugin.publisher !== request.package.plugin.publisher || provider.plugin.id !== request.package.plugin.id
      || provider.plugin.version !== request.package.plugin.version) throw new Error("Invalid IPC acknowledgement: text review");
    return view;
  },
  textReviews: () => checkedInvoke("read_plugin_text_reviews", undefined, validateResponseTextReviews),
};

/** Package reads share the native Store's exclusive application lock. Preserve
 * its Busy/error boundary by scanning in order instead of competing reads. */
export async function readEnabledPluginPackages(inventory: PluginInventoryView, current: () => boolean = () => true): Promise<PluginPackageDetailsView[]> {
  const packages: PluginPackageDetailsView[] = [];
  for (const item of inventory.packages) {
    if (!current()) break;
    if (item.state !== "sealed" || !inventory.packageDecisions.some(decision => decision.enabled
      && decision.packageDigest === item.packageDigest && decision.plugin.publisher === item.plugin.publisher
      && decision.plugin.id === item.plugin.id && decision.plugin.version === item.plugin.version)) continue;
    const details = await pluginCommands.package({ plugin: item.plugin, packageDigest: item.packageDigest });
    if (!current()) break;
    if (details.enabled) packages.push(details);
  }
  return packages;
}

function samePackage(left: PluginPackageRequest, right: PluginPackageRequest): boolean {
  return left.packageDigest === right.packageDigest && left.plugin.publisher === right.plugin.publisher
    && left.plugin.id === right.plugin.id && left.plugin.version === right.plugin.version;
}
function sameOrigin(left: { sourceId: string; publisherId: string }, right: { sourceId: string; publisherId: string }): boolean {
  return left.sourceId === right.sourceId && left.publisherId === right.publisherId;
}

import { checkedInvoke } from "./ipc";
import { validateResponseInventory, validateResponseCandidate, validateResponsePackage, validateResponseBinding, validateResponseRuntime, validateResponseSource, validateResponseBuild, validateResponseTranslation, validateResponseTool, validateResponseTextReview, validateResponseTextReviews } from "./generated/plugins.validators";
import type { PluginInstallRequest, PluginEnableRequest, PluginPackageRequest, PluginLookupRequest, PluginNativeHostApprovalRequest, PluginRuntimeInstallRequest, PluginDefaultsInstallRequest, PluginRuntimeLookupRequest, PluginSourceRequest, PluginBuildRequest, PluginTranslationRequest, PluginToolRequest, PluginTextReviewRequest } from "./generated/plugins.requests";
import type { ReviewCheckRequest } from "./generated/review.requests";
import type { PluginInventoryView, PluginPackageDetailsView } from "./generated/plugins.responses";
export type PluginTextReviewSelection = ReviewCheckRequest["advisoryChecks"][number];
export type { PluginTextReviewRequest } from "./generated/plugins.requests";
export type { PluginTextReviewView, PluginTextReviewListView, PluginTextReviewListEntry } from "./generated/plugins.responses";
export type { PluginInstallRequest, PluginEnableRequest, PluginPackageRequest, PluginLookupRequest, PluginNativeHostApprovalRequest, PluginRuntimeInstallRequest, PluginDefaultsInstallRequest, PluginRuntimeLookupRequest, PluginSourceRequest, PluginBuildRequest, PluginTranslationRequest, PluginToolRequest } from "./generated/plugins.requests";
export type { PluginInventoryView, PluginCandidateView, PluginPackageDetailsView, PluginRuntimeOfferView, PermissionRequest, PluginSourceView, PluginBuildView, PluginTranslationView, PluginToolView } from "./generated/plugins.responses";

export const pluginCommands = {
  inventory: () => checkedInvoke("read_plugin_inventory", {}, validateResponseInventory),
  select: () => checkedInvoke("select_plugin_package", {}, validateResponseCandidate),
  install: (request: PluginInstallRequest) => checkedInvoke("install_plugin_package", request, validateResponseInventory),
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

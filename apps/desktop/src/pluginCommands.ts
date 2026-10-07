import { checkedInvoke } from "./ipc";
import { validateResponseInventory, validateResponseCandidate, validateResponsePackage, validateResponseBinding, validateResponseRuntime, validateResponseSource, validateResponseBuild, validateResponseTranslation, validateResponseTool } from "./generated/plugins.validators";
import type { PluginInstallRequest, PluginEnableRequest, PluginPackageRequest, PluginLookupRequest, PluginNativeHostApprovalRequest, PluginRuntimeInstallRequest, PluginDefaultsInstallRequest, PluginRuntimeLookupRequest, PluginSourceRequest, PluginBuildRequest, PluginTranslationRequest, PluginToolRequest } from "./generated/plugins.requests";
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
};

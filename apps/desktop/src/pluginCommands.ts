import { checkedInvoke } from "./ipc";
import { validateResponseInventory, validateResponseCandidate, validateResponsePackage, validateResponseBinding, validateResponseRuntime, validateResponseSource } from "./generated/plugins.validators";
import type { PluginInstallRequest, PluginEnableRequest, PluginPackageRequest, PluginLookupRequest, PluginRuntimeInstallRequest, PluginRuntimeLookupRequest, PluginSourceRequest } from "./generated/plugins.requests";
export type { PluginInstallRequest, PluginEnableRequest, PluginPackageRequest, PluginLookupRequest, PluginRuntimeInstallRequest, PluginRuntimeLookupRequest, PluginSourceRequest } from "./generated/plugins.requests";
export type { PluginInventoryView, PluginCandidateView, PluginPackageDetailsView, PluginRuntimeOfferView, PermissionRequest, PluginSourceView } from "./generated/plugins.responses";

export const pluginCommands = {
  inventory: () => checkedInvoke("read_plugin_inventory", {}, validateResponseInventory),
  select: () => checkedInvoke("select_plugin_package", {}, validateResponseCandidate),
  install: (request: PluginInstallRequest) => checkedInvoke("install_plugin_package", request, validateResponseInventory),
  enable: (request: PluginEnableRequest) => checkedInvoke("set_plugin_enabled", request, validateResponseInventory),
  package: (request: PluginPackageRequest) => checkedInvoke("read_plugin_package", request, validateResponsePackage),
  lookup: (request: PluginLookupRequest) => checkedInvoke("lookup_plugin_capability", request, validateResponseBinding),
  installRuntime: (request: PluginRuntimeInstallRequest) => checkedInvoke("install_plugin_runtime", request, validateResponseInventory),
  lookupRuntime: (request: PluginRuntimeLookupRequest) => checkedInvoke("lookup_plugin_runtime", request, validateResponseRuntime),
  source: (request: PluginSourceRequest) => checkedInvoke("read_plugin_source", request, validateResponseSource),
};

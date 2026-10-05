import { checkedInvoke } from "./ipc";
import { validateResponseInventory, validateResponseCandidate, validateResponsePackage, validateResponseBinding } from "./generated/plugins.validators";
import type { PluginInstallRequest, PluginEnableRequest, PluginPackageRequest, PluginLookupRequest } from "./generated/plugins.requests";
export type { PluginInstallRequest, PluginEnableRequest, PluginPackageRequest, PluginLookupRequest } from "./generated/plugins.requests";
export type { PluginInventoryView, PluginCandidateView, PluginPackageDetailsView, PermissionRequest } from "./generated/plugins.responses";

export const pluginCommands = {
  inventory: () => checkedInvoke("read_plugin_inventory", {}, validateResponseInventory),
  select: () => checkedInvoke("select_plugin_package", {}, validateResponseCandidate),
  install: (request: PluginInstallRequest) => checkedInvoke("install_plugin_package", request, validateResponseInventory),
  enable: (request: PluginEnableRequest) => checkedInvoke("set_plugin_enabled", request, validateResponseInventory),
  package: (request: PluginPackageRequest) => checkedInvoke("read_plugin_package", request, validateResponsePackage),
  lookup: (request: PluginLookupRequest) => checkedInvoke("lookup_plugin_capability", request, validateResponseBinding),
};

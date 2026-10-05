import { checkedInvoke } from "./ipc";
import { validateResponseInventory } from "./generated/plugins.validators";
export type { PluginInventoryView } from "./generated/plugins.responses";

export const pluginCommands = {
  inventory: () => checkedInvoke("read_plugin_inventory", {}, validateResponseInventory),
};

import { pluginCommands, type PluginToolRequest, type PluginToolView } from "./pluginCommands";
import { approvedPluginEnvironments } from "./pluginEnvironments";

/** Compare captured presentation identities without depending on JSON key order. */
export function jsonIdentity(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

export function queryField(value: unknown, path: readonly (string | number)[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = Object.getOwnPropertyDescriptor(value, String(key))?.value;
  }
  return value;
}

export function matchesTool(view: PluginToolView, request: PluginToolRequest): boolean {
  const provider = view.binding.capability.provider;
  return view.resourceId === request.resourceId && view.environmentDigest === request.environmentDigest
    && provider.packageDigest === request.package.packageDigest && jsonIdentity(provider.plugin) === jsonIdentity(request.package.plugin);
}

/** Both manual queries and work plans use the installed package/read owner. */
export async function readPluginToolChoices() {
  const value = await pluginCommands.inventory();
  const enabled = value.packages.filter(item => item.state === "sealed" && value.packageDecisions.some(decision => decision.enabled
    && decision.packageDigest === item.packageDigest && jsonIdentity(decision.plugin) === jsonIdentity(item.plugin)));
  const packages = await Promise.all(enabled.map(item => pluginCommands.package({ plugin: item.plugin, packageDigest: item.packageDigest })));
  const choices = packages.flatMap(item => item.manifest.contributions.flatMap(contribution => contribution.contribution.kind === "resource"
    && contribution.contribution.schema.id === "tsumugi.capability-tool-declaration" && contribution.contribution.schema.schemaVersion === 1
    && contribution.contribution.schema.behaviorVersion === 1 ? [{ key: `${item.packageDigest}:${contribution.id}`,
      label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`,
      package: { plugin: item.manifest.plugin, packageDigest: item.packageDigest }, resourceId: contribution.id,
      runtimeKinds: item.manifest.components.map(component => component.runtime) }] : []));
  return { choices, runtimes: approvedPluginEnvironments(value) };
}

import { pluginCommands, readEnabledPluginPackages, type PluginInventoryView, type PluginPackageRequest,
  type PluginToolRequest, type PluginToolView } from "./pluginCommands";
import { approvedPluginEnvironments } from "./pluginEnvironments";
import type { PluginToolPreflight } from "./executionCommands";

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

/** Manual and delegated queries review the same frozen component roster. */
export function matchesApplicationToolRoster(tool: Pick<PluginToolView, "binding" | "componentScope" | "environment">,
  basis: PluginToolPreflight["applicationScope"], capabilities: PluginToolPreflight["applicationCapabilities"]): boolean {
  if (tool.componentScope !== "application") return basis === null && capabilities.length === 0;
  return basis !== null && capabilities.length > 0 && capabilities.length <= 128
    && (tool.environment.profile === "node-system-libraries-v1"
      || tool.environment.profile === "native-application-host-v1" && capabilities.length === 1)
    && new Set(capabilities.map(member => member.contributionId)).size === capabilities.length
    && capabilities.some(member => member.contributionId === tool.binding.capability.provider.contributionId
      && jsonIdentity(member.capability) === jsonIdentity(tool.binding.capability.declaration))
    && capabilities.every(member => member.capability.effect === "read-only"
      && member.capability.permissions.every(permission => permission.kind !== "project-service"));
}

/** Both manual queries and work plans use the installed package/read owner. */
export async function readPluginToolChoices() {
  const value = await pluginCommands.inventory();
  const packages = await readEnabledPluginPackages(value);
  const choices = packages.flatMap(item => item.manifest.contributions.flatMap(contribution => contribution.contribution.kind === "resource"
    && contribution.contribution.schema.id === "tsumugi.capability-tool-declaration" && contribution.contribution.schema.schemaVersion === 1
    && contribution.contribution.schema.behaviorVersion === 1 ? [{ key: `${item.packageDigest}:${contribution.id}`,
      label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`,
      package: { plugin: item.manifest.plugin, packageDigest: item.packageDigest }, resourceId: contribution.id,
      runtimeKinds: item.manifest.components.map(component => component.runtime) }] : []));
  return { choices, runtimes: approvedPluginEnvironments(value) };
}

export type ReferenceQueryChoice = { kind: "resource" | "ui"; key: string; label: string; package: PluginPackageRequest;
  resourceId: string | null; componentId: string; uiId: string | null; settingsRevision: string; runtimeKinds: ("data" | "native-worker" | "javascript")[] };

/** A declared view replaces the resource choice in its component. The host
 * resolves the one exact resource and capability when the view is read. */
export async function readReferenceQueryChoices(inventory: PluginInventoryView, sessionIdentity: string, current: () => boolean) {
  const packages = await readEnabledPluginPackages(inventory, current);
  const choices: ReferenceQueryChoice[] = [];
  const unsupportedViews: string[] = [];
  for (const item of packages) {
    if (!current()) break;
    const components = new Map(item.manifest.components.map(component => [component.id, component]));
    const views = item.manifest.contributions.filter(contribution => contribution.contribution.kind === "ui"
      && contribution.contribution.slot === "reference-query");
    const viewComponents = new Set(views.map(view => view.componentId));
    const packageRef = { plugin: item.manifest.plugin, packageDigest: item.packageDigest };
    for (const view of views) {
      const component = components.get(view.componentId), contribution = view.contribution;
      if (!component || contribution.kind !== "ui") continue;
      if (contribution.schema.id !== "tsumugi.capability-tool-declaration" || contribution.schema.schemaVersion !== 1
        || contribution.schema.behaviorVersion !== 1) {
        unsupportedViews.push(`${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${view.id}`);
        continue;
      }
      choices.push({ kind: "ui", key: JSON.stringify(["ui", sessionIdentity, inventory.settingsRevision,
        packageRef.plugin.publisher, packageRef.plugin.id, packageRef.plugin.version, packageRef.packageDigest, view.componentId, view.id]),
        label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${view.id}`, package: packageRef,
        resourceId: null, componentId: view.componentId, uiId: view.id, settingsRevision: inventory.settingsRevision,
        runtimeKinds: [component.runtime] });
    }
    for (const resource of item.manifest.contributions) {
      const component = components.get(resource.componentId), contribution = resource.contribution;
      if (!component || viewComponents.has(resource.componentId) || contribution.kind !== "resource"
        || contribution.schema.id !== "tsumugi.capability-tool-declaration" || contribution.schema.schemaVersion !== 1
        || contribution.schema.behaviorVersion !== 1) continue;
      choices.push({ kind: "resource", key: `${item.packageDigest}:${resource.id}`, label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${resource.id}`,
        package: packageRef, resourceId: resource.id, componentId: resource.componentId, uiId: null,
        settingsRevision: inventory.settingsRevision, runtimeKinds: item.manifest.components.map(member => member.runtime) });
    }
  }
  return { choices, unsupportedViews, runtimes: approvedPluginEnvironments(inventory), settingsRevision: inventory.settingsRevision };
}

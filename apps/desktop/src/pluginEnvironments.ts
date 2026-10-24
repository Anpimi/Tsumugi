import type { PluginInventoryView, PluginPackageDetailsView } from "./pluginCommands";

export type PluginComponentRuntime = PluginPackageDetailsView["manifest"]["components"][number]["runtime"];

export type PluginEnvironmentChoice = Pick<PluginInventoryView["runtimeDecisions"][number], "environment" | "environmentDigest" | "origin">;

/** Presentation candidates only. The native boundary reopens exact approval,
 * checks the actual Host and matches every selected executable component. */
export function approvedPluginEnvironments(inventory: PluginInventoryView): PluginEnvironmentChoice[] {
  const choices: PluginEnvironmentChoice[] = inventory.runtimes.filter(record => record.state === "sealed"
    && inventory.runtimeDecisions.some(decision => decision.environment.profile === "node-system-libraries-v1"
      && decision.environmentDigest === record.environmentDigest && decision.origin.sourceId === record.origin.sourceId
      && decision.origin.publisherId === record.origin.publisherId))
    .map(({ environment, environmentDigest, origin }) => ({ environment, environmentDigest, origin }));
  const offer = inventory.nativeHostOffer;
  if (offer.availability === "available" && inventory.runtimeDecisions.some(decision => decision.environment.profile === "native-application-host-v1"
    && decision.environmentDigest === offer.environmentDigest && decision.origin.sourceId === offer.origin.sourceId
    && decision.origin.publisherId === offer.origin.publisherId)) {
    choices.push({ environment: offer.environment, environmentDigest: offer.environmentDigest, origin: offer.origin });
  }
  return choices;
}

export function pluginEnvironmentVersion(environment: PluginEnvironmentChoice["environment"]): string {
  return environment.profile === "node-system-libraries-v1" ? environment.toolVersion : environment.hostVersion;
}

/** Package-level presentation filter. The backend resolves the exact providers
 * selected by the resource and refuses mixed or mismatched runtime families. */
export function matchingPluginEnvironments(environments: readonly PluginEnvironmentChoice[], runtimes: readonly PluginComponentRuntime[]): PluginEnvironmentChoice[] {
  return environments.filter(choice => runtimes.includes(choice.environment.profile === "node-system-libraries-v1" ? "javascript" : "native-worker"));
}

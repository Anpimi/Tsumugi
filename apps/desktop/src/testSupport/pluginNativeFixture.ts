import type { PluginInventoryView, PluginPackageDetailsView } from "../pluginCommands";
import { validateResponseInventory, validateResponsePackage } from "../generated/plugins.validators";

export const nativeEnvironment = {
  protocolVersion: 1, platform: { operatingSystem: "macos", architecture: "aarch64" },
  sdkVersion: "0.1.0-alpha.1", processProtocol: 1, profile: "native-application-host-v1",
  hostVersion: "0.2.0-alpha.1", executable: { kind: "darwin-code-directory-hash-v1", value: "a".repeat(40) },
} as const;
export const nativeDigest = "b".repeat(64);
export const nativeOrigin = { sourceId: "application-host", publisherId: "tsumugi-application" };

/** Synthetic DOM/contract metadata, never an actual Host identity or worker. */
export function nativeInventory(node: PluginInventoryView, approved = true): PluginInventoryView {
  const view = { ...node, nativeHostOffer: { availability: "available", environment: nativeEnvironment, environmentDigest: nativeDigest, origin: nativeOrigin },
    runtimeDecisions: [...node.runtimeDecisions, ...(approved ? [{ environment: nativeEnvironment, environmentDigest: nativeDigest, origin: nativeOrigin }] : [])] };
  if (!validateResponseInventory(view)) throw new Error("Invalid Native inventory fixture");
  return view;
}
export function nativePackage(node: PluginPackageDetailsView): PluginPackageDetailsView {
  const view = { ...node, manifest: { ...node.manifest, components: node.manifest.components.map(component => ({ ...component, runtime: component.runtime === "javascript" ? "native-worker" : component.runtime })) } };
  if (!validateResponsePackage(view)) throw new Error("Invalid Native package fixture");
  return view;
}

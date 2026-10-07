// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * Read-only concerns project state; proposals are not already-adopted changes.
 * Network/process effects still require their own host authorization.
 *
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "EffectKind".
 */
export type EffectKind = "read-only" | "proposal" | "external";
/**
 * These are requested permissions, never an authorization token.
 *
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "PermissionRequest".
 */
export type PermissionRequest =
  | {
      kind: "captured-input";
    }
  | {
      kind: "staged-output";
    }
  | {
      contract: ContractRef;
      kind: "project-service";
    }
  | {
      destination: string;
      kind: "network";
    }
  | {
      kind: "process";
      program: string;
    };

export interface ToolTypes {
  binding: CapabilityToolBinding;
  declaration: CapabilityToolDeclaration;
}
/**
 * A fixed selection, not an execution grant or a trusted model instruction.
 * Deserialized claims must be rebound against the actual captured package.
 *
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "CapabilityToolBinding".
 */
export interface CapabilityToolBinding {
  capability: CapabilityBinding;
  declaration: CapabilityToolDeclaration;
  resources: ToolResourceBinding[];
}
/**
 * Captured declaration data for one selected capability. Requested permissions
 * remain declarations; validation does not establish an active provider, a
 * grant, current authority or permission to adopt a result.
 *
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "CapabilityBinding".
 */
export interface CapabilityBinding {
  declaration: CapabilityDeclaration;
  provider: ProviderSelectionBinding;
}
/**
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "CapabilityDeclaration".
 */
export interface CapabilityDeclaration {
  contract: ContractRef;
  effect: EffectKind;
  errorSchema: ContractRef;
  inputSchema: ContractRef;
  limits: CapabilityLimits;
  outputSchema: ContractRef;
  permissions: PermissionRequest[];
  profiles: ContractRef[];
}
/**
 * Schema and behavior are separate exact-match compatibility identities.
 * Matching JSON field types or a package SemVer is not behavioral compatibility.
 *
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "ContractRef".
 */
export interface ContractRef {
  behaviorVersion: number;
  id: string;
  schemaVersion: number;
}
/**
 * Requested upper bounds. The host must also enforce its own current limits.
 *
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "CapabilityLimits".
 */
export interface CapabilityLimits {
  concurrency: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}
/**
 * A fixed package/contribution choice, independent of any active instance.
 * Its digest is supplied by the trusted package owner; this value neither
 * authenticates those bytes nor grants permission to load or call them.
 *
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "ProviderSelectionBinding".
 */
export interface ProviderSelectionBinding {
  componentId: string;
  contributionId: string;
  packageDigest: string;
  plugin: PluginIdentity;
}
/**
 * Claimed package identity; a host must authenticate the actual package source.
 *
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "PluginIdentity".
 */
export interface PluginIdentity {
  id: string;
  publisher: string;
  version: string;
}
/**
 * A package-local adapter to one declared, read-only capability. Input/output
 * contracts, limits and permissions are taken from that capability, rather
 * than repeated in a model-specific descriptor. A profile is an exact choice.
 *
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "CapabilityToolDeclaration".
 */
export interface CapabilityToolDeclaration {
  capabilityId: string;
  description: string;
  name: string;
  profile?: ContractRef | null;
  skill?: string | null;
  supportingResources: string[];
  title: string;
}
/**
 * This interface was referenced by `ToolTypes`'s JSON-Schema
 * via the `definition` "ToolResourceBinding".
 */
export interface ToolResourceBinding {
  contributionId: string;
  schema: ContractRef;
}

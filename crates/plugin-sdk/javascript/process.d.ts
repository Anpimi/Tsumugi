// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "ProcessBody".
 */
export type ProcessBody =
  | {
      data: ProcessActivation;
      kind: "activate";
    }
  | {
      data: ProcessActivation;
      kind: "ready";
    }
  | {
      data: InvocationRequest;
      kind: "invoke";
    }
  | {
      data: InvocationResult;
      kind: "result";
    }
  | {
      data: ServiceRequest;
      kind: "service-request";
    }
  | {
      data: ServiceResponse;
      kind: "service-response";
    }
  | {
      data: {
        dispatchId: string;
      };
      kind: "cancel";
    }
  | {
      data: {
        dispatchId: string;
      };
      kind: "cancelled";
    }
  | {
      data: {
        provider: ProviderBinding;
      };
      kind: "close";
    }
  | {
      data: {
        provider: ProviderBinding;
      };
      kind: "closed";
    }
  | {
      data: {
        nonce: string;
      };
      kind: "ping";
    }
  | {
      data: {
        nonce: string;
      };
      kind: "pong";
    };
/**
 * Read-only concerns project state; proposals are not already-adopted changes.
 * Network/process effects still require their own host authorization.
 *
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "EffectKind".
 */
export type EffectKind = "read-only" | "proposal" | "external";
/**
 * These are requested permissions, never an authorization token.
 *
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
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
/**
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "InvocationOutcome".
 */
export type InvocationOutcome =
  | {
      kind: "succeeded";
      output: EncodedPayload;
    }
  | {
      error: EncodedPayload;
      kind: "failed";
    }
  | {
      error: EncodedPayload;
      kind: "unknown";
    };

/**
 * Wire representation: a four-byte big-endian length followed by exactly that
 * many JSON bytes. Stdout is reserved for frames; stderr is a separate bounded
 * diagnostic stream. Hosts must also enforce direction, state and deadlines.
 */
export interface ProcessFrame {
  body: ProcessBody;
  protocolVersion: 2;
}
/**
 * A captured declaration for one capability on one actual component channel.
 * Echoing this structure is a handshake claim, never a grant or source proof.
 *
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "ProcessActivation".
 */
export interface ProcessActivation {
  capability: CapabilityDeclaration;
  provider: ProviderBinding;
  /**
   * Host-selected project services, resolved before component activation.
   */
  services: ServiceBinding[];
}
/**
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
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
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
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
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "CapabilityLimits".
 */
export interface CapabilityLimits {
  concurrency: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}
/**
 * A claimed wire binding. Only the trusted host can compare it to the actual
 * verified package and channel; constructing this value proves no authority.
 *
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "ProviderBinding".
 */
export interface ProviderBinding {
  activationGeneration: number;
  componentId: string;
  contributionId: string;
  instanceId: string;
  packageDigest: string;
  plugin: PluginIdentity;
}
/**
 * Claimed package identity; a host must authenticate the actual package source.
 *
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "PluginIdentity".
 */
export interface PluginIdentity {
  id: string;
  publisher: string;
  version: string;
}
/**
 * A Host-selected service descriptor, not a grant or a project/store handle.
 * The Host authenticates its provider, scope, configuration and live generation.
 *
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "ServiceBinding".
 */
export interface ServiceBinding {
  activationGeneration: number;
  configurationDigest: string;
  contract: ContractRef;
  effect: EffectKind;
  errorSchema: ContractRef;
  handleId: string;
  inputSchema: ContractRef;
  limits: CapabilityLimits;
  outputSchema: ContractRef;
  projectId: string;
  providerId: string;
  scopeId: string;
}
/**
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "InvocationRequest".
 */
export interface InvocationRequest {
  capability: ContractRef;
  context: InvocationContext;
  errorSchema: ContractRef;
  input: EncodedPayload;
  maxResultBytes: number;
  outputSchema: ContractRef;
  profile?: ContractRef | null;
  provider: ProviderBinding;
}
/**
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "InvocationContext".
 */
export interface InvocationContext {
  attemptId: string;
  configurationDigest: string;
  dispatchId: string;
  environmentDigest: string;
  inputDigest: string;
  itemId: string;
  operationId: string;
  projectId: string;
  scopeDigest: string;
  scopeId: string;
}
/**
 * Exact UTF-8 schema payload. The SDK verifies its byte digest but does not
 * substitute a generic parser for that schema's actual semantic validator.
 *
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "EncodedPayload".
 */
export interface EncodedPayload {
  schema: ContractRef;
  sha256: string;
  utf8: string;
}
/**
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "InvocationResult".
 */
export interface InvocationResult {
  capability: ContractRef;
  context: InvocationContext;
  outcome: InvocationOutcome;
  profile?: ContractRef | null;
  provider: ProviderBinding;
  resultId: string;
}
/**
 * The context is the original outer invocation. Its inputDigest describes that
 * invocation, while input.sha256 independently authenticates the service bytes.
 *
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "ServiceRequest".
 */
export interface ServiceRequest {
  callId: string;
  context: InvocationContext;
  handleId: string;
  input: EncodedPayload;
}
/**
 * A response preserves failed/unknown outcomes. Matching it does not authorize
 * a mutation, validate its domain payload or prove that a child task finished.
 *
 * This interface was referenced by `ProcessFrame`'s JSON-Schema
 * via the `definition` "ServiceResponse".
 */
export interface ServiceResponse {
  callId: string;
  context: InvocationContext;
  handleId: string;
  outcome: InvocationOutcome;
}

// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * Read-only concerns project state; proposals are not already-adopted changes.
 * Network/process effects still require their own host authorization.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "EffectKind".
 */
export type EffectKind = "read-only" | "proposal" | "external";
/**
 * These are requested permissions, never an authorization token.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ReviewCheckErrorCode".
 */
export type ReviewCheckErrorCode =
  | "invalid-input"
  | "unsupported-profile"
  | "invalid-source"
  | "invalid-translation"
  | "unsupported-structure"
  | "limit-exceeded"
  | "cancelled";
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "CheckImplementation".
 */
export type CheckImplementation =
  | {
      kind: "core";
      validator: ContractRef;
    }
  | {
      kind: "plugin";
      provider: ProviderSelectionBinding;
    };
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ExtensionHandling".
 */
export type ExtensionHandling = "required" | "preserve" | "optional";
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ContentTarget".
 */
export type ContentTarget =
  | {
      kind: "snapshot";
    }
  | {
      id: string;
      kind: "unit";
    }
  | {
      id: string;
      kind: "occurrence";
    };
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "TextEncoding".
 */
export type TextEncoding = "utf8-byte" | "utf16" | "grapheme";
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "CheckOutcome".
 */
export type CheckOutcome =
  | {
      findings: CheckFinding[];
      kind: "completed";
    }
  | {
      basis: NotApplicableBasis;
      kind: "not-applicable";
    }
  | {
      kind: "failed";
    }
  | {
      kind: "cancelled";
    }
  | {
      kind: "unavailable";
    };
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "FindingSeverity".
 */
export type FindingSeverity = "warning" | "error";

export interface ReviewTypes {
  binding: ReviewBinding;
  error: ReviewCheckError;
  input: ReviewCheckInput;
  results: CheckResult[];
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ReviewBinding".
 */
export interface ReviewBinding {
  checker: CapabilityBinding;
  declaration: ReviewDeclaration;
}
/**
 * Captured declaration data for one selected capability. Requested permissions
 * remain declarations; validation does not establish an active provider, a
 * grant, current authority or permission to adopt a result.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "CapabilityBinding".
 */
export interface CapabilityBinding {
  declaration: CapabilityDeclaration;
  provider: ProviderSelectionBinding;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "PluginIdentity".
 */
export interface PluginIdentity {
  id: string;
  publisher: string;
  version: string;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ReviewDeclaration".
 */
export interface ReviewDeclaration {
  checker: string;
  profile: ContractRef;
  rules: ReviewRuleDeclaration[];
}
/**
 * A rule may permit N/A only for a captured scope with no selected translation.
 * Source-only rules must still run for a source fallback. Domain findings in
 * this contract are mandatory and cannot acquire ordinary issue waivers.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ReviewRuleDeclaration".
 */
export interface ReviewRuleDeclaration {
  requiresTranslation: boolean;
  rule: ContractRef;
}
/**
 * Public descriptions and operation-local unit references only. Arbitrary
 * diagnostic text is not thereby authenticated or safe to disclose.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ReviewCheckError".
 */
export interface ReviewCheckError {
  code: ReviewCheckErrorCode;
  detail: string;
  unitId?: string | null;
}
/**
 * Complete original content plus an explicit, nonempty subset to check for one
 * target language. Domain blocks and captured source bytes remain unchanged.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ReviewCheckInput".
 */
export interface ReviewCheckInput {
  requirements: CheckRequirement[];
  selections: ReviewSelection[];
  source: ContentExchange;
  targetLanguage: string;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "CheckRequirement".
 */
export interface CheckRequirement {
  inputDigest: string;
  key: CheckKey;
  mandatory: boolean;
  notApplicable?: NotApplicableBasis | null;
  scopeDigest: string;
  targets: string[];
  waivable: boolean;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "CheckKey".
 */
export interface CheckKey {
  implementation: CheckImplementation;
  rule: ContractRef;
}
/**
 * A trusted capture of an allowed reason and its exact scope basis, not a
 * plugin's claim that it is safe to skip a required check.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "NotApplicableBasis".
 */
export interface NotApplicableBasis {
  basisDigest: string;
  code: string;
}
/**
 * The original source unit identity/revision is operation-local. Missing text
 * stays explicit; it is not replaced by source text or treated as approval.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ReviewSelection".
 */
export interface ReviewSelection {
  sourceRevisionId: string;
  translationText?: string | null;
  unitId: string;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ContentExchange".
 */
export interface ContentExchange {
  artifacts: CapturedTextArtifact[];
  domainBlocks: DomainBlock[];
  /**
   * Exact occurrence order. Hierarchies and other graphs use typed relations.
   */
  order: string[];
  profile: ContractRef;
  relations: ContentRelation[];
  sourceLanguage: string;
  sourceSetId: string;
  units: ContentUnit[];
}
/**
 * Captured UTF-8 bytes, including a BOM and original line endings. These are
 * immutable source evidence; logical paths are not local filesystem authority.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "CapturedTextArtifact".
 */
export interface CapturedTextArtifact {
  id: string;
  logicalPath: string;
  role: string;
  sha256: string;
  utf8: string;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "DomainBlock".
 */
export interface DomainBlock {
  handling: ExtensionHandling;
  /**
   * Exact UTF-8 payload, intentionally not an open JSON property bag. Its
   * schema is interpreted by the domain, without loss through Value parsing.
   */
  payloadUtf8: string;
  schema: ContractRef;
  target: ContentTarget;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ContentRelation".
 */
export interface ContentRelation {
  fromOccurrence: string;
  kind: ContractRef;
  toOccurrence: string;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ContentUnit".
 */
export interface ContentUnit {
  /**
   * Operation-local reference or a captured project identity, as specified by
   * the capability. A plugin cannot allocate authoritative project revisions.
   */
  id: string;
  occurrences: ContentOccurrence[];
  protectedFragments: ProtectedFragment[];
  /**
   * During extraction this is an operation-local proposal reference. Only
   * Core may map it to an authoritative project source revision.
   */
  sourceRevisionId: string;
  text: string;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ContentOccurrence".
 */
export interface ContentOccurrence {
  id: string;
  nativeIdentity?: NativeIdentityEvidence | null;
  source: SourceReference;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "NativeIdentityEvidence".
 */
export interface NativeIdentityEvidence {
  display: NativeIdentityDisplay;
  namespace: string;
  policy: ContractRef;
  /**
   * The domain's canonical matching value, not necessarily its original
   * literal spelling. Core does not normalize this value again.
   */
  value: string;
}
/**
 * Domain-confirmed spelling for presentation, separate from canonical
 * matching. A source reference is optional when the identity is derived.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "NativeIdentityDisplay".
 */
export interface NativeIdentityDisplay {
  source: SourceReference | null;
  value: string;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "SourceReference".
 */
export interface SourceReference {
  artifactId: string;
  range: TextRange;
}
/**
 * Half-open offsets into one exact string, never between different strings.
 *
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "TextRange".
 */
export interface TextRange {
  encoding: TextEncoding;
  end: number;
  start: number;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "ProtectedFragment".
 */
export interface ProtectedFragment {
  kind: ContractRef;
  range: TextRange1;
}
/**
 * Half-open offsets into one exact string, never between different strings.
 */
export interface TextRange1 {
  encoding: TextEncoding;
  end: number;
  start: number;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "CheckResult".
 */
export interface CheckResult {
  coveredTargets: string[];
  inputDigest: string;
  key: CheckKey;
  outcome: CheckOutcome;
  scopeDigest: string;
}
/**
 * This interface was referenced by `ReviewTypes`'s JSON-Schema
 * via the `definition` "CheckFinding".
 */
export interface CheckFinding {
  code: string;
  severity: FindingSeverity;
  target: string;
}

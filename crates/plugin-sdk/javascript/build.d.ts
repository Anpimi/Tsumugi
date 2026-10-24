// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "ExtensionHandling".
 */
export type ExtensionHandling = "required" | "preserve" | "optional";
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "TextEncoding".
 */
export type TextEncoding = "utf8-byte" | "utf16" | "grapheme";
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "BuildErrorCode".
 */
export type BuildErrorCode =
  "invalid-input" | "unsupported-profile" | "invalid-target" | "invalid-artifact" | "limit-exceeded" | "cancelled";

export interface BuildTypes {
  artifacts: ArtifactSet;
  check_input: ArtifactCheckInput;
  declaration: BuildDeclaration;
  error: BuildError;
  input: BuildInput;
}
/**
 * Actual UTF-8 output, including BOM and line endings. This contract deliberately
 * makes no binary-artifact or domain conformance claim. No local paths are used.
 *
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "ArtifactSet".
 */
export interface ArtifactSet {
  artifacts: CapturedTextArtifact[];
  profile: ContractRef;
  sourceSetId: string;
  targetLanguage: string;
}
/**
 * Captured UTF-8 bytes, including a BOM and original line endings. These are
 * immutable source evidence; logical paths are not local filesystem authority.
 *
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * Schema and behavior are separate exact-match compatibility identities.
 * Matching JSON field types or a package SemVer is not behavioral compatibility.
 *
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "ContractRef".
 */
export interface ContractRef {
  behaviorVersion: number;
  id: string;
  schemaVersion: number;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "ArtifactCheckInput".
 */
export interface ArtifactCheckInput {
  input: BuildInput;
  output: ArtifactSet;
  requirements: CheckRequirement[];
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "BuildInput".
 */
export interface BuildInput {
  /**
   * Exact domain configuration; an empty collection means no configuration.
   */
  configuration: EncodedPayload[];
  outputLimits: BuildOutputLimits;
  /**
   * Complete authorized relative output paths, fixed before dispatch.
   */
  outputPaths: string[];
  source: ContentExchange;
  targetLanguage: string;
  targets: BuildTarget[];
}
/**
 * Exact UTF-8 schema payload. The SDK verifies its byte digest but does not
 * substitute a generic parser for that schema's actual semantic validator.
 *
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "EncodedPayload".
 */
export interface EncodedPayload {
  schema: ContractRef;
  sha256: string;
  utf8: string;
}
/**
 * Captured by the trusted planner, never replaced by returned artifacts.
 */
export interface BuildOutputLimits {
  maxArtifacts: number;
  maxTotalBytes: number;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "ContentRelation".
 */
export interface ContentRelation {
  fromOccurrence: string;
  kind: ContractRef;
  toOccurrence: string;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "ContentOccurrence".
 */
export interface ContentOccurrence {
  id: string;
  nativeIdentity?: NativeIdentityEvidence | null;
  source: SourceReference;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "NativeIdentityDisplay".
 */
export interface NativeIdentityDisplay {
  source: SourceReference | null;
  value: string;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "SourceReference".
 */
export interface SourceReference {
  artifactId: string;
  range: TextRange;
}
/**
 * Half-open offsets into one exact string, never between different strings.
 *
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "TextRange".
 */
export interface TextRange {
  encoding: TextEncoding;
  end: number;
  start: number;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * One already decided text per source unit, even when it has many occurrences.
 * No candidate selection, review decision or project write handle is supplied.
 *
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "BuildTarget".
 */
export interface BuildTarget {
  sourceRevisionId: string;
  text: string;
  unitId: string;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "CheckKey".
 */
export interface CheckKey {
  implementation: CheckImplementation;
  rule: ContractRef;
}
/**
 * A fixed package/contribution choice, independent of any active instance.
 * Its digest is supplied by the trusted package owner; this value neither
 * authenticates those bytes nor grants permission to load or call them.
 *
 * This interface was referenced by `BuildTypes`'s JSON-Schema
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
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "PluginIdentity".
 */
export interface PluginIdentity {
  id: string;
  publisher: string;
  version: string;
}
/**
 * A trusted capture of an allowed reason and its exact scope basis, not a
 * plugin's claim that it is safe to skip a required check.
 *
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "NotApplicableBasis".
 */
export interface NotApplicableBasis {
  basisDigest: string;
  code: string;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "BuildDeclaration".
 */
export interface BuildDeclaration {
  artifactRules: ContractRef[];
  builder: string;
  checker: string;
  displayName: string;
  outputLimits: BuildOutputLimits1;
  profile: ContractRef;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "BuildOutputLimits".
 */
export interface BuildOutputLimits1 {
  maxArtifacts: number;
  maxTotalBytes: number;
}
/**
 * This interface was referenced by `BuildTypes`'s JSON-Schema
 * via the `definition` "BuildError".
 */
export interface BuildError {
  artifactId?: string | null;
  code: BuildErrorCode;
  detail: string;
}

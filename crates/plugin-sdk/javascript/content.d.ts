// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "ExtensionHandling".
 */
export type ExtensionHandling = "required" | "preserve" | "optional";
/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "TextEncoding".
 */
export type TextEncoding = "utf8-byte" | "utf16" | "grapheme";
/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "FindingSeverity".
 */
export type FindingSeverity = "warning" | "error";
/**
 * Finite public failure classifications; details never determine permissions.
 *
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "SourceExtractionErrorCode".
 */
export type SourceExtractionErrorCode =
  "invalid-input" | "unsupported-profile" | "invalid-source" | "unsupported-structure" | "limit-exceeded" | "cancelled";

export interface SourceExtractionTypes {
  check_input: SourceExtractionCheckInput;
  check_results: CheckResult[];
  content: ContentExchange;
  error: SourceExtractionError;
  input: SourceExtractionInput;
  revision_policy: SourceRevisionPolicy;
}
/**
 * A domain checker receives captured source and the complete proposal, with
 * requirements fixed independently by its caller. Receiving these values does
 * not authenticate the selected provider or authorize adoption.
 *
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "SourceExtractionCheckInput".
 */
export interface SourceExtractionCheckInput {
  proposal: ContentExchange;
  requirements: CheckRequirement[];
  source: SourceExtractionInput;
}
/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * Schema and behavior are separate exact-match compatibility identities.
 * Matching JSON field types or a package SemVer is not behavioral compatibility.
 *
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "ContractRef".
 */
export interface ContractRef {
  behaviorVersion: number;
  id: string;
  schemaVersion: number;
}
/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "ContentRelation".
 */
export interface ContentRelation {
  fromOccurrence: string;
  kind: ContractRef;
  toOccurrence: string;
}
/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "ContentOccurrence".
 */
export interface ContentOccurrence {
  id: string;
  nativeIdentity?: NativeIdentityEvidence | null;
  source: SourceReference;
}
/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "NativeIdentityDisplay".
 */
export interface NativeIdentityDisplay {
  source: SourceReference | null;
  value: string;
}
/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "SourceReference".
 */
export interface SourceReference {
  artifactId: string;
  range: TextRange;
}
/**
 * Half-open offsets into one exact string, never between different strings.
 *
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "TextRange".
 */
export interface TextRange {
  encoding: TextEncoding;
  end: number;
  start: number;
}
/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "NotApplicableBasis".
 */
export interface NotApplicableBasis {
  basisDigest: string;
  code: string;
}
/**
 * Raw captured UTF-8 material supplied for one selected extraction profile.
 * Logical paths and artifact IDs carry no filesystem or execution authority.
 * This input contains no authoritative project unit or source revision IDs.
 *
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "SourceExtractionInput".
 */
export interface SourceExtractionInput {
  artifacts: CapturedTextArtifact[];
  profile: ContractRef;
  sourceLanguage: string;
  sourceSetId: string;
}
/**
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
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
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "CheckFinding".
 */
export interface CheckFinding {
  code: string;
  severity: FindingSeverity;
  target: string;
}
/**
 * A bounded public diagnostic. Producers must use public descriptions and
 * captured artifact IDs, never local paths, raw source text or secrets. Data
 * validation cannot establish that arbitrary diagnostic text is safe to share.
 *
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "SourceExtractionError".
 */
export interface SourceExtractionError {
  artifactId?: string | null;
  code: SourceExtractionErrorCode;
  detail: string;
}
/**
 * Captured by the trusted policy owner before a proposal is received. Only
 * these exact block schemas contribute opaque bytes to source revisions.
 *
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "SourceRevisionPolicy".
 */
export interface SourceRevisionPolicy {
  profile: ContractRef;
  revisionBasis: ContractRef[];
}

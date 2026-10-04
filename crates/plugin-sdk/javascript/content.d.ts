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
 * Finite public failure classifications; details never determine permissions.
 *
 * This interface was referenced by `SourceExtractionTypes`'s JSON-Schema
 * via the `definition` "SourceExtractionErrorCode".
 */
export type SourceExtractionErrorCode =
  "invalid-input" | "unsupported-profile" | "invalid-source" | "unsupported-structure" | "limit-exceeded" | "cancelled";

export interface SourceExtractionTypes {
  content: ContentExchange;
  error: SourceExtractionError;
  input: SourceExtractionInput;
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
  namespace: string;
  policy: ContractRef;
  /**
   * The domain's canonical matching value, not necessarily its original
   * literal spelling. Literal identity and semantic revision evidence belong
   * in versioned domain blocks; Core does not normalize this value again.
   */
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

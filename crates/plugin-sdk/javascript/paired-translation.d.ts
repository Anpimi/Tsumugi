// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * Exactly one representation. Text retains its original wire shape; mixed,
 * null and unknown fields are rejected by the two closed representations.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "CapturedArtifact".
 */
export type CapturedArtifact = CapturedTextArtifact | CapturedBinaryArtifact;
/**
 * Describes the caller's recorded explicit choice, not an execution/adoption
 * grant. Only the trusted application can establish that consent actually ran.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "TranslationLanguageEvidence".
 */
export type TranslationLanguageEvidence = "user-confirmed";
/**
 * Source coordinates are separate from ranges in decoded unit/target text.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "SourceEncoding".
 */
export type SourceEncoding = "utf8-byte" | "utf16" | "grapheme" | "raw-byte";
/**
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
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
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "SourceMaterialEncoding".
 */
export type SourceMaterialEncoding = "utf8" | "binary";

export interface TranslationTypes {
  check_input: TranslationExtractionCheckInput;
  declaration: TranslationImportDeclaration;
  exchange: TranslationExchange;
  input: TranslationExtractionInput;
}
/**
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "TranslationExtractionCheckInput".
 */
export interface TranslationExtractionCheckInput {
  input: TranslationExtractionInput;
  proposal: TranslationExchange;
  requirements: CheckRequirement[];
}
/**
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "TranslationExtractionInput".
 */
export interface TranslationExtractionInput {
  artifacts: CapturedArtifact[];
  importId: string;
  languageEvidence: TranslationLanguageEvidence;
  nativeScope: TranslationNativeScope;
  pairedSource: {
    artifacts: CapturedArtifact[];
    sourceLanguage: string;
  };
  profile: ContractRef;
  sourceSetId: string;
  sourceSnapshotId: string;
  targetLanguage: string;
}
/**
 * Exact UTF-8 bytes, including BOMs and original line endings.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
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
 * Canonical padded RFC 4648 base64 of the original bytes. The digest describes
 * the decoded bytes, never their transport encoding. Decoding is domain-owned.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "CapturedBinaryArtifact".
 */
export interface CapturedBinaryArtifact {
  base64: string;
  id: string;
  logicalPath: string;
  role: string;
  sha256: string;
}
/**
 * Captured from the current adopted source. The plugin supplies canonical
 * native values under this exact policy; Core must never normalize them again.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "TranslationNativeScope".
 */
export interface TranslationNativeScope {
  namespace: string;
  policy: ContractRef;
}
/**
 * Schema and behavior are separate exact-match compatibility identities.
 * Matching JSON field types or a package SemVer is not behavioral compatibility.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "ContractRef".
 */
export interface ContractRef {
  behaviorVersion: number;
  id: string;
  schemaVersion: number;
}
/**
 * Complete captured file evidence is retained once, including an empty file.
 * Declared language is domain evidence, not an inferred project locale.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "TranslationExchange".
 */
export interface TranslationExchange {
  artifacts: CapturedArtifact[];
  declaredLanguage: string;
  entries: ImportedTranslation[];
  importId: string;
  languageEvidence: TranslationLanguageEvidence;
  nativeScope: TranslationNativeScope;
  order: string[];
  profile: ContractRef;
  sourceSetId: string;
  sourceSnapshotId: string;
  targetLanguage: string;
}
/**
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "ImportedTranslation".
 */
export interface ImportedTranslation {
  id: string;
  nativeIdentity: NativeIdentityEvidence;
  source: SourceReference;
  text: string;
}
/**
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
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
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "NativeIdentityDisplay".
 */
export interface NativeIdentityDisplay {
  source: SourceReference | null;
  value: string;
}
/**
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "SourceReference".
 */
export interface SourceReference {
  artifactId: string;
  range: SourceRange;
}
/**
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "SourceRange".
 */
export interface SourceRange {
  encoding: SourceEncoding;
  end: number;
  start: number;
}
/**
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
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
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
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
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
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
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
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
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "NotApplicableBasis".
 */
export interface NotApplicableBasis {
  basisDigest: string;
  code: string;
}
/**
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "TranslationImportDeclaration".
 */
export interface TranslationImportDeclaration {
  checker: string;
  displayName: string;
  extractor: string;
  fileSets: SourceFileSetDeclaration[];
  maxTotalBytes: number;
  profile: ContractRef;
  semanticRules: ContractRef[];
}
/**
 * Explicit user choices within one authorized root. No glob, directory scan,
 * absolute path, or permission is part of this declaration or its resolution.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "SourceFileSetDeclaration".
 */
export interface SourceFileSetDeclaration {
  displayName: string;
  encoding: SourceMaterialEncoding;
  extensions: string[];
  id: string;
  maxBytes: number;
  maxFiles: number;
  minFiles: number;
  role: string;
}
/**
 * Metadata describing one selected file relative to an explicitly granted
 * directory. No glob, executable discovery or filesystem authority is implied.
 *
 * This interface was referenced by `TranslationTypes`'s JSON-Schema
 * via the `definition` "TranslationMaterialDeclaration".
 */
export interface TranslationMaterialDeclaration {
  extension: string;
  logicalDirectory: string;
  maxBytes: number;
  role: string;
}

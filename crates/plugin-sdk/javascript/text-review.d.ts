// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * Read-only concerns project state; proposals are not already-adopted changes.
 * Network/process effects still require their own host authorization.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "EffectKind".
 */
export type EffectKind = "read-only" | "proposal" | "external";
/**
 * These are requested permissions, never an authorization token.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * Selecting a check is not adopting its resource or requiring its findings.
 * Blocking checks continue to use the original mandatory Review contract.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewDisposition".
 */
export type TextReviewDisposition = "advisory";
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewField".
 */
export type TextReviewField = "source" | "translation";
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextEncoding".
 */
export type TextEncoding = "utf8-byte" | "utf16" | "grapheme";
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "FindingSeverity".
 */
export type FindingSeverity = "warning" | "error";

export interface TextReviewTypes {
  binding: TextReviewBinding;
  declaration: TextReviewDeclaration;
  error: ReviewCheckError;
  input: TextReviewCheckInput;
  report: TextReviewCheckReport;
}
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewBinding".
 */
export interface TextReviewBinding {
  checker: CapabilityBinding;
  declaration: TextReviewDeclaration;
  resources: TextReviewResourceBinding[];
}
/**
 * Captured declaration data for one selected capability. Requested permissions
 * remain declarations; validation does not establish an active provider, a
 * grant, current authority or permission to adopt a result.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "CapabilityBinding".
 */
export interface CapabilityBinding {
  declaration: CapabilityDeclaration;
  provider: ProviderSelectionBinding;
}
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "PluginIdentity".
 */
export interface PluginIdentity {
  id: string;
  publisher: string;
  version: string;
}
/**
 * One provider's available rules. An invocation must use an explicitly chosen
 * nonempty subset; installation and a matching spelling do not select rules.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewDeclaration".
 */
export interface TextReviewDeclaration {
  checker: string;
  disposition: TextReviewDisposition;
  profile: ContractRef;
  rules: TextReviewRuleDeclaration[];
  supportingResources: string[];
}
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewRuleDeclaration".
 */
export interface TextReviewRuleDeclaration {
  description: string;
  requiresTranslation: boolean;
  rule: ContractRef;
  title: string;
}
/**
 * A declared Resource contribution in the exact same package as the checker.
 * This mirrors Resource metadata, without coupling review to tool declarations.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewResourceBinding".
 */
export interface TextReviewResourceBinding {
  contributionId: string;
  schema: ContractRef;
}
/**
 * Public descriptions and operation-local unit references only. Arbitrary
 * diagnostic text is not thereby authenticated or safe to disclose.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "ReviewCheckError".
 */
export interface ReviewCheckError {
  code: ReviewCheckErrorCode;
  detail: string;
  unitId?: string | null;
}
/**
 * Generic captured text only. The profile selects the text checker, not the
 * original file format. Mapping to project revisions remains Host-owned.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewCheckInput".
 */
export interface TextReviewCheckInput {
  profile: ContractRef;
  requirements: CheckRequirement[];
  resources: TextReviewResourcePin[];
  selections: TextReviewSelection[];
  sourceLanguage: string;
  targetLanguage: string;
}
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "NotApplicableBasis".
 */
export interface NotApplicableBasis {
  basisDigest: string;
  code: string;
}
/**
 * Exact package Resource bytes captured by the Host, never a plugin's mutable
 * lookup or a claim that the referenced resource has been adopted by a project.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewResourcePin".
 */
export interface TextReviewResourcePin {
  contributionId: string;
  schema: ContractRef;
  sha256: string;
}
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewSelection".
 */
export interface TextReviewSelection {
  sourceRevisionId: string;
  sourceText: string;
  translationText?: string | null;
  unitId: string;
}
/**
 * A successful report includes one explicit outcome for every selected rule.
 * Failed/cancelled/unavailable outcomes are not converted to passed coverage.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewCheckReport".
 */
export interface TextReviewCheckReport {
  diagnostics: TextReviewDiagnostic[];
  results: CheckResult[];
}
/**
 * Optional public presentation associated with one actual finding. Diagnostic
 * prose is not authenticated or sanitized by these structural checks.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewDiagnostic".
 */
export interface TextReviewDiagnostic {
  code: string;
  detail?: string | null;
  key: CheckKey;
  location?: TextReviewLocation | null;
  resourceEntry?: TextReviewResourceEntry | null;
  suggestion?: string | null;
  target: string;
}
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewLocation".
 */
export interface TextReviewLocation {
  field: TextReviewField;
  range: TextRange;
}
/**
 * Half-open offsets into one exact string, never between different strings.
 *
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextRange".
 */
export interface TextRange {
  encoding: TextEncoding;
  end: number;
  start: number;
}
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "TextReviewResourceEntry".
 */
export interface TextReviewResourceEntry {
  contributionId: string;
  entryId: string;
}
/**
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
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
 * This interface was referenced by `TextReviewTypes`'s JSON-Schema
 * via the `definition` "CheckFinding".
 */
export interface CheckFinding {
  code: string;
  severity: FindingSeverity;
  target: string;
}

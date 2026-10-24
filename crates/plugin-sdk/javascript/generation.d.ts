// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * This interface was referenced by `GenerationServiceTypes`'s JSON-Schema
 * via the `definition` "GenerationServiceErrorCode".
 */
export type GenerationServiceErrorCode =
  | "invalid-input"
  | "unavailable"
  | "permission-denied"
  | "cancelled"
  | "limit-exceeded"
  | "conflict"
  | "busy"
  | "storage-failed"
  | "outcome-unknown";

export interface GenerationServiceTypes {
  error: GenerationServiceError;
  input: GenerationServiceInput;
  receipt: GenerationServiceReceipt;
}
/**
 * This interface was referenced by `GenerationServiceTypes`'s JSON-Schema
 * via the `definition` "GenerationServiceError".
 */
export interface GenerationServiceError {
  code: GenerationServiceErrorCode;
}
/**
 * No model, text payload, destination, consent, lease or budget can be supplied.
 * The real Host derives input from the original plan and checks current scope.
 *
 * This interface was referenced by `GenerationServiceTypes`'s JSON-Schema
 * via the `definition` "GenerationServiceInput".
 */
export interface GenerationServiceInput {
  attemptId: string;
  taskId: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  unitIds: [string, ...string[]];
}
/**
 * The original ledger accepted these identities. A repeated call may already
 * be terminal; this acknowledgement does not claim queue or model completion.
 * It carries no grant, lease, credential or authorization renewal handle.
 *
 * This interface was referenced by `GenerationServiceTypes`'s JSON-Schema
 * via the `definition` "GenerationServiceReceipt".
 */
export interface GenerationServiceReceipt {
  attemptId: string;
  inputDigest: string;
  taskId: string;
}

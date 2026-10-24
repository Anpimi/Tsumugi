// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * Data supplied to the generation component after the Host prepared its
 * read-only query inputs from the user's selected work plan.
 */
export interface GenerationComponentInput {
  generation: GenerationServiceInput;
  /**
   * @maxItems 15
   */
  preparedTools:
    | []
    | [PreparedToolServiceCall]
    | [PreparedToolServiceCall, PreparedToolServiceCall]
    | [PreparedToolServiceCall, PreparedToolServiceCall, PreparedToolServiceCall]
    | [PreparedToolServiceCall, PreparedToolServiceCall, PreparedToolServiceCall, PreparedToolServiceCall]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ]
    | [
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall,
        PreparedToolServiceCall
      ];
}
/**
 * No model, text payload, destination, consent, lease or budget can be supplied.
 * The real Host derives input from the original plan and checks current scope.
 *
 * This interface was referenced by `GenerationComponentInput`'s JSON-Schema
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
 * One query payload selected from the original work plan. These identities
 * carry data only and do not grant permission to invoke the selected tool.
 *
 * This interface was referenced by `GenerationComponentInput`'s JSON-Schema
 * via the `definition` "PreparedToolServiceCall".
 */
export interface PreparedToolServiceCall {
  callId: string;
  handleId: string;
  input: EncodedPayload;
  toolHandle: string;
}
/**
 * Exact UTF-8 schema payload. The SDK verifies its byte digest but does not
 * substitute a generic parser for that schema's actual semantic validator.
 *
 * This interface was referenced by `GenerationComponentInput`'s JSON-Schema
 * via the `definition` "EncodedPayload".
 */
export interface EncodedPayload {
  schema: ContractRef;
  sha256: string;
  utf8: string;
}
/**
 * Schema and behavior are separate exact-match compatibility identities.
 * Matching JSON field types or a package SemVer is not behavioral compatibility.
 *
 * This interface was referenced by `GenerationComponentInput`'s JSON-Schema
 * via the `definition` "ContractRef".
 */
export interface ContractRef {
  behaviorVersion: number;
  id: string;
  schemaVersion: number;
}

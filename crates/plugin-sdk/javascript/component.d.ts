import type { ComponentInstanceBinding, ContractRef, EncodedPayload, InvocationContext, ProviderBinding, ServiceBinding, ServiceResponse } from './process.js';

/** A proposal payload. The Host supplies the exact schema and digest; Core
 * remains responsible for semantic validation, authority and adoption. */
export interface CapabilityOutput {
  readonly kind: 'succeeded' | 'failed' | 'unknown';
  readonly utf8: string;
}
export interface InvocationMetadata {
  readonly context: Readonly<InvocationContext>;
  /** The Host-validated channel identity, separate from untrusted input data.
   * Inspecting it supplies no grant, installer or transport authority. */
  readonly provider: Readonly<ProviderBinding>;
  readonly profile: Readonly<ContractRef> | null;
  readonly signal: AbortSignal;
  readonly services: InvocationServices;
}
/** Calls are serialized and bound to this invocation's original context. A
 * response may acknowledge enqueueing; its outcome is not a child completion. */
export interface InvocationServices {
  readonly bindings: readonly Readonly<ServiceBinding>[];
  call(handleId: string, utf8: string, callId?: string): Promise<Readonly<ServiceResponse>>;
}
export type CapabilityHandler = (
  input: Readonly<EncodedPayload>,
  metadata: InvocationMetadata,
) => CapabilityOutput | Promise<CapabilityOutput>;

/** Facade for one frozen callable roster. No Cordis Context, service registry,
 * installer, credential, grant, project store or transport handle is exposed. */
export interface ComponentAPI {
  readonly instance: Readonly<ComponentInstanceBinding>;
  readonly contributions: readonly Readonly<{ id: string; contract: Readonly<ContractRef> }>[];
  readonly signal: AbortSignal;
  /** Resolved before activation. Descriptors expose no authority or caller API. */
  readonly services: readonly Readonly<ServiceBinding>[];
  /** Register every captured member exactly once before activation completes.
   * Unknown, duplicate, missing or late registrations fail activation. */
  register(contributionId: string, handler: CapabilityHandler): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface ComponentModule {
  activate(api: ComponentAPI): void | Promise<void>;
}

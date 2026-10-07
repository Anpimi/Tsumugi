import type { ContractRef, EncodedPayload, InvocationContext, ProviderBinding } from './process.js';

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
}
export type CapabilityHandler = (
  input: Readonly<EncodedPayload>,
  metadata: InvocationMetadata,
) => CapabilityOutput | Promise<CapabilityOutput>;

/** Facade for one selected contribution. No Cordis Context, service registry,
 * installer, credential, grant, project store or transport handle is exposed. */
export interface ComponentAPI {
  readonly contribution: Readonly<{ id: string; contract: Readonly<ContractRef> }>;
  readonly signal: AbortSignal;
  register(handler: CapabilityHandler): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface ComponentModule {
  activate(api: ComponentAPI): void | Promise<void>;
}

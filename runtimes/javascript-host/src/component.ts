import { Context, type Fiber } from 'cordis';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { ComponentAPI, CapabilityHandler, CapabilityOutput, ComponentModule } from '../../../crates/plugin-sdk/javascript/component.js';
import type { InvocationRequest, ProcessActivation, ProcessBody, ProcessFrame, ServiceBinding, ServiceRequest, ServiceResponse } from '../../../crates/plugin-sdk/javascript/process.js';
import { PROCESS_PROFILE } from './generated/protocol.js';
import { encodeFrame, scalarString } from './codec.js';

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const opaqueId = (value: string) => typeof value === 'string' && /^[A-Za-z0-9.\-_:/]{1,128}$/.test(value);
const name = (value: string) => typeof value === 'string' && value.length <= 128
  && /^[a-z][a-z0-9.\-_/]*[a-z0-9]$|^[a-z]$/.test(value) && !/[.\-_/]{2}/.test(value);
function validateServices(bindings: ServiceBinding[]): void {
  if (!Array.isArray(bindings) || bindings.length > PROCESS_PROFILE.maxServiceBindings) throw new Error('Service bindings limit');
  const handles = new Set<string>();
  const providers = new Set<string>();
  for (const binding of bindings) {
    const selection = JSON.stringify([binding.providerId, binding.contract.id, binding.contract.schemaVersion, binding.contract.behaviorVersion]);
    if (!opaqueId(binding.handleId) || !name(binding.providerId)
      || !opaqueId(binding.projectId) || !opaqueId(binding.scopeId)
      || !Number.isSafeInteger(binding.activationGeneration) || binding.activationGeneration <= 0
      || binding.activationGeneration > 0xffffffff
      || !/^[a-f0-9]{64}$/.test(binding.configurationDigest)
      || !['read-only', 'proposal', 'external'].includes(binding.effect)
      || handles.has(binding.handleId) || providers.has(selection)) throw new Error('Invalid service binding');
    for (const contract of [binding.contract, binding.inputSchema, binding.outputSchema, binding.errorSchema]) {
      if (!name(contract.id) || !Number.isSafeInteger(contract.schemaVersion) || contract.schemaVersion <= 0
        || contract.schemaVersion > 0xffffffff || !Number.isSafeInteger(contract.behaviorVersion)
        || contract.behaviorVersion <= 0 || contract.behaviorVersion > 0xffffffff) throw new Error('Invalid service contract');
    }
    const limits = binding.limits;
    if (limits.concurrency !== 1 || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0
      || limits.timeoutMs > 0xffffffff
      || !Number.isSafeInteger(limits.maxInputBytes) || limits.maxInputBytes <= 0
      || limits.maxInputBytes > PROCESS_PROFILE.maxInvocationPayloadBytes
      || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes <= 0
      || limits.maxOutputBytes > PROCESS_PROFILE.maxInvocationPayloadBytes) throw new Error('Service limits');
    handles.add(binding.handleId);
    providers.add(selection);
  }
}
interface PendingService {
  request: ServiceRequest;
  binding: ServiceBinding;
  abort: AbortController;
  resolve(response: Readonly<ServiceResponse>): void;
  reject(error: Error): void;
}

/** One SDK facade on one Cordis fiber. Neither object escapes to the component.
 * The parent Rust Host owns actual channel identity, authority and deadlines. */
export class ComponentSession {
  private phase: 'waiting' | 'activating' | 'active' | 'closing' | 'closed' = 'waiting';
  private root = new Context();
  private fiber: Fiber | undefined;
  private activation: ProcessActivation | undefined;
  private starting: Promise<void> | undefined;
  private invocation: { id: string; abort: AbortController; done: Promise<void> } | undefined;
  private scope = new AbortController();
  private dispatches = new Set<string>();
  private serviceCalls = new Set<string>();
  private pendingService: PendingService | undefined;
  private handlerKey = `tsumugi.handler.${randomUUID()}`;
  private cleanupFailed = false;
  constructor(
    private entry: string,
    private send: (frame: ProcessFrame) => Promise<void>,
    private fail: () => void,
    private finish: () => void,
  ) {}
  private emit(body: ProcessBody, maxResultBytes?: number): Promise<void> {
    const frame: ProcessFrame = { protocolVersion: PROCESS_PROFILE.protocolVersion, body };
    if (maxResultBytes !== undefined && encodeFrame(frame).byteLength - 4 > maxResultBytes) {
      throw new Error('Output limit');
    }
    return this.send(frame);
  }
  receive(frame: ProcessFrame): void {
    const body = frame.body;
    if (body.kind === 'activate' && this.phase === 'waiting') {
      validateServices(body.data.services);
      this.phase = 'activating';
      this.activation = immutable(structuredClone(body.data));
      this.starting = this.activate();
      void this.starting.catch(this.fail);
    } else if (body.kind === 'invoke' && this.phase === 'active' && !this.invocation) {
      const request = immutable(structuredClone(body.data));
      const declaration = this.activation!.capability;
      if (!isDeepStrictEqual(request.provider, this.activation!.provider)
        || !isDeepStrictEqual(request.capability, declaration.contract)
        || !isDeepStrictEqual(request.input.schema, declaration.inputSchema)
        || !isDeepStrictEqual(request.outputSchema, declaration.outputSchema)
        || !isDeepStrictEqual(request.errorSchema, declaration.errorSchema)
        || (request.profile != null && !declaration.profiles.some(p => isDeepStrictEqual(p, request.profile)))
        || request.input.sha256 !== digest(request.input.utf8)
        || request.context.inputDigest !== request.input.sha256
        || Buffer.byteLength(request.input.utf8) > declaration.limits.maxInputBytes
        || Buffer.byteLength(request.input.utf8) > PROCESS_PROFILE.maxInvocationPayloadBytes
        || !Number.isSafeInteger(request.maxResultBytes) || request.maxResultBytes <= 0
        || request.maxResultBytes > PROCESS_PROFILE.maxFrameBytes
        || this.dispatches.has(request.context.dispatchId) || this.dispatches.size >= 128) {
        throw new Error('Request mismatch');
      }
      this.dispatches.add(request.context.dispatchId);
      const abort = new AbortController();
      // Defer execution until the token is installed, including synchronous handlers.
      const done = Promise.resolve().then(() => this.invoke(request, abort));
      const token = { id: request.context.dispatchId, abort, done };
      this.invocation = token;
      void done.then(() => { if (this.invocation === token) this.invocation = undefined; }, this.fail);
    } else if (body.kind === 'service-response' && this.phase === 'active') {
      this.receiveServiceResponse(body.data);
    } else if (body.kind === 'cancel' && this.phase === 'active' && this.invocation?.id === body.data.dispatchId) {
      this.invocation.abort.abort();
      this.rejectService(new Error('Invocation cancelled'));
      void this.emit({ kind: 'cancelled', data: body.data }).catch(this.fail);
    } else if (body.kind === 'close' && (this.phase === 'active' || this.phase === 'activating')
      && isDeepStrictEqual(body.data.provider, this.activation!.provider)) {
      this.phase = 'closing';
      this.scope.abort();
      this.invocation?.abort.abort();
      this.rejectService(new Error('Component closed'));
      void this.close().catch(this.fail);
    } else if (body.kind === 'ping' && this.phase === 'active' && !this.invocation) {
      void this.emit({ kind: 'pong', data: body.data }).catch(this.fail);
    } else throw new Error('Unexpected process frame');
  }
  private async activate(): Promise<void> {
    const module: { default?: ComponentModule } = await import(pathToFileURL(this.entry).href);
    if (this.phase !== 'activating') return;
    if (!module.default || typeof module.default.activate !== 'function') throw new Error('Invalid component');
    let registered = false;
    this.fiber = this.root.plugin({
      name: 'tsumugi-component',
      apply: async ctx => {
        const live = () => { if (this.phase !== 'activating' || this.scope.signal.aborted) throw new Error('Inactive component'); };
        const api: ComponentAPI = Object.freeze({
          contribution: immutable({ id: this.activation!.provider.contributionId, contract: structuredClone(this.activation!.capability.contract) }),
          signal: this.scope.signal,
          services: this.activation!.services,
          register: (handler: CapabilityHandler) => {
            live();
            if (registered || typeof handler !== 'function') throw new Error('Invalid registration');
            registered = true;
            // Keep plugin-owned function metadata outside Cordis reflection.
            const owned: CapabilityHandler = (input, metadata) => handler(input, metadata);
            ctx.provide(this.handlerKey, owned);
          },
          onDispose: (cleanup: () => void | Promise<void>) => {
            live();
            if (typeof cleanup !== 'function') throw new Error('Invalid cleanup');
            ctx.effect(() => async () => {
              try { await cleanup(); } catch { this.cleanupFailed = true; }
            });
          },
        });
        await module.default!.activate(api);
        if (!registered) throw new Error('Missing capability');
      },
    });
    try {
      await this.fiber.await();
      if (this.phase !== 'activating') return;
      if (typeof this.root.get(this.handlerKey) !== 'function') throw new Error('Missing capability');
      this.phase = 'active';
      await this.emit({ kind: 'ready', data: this.activation! });
    } catch {
      await this.fiber.dispose();
      throw new Error('Activation failed');
    }
  }
  private async invoke(request: InvocationRequest, abort: AbortController): Promise<void> {
    if (this.phase !== 'active' || abort.signal.aborted) return;
    const handler: CapabilityHandler = this.root.get(this.handlerKey);
    let output: CapabilityOutput;
    try {
      output = await handler(request.input, Object.freeze({
        context: request.context,
        provider: this.activation!.provider,
        profile: request.profile ?? null,
        signal: abort.signal,
        services: Object.freeze({
          bindings: this.activation!.services,
          call: (handleId: string, utf8: string, callId?: string) => this.callService(request, abort, handleId, utf8, callId),
        }),
      }));
    } catch (error) {
      if (this.phase !== 'active' || abort.signal.aborted) return;
      this.rejectService(new Error('Invocation failed'));
      throw error;
    }
    if (this.phase !== 'active' || abort.signal.aborted) return;
    if (this.pendingService?.abort === abort) {
      this.rejectService(new Error('Service call was not awaited'));
      throw new Error('Unawaited service call');
    }
    if (!output) throw new Error('Invalid output');
    const { kind, utf8 } = output;
    if (!['succeeded', 'failed', 'unknown'].includes(kind) || typeof utf8 !== 'string') throw new Error('Invalid output');
    scalarString(utf8);
    if (Buffer.byteLength(utf8) > this.activation!.capability.limits.maxOutputBytes
      || Buffer.byteLength(utf8) > PROCESS_PROFILE.maxInvocationPayloadBytes) throw new Error('Output limit');
    const payload = { schema: kind === 'succeeded' ? request.outputSchema : request.errorSchema, utf8, sha256: digest(utf8) };
    // The peer can read Result before the stdout callback runs. Release the
    // completed handler slot before writing so its next serial call is valid.
    this.invocation = undefined;
    await this.emit({ kind: 'result', data: {
      context: request.context, provider: this.activation!.provider, capability: request.capability,
      profile: request.profile ?? null, resultId: randomUUID(),
      outcome: kind === 'succeeded' ? { kind: 'succeeded', output: payload } : { kind, error: payload },
    } }, request.maxResultBytes);
  }
  private callService(
    outer: InvocationRequest, abort: AbortController, handleId: string, utf8: string, callId: string = randomUUID(),
  ): Promise<Readonly<ServiceResponse>> {
    if (this.phase !== 'active' || abort.signal.aborted || this.scope.signal.aborted
      || this.invocation?.abort !== abort) throw new Error('Inactive invocation');
    if (this.pendingService) throw new Error('Concurrent service call');
    const binding = this.activation!.services.find(service => service.handleId === handleId);
    if (!binding || !opaqueId(callId) || this.serviceCalls.has(callId)
      || this.serviceCalls.size >= PROCESS_PROFILE.maxServiceCalls
      || binding.projectId !== outer.context.projectId || binding.scopeId !== outer.context.scopeId
      || typeof utf8 !== 'string') throw new Error('Service request mismatch');
    scalarString(utf8);
    if (Buffer.byteLength(utf8) > binding.limits.maxInputBytes
      || Buffer.byteLength(utf8) > PROCESS_PROFILE.maxInvocationPayloadBytes) throw new Error('Service input limit');
    const request: ServiceRequest = immutable({ callId, handleId, context: outer.context,
      input: { schema: binding.inputSchema, utf8, sha256: digest(utf8) } });
    let resolve!: PendingService['resolve'];
    let reject!: PendingService['reject'];
    const promise = new Promise<Readonly<ServiceResponse>>((yes, no) => { resolve = yes; reject = no; });
    // Observe rejection even when a component forgets to await its call. The
    // invocation still fails rather than hanging or emitting a false result.
    void promise.catch(() => {});
    const pending = { request, binding, abort, resolve, reject };
    this.serviceCalls.add(callId);
    this.pendingService = pending;
    try {
      void this.emit({ kind: 'service-request', data: request }).catch(() => {
        if (this.pendingService === pending) this.rejectService(new Error('Service transport unavailable'));
        this.fail();
      });
    } catch (error) {
      this.rejectService(new Error('Service transport unavailable'));
      throw error;
    }
    return promise;
  }
  private receiveServiceResponse(response: ServiceResponse): void {
    const pending = this.pendingService;
    if (!pending || pending.abort.signal.aborted || this.invocation?.abort !== pending.abort
      || response.callId !== pending.request.callId || response.handleId !== pending.request.handleId
      || !isDeepStrictEqual(response.context, pending.request.context)) throw new Error('Unexpected service response');
    const outcome = response.outcome;
    const payload = outcome.kind === 'succeeded' ? outcome.output : outcome.error;
    const schema = outcome.kind === 'succeeded' ? pending.binding.outputSchema : pending.binding.errorSchema;
    if (!['succeeded', 'failed', 'unknown'].includes(outcome.kind) || !payload
      || typeof payload.utf8 !== 'string' || !isDeepStrictEqual(payload.schema, schema)
      || payload.sha256 !== digest(payload.utf8)
      || Buffer.byteLength(payload.utf8) > pending.binding.limits.maxOutputBytes
      || Buffer.byteLength(payload.utf8) > PROCESS_PROFILE.maxInvocationPayloadBytes) throw new Error('Service response mismatch');
    scalarString(payload.utf8);
    this.pendingService = undefined;
    pending.resolve(immutable(structuredClone(response)));
  }
  private rejectService(error: Error): void {
    const pending = this.pendingService;
    this.pendingService = undefined;
    pending?.reject(error);
  }
  private async close(): Promise<void> {
    await this.starting;
    await this.invocation?.done;
    await this.fiber?.dispose();
    if (this.cleanupFailed) throw new Error('Cleanup failed');
    this.phase = 'closed';
    await this.emit({ kind: 'closed', data: { provider: this.activation!.provider } });
    this.finish();
  }
}

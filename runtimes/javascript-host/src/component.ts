import { Context, type Fiber } from 'cordis';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { ComponentAPI, CapabilityHandler, ComponentModule } from '../../../crates/plugin-sdk/javascript/component.js';
import type { InvocationRequest, ProcessActivation, ProcessBody, ProcessFrame } from '../../../crates/plugin-sdk/javascript/process.js';
import { PROCESS_PROFILE } from './generated/protocol.js';
import { scalarString } from './codec.js';

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

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
  private handlerKey = `tsumugi.handler.${randomUUID()}`;
  private cleanupFailed = false;
  constructor(
    private entry: string,
    private send: (frame: ProcessFrame) => Promise<void>,
    private fail: () => void,
    private finish: () => void,
  ) {}
  private emit(body: ProcessBody): Promise<void> {
    return this.send({ protocolVersion: PROCESS_PROFILE.protocolVersion, body });
  }
  receive(frame: ProcessFrame): void {
    const body = frame.body;
    if (body.kind === 'activate' && this.phase === 'waiting') {
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
        || request.maxResultBytes > declaration.limits.maxOutputBytes
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
    } else if (body.kind === 'cancel' && this.phase === 'active' && this.invocation?.id === body.data.dispatchId) {
      this.invocation.abort.abort();
      void this.emit({ kind: 'cancelled', data: body.data }).catch(this.fail);
    } else if (body.kind === 'close' && (this.phase === 'active' || this.phase === 'activating')
      && isDeepStrictEqual(body.data.provider, this.activation!.provider)) {
      this.phase = 'closing';
      this.scope.abort();
      this.invocation?.abort.abort();
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
    const output = await handler(request.input, Object.freeze({ context: request.context, profile: request.profile ?? null, signal: abort.signal }));
    if (this.phase !== 'active' || abort.signal.aborted) return;
    if (!output) throw new Error('Invalid output');
    const { kind, utf8 } = output;
    if (!['succeeded', 'failed', 'unknown'].includes(kind) || typeof utf8 !== 'string') throw new Error('Invalid output');
    scalarString(utf8);
    if (Buffer.byteLength(utf8) > request.maxResultBytes) throw new Error('Output limit');
    const payload = { schema: kind === 'succeeded' ? request.outputSchema : request.errorSchema, utf8, sha256: digest(utf8) };
    // The peer can read Result before the stdout callback runs. Release the
    // completed handler slot before writing so its next serial call is valid.
    this.invocation = undefined;
    await this.emit({ kind: 'result', data: {
      context: request.context, provider: this.activation!.provider, capability: request.capability,
      profile: request.profile ?? null, resultId: randomUUID(),
      outcome: kind === 'succeeded' ? { kind: 'succeeded', output: payload } : { kind, error: payload },
    } });
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

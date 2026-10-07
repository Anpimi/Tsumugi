import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const mode = await readFile(new URL('./behavior.txt', import.meta.url), 'utf8');
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
function emit(kind, data) {
  const bytes = Buffer.from(JSON.stringify({ protocolVersion: 2, body: { kind, data } }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  process.stdout.write(Buffer.concat([length, bytes]));
}
export default {
  async activate(api) {
    if (!Object.isFrozen(api) || !Object.isFrozen(api.services)
      || api.services.some(binding => !Object.isFrozen(binding))) throw new Error('Mutable services');
    api.register(async (input, metadata) => {
      if (mode === 'optional-empty') {
        if (api.services.length !== 0 || metadata.services.bindings.length !== 0) throw new Error('Unexpected service');
        return { kind: 'succeeded', utf8: 'optional-none:' + input.utf8 };
      }
      const binding = api.services[0];
      if (!Object.isFrozen(metadata.services) || metadata.services.bindings !== api.services)
        throw new Error('Service facade mismatch');
      const call = {
        callId: 'service-a', handleId: binding.handleId,
        context: structuredClone(metadata.context),
        input: { schema: binding.inputSchema, utf8: 'service:你好 👩🏽‍💻', sha256: digest('service:你好 👩🏽‍💻') },
      };
      if (mode.startsWith('raw-')) {
        if (mode === 'raw-project') call.context.projectId = 'forged-project';
        if (mode === 'raw-scope') call.context.scopeId = 'forged-scope';
        if (mode === 'raw-dispatch') call.context.dispatchId = 'forged-dispatch';
        if (mode === 'raw-input-context') call.context.inputDigest = call.input.sha256;
        if (mode === 'raw-handle') call.handleId = 'forged-handle';
        if (mode === 'raw-schema') call.input.schema = { ...binding.inputSchema, behaviorVersion: 2 };
        if (mode === 'raw-digest') call.input.sha256 = digest('other bytes');
        if (mode === 'raw-input-limit') {
          call.input.utf8 = 'x'.repeat(binding.limits.maxInputBytes + 1);
          call.input.sha256 = digest(call.input.utf8);
        }
        if (mode === 'raw-provider') call.provider = { ...metadata.provider, instanceId: 'forged-instance' };
        if (mode === 'raw-direction') {
          emit('service-response', { callId: call.callId, handleId: call.handleId,
            context: call.context, outcome: { kind: 'succeeded', output: call.input } });
        } else {
          emit('service-request', call);
          if (mode === 'raw-burst') emit('service-request', { ...call, callId: 'service-b' });
        }
        await new Promise(() => {});
      }
      const results = [];
      for (const selected of api.services) {
        const count = mode === 'sequence' ? 4 : mode === 'calls-limit' ? 128 : 1;
        for (let index = 0; index < count; index++) {
          const response = await metadata.services.call(selected.handleId, call.input.utf8,
            index === 0 && selected === binding ? 'service-a' : `${selected.handleId}-${index}`);
          if (!Object.isFrozen(response) || response.context.inputDigest !== metadata.context.inputDigest)
            throw new Error('Invalid service response');
          const payload = response.outcome.kind === 'succeeded' ? response.outcome.output : response.outcome.error;
          results.push(payload.utf8);
        }
      }
      if (mode === 'calls-limit') {
        emit('service-request', { ...call, callId: 'over-limit-call' });
        await new Promise(() => {});
      }
      if (mode === 'duplicate') {
        emit('service-request', call);
        await new Promise(() => {});
      }
      if (mode === 'late') setTimeout(() => emit('service-request', { ...call, callId: 'late-call' }), 40);
      if (mode === 'after-service') {
        const observer = await readFile(new URL('./observer.txt', import.meta.url), 'utf8');
        await writeFile(observer, 'service-received');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { kind: 'succeeded', utf8: results.join('|') + ':' + input.utf8 };
    });
    if (mode === 'activation-pause') {
      const observer = await readFile(new URL('./observer.txt', import.meta.url), 'utf8');
      await writeFile(observer, 'activating');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  },
};

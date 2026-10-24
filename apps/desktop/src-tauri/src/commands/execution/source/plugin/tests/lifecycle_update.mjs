// An actual SDK component wrapping the independent synthetic records fixture.
// Only observation/gates in this test-owned directory are added. Its output is
// computed by the original semantic component, never by a Rust Runner mock.
import component from './upgrade.mjs';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const configuration = JSON.parse(await readFile(new URL('./lifecycle.json', import.meta.url), 'utf8'));
const root = configuration.observations;
if (typeof root !== 'string' || !root.startsWith('/')) throw new Error('Owned observations required');
const stage = fileURLToPath(new URL('../', import.meta.url));
const exists = async path => {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
async function observe(attempt, suffix, value) {
  const destination = join(root, `${attempt}.${suffix}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, destination);
}

async function waitForRelease(attempt, signal) {
  const release = join(root, `${attempt}.release`);
  // Match this fixture's original ten-second callable limit. Capturing and
  // staging the independent real Node runtime can consume more than eight
  // seconds while the first invocation remains live. Host/Core still enforce
  // the original absolute invocation deadline and captured grant unchanged.
  const deadline = performance.now() + 10_000;
  while (!signal.aborted) {
    if (await exists(release)) return 'released';
    if (performance.now() >= deadline) throw new Error('Owned invocation gate exceeded its original callable limit');
    // This timer is always awaited and cleared before cleanup; there are no
    // detached callbacks keeping a captured instance alive after owner drain.
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return 'cancelled';
}

export default {
  activate(api) {
    let invocation;
    let returned;
    api.onDispose(async () => {
      if (!invocation) throw new Error('Missing actual invocation observation');
      const denied = operation => {
        try { operation(); return null; }
        catch (error) { return error.message; }
      };
      // In the held-A case these calls run while B has its own live handler.
      // No mutable Host registry or installer is exposed to either component.
      const registerError = denied(() => api.register(api.contributions[0].id, () => returned));
      const disposeError = denied(() => api.onDispose(() => {}));
      await observe(invocation.context.attemptId, 'disposed', {
        pid: process.pid, stage, provider: invocation.provider,
        context: invocation.context, scopeAborted: api.signal.aborted,
        registerError, disposeError,
      });
      if (registerError !== 'Inactive component' || disposeError !== 'Inactive component') {
        throw new Error('Disposed facade accepted a late registration');
      }
    });
    component.activate({
      instance: api.instance,
      contributions: api.contributions,
      signal: api.signal,
      services: api.services,
      onDispose: cleanup => api.onDispose(cleanup),
      register: (contributionId, handler) => api.register(contributionId, async (input, metadata) => {
        invocation = metadata;
        // Produce the real versioned proposal before the held callback waits.
        returned = await handler(input, metadata);
        await observe(metadata.context.attemptId, 'entered', {
          pid: process.pid, stage, provider: metadata.provider,
          context: metadata.context, profile: metadata.profile, input,
          contribution: api.contributions.find(member => member.id === contributionId),
        });
        const hold = join(root, `${metadata.context.attemptId}.hold`);
        if (await exists(hold)) {
          const mode = await readFile(hold, 'utf8');
          const outcome = await waitForRelease(metadata.context.attemptId, metadata.signal);
          if (outcome === 'cancelled') {
            if (mode !== 'return-after-cancel') throw new Error('Original invocation cancelled');
            // Return the actual cached callback output after its original
            // signal is revoked. ComponentSession must suppress this return;
            // it is not an SDK Result frame or a durable successful result.
            await observe(metadata.context.attemptId, 'late-return', {
              pid: process.pid, provider: metadata.provider, context: metadata.context,
              invocationAborted: metadata.signal.aborted, output: returned,
            });
          }
        }
        return returned;
      }),
    });
  },
};

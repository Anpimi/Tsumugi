import { readFile, writeFile } from 'node:fs/promises';
const mode = await readFile(new URL('./behavior.txt', import.meta.url), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export default {
  async activate(api) {
    if (Object.keys(api).sort().join(',') !== 'contribution,onDispose,register,services,signal'
      || !Object.isFrozen(api) || !Object.isFrozen(api.contribution.contract)
      || !Object.isFrozen(api.services) || api.services.length !== 0) throw new Error('Facade leak');
    let cleaned = false;
    api.onDispose(async () => {
      if (mode === 'cleanup-hang') await new Promise(() => {});
      if (mode === 'cleanup-fail') throw new Error('synthetic cleanup failure');
      await delay(20);
      cleaned = true;
      if (mode === 'observe-cleanup' || mode === 'half-fail') {
        const observer = await readFile(new URL('./observer.txt', import.meta.url), 'utf8');
        await writeFile(observer, 'cleaned');
      }
    });
    api.register(async (input, metadata) => {
      if (cleaned || !Object.isFrozen(input) || !Object.isFrozen(metadata.context)) throw new Error('Invalid lifetime');
      // macOS may inject __CF_USER_TEXT_ENCODING into a process started with env_clear.
      // Assert that parent-only data and runtime injection settings did not cross the pipe boundary.
      if (['TSUMUGI_PARENT_ONLY', 'TSUMUGI_TEST_RUNTIME_TOOL', 'TSUMUGI_TEST_RUNTIME_HOST', 'TSUMUGI_TEST_RUNTIME_APPROVAL', 'HOME', 'PATH', 'NODE_OPTIONS'].some(key => key in process.env)) throw new Error('Inherited environment');
      if (mode === 'hang') await new Promise(() => {});
      if (mode === 'spin') while (true) {}
      if (mode === 'late') await delay(500);
      if (mode === 'oversize') return { kind: 'succeeded', utf8: 'x'.repeat(65537) };
      if (mode === 'invalid-output') return { kind: 'succeeded', utf8: '\ud800' };
      if (mode === 'throw') throw new Error('synthetic handler failure');
      if (mode === 'late-register') api.register(() => ({ kind: 'succeeded', utf8: 'bad' }));
      return { kind: mode === 'failed' ? 'failed' : mode === 'unknown' ? 'unknown' : 'succeeded', utf8: 'answer:' + input.utf8 };
    });
    if (mode === 'half-fail') throw new Error('synthetic partial activation failure');
    if (mode === 'double-register') api.register(() => ({ kind: 'succeeded', utf8: 'bad' }));
    if (mode === 'activation-hang') await new Promise(() => {});
  },
};

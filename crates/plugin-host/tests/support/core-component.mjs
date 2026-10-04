import { readFile, writeFile } from 'node:fs/promises';
const mode = await readFile(new URL('./behavior.txt', import.meta.url), 'utf8');
export default {
  activate(api) {
    api.onDispose(async () => {});
    api.register(async input => {
      const item = JSON.parse(input.utf8);
      if (mode === 'crash') throw new Error('synthetic channel failure');
      if (mode === 'failed' || mode === 'unknown') return { kind: mode, utf8: '{\r\n"reason":"synthetic"\r\n}' };
      if (mode === 'late') {
        const observer = await readFile(new URL('./observer.txt', import.meta.url), 'utf8');
        await writeFile(observer, 'entered');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (mode === 'duplicate') return { kind: 'succeeded', utf8: '{"text":"Updated sample","text":"wrong"}' };
      if (mode === 'oversize') return { kind: 'succeeded', utf8: JSON.stringify({ text: 'x'.repeat(20000), itemIndex: item.index }) };
      if (mode === 'environment') return { kind: 'succeeded', utf8: JSON.stringify({ text: 'Updated sample', itemIndex: item.index, runtime: globalThis.__environmentLabel, toolPath: process.execPath, hostPath: globalThis.__environmentHost, nodeVersion: process.versions.node }) };
      const text = mode === 'invalid' ? 'wrong proposal' : 'Updated sample';
      return { kind: 'succeeded', utf8: '{\r\n  "text":' + JSON.stringify(text) + ', "itemIndex":' + item.index + '\r\n}' };
    });
  },
};

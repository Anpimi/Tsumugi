import { readFile, stat, writeFile } from 'node:fs/promises';

const controls = JSON.parse(await readFile(new URL('./controls.json', import.meta.url), 'utf8'));
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

export default {
  activate(api) {
    api.onDispose(async () => {
      await writeFile(controls.disposed, String(process.pid));
    });
    api.register('call', async input => {
      const payload = JSON.parse(input.utf8);
      await writeFile(controls.entered, JSON.stringify({ pid: process.pid, tag: payload.tag }));
      // This owned fixture must finish within the unchanged 10-second Host limit.
      const deadline = Date.now() + 8000;
      for (;;) {
        try {
          await stat(controls.release);
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (Date.now() >= deadline) throw new Error('Owned test release was not received');
        await pause();
      }
      await writeFile(controls.finished, String(process.pid));
      return { kind: 'succeeded', utf8: JSON.stringify({ tag: payload.tag, pid: process.pid }) };
    });
  },
};

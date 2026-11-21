import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const refreshInterval = 6 * 60 * 60 * 1000;

export async function posterCache(creators, load, directory) {
  const snapshots = new Map();
  const pathFor = (creator) => join(directory, creator + '.json');
  if (directory) {
    await mkdir(directory, { recursive: true });
    for (const creator of creators) {
      try {
        const value = JSON.parse(await readFile(pathFor(creator), 'utf8'));
        if (Number.isFinite(value.updatedAt) && Array.isArray(value.items)) snapshots.set(creator, value);
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn('Could not read poster index for', creator);
      }
    }
  }
  let running;
  function refresh() {
    if (running) return running;
    running = (async () => {
      for (const creator of creators) {
        if (Date.now() - (snapshots.get(creator)?.updatedAt ?? 0) < refreshInterval) continue;
        try {
          const value = { updatedAt: Date.now(), items: await load(creator) };
          snapshots.set(creator, value);
          if (directory) {
            const path = pathFor(creator);
            await writeFile(path + '.tmp', JSON.stringify(value));
            await rename(path + '.tmp', path);
          }
        } catch (error) {
          console.warn('Could not refresh poster index for', creator, error.status ?? error.code ?? error.name);
          if (error.status === 429) break;
        }
      }
    })().finally(() => { running = null; });
    return running;
  }
  return { get: (creator) => snapshots.get(creator)?.items, refresh };
}

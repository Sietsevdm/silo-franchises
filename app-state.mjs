import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function appState(directory) {
  const memory = new Map();
  const pending = new Map();
  if (directory) await mkdir(directory, { recursive: true });
  const fileName = (namespace, key) => namespace + '-' + createHash('sha256').update(key).digest('hex') + '.json';
  async function read(file) {
    if (!directory) return memory.get(file);
    try { return JSON.parse(await readFile(join(directory, file), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function update(namespace, key, change) {
    const file = fileName(namespace, key);
    const operation = (pending.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const value = await change(await read(file));
      if (directory) {
        const path = join(directory, file);
        const temp = path + '.' + randomUUID() + '.tmp';
        await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
        await rename(temp, path);
      } else memory.set(file, value);
      return value;
    });
    pending.set(file, operation);
    const clear = () => { if (pending.get(file) === operation) pending.delete(file); };
    operation.then(clear, clear);
    return operation;
  }
  async function list(namespace) {
    const names = directory ? await readdir(directory) : [...memory.keys()];
    return Promise.all(names.filter((name) => name.startsWith(namespace + '-') && name.endsWith('.json')).map(read));
  }
  return { get: (namespace, key) => read(fileName(namespace, key)), list, update };
}

// On-disk storage helpers: data root, atomic JSON writes, per-file write queues.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export class LibraryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Read at call time so tests can point WORKBENCH_DATA_DIR at a temp folder.
export const dataRoot = () => path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(here, '../../data'));
export const libraryDir = () => path.join(dataRoot(), 'library');
export const filesDir = () => path.join(libraryDir(), 'files');
export const projectsDir = () => path.join(dataRoot(), 'projects');
export const productModelsDir = () => path.resolve(here, '../../../data/product-models/simplified');

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      // Keep the broken file for inspection instead of silently overwriting it.
      await fs.rename(file, `${file}.broken-${Date.now()}`).catch(() => {});
      return fallback;
    }
    throw error;
  }
}

export async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (error) {
      // Windows can briefly lock the target (indexer, antivirus).
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        await fs.unlink(tmp).catch(() => {});
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export const writeJsonAtomic = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

const queues = new Map();

// Run read-modify-write sections for one key strictly one after another.
export function serialize(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

export const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

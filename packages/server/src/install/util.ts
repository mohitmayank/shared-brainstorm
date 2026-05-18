// packages/server/src/install/util.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(
  base: PlainObject,
  patch: PlainObject,
  onConflict: 'fail' | 'overwrite' | 'keep',
): PlainObject {
  const result: PlainObject = { ...base };
  for (const key of Object.keys(patch)) {
    const pVal = patch[key];
    const bVal = base[key];
    if (isPlainObject(pVal) && isPlainObject(bVal)) {
      result[key] = deepMerge(bVal, pVal, onConflict);
    } else if (key in base) {
      // Leaf conflict
      if (onConflict === 'fail') {
        throw new Error(
          `mergeJsonFile conflict at key "${key}": existing="${String(bVal)}" patch="${String(pVal)}"`,
        );
      } else if (onConflict === 'keep') {
        // do not overwrite — keep existing value
      } else {
        result[key] = pVal;
      }
    } else {
      result[key] = pVal;
    }
  }
  return result;
}

export interface MergeJsonOpts {
  onConflict?: 'fail' | 'overwrite' | 'keep';
}

export async function mergeJsonFile(
  filePath: string,
  patch: PlainObject,
  opts?: MergeJsonOpts,
): Promise<void> {
  const onConflict = opts?.onConflict ?? 'overwrite';
  await mkdir(dirname(filePath), { recursive: true });
  let existing: PlainObject = {};
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed)) {
      existing = parsed;
    }
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') throw err;
    // File doesn't exist — start with empty object
  }
  const merged = deepMerge(existing, patch, onConflict);
  await writeFile(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

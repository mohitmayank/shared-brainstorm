import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transcript } from '@shared-brainstorm/shared';

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function transcriptFilename(t: Transcript): string {
  const date = t.started_at.slice(0, 10);
  return `${date}-${slugify(t.brief)}.json`;
}

export function writeTranscript(t: Transcript, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const base = transcriptFilename(t);
  const stem = base.replace(/\.json$/, '');
  const data = JSON.stringify(t, null, 2);
  for (let n = 1; n <= 100; n++) {
    const name = n === 1 ? base : `${stem}-${n}.json`;
    const path = join(dir, name);
    try {
      writeFileSync(path, data, { encoding: 'utf8', flag: 'wx' });
      return path;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n === 100) throw err;
    }
  }
  throw new Error('unreachable');
}

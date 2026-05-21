// packages/server/src/demo.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../../');
const DEMO_PATH = resolve(ROOT, 'demo/index.html');

// ---------------------------------------------------------------------------
// DISC-02: demo/index.html asset
// ---------------------------------------------------------------------------

describe('DISC-02: demo/index.html asset', () => {
  it('file exists at demo/index.html', () => {
    expect(existsSync(DEMO_PATH)).toBe(true);
  });

  it('is self-contained: no external script src', () => {
    const content = readFileSync(DEMO_PATH, 'utf8');
    expect(/<script[^>]+src=["']https?:/i.test(content)).toBe(false);
  });

  it('is self-contained: no external link href', () => {
    const content = readFileSync(DEMO_PATH, 'utf8');
    expect(/<link[^>]+href=["']https?:/i.test(content)).toBe(false);
  });

  it('is self-contained: no fetch() calls', () => {
    const content = readFileSync(DEMO_PATH, 'utf8');
    expect(content.includes('fetch(')).toBe(false);
  });

  it('contains hero headline', () => {
    const content = readFileSync(DEMO_PATH, 'utf8');
    expect(content.includes('Your AI plans. Your team decides.')).toBe(true);
  });

  it('contains concrete Postgres/DynamoDB example', () => {
    const content = readFileSync(DEMO_PATH, 'utf8');
    expect(content.includes('Postgres or DynamoDB')).toBe(true);
  });

  it('contains replay button', () => {
    const content = readFileSync(DEMO_PATH, 'utf8');
    expect(content.includes('replay-btn') || content.includes('Replay')).toBe(true);
  });

  it('packages/server/package.json files array excludes demo', () => {
    const pkgPath = resolve(ROOT, 'packages/server/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files?: string[] };
    expect(pkg.files?.includes('demo')).toBe(false);
  });
});

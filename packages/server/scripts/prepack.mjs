// packages/server/scripts/prepack.mjs
// Cross-platform copy script: assembles dist/public + skills before npm pack.
// Run via: node scripts/prepack.mjs
import { cp, stat, rm, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, '..');
const repoRoot = resolve(serverRoot, '../..');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const webDist = resolve(repoRoot, 'packages/web/dist');
  const publicDest = resolve(serverRoot, 'dist/public');
  const skillsSrc = resolve(repoRoot, 'skills');
  const skillsDest = resolve(serverRoot, 'skills');

  // Validate prerequisites
  if (!(await exists(webDist))) {
    process.stderr.write(`ERROR: web dist not found at ${webDist}\n`);
    process.stderr.write('Run `npm run build -w packages/web` first.\n');
    process.exit(1);
  }

  if (!(await exists(resolve(serverRoot, 'dist/cli.js')))) {
    process.stderr.write(`ERROR: server dist not found at ${serverRoot}/dist/cli.js\n`);
    process.stderr.write('Run `npm run build -w packages/server` first.\n');
    process.exit(1);
  }

  if (!(await exists(skillsSrc))) {
    process.stderr.write(`ERROR: skills/ not found at ${skillsSrc}\n`);
    process.exit(1);
  }

  // Copy web dist → dist/public
  process.stdout.write(`Copying ${webDist} → ${publicDest}\n`);
  if (await exists(publicDest)) await rm(publicDest, { recursive: true });
  await mkdir(publicDest, { recursive: true });
  await cp(webDist, publicDest, { recursive: true });

  // Copy repo skills → package skills
  process.stdout.write(`Copying ${skillsSrc} → ${skillsDest}\n`);
  if (await exists(skillsDest)) await rm(skillsDest, { recursive: true });
  await cp(skillsSrc, skillsDest, { recursive: true });

  // Copy root README + LICENSE into the package so npm includes them.
  // Without this, the published package on npm has no readme / license file.
  for (const name of ['README.md', 'LICENSE']) {
    const src = resolve(repoRoot, name);
    const dest = resolve(serverRoot, name);
    if (!(await exists(src))) {
      process.stderr.write(`ERROR: ${name} not found at ${src}\n`);
      process.exit(1);
    }
    process.stdout.write(`Copying ${src} → ${dest}\n`);
    await copyFile(src, dest);
  }

  // Copy root CHANGELOG into the package (npm omits CHANGELOG by default, so it is
  // also listed in `files`). Non-fatal: a fresh checkout before the first release
  // may not have one yet — release-it generates it during the release.
  {
    const src = resolve(repoRoot, 'CHANGELOG.md');
    const dest = resolve(serverRoot, 'CHANGELOG.md');
    if (await exists(src)) {
      process.stdout.write(`Copying ${src} → ${dest}\n`);
      await copyFile(src, dest);
    } else {
      process.stdout.write(`Skipping CHANGELOG.md (not found at ${src})\n`);
    }
  }

  process.stdout.write('prepack done.\n');
}

main().catch((err) => {
  process.stderr.write(`prepack failed: ${String(err)}\n`);
  process.exit(1);
});

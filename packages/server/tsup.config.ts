import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  bundle: true,
  external: [/^@modelcontextprotocol\/sdk/, /^hono/, /^@hono\/.*/, 'zod'],
  noExternal: ['@shared-brainstorm/shared'],
});

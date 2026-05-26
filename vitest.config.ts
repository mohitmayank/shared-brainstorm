import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    setupFiles: ['packages/web/src/test-setup.ts'],
    environmentMatchGlobs: [
      ['packages/web/src/**', 'jsdom'],
      ['**/*', 'node'],
    ],
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'packages/*/bin/*.test.ts',
    ],
    coverage: {
      reporter: ['text', 'lcov'],
      exclude: ['**/dist/**', '**/*.config.*', '**/index.ts'],
    },
  },
});

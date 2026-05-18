import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The shared package imports node:crypto for server-side ID generation functions
// which are never called in browser code. We stub it with a pre-priority plugin
// so it runs before Vite's built-in node builtins externalization.
function stubNodeCrypto(): Plugin {
  const STUB_ID = '\0vite-stub-node-crypto';
  return {
    name: 'stub-node-crypto',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'node:crypto' || id === 'crypto') return STUB_ID;
      return undefined;
    },
    load(id) {
      if (id === STUB_ID) {
        return `export function randomBytes() { throw new Error('node:crypto not available in browser'); }
export function createHash() { throw new Error('node:crypto not available in browser'); }`;
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [stubNodeCrypto(), react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173 },
});

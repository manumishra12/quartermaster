import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The API is proxied rather than called cross-origin, so `TrueForgeUI` runs same-origin against
 * `baseUrl: '/'`. No CORS configuration, and no server URL baked into the bundle.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // One source of truth for the evidence rules. The CLI and the UI must never disagree about
      // whether a claim is substantiated, so they import the same module rather than each keeping
      // their own copy of the logic.
      '@evidence': fileURLToPath(new URL('../scripts/lib/evidence.mjs', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
        changeOrigin: true,
      },
    },
  },
});

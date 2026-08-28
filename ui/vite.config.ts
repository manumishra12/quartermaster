import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The API is proxied rather than called cross-origin, so `TrueForgeUI` runs same-origin against
 * `baseUrl: '/'`. No CORS configuration, and no server URL baked into the bundle.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // One source of truth for the evidence rules. The CLI and the UI must never disagree about
      // whether a claim is substantiated, so they import the same module rather than each keeping
      // their own copy of the logic.
      '@evidence': fileURLToPath(new URL('../scripts/lib/evidence.mjs', import.meta.url)),
      // Shared with the CLI on purpose: two renderings of the same fact drift, and this one is a
      // statement about whether something happened.
      '@render-call': fileURLToPath(new URL('../scripts/lib/render-call.mjs', import.meta.url)),
      // The report the CLI writes to evidence/<session>/report.md, built by the same function.
      // The panel is not a second rendering of the verdict - it is that file, in the browser.
      '@report': fileURLToPath(new URL('../scripts/lib/report.mjs', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Vite binds to `localhost`, which on this machine resolved to ::1 only. A browser resolving
    // localhost to 127.0.0.1 then cannot connect at all, which looks identical to the server
    // being down. Binding to every interface removes the ambiguity.
    host: true,
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
        changeOrigin: true,
      },
    },
  },
});

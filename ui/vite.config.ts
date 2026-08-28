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
      // The handoff envelope, parsed by the same module that writes it. A wording change in one
      // would otherwise stop the other recognising a handoff, and the untrusted framing would
      // render as ordinary prose - which is the one thing that framing exists to prevent.
      '@handoff': fileURLToPath(new URL('../scripts/lib/handoff-envelope.mjs', import.meta.url)),
      // The report the CLI writes to evidence/<session>/report.md, built by the same function.
      // The panel is not a second rendering of the verdict - it is that file, in the browser.
      '@report': fileURLToPath(new URL('../scripts/lib/report.mjs', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    /**
     * Loopback, explicitly, and never `true`.
     *
     * `true` binds every interface, and this dev server proxies `/api` straight to the harness with
     * no authentication anywhere on the path. So it was not merely serving the interface to the
     * network - it was serving the harness. Verified from this machine's own LAN address:
     *
     *     GET http://192.168.0.120:5173/               -> 200, the whole interface
     *     GET http://192.168.0.120:5173/api/v1/agents  -> 200, every spec
     *
     * The part that matters is not the reading. The interface renders the approval prompt, and its
     * Allow button POSTs back through this same proxy - so anybody on the same wifi was a person at
     * a terminal, as far as the gate could tell. That is the one claim this project makes, and the
     * MCP servers were hardened against exactly this while the surface that reaches them through
     * the harness was left open.
     *
     * `127.0.0.1` also fixes what `host: true` was there for. Vite's default resolved to ::1 only
     * on this machine, so a browser resolving localhost to 127.0.0.1 could not connect at all -
     * which looks identical to the server being down. Naming the address removes the ambiguity
     * without handing the port to the network.
     */
    host: '127.0.0.1',
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
        changeOrigin: true,
      },
    },
  },
});

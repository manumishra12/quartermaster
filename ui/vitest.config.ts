import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const shared = {
  environment: 'jsdom' as const,
  globals: true,
  setupFiles: ['./src/test/setup.ts'],
};

export default defineConfig({
  plugins: [react()],
  /**
   * The documentation lives above this package, and one test reads it to check that every mermaid
   * block still parses. Vite refuses to serve above its root by default, so the test runner is told
   * it may.
   *
   * An earlier version of this comment claimed the dev server kept a narrower view. It does not:
   * `vite.config.ts` carries the same allowance and predates this file's, because the shared
   * modules the interface imports - the evidence rules, the handoff envelope, the report builder -
   * all live in `../scripts/lib`, and the aliases resolving to them are the whole reason the two
   * surfaces cannot disagree about a verdict. Removing it would break the dev server.
   *
   * What actually limits that is the bind address: `vite.config.ts` sets `host: '127.0.0.1'` after
   * this project shipped a dev server on every interface, proxying to the harness with no
   * authentication. The filesystem allowance is reachable by whoever can reach the port, and only
   * loopback can.
   *
   * A security comment claiming a property the code does not have is worse than no comment, and
   * this one did until a review caught it.
   */
  server: { fs: { allow: ['..'] } },
  resolve: {
    alias: {
      // The same shared evidence module the app and the CLI use. Tests must exercise the real
      // rules, not a stand-in, or they would only prove the interface agrees with a copy of itself.
      '@evidence': fileURLToPath(new URL('../scripts/lib/evidence.mjs', import.meta.url)),
      '@render-call': fileURLToPath(new URL('../scripts/lib/render-call.mjs', import.meta.url)),
      // The handoff envelope, parsed by the same module that writes it. A wording change in one
      // would otherwise stop the other recognising a handoff, and the untrusted framing would
      // render as ordinary prose - which is the one thing that framing exists to prevent.
      '@handoff': fileURLToPath(new URL('../scripts/lib/handoff-envelope.mjs', import.meta.url)),
      '@report': fileURLToPath(new URL('../scripts/lib/report.mjs', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/layout/mount.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: 'mount',
          include: ['src/layout/mount.test.tsx'],
          /**
           * Run with --dangerouslyIgnoreUnhandledErrors, applied on the `test:mount` script rather
           * than here, because Vitest does not honour the option per project.
           *
           * Mounting the real TrueForgeUI shell trips an infinite-update loop inside the SDK's own
           * resource scheduler: "Maximum update depth exceeded. The result of getSnapshot should be
           * cached." It reproduces with a bare layout containing none of our components, so it is
           * upstream, and it escapes asynchronously where neither act() nor an explicit unmount can
           * contain it.
           *
           * The alternative was deleting the test, and this is the test that caught the interface
           * rendering blank. Every other file runs under the `unit` project, which still fails on
           * an unhandled error.
           */
        },
      },
    ],
  },
});

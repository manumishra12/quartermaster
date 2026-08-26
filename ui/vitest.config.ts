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
  resolve: {
    alias: {
      // The same shared evidence module the app and the CLI use. Tests must exercise the real
      // rules, not a stand-in, or they would only prove the interface agrees with a copy of itself.
      '@evidence': fileURLToPath(new URL('../scripts/lib/evidence.mjs', import.meta.url)),
      '@render-call': fileURLToPath(new URL('../scripts/lib/render-call.mjs', import.meta.url)),
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

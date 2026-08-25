import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The same shared evidence module the app and the CLI use. Tests must exercise the real
      // rules, not a stand-in, or they would prove the interface agrees with a copy of itself.
      '@evidence': fileURLToPath(new URL('../scripts/lib/evidence.mjs', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

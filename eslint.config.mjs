import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The rules here are the ones that would have caught bugs this project actually shipped, not a
 * style opinion. Formatting is deliberately absent: an argument about semicolons in a pull request
 * costs more than it saves, and none of it changes what the code does.
 */
export default tseslint.config(
  /**
   * `.claude/` holds git worktrees, each a second full checkout of this repository. Without it
   * here, `npm run check` lints every worktree as though it were part of the tree you are in - so
   * work in progress somewhere else fails the check where you are.
   */
  { ignores: ['node_modules/**', 'ui/**', 'fixtures/**', 'evidence/**', 'design-system/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{mjs,ts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', TextEncoder: 'readonly' },
    },
    rules: {
      // A promise nobody waits for is how a run finishes before its work does.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      // Silently swallowing an error is how resultOf used to delete a red test run from the evidence.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-fallthrough': 'error',
      'require-atomic-updates': 'error',
    },
  },
  {
    files: ['**/*.test.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);

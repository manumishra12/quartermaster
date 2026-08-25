import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/**
 * Two plugins here earn their place rather than enforcing taste.
 *
 * react-hooks catches the class of bug that is invisible in review and obvious in production: a
 * dependency array that lies, a value derived in render that should not be, an effect that never
 * cleans up. This interface is the safety surface of an agent that acts on real systems, so a
 * stale render is not a cosmetic problem.
 *
 * jsx-a11y catches the accessibility defects that are cheap to prevent and expensive to retrofit.
 * A person approving an irreversible action has to be able to reach the Deny button.
 */
export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        Storage: 'readonly',
        MediaQueryListEvent: 'readonly',
        HTMLElement: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Ships as a warning. A dependency array that lies is the single most common cause of an
      // interface showing something that is no longer true, and this interface is what somebody
      // reads before approving an irreversible action. It is an error here.
      'react-hooks/exhaustive-deps': 'error',
      ...jsxA11y.flatConfigs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      // Tests deliberately reach for shapes the app would never produce.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);

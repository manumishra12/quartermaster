import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

/**
 * jsdom has no matchMedia, and the theme hook asks for it on first render. Without this every
 * component test fails on mount for a reason that has nothing to do with what is being tested.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

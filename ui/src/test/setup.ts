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

/**
 * jsdom implements neither of these, and the SDK's chat surface uses both. Without them a mount
 * test fails for a reason that has nothing to do with the code under test.
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'ResizeObserver', { writable: true, value: ResizeObserverStub });
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

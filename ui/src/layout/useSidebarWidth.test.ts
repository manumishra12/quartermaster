import { describe, expect, test } from 'vitest';
import { clamp, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH } from './useSidebarWidth';

/**
 * Conversation titles are the one thing here that is arbitrarily long - they come from whatever
 * somebody typed first - so the column has to be draggable. The bounds are the whole safety story:
 * a sidebar dragged to nothing, or past the window, is a sidebar somebody cannot get back.
 */
describe('sidebar width bounds', () => {
  test('a drag cannot collapse the column or take over the window', () => {
    expect(clamp(0)).toBe(MIN_WIDTH);
    expect(clamp(-500)).toBe(MIN_WIDTH);
    expect(clamp(99_999)).toBe(MAX_WIDTH);
  });

  test('a width in range is kept, rounded to whole pixels', () => {
    expect(clamp(300)).toBe(300);
    expect(clamp(300.6)).toBe(301);
  });

  test('the default sits inside the bounds', () => {
    expect(DEFAULT_WIDTH).toBeGreaterThanOrEqual(MIN_WIDTH);
    expect(DEFAULT_WIDTH).toBeLessThanOrEqual(MAX_WIDTH);
  });

  test('nonsense from storage does not produce a nonsense column', () => {
    // NaN would otherwise flow into a style attribute and collapse the sidebar to zero.
    expect(clamp(Number.NaN)).toBe(MIN_WIDTH);
  });
});

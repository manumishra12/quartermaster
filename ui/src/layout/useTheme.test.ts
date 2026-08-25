import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useTheme } from './useTheme';

/**
 * Two things worth testing here that are easy to get wrong: "system" must actually follow the
 * system, and storage must never be able to stop the page rendering. Private windows, cleared site
 * data and browsers set to block storage all throw on access rather than returning null.
 */

function setSystemDark(dark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: dark && query.includes('dark'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  setSystemDark(false);
});

afterEach(() => vi.restoreAllMocks());

describe('useTheme', () => {
  test('defaults to following the system rather than picking for the viewer', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('system');
  });

  test('system resolves dark when the OS asks for dark', () => {
    setSystemDark(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('an explicit choice overrides the system and is remembered', () => {
    setSystemDark(true);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.choose('light'));
    expect(result.current.resolved).toBe('light');
    expect(localStorage.getItem('quartermaster-theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('choosing system again clears the stored preference', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.choose('dark'));
    act(() => result.current.choose('system'));
    expect(localStorage.getItem('quartermaster-theme')).toBeNull();
  });

  test('a stored choice is restored on load', () => {
    localStorage.setItem('quartermaster-theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('dark');
    expect(result.current.resolved).toBe('dark');
  });

  test('a junk stored value falls back to system instead of breaking', () => {
    localStorage.setItem('quartermaster-theme', 'chartreuse');
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('system');
  });

  test('storage that throws on read still renders - a private window is not an error', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied');
    });
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('system');
  });

  test('storage that throws on write still applies the choice for this session', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const { result } = renderHook(() => useTheme());
    act(() => result.current.choose('dark'));
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('the root colour-scheme is set so form controls and scrollbars match', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.choose('dark'));
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});

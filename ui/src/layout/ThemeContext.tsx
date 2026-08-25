import { createContext, useContext } from 'react';
import type { ThemeMode } from './useTheme';

/**
 * The layout is handed to the SDK as a component *type*, and it renders `<HostLayout />`. A
 * `useCallback` with changing dependencies produces a new identity, React sees a new element type,
 * and unmounts the entire subtree.
 *
 * That happened on every theme change - including while an approval was pending, which reset the
 * guard that stops a decision being sent twice, dropped focus, and destroyed the composer draft
 * and scroll position. The layout component is now defined once at module scope and reads what it
 * needs from here.
 */
export type ThemeControl = {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  onThemeChange: (m: ThemeMode) => void;
  agentName: string;
};

const FALLBACK: ThemeControl = {
  mode: 'system',
  resolved: 'dark',
  onThemeChange: () => {},
  agentName: 'quartermaster-local',
};

export const ThemeContext = createContext<ThemeControl>(FALLBACK);

export const useThemeControl = () => useContext(ThemeContext);

import type { ThemeMode } from './useTheme';
import { MoonIcon, SunIcon } from './icons';

/**
 * A single control that cycles light, dark, and following the system.
 *
 * Three states in one button needs the current state said out loud rather than implied by an icon,
 * so the accessible name always names where you are and where the next press takes you. An icon
 * alone would leave a screen-reader user pressing a button that reports only "theme".
 */
const NEXT: Record<ThemeMode, ThemeMode> = { light: 'dark', dark: 'system', system: 'light' };
const SAYS: Record<ThemeMode, string> = {
  light: 'Light theme. Switch to dark.',
  dark: 'Dark theme. Switch to following your system.',
  system: 'Following your system. Switch to light.',
};

export function ThemeToggle({
  mode,
  resolved,
  onChange,
}: {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  onChange: (m: ThemeMode) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(NEXT[mode])}
      aria-label={SAYS[mode]}
      title={SAYS[mode]}
      className="qm-tap relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors duration-200 hover:bg-raised hover:text-ink"
    >
      {resolved === 'dark' ? <MoonIcon /> : <SunIcon />}
      {/* A dot marks "following the system", so the two automatic states are distinguishable
          without opening a menu. */}
      {mode === 'system' && (
        <span aria-hidden className="absolute bottom-1 right-1 size-1.5 rounded-full bg-accent" />
      )}
    </button>
  );
}

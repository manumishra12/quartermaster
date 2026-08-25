import type { ThemeMode } from './useTheme';

const OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Auto' },
  { value: 'dark', label: 'Dark' },
];

/**
 * A segmented control rather than a single toggle, because a toggle cannot express "follow the
 * system" - and that is the state most people should be in. Real radios, so it is keyboard
 * navigable and announced as a group without any ARIA of our own.
 */
export function ThemeToggle({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  return (
    <fieldset className="flex rounded-lg border border-line-soft p-0.5">
      <legend className="sr-only">Colour theme</legend>
      {OPTIONS.map((option) => {
        const active = mode === option.value;
        return (
          <label
            key={option.value}
            className={[
              'cursor-pointer rounded-md px-2 py-1 text-2xs font-medium transition-colors duration-200',
              active ? 'bg-raised text-ink' : 'text-muted hover:text-ink',
            ].join(' ')}
          >
            <input
              type="radio"
              name="qm-theme"
              value={option.value}
              checked={active}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </fieldset>
  );
}

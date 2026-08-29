import { useComposerRuntime } from '@assistant-ui/react';
import { BugIcon, DatabaseIcon, GlobeIcon, TerminalIcon } from './icons';

/**
 * Quick actions above the composer, available at every point in a conversation rather than only on
 * the empty screen.
 *
 * The welcome cards teach the product once and then disappear. These are the same prompts kept
 * within reach, because the second and third things you want to ask are the ones you have to
 * compose from nothing.
 */
const ACTIONS = [
  {
    icon: BugIcon,
    label: 'Fix a failing test',
    prompt:
      'Clone https://github.com/manumishra12/ledger-fixture into the sandbox, run its tests, show me the failure, then fix the root cause and re-run to prove it passes. Do not edit the test.',
  },
  {
    icon: TerminalIcon,
    label: 'Run code',
    prompt: 'Use the sandbox shell to run: python3 -c "print(sum(range(101)))" and report exactly what it printed.',
  },
  {
    icon: DatabaseIcon,
    label: 'Query data',
    prompt:
      'Build a SQLite database in the sandbox with a table of five orders in cents, then tell me the total revenue and show me the query you ran.',
  },
  {
    icon: GlobeIcon,
    label: 'Read a repo',
    prompt: 'Use deepwiki to tell me how the truefoundry/trueforge repository lays out its tests, and cite where you found it.',
  },
] as const;

export function QuickActions() {
  const composer = useComposerRuntime();

  const use = (prompt: string) => {
    try {
      composer?.setText(prompt);
      // Move focus to the box the text landed in. Writing into a field the person is not looking
      // at, while focus stays on the button, reads as the button having done nothing.
      document.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    } catch {
      // A runtime that cannot take text must not blank the page.
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5 px-5 pb-2" role="group" aria-label="Quick actions">
      {ACTIONS.map(({ icon: Icon, label, prompt }) => (
        <button
          key={label}
          type="button"
          onClick={() => use(prompt)}
          className="qm-tap inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-2xs text-muted transition-colors duration-200 hover:border-accent hover:bg-accent-wash hover:text-ink"
        >
          <Icon />
          {label}
        </button>
      ))}
    </div>
  );
}

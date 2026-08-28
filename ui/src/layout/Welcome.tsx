import { useComposerRuntime } from '@assistant-ui/react';
import { BugIcon, DatabaseIcon, GlobeIcon, TerminalIcon } from './icons';

/**
 * The empty state, which is the first thing a stranger sees and the only chance to say what this
 * agent is for before they have to guess.
 *
 * The suggestions are real prompts for the agent that is actually pinned, not generic capability
 * cards. A card that describes a feature teaches nothing; a card that fills the box with something
 * that works teaches the whole product in one click.
 */
const SUGGESTIONS = [
  {
    icon: BugIcon,
    title: 'Fix a failing test',
    detail: 'Reproduce it, patch it, prove it',
    prompt:
      'Clone https://github.com/manumishra12/ledger-fixture into the sandbox, run its tests, show me the failure, then fix the root cause and re-run to prove it passes. Do not edit the test.',
  },
  {
    icon: TerminalIcon,
    title: 'Run code safely',
    detail: 'Isolated sandbox, real output',
    prompt: 'Use the sandbox shell to run: python3 -c "print(sum(range(101)))" and report exactly what it printed.',
  },
  {
    icon: DatabaseIcon,
    title: 'Query a database',
    detail: 'SQL written, run, explained',
    prompt:
      'Build a SQLite database in the sandbox with a table of five orders in cents, then tell me the total revenue and show me the query you ran.',
  },
  {
    icon: GlobeIcon,
    title: 'Read a repository',
    detail: 'Its docs and conventions',
    prompt: 'Use deepwiki to tell me how the truefoundry/trueforge repository lays out its tests, and cite where you found it.',
  },
] as const;

export function Welcome({ heading }: { heading?: string }) {
  const composer = useComposerRuntime();

  const use = (prompt: string) => {
    try {
      composer?.setText(prompt);
    } catch {
      // If the runtime shape changes, the card should still not throw and blank the page.
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-5 py-10">
      {/* The glow is the only purely decorative thing in this interface. It marks the one moment
          nothing is happening yet, so the eye has somewhere to land. */}
      <div className="relative mb-6">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 blur-2xl"
          style={{ background: 'radial-gradient(circle, var(--qm-accent) 0%, transparent 70%)', opacity: 0.18 }}
        />
        <span className="flex size-16 items-center justify-center rounded-2xl border border-line-soft bg-surface shadow-[var(--qm-shadow)]">
          <img src="/mark.svg" alt="" width={32} height={32} />
        </span>
      </div>

      <h2 className="text-center text-2xl font-[550] tracking-[-0.032em] text-ink">
        {heading ?? 'What should it prove?'}
      </h2>
      <p className="mt-2 max-w-[46ch] text-center text-sm text-muted">
        It runs the work in a sandbox, shows you the output, and asks before anything irreversible.
      </p>

      <ul className="mt-8 grid w-full gap-2.5 sm:grid-cols-2">
        {SUGGESTIONS.map(({ icon: Icon, title, detail, prompt }) => (
          <li key={title}>
            <button
              type="button"
              onClick={() => use(prompt)}
              className="group h-full w-full cursor-pointer rounded-xl border border-line bg-surface p-3.5 text-left transition-colors duration-200 hover:border-accent hover:bg-raised"
            >
              <span className="mb-2.5 flex size-8 items-center justify-center rounded-lg border border-line-soft text-muted transition-colors duration-200 group-hover:text-accent">
                <Icon />
              </span>
              <span className="block text-sm font-medium text-ink">{title}</span>
              <span className="mt-0.5 block text-xs text-muted">{detail}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A crash must never be a blank page.
 *
 * When the SDK's resource scheduler threw, React unmounted the whole tree and the tab went white
 * while the dev server kept answering 200. Nothing on screen, nothing in the terminal, and the
 * only way to find out was reading the browser console. That cost most of a day.
 *
 * This does not fix anything. It makes the failure legible, which is the difference between a bug
 * you can report and a page that appears not to load.
 */
type State = { error: Error | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack: the message alone rarely says which subtree died.
    console.error('Quartermaster crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-bg p-6 text-ink">
        <div className="max-w-lg rounded-xl border border-failed/40 bg-surface p-5 shadow-[var(--qm-shadow)]">
          <h1 className="text-base font-[550] text-failed">The interface crashed</h1>
          <p className="mt-2 text-sm text-muted">
            This is a bug in Quartermaster, not in the harness. The agents and the API are unaffected
            and still reachable at the server this page talks to.
          </p>
          <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-line-soft bg-bg p-2.5 font-mono text-2xs text-ink">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-3 min-h-9 w-full cursor-pointer rounded-lg border border-line text-2xs text-muted transition-colors duration-200 hover:border-accent hover:text-ink"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

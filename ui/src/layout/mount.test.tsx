import { act, cleanup, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import App from '../App';

/**
 * The test the interface needed most, rewritten after it failed to catch the thing it existed for.
 *
 * It used to render the layout with hand-written props and tolerate an unhandled
 * "Maximum update depth exceeded" on the grounds that the loop was upstream. It was not upstream.
 * Every prop App handed the SDK - server, agentConfig, theme, overrides - was an object literal in
 * the JSX, so each render produced a new identity, and the SDK feeds those into a
 * useSyncExternalStore whose snapshot then differs on every read. In a browser that killed the
 * React tree and the page rendered blank, while the dev server answered 200.
 *
 * So this renders the real App, with the real props, and fails on that error rather than ignoring
 * it. A blank page is the one failure this file is here to prevent.
 */
test('the real App mounts, with no render loop', async () => {
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])));

  // A fake harness answering each route with the shape it really returns. A blanket `{data: []}`
  // makes the SDK read `.enabled` off undefined, failing for a reason about the stub.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const body = url.includes('/capabilities')
        ? { data: { sandbox: { enabled: true }, skill: { enabled: true }, settings: { enabled: true } } }
        : { data: [], pagination: { nextPageToken: null } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );

  await act(async () => {
    render(<App />);
    await new Promise((r) => setTimeout(r, 500));
  });

  // The three surfaces that must exist for the interface to do its job at all.
  const rail = screen.queryByLabelText('Agent status');
  expect(rail, 'the status rail did not render - the tree probably crashed').toBeInTheDocument();
  expect(within(rail!).getByText('Doing')).toBeInTheDocument();
  expect(within(rail!).getByText('Waiting on')).toBeInTheDocument();
  expect(within(rail!).getByText('Did')).toBeInTheDocument();
  expect(screen.getAllByRole('heading', { level: 1, name: 'Quartermaster' }).length).toBeGreaterThan(0);

  /**
   * Two different things share wording here, and only one is fatal.
   *
   * "The result of getSnapshot should be cached" on its own is a one-time development warning from
   * the SDK's own store, guarded by a module-level flag. It is upstream and harmless.
   *
   * "Maximum update depth exceeded" is thrown after fifty commits in which a snapshot never
   * settles. That one kills the React tree, and it is what made this page render blank in a
   * browser while the dev server answered 200.
   */
  const fatal = errors.filter((e) => /Maximum update depth exceeded/i.test(e));
  expect(fatal, `render loop killed the tree: ${fatal[0] ?? ''}`).toHaveLength(0);

  spy.mockRestore();
  await act(async () => {
    cleanup();
  });
});

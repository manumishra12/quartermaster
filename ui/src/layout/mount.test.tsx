import { act, cleanup, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { TrueForgeUI } from '@truefoundry/trueforge-ui';
import { QuartermasterLayout } from './QuartermasterLayout';

/**
 * The test the interface did not have, and needed most.
 *
 * Every other UI test mocks the harness hooks, which is right for behaviour but means none of them
 * can catch a component calling a hook outside its provider. That shipped: the rail and the topbar
 * both read composer busy state, ComposerBusyProvider is only wired inside <Thread /> which this
 * layout does not use, and the entire surface rendered blank. A smoke check against the dev server
 * returned 200 the whole time, because the HTML shell serves fine and React fails in the browser.
 *
 * This renders the real tree with nothing mocked but the network.
 */
test('the real component tree mounts inside TrueForgeUI', async () => {
  // A fake harness that answers each route with the shape it really returns. A blanket
  // `{data: []}` makes the SDK read `.enabled` off undefined, which fails the test for a reason
  // that is about the stub rather than about the interface.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const body = url.includes('/capabilities')
        ? { data: { sandbox: { enabled: true }, skill: { enabled: true }, settings: { enabled: true } } }
        : // The adapter reads page.response.pagination.nextPageToken. Omitting `pagination`
          // made every session-list load throw, and the failing list retried hard enough to drive
          // the shell into an update loop - which looked like an upstream bug and was my stub.
          { data: [], pagination: { nextPageToken: null } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );

  await act(async () => {
    render(
      <TrueForgeUI
        server={{ type: 'trueforge', baseUrl: '/' } as never}
        layout={(p: { className?: string }) => (
          <QuartermasterLayout {...p} mode="dark" resolved="dark" onThemeChange={() => {}} agentName="quartermaster-local" />
        )}
        agentConfig={{ mode: 'SingleAgent', name: 'quartermaster-local' }}
      />,
    );
    await new Promise((r) => setTimeout(r, 400));
  });

  // The three surfaces that must exist for the interface to do its job at all.
  const rail = screen.queryByLabelText('Agent status');
  expect(rail).toBeInTheDocument();
  expect(within(rail!).getByText('Doing')).toBeInTheDocument();
  expect(within(rail!).getByText('Waiting on')).toBeInTheDocument();
  expect(within(rail!).getByText('Did')).toBeInTheDocument();

  // The sidebar and the topbar both render, which is what proves the busy-state provider is above
  // them rather than only around the composer.
  // Two copies exist in the DOM - the desktop sidebar and the narrow-screen header - and CSS hides
  // one of them. jsdom applies no CSS, so both are found here.
  expect(screen.getAllByRole('heading', { level: 1, name: 'Quartermaster' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('quartermaster-local').length).toBeGreaterThan(0);

  // Unmount inside act so the shell's effects settle here rather than escaping into teardown.
  await act(async () => {
    cleanup();
  });
});

import { useCallback } from 'react';
import { TrueForgeUI } from '@truefoundry/trueforge-ui';
import { QuartermasterLayout } from './layout/QuartermasterLayout';
import { useTheme } from './layout/useTheme';
import { tokensFor } from './theme';

/**
 * Pinned to one agent on purpose. The agent library and composer are TrueForge's surfaces for
 * building agents; this is the surface for using one, so an agent picker would only be a way to
 * leave the product.
 *
 * The API is proxied through Vite, so this runs same-origin at baseUrl '/'.
 */
const AGENT_NAME = import.meta.env.VITE_AGENT_NAME ?? 'quartermaster-local';

export default function App() {
  const { mode, resolved, choose } = useTheme();

  // The SDK renders the transcript and composer, so it needs the same palette we do. One resolved
  // theme drives both; two sources of colour would drift within a release.
  const Layout = useCallback(
    (props: { className?: string }) => <QuartermasterLayout {...props} mode={mode} onThemeChange={choose} />,
    [mode, choose],
  );

  return (
    <div className="h-dvh">
      <TrueForgeUI
        server={{ type: 'trueforge', baseUrl: '/' }}
        layout={Layout}
        agentConfig={{ mode: 'SingleAgent', name: AGENT_NAME }}
        theme={{ preset: 'trueforge', mode: resolved, brand: { name: 'Quartermaster', logo: { src: '/mark.svg' } }, tokens: tokensFor(resolved) } as never}
      />
    </div>
  );
}

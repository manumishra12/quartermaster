import { TrueForgeUI } from '@truefoundry/trueforge-ui';
import { QuartermasterLayout } from './layout/QuartermasterLayout';
import { theme } from './theme';

/**
 * Pinned to one agent on purpose. The agent library and composer are TrueForge's surfaces for
 * building agents; this is the surface for *using* one, so an agent picker would only be a way to
 * leave the product.
 *
 * The API is proxied through Vite (see vite.config.ts), so this runs same-origin at baseUrl '/'.
 */
const AGENT_NAME = import.meta.env.VITE_AGENT_NAME ?? 'quartermaster-local';

export default function App() {
  return (
    <div style={{ height: '100dvh' }}>
      <TrueForgeUI
        server={{ type: 'trueforge', baseUrl: '/' }}
        layout={QuartermasterLayout}
        agentConfig={{ mode: 'SingleAgent', name: AGENT_NAME }}
        theme={theme as never}
      />
    </div>
  );
}

import { useMemo } from 'react';
import { TrueForgeUI } from '@truefoundry/trueforge-ui';
import { QuartermasterLayout } from './layout/QuartermasterLayout';
import { ThemeContext } from './layout/ThemeContext';
import { Welcome } from './layout/Welcome';
import { Code } from './layout/Code';
import { ThreadList, ThreadRow } from './layout/ThreadRow';
import { AgentStepsCard, ReasoningCard } from './layout/Steps';
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

/**
 * Every one of these is defined once, at module scope, and that is load-bearing rather than tidy.
 *
 * They were object literals in the JSX, so each render produced new identities. The SDK feeds them
 * into a `useSyncExternalStore`, whose snapshot is then different on every read - which is exactly
 * what "Maximum update depth exceeded. The result of getSnapshot should be cached." means. In a
 * browser that killed the React tree and the page rendered blank, while the dev server answered
 * 200 and every test passed.
 *
 * The lesson is narrow and worth keeping: a prop handed to a store must have a stable identity,
 * and an inline literal never does.
 */
const SERVER = { type: 'trueforge', baseUrl: '/' } as const;
const AGENT_CONFIG = { mode: 'SingleAgent', name: AGENT_NAME } as const;
const OVERRIDES = {
  // The empty state is the first thing a stranger sees, so it says what this agent is for rather
  // than showing a generic greeting. The conversation rows carry three competing pieces of
  // information and the default gives them equal weight, which is what made the sidebar cluttered.
  WelcomeScreen: Welcome,
  ThreadListRow: ThreadRow,
  ThreadListShell: ThreadList,
  // The agent's working is secondary to the answer, and the defaults give it the larger share of
  // the screen: a one-line greeting arrived under eight lines of expanded reasoning. These collapse
  // it to a line with a preview and put the answer back on top.
  AgentStepsCard,
  ReasoningCard,
  // One case intercepted, everything else handed back to the SDK: a patch is rendered as a patch,
  // and every other language keeps whatever highlighting the SDK does and whatever it improves.
  SyntaxHighlighter: Code,
} as const;
const BRAND = { name: 'Quartermaster', logo: { src: '/mark.svg' } } as const;

export default function App() {
  const { mode, resolved, choose } = useTheme();

  // The SDK renders the transcript and composer, so it needs the same palette we do. One resolved
  // theme drives both; two sources of colour would drift within a release. Memoised on the only
  // thing that actually changes it.
  const theme = useMemo(
    () => ({ preset: 'trueforge', mode: resolved, brand: BRAND, tokens: tokensFor(resolved) }),
    [resolved],
  );

  const themeControl = useMemo(
    () => ({ mode, resolved, onThemeChange: choose, agentName: AGENT_NAME }),
    [mode, resolved, choose],
  );

  return (
    <ThemeContext.Provider value={themeControl}>
      <div className="h-dvh">
        <TrueForgeUI
          server={SERVER as never}
          layout={QuartermasterLayout}
          agentConfig={AGENT_CONFIG as never}
          theme={theme as never}
          overrides={OVERRIDES as never}
        />
      </div>
    </ThemeContext.Provider>
  );
}

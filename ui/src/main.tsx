import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * Deliberately not wrapped in StrictMode.
 *
 * StrictMode double-invokes effects to surface exactly the kind of bug it cannot survive here: the
 * SDK's resource scheduler (`@assistant-ui/tap`) re-enters its own commit and throws "Maximum
 * update depth exceeded. The result of getSnapshot should be cached." In a browser that kills the
 * React tree, so the page rendered blank - which is what "localhost will not open" turned out to
 * mean.
 *
 * Giving up StrictMode is a real cost and worth stating rather than deleting quietly. The
 * alternative was an interface that does not render at all.
 */
createRoot(document.getElementById('root')!).render(<App />);

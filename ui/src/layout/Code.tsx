import { SyntaxHighlighter } from '@truefoundry/trueforge-ui';
import { Diff, looksLikeDiff } from './Diff';

/**
 * The SDK's code block, except when the code is a patch.
 *
 * `SyntaxHighlighter` is a slot the SDK exposes, so this overrides one case and hands everything
 * else straight back to it. That matters more than the diff does: replacing the highlighter
 * outright would mean maintaining syntax colouring for every language the agents touch, and losing
 * whatever the SDK improves in it later.
 *
 * The detection is deliberately narrow - a hunk header, or a language the model itself labelled
 * `diff`. A file of vendor-prefixed CSS opens plenty of lines with `-`, and colouring half of it
 * red because of that would be worse than not rendering patches at all.
 */
export function Code(props: {
  code: string;
  language?: string;
  darkTheme?: boolean;
  className?: string;
  showLineNumbers?: boolean;
}) {
  if (looksLikeDiff(props.code, props.language)) {
    return <Diff code={props.code} className={props.className} />;
  }
  return <SyntaxHighlighter {...props} />;
}

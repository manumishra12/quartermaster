// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every mermaid block in the documentation, parsed by the same library that renders it.
 *
 * A diagram that does not parse renders on GitHub as a grey box containing its own source. It is
 * the one class of documentation error that is invisible to a writer - the markdown is fine, the
 * fence is fine, and nothing complains until somebody opens the page. Presentation is one of the
 * six judged criteria here, and the diagrams are most of it.
 *
 * jsdom rather than plain node, because mermaid's sanitiser needs a document and fails with
 * "DOMPurify.addHook is not a function" without one - which looks exactly like a syntax error and
 * is not.
 */
/**
 * `import.meta.url` is served by Vite and comes back with a `/@fs/` prefix, so resolving against it
 * scans a directory that does not exist. vitest runs with `ui/` as the working directory.
 */
const ROOT = join(process.cwd(), '..');

const blocksIn = (file: string) =>
  [...readFileSync(join(ROOT, file), 'utf8').matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

const docs = readdirSync(ROOT).filter((f) => f.endsWith('.md') && blocksIn(f).length > 0);

describe('the diagrams in the documentation', () => {
  it('is watching at least one document, so a passing run means something', () => {
    expect(docs.length).toBeGreaterThan(0);
  });

  for (const doc of docs) {
    for (const [i, block] of blocksIn(doc).entries()) {
      it(`${doc} block ${i + 1} parses`, async () => {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'sandbox' });
        await expect(mermaid.parse(block)).resolves.toBeTruthy();
      });
    }
  }
});

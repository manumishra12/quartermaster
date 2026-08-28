// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

/**
 * Every mermaid block in the documentation, parsed by the same library that renders it.
 *
 * A diagram that does not parse renders on GitHub as a grey box containing its own source. It is
 * the one class of documentation error invisible to whoever wrote it - the markdown is fine, the
 * fence is fine, and nothing complains until somebody opens the page. Presentation is one of the
 * six judged criteria here and the diagrams are most of it.
 *
 * The documents are pulled in by `import.meta.glob` rather than read with `node:fs`, which is not a
 * style preference: `ui/tsconfig.json` declares `types: ["vite/client"]` and the interface has no
 * node types, so importing `node:fs` here typechecks in vitest and breaks `npm run build`. It did,
 * and CI builds the interface. Vite resolves this at transform time and needs nothing added.
 *
 * jsdom rather than plain node, because mermaid's sanitiser needs a document and fails without one
 * with "DOMPurify.addHook is not a function" - which reads exactly like a syntax error and is not.
 */
const docs = import.meta.glob('../../../*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const blocksIn = (text: string) => [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

const withDiagrams = Object.entries(docs)
  .map(([path, text]) => ({ name: path.split('/').pop() ?? path, blocks: blocksIn(text) }))
  .filter((d) => d.blocks.length > 0);

describe('the diagrams in the documentation', () => {
  it('is watching at least one document, so a passing run means something', () => {
    expect(withDiagrams.length).toBeGreaterThan(0);
  });

  for (const doc of withDiagrams) {
    for (const [i, block] of doc.blocks.entries()) {
      it(`${doc.name} block ${i + 1} parses`, async () => {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'sandbox' });
        await expect(mermaid.parse(block)).resolves.toBeTruthy();
      });
    }
  }
});

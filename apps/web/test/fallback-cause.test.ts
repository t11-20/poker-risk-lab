/**
 * A fallback notice ends with the transport message, "(could not reach the API at http://localhost:3001:
 * …)", whose URL has no break opportunity: at 360px with 200% text it made /learn and the Legends profiles
 * scroll sideways (402px) whenever the API was down. So the message is its own span, which may break.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string): string => readFileSync(join(web, path), 'utf8');

function pagesUnder(dir: string): string[] {
  return readdirSync(join(web, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pagesUnder(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('a fallback notice lets its transport message break, and only that', () => {
  it('builds every reason as a sentence and a cause, never one string with the cause pasted on', () => {
    for (const loader of ['src/lib/learn-data.ts', 'src/lib/legends-data.ts']) {
      const source = read(loader);
      assert.doesNotMatch(source, /`\$\{[A-Z_]+\} \(/u, `${loader} pastes a cause onto a sentence`);
      assert.match(source, /fallbackReason: \{ text, cause \}/u, `${loader} builds no { text, cause }`);
    }
  });

  it('renders every reason through FallbackText', () => {
    const pages = pagesUnder('src/app');
    assert.ok(pages.length > 0, 'read no page under src/app');
    const raw = pages.filter((page) =>
      /(?<!=)\{[\w.]+\.(?:fallbackReason|unavailableReason)\}/u.test(read(page)),
    );
    assert.deepEqual(raw, [], 'these pages print a reason as a bare string');
    const uses = pages.reduce((n, page) => n + (read(page).match(/<FallbackText reason=/gu)?.length ?? 0), 0);
    assert.equal(uses, 8, 'every notice: the learn index, a lesson, the glossary, and five on Legends');
  });

  it('keeps the words "text (cause)" and puts the cause in the span that may break', () => {
    const component = read('src/components/FallbackText.tsx');
    assert.match(
      component,
      /\{reason\.text\} <span className="prl-fallback-cause">\(\{reason\.cause\}\)<\/span>/u,
    );
    const css = read('src/app/globals.css');
    const rule = /\.prl-fallback-cause \{([^}]*)\}/u.exec(css)?.[1] ?? '';
    assert.match(rule, /overflow-wrap: anywhere;/u, 'no rule lets the cause break');
  });
});

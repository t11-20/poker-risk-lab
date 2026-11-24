/**
 * A section page's suit mark sits in an eyebrow with the section's name. A bare mark is a letter
 * floating above the title, which is what `/legends` shipped. Pages are held to source: they import
 * CSS and cannot render under `node --test`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const APP = join(SRC, 'app');

/** The five sections. Home and the 404 use the mark as a destination glyph, not a page eyebrow. */
const AREAS = ['learn', 'lab', 'play', 'legends', 'review'] as const;

const LABEL: Readonly<Record<(typeof AREAS)[number], string>> = {
  learn: 'Learn',
  lab: 'Lab',
  play: 'Play',
  legends: 'Legends',
  review: 'Review',
};

/** Pages that already carry the mark, so a walk that missed `app/legends` cannot pass over nothing. */
const EXPECTED = [
  'learn/page.tsx',
  'lab/page.tsx',
  'play/page.tsx',
  'review/page.tsx',
  'legends/page.tsx',
  'legends/compare/page.tsx',
  'legends/hand-review/page.tsx',
] as const;

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (name === 'page.tsx') found.push(path);
  }
  return found;
}

/** Comments removed, so a note about a bare mark cannot satisfy or trip the check. */
function code(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

function sectionPages(): readonly string[] {
  return walk(APP).filter((path) => {
    const top = relative(APP, path).split(sep)[0];
    return AREAS.includes(top as (typeof AREAS)[number]);
  });
}

describe('a section mark sits in an eyebrow with the section’s name', () => {
  const pages = sectionPages();
  const marked = pages.filter((path) => code(readFileSync(path, 'utf8')).includes('<SuitMark'));

  it('reads the section pages, including every page that already shows a mark', () => {
    assert.ok(pages.length >= EXPECTED.length, `walked ${pages.length} section pages`);
    assert.ok(marked.length >= EXPECTED.length, `only ${marked.length} pages show a SuitMark`);
    for (const expected of EXPECTED) {
      assert.ok(
        marked.some((path) => relative(APP, path) === expected),
        `did not read ${expected}, so a bare mark there would pass`,
      );
    }
  });

  it('wraps every SuitMark in an eyebrow that also carries a word (REGRESSION)', () => {
    assert.ok(marked.length > 0, 'no section page shows a SuitMark, so this check read nothing');
    const eyebrowOpen = /<([A-Za-z][\w.-]*)\b[^>]*className="[^"]*eyebrow[^"]*"[^>]*>\s*$/u;

    for (const path of marked) {
      const source = code(readFileSync(path, 'utf8'));
      const marks = [...source.matchAll(/<SuitMark\b[^>]*\/>/gu)];
      assert.ok(marks.length > 0, `${relative(APP, path)} matched <SuitMark and then had none`);

      for (const mark of marks) {
        const at = mark.index ?? 0;
        const open = eyebrowOpen.exec(source.slice(0, at));
        assert.ok(
          open !== null,
          `${relative(APP, path)} renders a SuitMark outside an eyebrow:\n${source.slice(Math.max(0, at - 120), at + mark[0].length)}`,
        );
        const tag = open[1] ?? '';
        const closeAt = source.indexOf(`</${tag}>`, at);
        assert.ok(closeAt > at, `${relative(APP, path)} eyebrow <${tag}> never closes`);
        const inner = source.slice(at + mark[0].length, closeAt).replace(/<[^>]+>/gu, ' ');
        const words: readonly string[] = inner.match(/[A-Za-z]{2,}/gu) ?? [];
        assert.ok(words.length > 0, `${relative(APP, path)} eyebrow has no word beside the mark`);

        const area = /area="([^"]+)"/u.exec(mark[0])?.[1];
        if (area !== undefined && area in LABEL) {
          assert.ok(
            words.includes(LABEL[area as (typeof AREAS)[number]]),
            `${relative(APP, path)} eyebrow says "${words.join(' ')}", not "${LABEL[area as (typeof AREAS)[number]]}"`,
          );
        }
      }
    }
  });

  it('puts that eyebrow above the title, and the wide head keeps it in the title’s column', () => {
    const heads = marked.filter((path) => code(readFileSync(path, 'utf8')).includes('prl-legend-head'));
    assert.ok(heads.length >= 3, `only ${heads.length} legend heads show a mark`);

    for (const path of heads) {
      const source = code(readFileSync(path, 'utf8'));
      const headAt = source.indexOf('<div className="prl-legend-head">');
      const titleAt = source.indexOf('<h1', headAt);
      const eyebrowAt = source.indexOf('className="prl-eyebrow"', headAt);
      assert.ok(headAt >= 0 && titleAt > headAt, `${relative(APP, path)} head has no h1`);
      assert.ok(
        eyebrowAt > headAt && eyebrowAt < titleAt,
        `${relative(APP, path)} eyebrow is not above the title`,
      );
    }

    const css = readFileSync(join(SRC, 'styles', 'legends.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    assert.ok(css.length > 0, 'legends.css was empty');
    // A stretched grid item centres the glyph. The eyebrow has to shrink to the name instead.
    assert.match(css, /\.prl-legend-head > \.prl-eyebrow \{[^}]*justify-self: start;/u);
    assert.doesNotMatch(css, /\.prl-legend-head > \.prl-suit-mark/u);
    // From 900px the standfirst takes column two. Everything else, including the eyebrow, stays in one.
    assert.match(
      css,
      /\.prl-legend-head:has\(> \.prl-legend-head__standfirst\) > :not\(\.prl-legend-head__standfirst\) \{\s*grid-column: 1;/u,
    );
  });
});

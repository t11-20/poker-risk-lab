/**
 * On `/legends`, the Play links start the match at the difficulty the reader TICKED, not the applied
 * one. The links are client components (`LegendDifficultyScope.tsx`) that follow the radio; the wiring
 * is read from source because `node --test` cannot render TSX. Nothing may navigate on `change`
 * (WCAG 3.2.2), which is why `DifficultyPicker` refuses to auto-submit.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareHref, MATCH_DIFFICULTY_PARAM, profileHref } from '../src/lib/legend-links.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/** Source with comments removed, so a sentence ABOUT a call cannot satisfy or trip a check. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/u.test(path))
    .map((path) => join(directory, path));
}

/** The query key an expression names: a string literal, a constant declared in the file, or the shared one. */
function keyAt(source: string, at: RegExp): string {
  const expression = at.exec(code(source))?.[1];
  assert.ok(expression !== undefined, `nothing matches ${at}`);
  const literal = /^'([^']+)'$/u.exec(expression)?.[1];
  if (literal !== undefined) return literal;
  const local = new RegExp(`const ${expression} = '([^']+)'`, 'u').exec(source)?.[1];
  if (local !== undefined) return local;
  assert.equal(expression, 'MATCH_DIFFICULTY_PARAM', `${expression} is neither a literal nor a constant`);
  return MATCH_DIFFICULTY_PARAM;
}

describe('the Play links follow the ticked difficulty', () => {
  it('the card renders the following links, not a link fixed to the applied setting', () => {
    const card = code(read('components', 'LegendCard.tsx'));
    assert.match(card, /<LegendPlayLink\b/u);
    assert.match(card, /<LegendProfileLink\b/u);
    assert.doesNotMatch(card, /legendMatchHref\(/u, 'a server-built Play href cannot follow the radio');
  });

  it('the selector page puts the picker and every card inside one scope', () => {
    const page = code(read('app', 'legends', 'page.tsx'));
    const open = page.indexOf('<LegendDifficultyScope>');
    const close = page.indexOf('</LegendDifficultyScope>');
    assert.ok(open >= 0 && close > open, 'no LegendDifficultyScope on /legends');
    const picker = page.indexOf('<DifficultyPicker');
    const cards = page.indexOf('<LegendCard');
    assert.ok(picker > open && picker < close, 'the picker is outside the scope, so nothing hears it');
    assert.ok(cards > open && cards < close, 'the cards are outside the scope, so their links cannot follow');
  });

  it('the scope listens to the same radio group the picker writes', () => {
    const scope = read('components', 'LegendDifficultyScope.tsx');
    const picker = read('components', 'DifficultyPicker.tsx');
    const written = keyAt(picker, /name=\{(\w+)\}\s+type="radio"/u);
    assert.equal(keyAt(scope, /\[name="\$\{(\w+)\}"\]:checked/u), written);
    assert.equal(keyAt(scope, /target\.name !== (\w+)/u), written);
    assert.match(scope, /^'use client';/u);
    assert.match(code(scope), /onChange=\{onChange\}/u);
  });

  it('every Legends page reads the key the picker writes and the links build', () => {
    const written = keyAt(read('components', 'DifficultyPicker.tsx'), /name=\{(\w+)\}\s+type="radio"/u);
    assert.equal(written, MATCH_DIFFICULTY_PARAM);
    for (const page of [
      ['legends', 'page.tsx'],
      ['legends', 'compare', 'page.tsx'],
      ['legends', '[profileId]', 'page.tsx'],
    ] as const) {
      assert.equal(
        keyAt(read('app', ...page), /parseDifficulty\(\w+\[([^\]]+)\]\)/u),
        written,
        page.join('/'),
      );
    }
    assert.ok(profileHref('p', 'expert').endsWith(`?${written}=expert`));
    assert.ok(compareHref(['p', 'q'], 'expert').endsWith(`&${written}=expert`));
  });

  it('the key is spelled once, in `legend-links.ts`', () => {
    // The Lab's own `difficulty` filter is a different parameter that happens to share the word.
    const files = sourceFiles(SRC).filter((file) => !relative(SRC, file).startsWith(join('app', 'lab')));
    assert.ok(files.length > 100, `read only ${files.length} source files`);
    const spelled = files.filter((file) =>
      /'difficulty'|[?&]difficulty=/u.test(code(readFileSync(file, 'utf8'))),
    );
    assert.deepEqual(
      spelled.map((file) => relative(SRC, file)),
      [join('lib', 'legend-links.ts')],
    );
  });

  it('following the radio never navigates or submits on change (WCAG 3.2.2)', () => {
    const scope = code(read('components', 'LegendDifficultyScope.tsx'));
    const picker = code(read('components', 'DifficultyPicker.tsx'));
    for (const [name, source] of [
      ['LegendDifficultyScope.tsx', scope],
      ['DifficultyPicker.tsx', picker],
    ] as const) {
      assert.doesNotMatch(
        source,
        /requestSubmit|\.submit\(|router\.push|location\.(assign|href\s*=)|useRouter/u,
        name,
      );
    }
    assert.doesNotMatch(picker, /onChange/u, 'the picker itself must still not act on change');
  });
});

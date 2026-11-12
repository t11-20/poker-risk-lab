/**
 * On `/legends`, the Play links start the match at the difficulty the reader TICKED.
 *
 * ## The defect
 *
 * Measured on the running build at 360px: tapping "Expert" in the picker checked the radio and gave
 * the option its accent border, and every one of the twelve "Play this style" links still pointed
 * at `difficulty=educational`. Only "Apply setting" — at y=1790, below the third option — changed
 * them, so a reader who picked Expert and pressed Play was dealt an Educational match with the
 * Coach they had chosen to give up still beside it.
 *
 * The links are client components now (`LegendDifficultyScope.tsx`) that follow the ticked radio.
 * These files are TSX and `node --test` cannot render them, so what is asserted is the wiring that
 * makes it true, read off the source: which component the card renders, what the page wraps, and
 * that following the radio stayed a follow — nothing here may navigate on `change`, which is the
 * WCAG 3.2.2 reason `DifficultyPicker` refuses to auto-submit and which still holds.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/** Source with comments removed, so a sentence ABOUT a call cannot satisfy or trip a check. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
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
    const written = /export const DIFFICULTY_PARAM = '([^']+)'/u.exec(picker)?.[1];
    const heard = /const DIFFICULTY_NAME = '([^']+)'/u.exec(scope)?.[1];
    assert.ok(written !== undefined && heard !== undefined);
    assert.equal(heard, written);
    assert.match(scope, /^'use client';/u);
    assert.match(code(scope), /onChange=\{onChange\}/u);
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

/**
 * The deck's forms and the keys in each. The stylesheet decides the form by the picker's width and
 * says which in `--prl-picker-cols`; the component maps that count to a flow. Every form keeps 44px
 * targets, so the thresholds are checked against the token arithmetic rather than a remembered number.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DECK_RANKS, DECK_SUITS, deckFlowFor } from '../src/card-picker.ts';

const css = readFileSync(new URL('../src/styles/card-picker.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//gu,
  '',
);
const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

function token(name: string): number {
  const match = new RegExp(`--${name}: ([\\d.]+)(px|rem);`, 'u').exec(tokens);
  assert.ok(match !== null, `no --${name} in tokens.css`);
  return Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
}

describe('the stylesheet names the form the keys follow', () => {
  const forms = [...css.matchAll(/--prl-picker-cols: (\d+);/gu)].map((match) => Number(match[1]));

  it('sets each column count once, and each maps to its own flow', () => {
    assert.deepEqual(forms, [DECK_SUITS, DECK_RANKS]);
    assert.deepEqual(forms.map(deckFlowFor), ['columns', 'rows']);
  });

  it('builds every form’s tracks from that count, so the keys and the drawing cannot disagree', () => {
    const tracks = [...css.matchAll(/grid-template-columns: repeat\(([^,]+),/gu)].map((match) => match[1]);
    assert.ok(tracks.length >= 2, 'fewer than two deck track rules');
    for (const count of tracks.slice(-2)) assert.equal(count, 'var(--prl-picker-cols)');
  });
});

describe('every form keeps 44px targets', () => {
  const target = token('prl-target-min');

  function threshold(columns: number): number {
    const block = new RegExp(
      `@container prl-picker \\(min-width: (\\d+)px\\) \\{\\s*\\.prl-picker__deck \\{\\s*--prl-picker-cols: ${columns};`,
      'u',
    ).exec(css);
    assert.ok(block !== null, `no px container query sets ${columns} columns`);
    return Number(block[1]);
  }

  it('thirteen across starts where thirteen 44px cells fit with no gap', () => {
    assert.equal(target, 44);
    assert.equal(threshold(DECK_RANKS), DECK_RANKS * target);
  });
});

/**
 * The deck's three forms and the keys in each. The stylesheet decides the form by the picker's width and
 * says which in `--prl-picker-cols`; the component maps that count to a flow. Every form keeps 44px
 * targets, so the thresholds are checked against the token arithmetic rather than a remembered number.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  DECK_FOLD,
  DECK_RANKS,
  DECK_SUITS,
  deckFlowFor,
  deckFlowOf,
  moveInDeck,
  PICKER_COLUMNS_PROPERTY,
} from '../src/card-picker.ts';

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

/** Where a folded card is drawn: line 0 to 7, column 0 to 6. */
function drawn(index: number): { line: number; column: number } {
  const rank = index % DECK_RANKS;
  return { line: Math.floor(index / DECK_RANKS) * 2 + Math.floor(rank / 7), column: rank % 7 };
}

const ARROWS = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'] as const;

describe('keys in the folded deck follow what is drawn', () => {
  it('a suit folds into a line of seven and a line of six', () => {
    assert.equal(DECK_FOLD, 7);
    assert.deepEqual(drawn(6), { line: 0, column: 6 });
    assert.deepEqual(drawn(7), { line: 1, column: 0 });
  });

  it('right and left stay on the line; down from a first line goes to the line under it', () => {
    assert.equal(moveInDeck(0, 'ArrowRight', 'folded'), 1);
    assert.equal(moveInDeck(6, 'ArrowRight', 'folded'), 6, 'the end of a line is an edge');
    assert.equal(moveInDeck(7, 'ArrowLeft', 'folded'), 7, 'the start of a line is an edge');
    assert.equal(moveInDeck(0, 'ArrowDown', 'folded'), 7, 'under the ace of spades is the seven');
    assert.equal(moveInDeck(7, 'ArrowDown', 'folded'), 13, 'under the seven of spades is the ace of hearts');
  });

  it('the hole under a seventh card is skipped to the next suit, and up undoes it', () => {
    assert.equal(moveInDeck(6, 'ArrowDown', 'folded'), 19);
    assert.equal(moveInDeck(19, 'ArrowUp', 'folded'), 6);
    assert.equal(moveInDeck(45, 'ArrowDown', 'folded'), 45, 'the last suit has nothing under its hole');
  });

  it('every arrow from every card lands where the drawn grid says, or stays at an edge', () => {
    const cellAt = new Map<string, number>();
    for (let index = 0; index < DECK_RANKS * DECK_SUITS; index++) {
      const { line, column } = drawn(index);
      cellAt.set(`${line},${column}`, index);
    }
    const card = (line: number, column: number): number | undefined => cellAt.get(`${line},${column}`);
    for (let index = 0; index < DECK_RANKS * DECK_SUITS; index++) {
      const { line, column } = drawn(index);
      // Only a second line has a hole, under the seventh card, so only there does a move skip a line.
      const vertical = (step: number): number =>
        card(line + step, column) ??
        (column === DECK_FOLD - 1 ? card(line + 2 * step, column) : undefined) ??
        index;
      const expected: Readonly<Record<(typeof ARROWS)[number], number>> = {
        ArrowRight: card(line, column + 1) ?? index,
        ArrowLeft: card(line, column - 1) ?? index,
        ArrowDown: vertical(1),
        ArrowUp: vertical(-1),
      };
      for (const key of ARROWS) {
        assert.equal(moveInDeck(index, key, 'folded'), expected[key], `${key} from ${index}`);
      }
    }
  });

  it('the component reads the same custom property the stylesheet sets', () => {
    const style = (value: string) => ({
      getPropertyValue: (name: string) => (name === PICKER_COLUMNS_PROPERTY ? value : ''),
    });
    assert.equal(deckFlowOf(style(' 7')), 'folded');
    assert.equal(deckFlowOf(style('13')), 'rows');
    assert.equal(deckFlowOf(style(' 4')), 'columns');
    assert.equal(deckFlowOf(style('')), 'rows');
    assert.match(css, new RegExp(`${PICKER_COLUMNS_PROPERTY}:\\s*7;`, 'u'), 'the stylesheet never sets 7');
    const picker = readFileSync(new URL('../src/components/CardPicker.tsx', import.meta.url), 'utf8');
    assert.match(picker, /deckFlowOf\(window\.getComputedStyle\(deck\)\)/u, 'the keys do not read the deck');
  });

  it('up undoes down, and left undoes right, wherever the first move went somewhere', () => {
    for (let index = 0; index < 52; index++) {
      for (const [go, back] of [
        ['ArrowDown', 'ArrowUp'],
        ['ArrowRight', 'ArrowLeft'],
      ] as const) {
        const next = moveInDeck(index, go, 'folded');
        if (next !== null && next !== index)
          assert.equal(moveInDeck(next, back, 'folded'), index, `${go} ${index}`);
      }
    }
  });

  it('Home and End go to the ends of the suit, as in the other forms', () => {
    assert.equal(moveInDeck(20, 'Home', 'folded'), 13);
    assert.equal(moveInDeck(20, 'End', 'folded'), 25);
    assert.equal(moveInDeck(5, 'a', 'folded'), null);
  });
});

describe('the stylesheet names the form the keys follow', () => {
  const forms = [...css.matchAll(/--prl-picker-cols: (\d+);/gu)].map((match) => Number(match[1]));

  it('sets each of the three column counts once, and each maps to its own flow', () => {
    assert.deepEqual(forms, [DECK_SUITS, DECK_FOLD, DECK_RANKS]);
    assert.deepEqual(forms.map(deckFlowFor), ['columns', 'folded', 'rows']);
  });

  it('builds every form’s tracks from that count, so the keys and the drawing cannot disagree', () => {
    const tracks = [...css.matchAll(/grid-template-columns: repeat\(([^,]+),/gu)].map((match) => match[1]);
    assert.ok(tracks.length >= 3, 'fewer than three deck track rules');
    for (const count of tracks.slice(-3)) assert.equal(count, 'var(--prl-picker-cols)');
  });
});

describe('every form keeps 44px targets', () => {
  const target = token('prl-target-min');
  const gap = token('prl-space-1');
  /* The face, the button's padding on both sides, and its 1px border on both sides. */
  const cell = token('prl-space-10') + 2 * gap + 2;

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

  it('the folded deck starts where seven whole cards and their gaps fit', () => {
    assert.ok(cell >= target, `a hugging cell is ${cell}px`);
    assert.equal(threshold(DECK_FOLD), DECK_FOLD * cell + (DECK_FOLD - 1) * gap);
  });

  it('spaces the folded suits only below thirteen across, where no reset could outrank the selector', () => {
    const spaced = [...css.matchAll(/@container prl-picker \(([^)]*)\) \{[^@]*margin-block-start/gu)];
    assert.equal(spaced.length, 1, 'expected one container query that spaces the suits');
    assert.equal(spaced[0]?.[1], `${threshold(DECK_FOLD)}px <= width < ${threshold(DECK_RANKS)}px`);
  });

  it('the folded deck hugs its cards, and keeps 44px cells inside the panel at any root font size', () => {
    assert.match(
      css,
      /grid-template-columns: repeat\(var\(--prl-picker-cols\), minmax\(var\(--prl-target-min\), max-content\)\);/u,
    );
    const capped =
      /@container prl-picker \(min-width: \d+px\) \{[^@]*?--prl-picker-cols: 7;[^@]*?\.prl-picker__card \.prl-card \{\s*--prl-card-w: min\(\s*var\(--prl-space-10\),\s*calc\(\(100cqi - 6 \* var\(--prl-space-1\)\) \/ 7/u;
    assert.match(css, capped, 'the folded face is not capped by the picker width');
  });
});

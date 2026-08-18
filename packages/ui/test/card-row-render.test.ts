/**
 * `CardRow`, actually rendered, read the way a screen reader reads it.
 *
 * ## Why this exists
 *
 * Card accessibility is the best-built thing in this package and the audit said so: a live
 * server-dealt hand produced the accessible names `"five of clubs"`, `"eight of hearts"` and
 * `"face-down card"`, grouped by `<figure>` + a visually hidden `<figcaption>`, with the suit
 * carried by symbol, letter *and* colour so no one of the three is load-bearing (A11Y-014,
 * PASS). That is a thing to keep, and until now nothing in this package's tests would have
 * noticed it going.
 *
 * The one gap the audit found was structural rather than broken: the `/review` board is laid
 * out as loose `PlayingCard`s inside a plain `<span>`, so those cards — alone on the site —
 * have no group label. The reason was an API gap, not an oversight: `CardRow` took engine
 * integers and a stored hand carries notation (`"Kh"`), so the page had no row to use. It
 * takes both now, and these tests are what say so.
 *
 * ## The expectations are hand-derived
 *
 * `describeCard` is not called here. The encoding is documented — `card = rank * 4 + suit`,
 * ranks `2..A` from zero, suits `club, diamond, heart, spade` — so `12` is the five of clubs
 * and `26` the eight of hearts, written out. Asserting against what the producer computes
 * would only prove it agrees with itself; these are the two names the audit read off a real
 * dealt hand in a real browser, which is a fact about the world rather than about this repo.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadComponent } from './support/render-component.ts';

interface CardRowProps {
  readonly cards: readonly (number | string)[];
  readonly label: string;
  readonly showLabel?: boolean;
  readonly faceDown?: boolean;
  readonly highlightedCards?: readonly number[];
  readonly highlightLabel?: string;
  readonly emptyText?: string;
}

async function render(props: CardRowProps): Promise<string> {
  const CardRow = await loadComponent<CardRowProps>('components/CardRow', 'CardRow');
  return renderToStaticMarkup(createElement(CardRow, props));
}

/** Every `aria-label` in the markup, in document order — what a screen reader would say. */
function accessibleNames(markup: string): readonly string[] {
  return [...markup.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1] ?? '');
}

/** The five of clubs and the eight of hearts: rank * 4 + suit, ranks from 2, suits from clubs. */
const FIVE_OF_CLUBS = 3 * 4 + 0;
const EIGHT_OF_HEARTS = 6 * 4 + 2;

test('a row of engine integers announces every card by rank and suit, inside a named group', async () => {
  const markup = await render({ cards: [FIVE_OF_CLUBS, EIGHT_OF_HEARTS], label: 'Your cards' });

  assert.deepEqual(accessibleNames(markup), ['five of clubs', 'eight of hearts']);
  // `<figure>` + `<figcaption>`, not `role="group"` + `aria-label`: the label is real visible
  // text that takes the figure's accessible name with it, and needs no ARIA to do it.
  assert.ok(markup.startsWith('<figure'), 'the row has to be a figure for the caption to name it');
  assert.ok(markup.includes('<figcaption'), 'and the caption is what supplies the group name');
  assert.ok(markup.includes('Your cards'), 'which has to be the label the caller asked for');
});

test('a row of notation announces the same names, so a stored hand is not second class', async () => {
  // The `/review` board holds `["5c", "8h"]`, not integers. Before this row accepted notation
  // the page had to lay the cards out itself, and lost its group label doing it.
  const markup = await render({ cards: ['5c', '8h'], label: 'Community cards' });

  assert.deepEqual(accessibleNames(markup), ['five of clubs', 'eight of hearts']);
  assert.ok(markup.includes('Community cards'));
});

test('a mixed row, and a highlight that finds a card given as notation', async () => {
  // The highlight set stays a set of integers whichever form the row was given, so a caller
  // never has to know which one it happens to be holding.
  const markup = await render({
    cards: [FIVE_OF_CLUBS, '8h'],
    label: 'Board',
    highlightedCards: [EIGHT_OF_HEARTS],
    highlightLabel: 'part of the winning hand',
  });

  assert.deepEqual(accessibleNames(markup), [
    'five of clubs',
    // The phrase is appended to the NAME, because a border and a corner notch are cues only a
    // sighted reader gets. "part of the winning hand" is information; "highlighted" is not.
    'eight of hearts, part of the winning hand',
  ]);
});

test('notation that does not parse renders as text rather than disappearing', async () => {
  // Silence is the wrong failure here. A board that quietly shows two cards instead of three
  // reads as a two-card board, and the reader has no way to know a card went missing.
  const markup = await render({ cards: ['5c', 'not-a-card'], label: 'Board' });

  assert.ok(markup.includes('not-a-card'), 'the unreadable entry has to still be on the page');
  assert.deepEqual(accessibleNames(markup), ['five of clubs'], 'and it must not claim to be a card');
});

test('hiding the label hides its pixels, never its accessible name', async () => {
  const markup = await render({ cards: ['5c'], label: 'Community cards', showLabel: false });

  assert.ok(markup.includes('<figcaption'), 'the caption stays in the DOM');
  assert.ok(markup.includes('Community cards'), 'and still carries the text');
  assert.ok(markup.includes('prl-visually-hidden'), 'only its pixels go');
});

test('a face-down row leaks nothing at all', async () => {
  // The hidden-information boundary, at the last place it could be lost. The server already
  // redacts, so this is belt and braces — but a component that rendered `data-card="12"` on a
  // face-down card would quietly undo all of it.
  const markup = await render({ cards: [FIVE_OF_CLUBS, '8h'], label: 'Their cards', faceDown: true });

  assert.deepEqual(accessibleNames(markup), ['face-down card', 'face-down card']);
  assert.ok(!markup.includes('five'), 'no rank word may survive');
  assert.ok(!markup.includes('data-suit'), 'and no suit attribute either');
  assert.ok(!markup.includes('8h'), 'nor the notation it was given');
});

test('a face-down row does not fall through to the text chip, however unreadable the entry', async () => {
  // The chip prints its entry verbatim, which is right for a face-UP row where a card the app
  // cannot read is better shown than dropped — and exactly wrong for a face-down one, where
  // printing the entry prints the one thing the card exists to hide.
  const markup = await render({ cards: ['whatever-this-is'], label: 'Their cards', faceDown: true });

  assert.deepEqual(accessibleNames(markup), ['face-down card']);
  assert.ok(!markup.includes('whatever-this-is'), 'an unreadable entry must not leak out of a back');
});

test('an empty row says it is empty instead of rendering a bare label', async () => {
  const markup = await render({ cards: [], label: 'Community cards', emptyText: 'none dealt yet' });

  assert.ok(markup.includes('none dealt yet'));
  assert.deepEqual(accessibleNames(markup), []);
});

/**
 * `CardRow`, rendered, read the way a screen reader reads it (A11Y-014).
 * It takes engine integers and notation (`"Kh"`), so the `/review` board gets a group label too.
 * Expected names are hand-derived, not from `describeCard`, which would only agree with itself.
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

/** Every `aria-label` in the markup, in document order. */
function accessibleNames(markup: string): readonly string[] {
  return [...markup.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1] ?? '');
}

/** The five of clubs and the eight of hearts: rank * 4 + suit, ranks from 2, suits from clubs. */
const FIVE_OF_CLUBS = 3 * 4 + 0;
const EIGHT_OF_HEARTS = 6 * 4 + 2;

test('a row of engine integers announces every card by rank and suit, inside a named group', async () => {
  const markup = await render({ cards: [FIVE_OF_CLUBS, EIGHT_OF_HEARTS], label: 'Your cards' });

  assert.deepEqual(accessibleNames(markup), ['five of clubs', 'eight of hearts']);
  // `<figure>` + `<figcaption>`, not `role="group"` + `aria-label`, so the name is visible text.
  assert.ok(markup.startsWith('<figure'), 'the row has to be a figure for the caption to name it');
  assert.ok(markup.includes('<figcaption'), 'and the caption is what supplies the group name');
  assert.ok(markup.includes('Your cards'), 'which has to be the label the caller asked for');
});

test('a row of notation announces the same names, so a stored hand is not second class', async () => {
  const markup = await render({ cards: ['5c', '8h'], label: 'Community cards' });

  assert.deepEqual(accessibleNames(markup), ['five of clubs', 'eight of hearts']);
  assert.ok(markup.includes('Community cards'));
});

test('a mixed row, and a highlight that finds a card given as notation', async () => {
  const markup = await render({
    cards: [FIVE_OF_CLUBS, '8h'],
    label: 'Board',
    highlightedCards: [EIGHT_OF_HEARTS],
    highlightLabel: 'part of the winning hand',
  });

  assert.deepEqual(accessibleNames(markup), [
    'five of clubs',
    // Appended to the name, because a border and a corner notch are cues only a sighted reader gets.
    'eight of hearts, part of the winning hand',
  ]);
});

test('notation that does not parse renders as text rather than disappearing', async () => {
  // A board that quietly drops a card reads as a shorter board.
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
  // The server already redacts. This guards the last place hidden information could leak.
  const markup = await render({ cards: [FIVE_OF_CLUBS, '8h'], label: 'Their cards', faceDown: true });

  assert.deepEqual(accessibleNames(markup), ['face-down card', 'face-down card']);
  assert.ok(!markup.includes('five'), 'no rank word may survive');
  assert.ok(!markup.includes('data-suit'), 'and no suit attribute either');
  assert.ok(!markup.includes('8h'), 'nor the notation it was given');
});

test('a face-down row does not fall through to the text chip, however unreadable the entry', async () => {
  // The text chip prints its entry verbatim, which on a face-down row prints what the card hides.
  const markup = await render({ cards: ['whatever-this-is'], label: 'Their cards', faceDown: true });

  assert.deepEqual(accessibleNames(markup), ['face-down card']);
  assert.ok(!markup.includes('whatever-this-is'), 'an unreadable entry must not leak out of a back');
});

test('an empty row says it is empty instead of rendering a bare label', async () => {
  const markup = await render({ cards: [], label: 'Community cards', emptyText: 'none dealt yet' });

  assert.ok(markup.includes('none dealt yet'));
  assert.deepEqual(accessibleNames(markup), []);
});

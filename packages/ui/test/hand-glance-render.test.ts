/**
 * `HandGlance`, and the slot in `ActionBar` that draws it between the price and the sizer.
 *
 * ## The defect
 *
 * On a phone, a decision with a raise legal scrolls the page to the sizer, and that took the reader's
 * own plate and the board off the top: at 390x844 on the live table, plate at -174..46 and board at
 * -303..-203 under a 77px header, while the reader sized a bet. Nothing in the band said what they
 * held or what the board was.
 *
 * ## What is checked
 *
 * Rendered for real, through `loadComponent`: the glance is ONE named image whose name is the hand
 * and the board as a sentence, with the seven card images inside it hidden — not two figures and
 * seven names for a reader to step through on the way to the sizer — and the bar draws it after the
 * price strip and before the sizer, which is the placement `apps/web/src/lib/follow-the-table.ts`
 * does its arithmetic for. The negative control is the bar without the slot: its markup carries no
 * glance at all, which is what the old `ActionBar.tsx`, copied back, rendered.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { handAndBoardName } from '../src/cards.ts';
import type { LegalAction, TableAction } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

interface HandGlanceProps {
  readonly hole: readonly number[];
  readonly board: readonly number[];
}

interface ActionBarProps {
  readonly legalActions: readonly LegalAction[];
  readonly onAct: (action: TableAction) => void;
  readonly pot: number;
  readonly toCall: number;
  readonly committedThisStreet: number;
  readonly context?: ReactNode;
}

// Engine integers: rank * 4 + suit, suits in `c d h s` order.
const ACE_OF_SPADES = 12 * 4 + 3;
const KING_OF_DIAMONDS = 11 * 4 + 1;
const QUEEN_OF_HEARTS = 10 * 4 + 2;
const JACK_OF_SPADES = 9 * 4 + 3;
const TWO_OF_CLUBS = 0;
const HOLE = [ACE_OF_SPADES, KING_OF_DIAMONDS];
const FLOP = [QUEEN_OF_HEARTS, JACK_OF_SPADES, TWO_OF_CLUBS];

async function glance(board: readonly number[]): Promise<string> {
  const HandGlance = await loadComponent<HandGlanceProps>('components/HandGlance', 'HandGlance');
  return renderToStaticMarkup(createElement(HandGlance, { hole: HOLE, board }));
}

const FACING_A_BET: readonly LegalAction[] = [
  { type: 'fold' },
  { type: 'call', minTo: 100, costAtMin: 100 },
  { type: 'raise', minTo: 200, maxTo: 840, note: 'The minimum raise is twice the current bet.' },
];

async function bar(withGlance: boolean): Promise<string> {
  const ActionBar = await loadComponent<ActionBarProps>('components/ActionBar', 'ActionBar');
  const HandGlance = await loadComponent<HandGlanceProps>('components/HandGlance', 'HandGlance');
  return renderToStaticMarkup(
    createElement(ActionBar, {
      legalActions: FACING_A_BET,
      onAct: () => undefined,
      pot: 300,
      toCall: 100,
      committedThisStreet: 0,
      ...(withGlance ? { context: createElement(HandGlance, { hole: HOLE, board: FLOP }) } : {}),
    }),
  );
}

describe('the glance’s one name', () => {
  it('says the hand, then the board, as a sentence', () => {
    assert.equal(
      handAndBoardName(HOLE, FLOP),
      'Your cards: ace of spades and king of diamonds. Board: queen of hearts, jack of spades and two of clubs.',
    );
  });

  it('says an empty board in the table’s words rather than "no cards"', () => {
    assert.equal(
      handAndBoardName(HOLE, []),
      'Your cards: ace of spades and king of diamonds. Board: none dealt yet.',
    );
  });
});

describe('HandGlance, rendered', () => {
  it('is one named image, with the cards inside it hidden', async () => {
    const markup = await glance(FLOP);
    assert.equal(markup.match(/role="img"/gu)?.length, 6, 'the glance and its five cards, and no more');
    assert.ok(
      markup.startsWith(
        `<span class="prl-hand-glance" role="img" aria-label="${handAndBoardName(HOLE, FLOP)}">`,
      ),
      `the glance is not the named image: ${markup.slice(0, 160)}`,
    );
    // Every card image sits inside an `aria-hidden` group, so the tree holds one image, not six.
    const groups = markup.match(/<span class="prl-hand-glance__cards[^"]*" aria-hidden="true">/gu) ?? [];
    assert.equal(groups.length, 2, 'the hand and the board are each hidden behind the one name');
    assert.ok(!markup.includes('<figure'), 'a figure and a caption per group is the shape this replaces');
    assert.ok(!/aria-live|role="status"/u.test(markup), 'not a live region: the narration already said it');
  });

  it('draws the two cards and the board at the size the seat plates use', async () => {
    const markup = await glance(FLOP);
    assert.equal(markup.match(/class="prl-card prl-card--sm"/gu)?.length, 5);
  });

  it('draws no board group before the flop', async () => {
    const markup = await glance([]);
    assert.ok(
      !markup.includes('prl-hand-glance__board'),
      'an empty board group draws a hairline beside nothing',
    );
    assert.equal(markup.match(/class="prl-card prl-card--sm"/gu)?.length, 2);
  });
});

describe('the bar draws it between the price and the sizer', () => {
  it('NEGATIVE CONTROL: without the slot there is no glance in the bar', async () => {
    assert.ok(!(await bar(false)).includes('prl-hand-glance'));
  });

  it('puts the glance after the price strip and before the sizer', async () => {
    const markup = await bar(true);
    const price = markup.indexOf('class="prl-action-bar__price"');
    const hand = markup.indexOf('class="prl-hand-glance"');
    const sizer = markup.indexOf('class="prl-sizer"');
    assert.ok(price >= 0 && sizer >= 0, 'the bar did not render its price and sizer');
    assert.ok(hand >= 0, 'the bar dropped its context');
    assert.ok(price < hand && hand < sizer, `price at ${price}, glance at ${hand}, sizer at ${sizer}`);
  });
});

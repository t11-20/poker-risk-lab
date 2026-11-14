/**
 * `HandGlance`, and the slot in `ActionBar` that draws it between the price and the sizer.
 * Scrolling to the sizer on a 390x844 phone took the reader's plate and the board off the top, and with
 * them the clock and the street line. The cards are one named image so a reader does not step through
 * seven card names to reach the sizer.
 * `apps/web/src/lib/follow-the-table.ts` does its arithmetic for this placement.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { handAndBoardName } from '../src/cards.ts';
import type { LegalAction, TableAction } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

interface TurnClock {
  readonly deadlineMs: number;
  readonly serverTimeMs: number;
  readonly budgetSeconds: number;
}

interface HandGlanceProps {
  readonly hole: readonly number[];
  readonly board: readonly number[];
  readonly clock?: TurnClock | null;
  readonly latest?: string | null;
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

async function glance(board: readonly number[], extra: Partial<HandGlanceProps> = {}): Promise<string> {
  const HandGlance = await loadComponent<HandGlanceProps>('components/HandGlance', 'HandGlance');
  return renderToStaticMarkup(createElement(HandGlance, { hole: HOLE, board, ...extra }));
}

/** Twenty of thirty seconds left, as a frame would carry it. */
const CLOCK: TurnClock = { deadlineMs: 120_000, serverTimeMs: 100_000, budgetSeconds: 30 };
const LATEST = 'On the river: Calling Station bet 215';

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
        '<span class="prl-hand-glance">' +
          `<span class="prl-hand-glance__hand" role="img" aria-label="${handAndBoardName(HOLE, FLOP)}">`,
      ),
      `the cards are not the named image: ${markup.slice(0, 160)}`,
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

describe('the clock and the latest action, above the cards', () => {
  it('draws the ring and the phrase in one row before the cards', async () => {
    const markup = await glance(FLOP, { clock: CLOCK, latest: LATEST });
    const row = markup.indexOf('<span class="prl-hand-glance__now" aria-hidden="true">');
    const ring = markup.indexOf('class="prl-turn-timer"');
    const phrase = markup.indexOf(`<span class="prl-hand-glance__latest">${LATEST}</span>`);
    const hand = markup.indexOf('class="prl-hand-glance__hand"');
    assert.ok(row >= 0, `no row for the clock and the latest action: ${markup.slice(0, 200)}`);
    assert.ok(
      row < ring && ring < phrase && phrase < hand,
      `row ${row}, ring ${ring}, phrase ${phrase}, cards ${hand}`,
    );
  });

  it('is hidden from the tree, which already holds the plate’s timer and the street line', async () => {
    const markup = await glance(FLOP, { clock: CLOCK, latest: LATEST });
    const row = /<span class="prl-hand-glance__now"([^>]*)>/u.exec(markup);
    assert.ok(row !== null, 'the row was not drawn; the check is over nothing');
    assert.match(row[1] ?? '', /aria-hidden="true"/u);
  });

  it('draws either one alone', async () => {
    const clockOnly = await glance(FLOP, { clock: CLOCK });
    assert.ok(clockOnly.includes('class="prl-turn-timer"'));
    assert.ok(!clockOnly.includes('prl-hand-glance__latest'));
    const latestOnly = await glance(FLOP, { latest: LATEST });
    assert.ok(latestOnly.includes(LATEST));
    assert.ok(!latestOnly.includes('prl-turn-timer'));
  });

  it('draws no row when there is neither, so a fixture without a clock adds no blank line', async () => {
    for (const markup of [await glance(FLOP), await glance(FLOP, { clock: null, latest: null })]) {
      assert.ok(!markup.includes('prl-hand-glance__now'), markup.slice(0, 160));
    }
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

/**
 * `Seat`, actually rendered, with the settled frame as the subject.
 *
 * ## The defect this exists for
 *
 * `SeatStatus` describes a seat's participation **in the current hand**, and the engine keeps
 * sending it after the hand is over: `street: 'complete'` arrives with everybody's last status
 * still on them. `Seat` read it as present tense whatever the street, so the frame a reader spends
 * the longest looking at — the one at the end of a hand, before the next deal, and the same frame
 * the replay screen shows — said the wrong thing about every seat that had not folded.
 *
 * Measured on the built app at `/play?state=complete`, which renders the settled fixture through
 * this component and is also what the live table draws when the last frame of a hand lands:
 *
 *     Balanced bot           data-status=active   status line: "in the hand"   chips: []
 *     Calling-station bot    data-status=active   status line: "in the hand"   chips: []
 *     You (you)              data-status=allIn    status line: "all in"        chips: ["all in"]
 *
 * The pot had been awarded. Nobody was in any hand, and the seat wearing the "all in" chip is the
 * one that had just won the main pot with an ace-high flush — so the chip read as a commitment
 * still standing in the middle.
 *
 * ## Why this is rendered rather than read
 *
 * The whole point is what reaches the screen. `bet-sizing.test.ts` can test arithmetic without a
 * renderer; "what does this seat say" cannot be separated from the markup, and a copy of the
 * component would reproduce whatever mistake the component makes. `loadComponent` compiles the
 * real `src/` with the same compiler and renders it with the same React the app ships.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SeatStatus, SeatView, Street } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

interface SeatProps {
  readonly seat: SeatView;
  readonly street: Street;
  readonly name: string;
  readonly ringIndex: number;
  readonly ringCount: number;
  readonly as?: 'li' | 'div';
}

/** The winner of the settled fixture: all in, never folded, and holding the best hand. */
function seatWith(status: SeatStatus): SeatView {
  return {
    seat: 0,
    playerId: 'fixture-user',
    stack: 0,
    committedThisStreet: 0,
    committedTotal: 300,
    status,
    position: 'BB',
    holeCards: null,
    isSelf: true,
    isButton: false,
    isToAct: false,
  };
}

async function render(status: SeatStatus, street: Street): Promise<string> {
  const Seat = await loadComponent<SeatProps>('components/Seat', 'Seat');
  return renderToStaticMarkup(
    createElement(Seat, {
      seat: seatWith(status),
      street,
      name: 'You',
      ringIndex: 0,
      ringCount: 6,
      as: 'div',
    }),
  );
}

/** The status line's text, which is the sentence the defect was about. */
function statusLine(markup: string): string {
  const found = /<p class="prl-seat__status">([^<]*)<\/p>/u.exec(markup);
  assert.ok(found !== null, `no status line in the rendered seat:\n${markup}`);
  return (found[1] ?? '').trim();
}

/** Whether the plate is wearing an "all in" chip. */
function hasAllInChip(markup: string): boolean {
  return /class="[^"]*prl-chip[^"]*"[^>]*>all in</u.test(markup);
}

describe('a seat in a hand that is still being played', () => {
  it('says it is in the hand, and badges an outstanding all-in', async () => {
    for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
      assert.equal(statusLine(await render('active', street)), 'in the hand', street);
      assert.equal(statusLine(await render('allIn', street)), 'all in', street);
      assert.equal(hasAllInChip(await render('allIn', street)), true, `${street}: no all-in badge`);
    }
  });

  it('keeps saying so at showdown, because the pot has not been awarded yet', async () => {
    // Deliberately unchanged. The cards are down and being compared; a seat that has not folded
    // genuinely is still in the hand.
    assert.equal(statusLine(await render('active', 'showdown')), 'in the hand');
    assert.equal(hasAllInChip(await render('allIn', 'showdown')), true);
  });
});

describe('a seat in a hand that is over', () => {
  it('does not claim anybody is still in the hand', async () => {
    const markup = await render('active', 'complete');
    assert.equal(statusLine(markup), 'still in at the end');
    assert.doesNotMatch(
      markup,
      />in the hand</u,
      'the settled frame still says a seat is in a hand that has been settled',
    );
  });

  it('puts a finished all-in in the past tense and takes the badge off', async () => {
    const markup = await render('allIn', 'complete');
    assert.equal(statusLine(markup), 'went all in');
    assert.equal(
      hasAllInChip(markup),
      false,
      'the winner of the pot is still wearing an "all in" chip, which reads as chips still in the middle',
    );
  });

  it('leaves the two statuses that were never about a hand in progress alone', async () => {
    assert.equal(statusLine(await render('folded', 'complete')), 'folded');
    assert.equal(statusLine(await render('sittingOut', 'complete')), 'sitting out');
    // And they are unchanged from the live wording, which is what "leaves alone" means.
    assert.equal(statusLine(await render('folded', 'river')), 'folded');
    assert.equal(statusLine(await render('sittingOut', 'river')), 'sitting out');
  });

  it('NEGATIVE CONTROL: the detectors fire on the markup this replaced', async () => {
    // The old component rendered the live wording whatever the street, so these two assertions
    // would have read the live markup. Feeding the detectors that markup proves they can fail.
    const live = await render('allIn', 'river');
    assert.equal(statusLine(live), 'all in');
    assert.equal(hasAllInChip(live), true);
    assert.notEqual(statusLine(live), statusLine(await render('allIn', 'complete')));

    const stillIn = await render('active', 'river');
    assert.match(stillIn, />in the hand</u, 'the "in the hand" detector never matches anything');
  });
});

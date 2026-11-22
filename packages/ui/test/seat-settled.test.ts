/**
 * `Seat`, rendered, with the settled frame as the subject.
 * The engine still sends each seat's last `SeatStatus` with `street: 'complete'`, and the settled frame
 * must not read it as present tense ("in the hand", an "all in" chip after the pot was awarded).
 * Rendered rather than copied, because a copy of the component would reproduce its mistake.
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

function statusLine(markup: string): string {
  const found = /<p class="prl-seat__status">([^<]*)<\/p>/u.exec(markup);
  assert.ok(found !== null, `no status line in the rendered seat:\n${markup}`);
  return (found[1] ?? '').trim();
}

/** A live seat with no action yet has no status line, because its cards already say it is in. */
function hasNoStatusLine(markup: string): boolean {
  return !markup.includes('class="prl-seat__status"');
}

function hasAllInChip(markup: string): boolean {
  return /class="[^"]*prl-chip[^"]*"[^>]*>all in</u.test(markup);
}

describe('a seat in a hand that is still being played', () => {
  it('says nothing of a seat that is simply in, and badges an outstanding all-in', async () => {
    for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
      assert.equal(hasNoStatusLine(await render('active', street)), true, street);
      assert.equal(statusLine(await render('allIn', street)), 'all in', street);
      assert.equal(hasAllInChip(await render('allIn', street)), true, `${street}: no all-in badge`);
    }
  });

  it('keeps saying so at showdown, because the pot has not been awarded yet', async () => {
    // Deliberately unchanged. The cards are being compared, so a seat that has not folded is still in.
    assert.equal(hasNoStatusLine(await render('active', 'showdown')), true);
    assert.equal(hasAllInChip(await render('allIn', 'showdown')), true);
  });
});

describe('a seat in a hand that is over', () => {
  it('does not claim anybody is still in the hand', async () => {
    const markup = await render('active', 'complete');
    assert.equal(statusLine(markup), 'stayed in');
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
    assert.equal(statusLine(await render('folded', 'river')), 'folded');
    assert.equal(statusLine(await render('sittingOut', 'river')), 'sitting out');
  });

  it('NEGATIVE CONTROL: the detectors fire on the markup this replaced', async () => {
    // The old component rendered the live wording on every street, so the live markup stands in for it.
    const live = await render('allIn', 'river');
    assert.equal(statusLine(live), 'all in');
    assert.equal(hasAllInChip(live), true);
    assert.notEqual(statusLine(live), statusLine(await render('allIn', 'complete')));

    assert.equal(hasNoStatusLine(await render('folded', 'river')), false, 'the detector never fires');
  });
});

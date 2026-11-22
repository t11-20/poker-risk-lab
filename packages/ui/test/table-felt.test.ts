/**
 * The felt table: each seat's place round it, the bet to match above the board, and an outline for
 * each board card still to come. Rendered, because a copy of the component would share its mistakes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerView } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

type SeatSlotOf = (index: number, count: number) => string;

/** Through the compiled module, because Node cannot import a `.tsx` file. */
async function slotOf(): Promise<SeatSlotOf> {
  return (await loadComponent<never>('components/Seat', 'seatSlot')) as unknown as SeatSlotOf;
}

describe('each seat’s place round the table', () => {
  it('puts the viewer at the bottom and the rest clockwise from the left', async () => {
    const seatSlot = await slotOf();
    const six = [0, 1, 2, 3, 4, 5].map((index) => seatSlot(index, 6));
    assert.deepEqual(six, ['hero', 'left-low', 'left-high', 'top', 'right-high', 'right-low']);
    assert.deepEqual(
      [0, 1].map((index) => seatSlot(index, 2)),
      ['hero', 'top'],
    );
  });

  it('never gives two seats the same place, for every table a room can seat', async () => {
    const seatSlot = await slotOf();
    for (let count = 2; count <= 6; count++) {
      const slots = Array.from({ length: count }, (_, index) => seatSlot(index, count));
      assert.equal(new Set(slots).size, count, `${count} seats: ${slots.join(', ')}`);
      assert.equal(slots[0], 'hero');
    }
  });
});

function seat(index: number, committedThisStreet: number, isSelf = false): PlayerView['seats'][number] {
  return {
    seat: index,
    playerId: `p${index}`,
    stack: 900,
    committedThisStreet,
    committedTotal: committedThisStreet,
    status: 'active',
    position: null,
    holeCards: isSelf ? [0, 1] : null,
    isSelf,
    isButton: false,
    isToAct: false,
  } as PlayerView['seats'][number];
}

function view(
  street: PlayerView['street'],
  board: readonly number[],
  committed: readonly number[],
): PlayerView {
  return {
    handId: 'hand-1',
    roomId: 'room-1',
    handNumber: 4,
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 60 },
    street,
    board,
    buttonSeat: 1,
    seats: committed.map((amount, index) => seat(index, amount, index === 0)),
    toAct: null,
    betLevel: 0,
    minimumRaiseTo: 0,
    potTotal: 100,
    pots: [{ amount: 100, eligibleSeats: [0, 1], capPerSeat: null, index: 0 }],
    forcedBets: [],
    actions: [],
    actionSequence: 0,
    legalActions: [],
    amountToCall: 0,
    result: null,
    viewerSeat: 0,
  } as unknown as PlayerView;
}

async function table(tableView: PlayerView): Promise<string> {
  const PokerTable = await loadComponent<{ view: PlayerView }>('components/PokerTable', 'PokerTable');
  return renderToStaticMarkup(createElement(PokerTable, { view: tableView })).replace(
    /<link rel="preload"[^>]*>/gu,
    '',
  );
}

const slots = (markup: string): number => [...markup.matchAll(/class="prl-card-row__slot"/gu)].length;
const betLine = (markup: string): string | null =>
  /<p class="prl-table__bet">(.*?)<\/p>/u.exec(markup)?.[1]?.replace(/<[^>]*>/gu, '') ?? null;

describe('the board', () => {
  it('draws an outline for each card still to come, hidden from the reader', async () => {
    assert.equal(slots(await table(view('preflop', [], [5, 10]))), 5);
    assert.equal(slots(await table(view('flop', [10, 20, 30], [0, 0]))), 2);
    assert.equal(slots(await table(view('river', [10, 20, 30, 40, 50], [0, 0]))), 0);
    assert.match(
      await table(view('flop', [10, 20, 30], [0, 0])),
      /class="prl-card-row__slot" aria-hidden="true"/u,
    );
  });

  it('still says there are no community cards before the flop', async () => {
    const markup = await table(view('preflop', [], [5, 10]));
    assert.match(markup, /community cards: none dealt yet/u);
    assert.match(markup, /<span class="prl-visually-hidden">no community cards yet<\/span>/u);
  });
});

describe('the bet to match', () => {
  it('is the most anybody has put in on this street', async () => {
    assert.equal(betLine(await table(view('flop', [10, 20, 30], [35, 0, 0]))), 'Bet this round 35');
    assert.equal(betLine(await table(view('preflop', [], [5, 10]))), 'Bet this round 10');
  });

  it('is not drawn before anybody bets, or once the pot is paid', async () => {
    assert.equal(betLine(await table(view('flop', [10, 20, 30], [0, 0]))), null);
    assert.equal(betLine(await table(view('complete', [10, 20, 30, 40, 50], [35, 35]))), null);
  });
});

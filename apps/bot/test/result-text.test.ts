import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  type Action,
  applyAction,
  createDeterministicRandomForTests,
  type HandState,
  type SeatIndex,
  startHand,
} from '@prl/poker-engine';
import { newTable, READER_SEAT, readerView, TABLE_CONFIG } from '../src/table.ts';
import { actionButtons, resultText, tableText } from '../src/view.ts';
import { testDeps } from './helpers.ts';

const table = newTable('scripted', testDeps(1));

/** A hand dealt straight from the engine with chosen stacks, so the all-in amounts are exact. */
function scripted(
  buttonSeat: SeatIndex,
  stacks: readonly (readonly [SeatIndex, number])[],
  moves: readonly (readonly [SeatIndex, Action])[],
): HandState {
  let state = startHand({
    handId: 'scripted-1',
    roomId: 'chat-scripted',
    handNumber: 1,
    config: TABLE_CONFIG,
    buttonSeat,
    seats: stacks.map(([seat, stack]) => ({ seat, playerId: `p${seat}`, stack })),
    random: createDeterministicRandomForTests(7),
  }).state;
  for (const [seat, action] of moves) state = applyAction(state, seat, action).state;
  return state;
}

describe('chips nobody could match go back, and are not won', () => {
  test('a shove into a shorter caller returns the difference instead of winning side pot 1', () => {
    const state = scripted(
      READER_SEAT,
      [
        [READER_SEAT, 1_000],
        [3, 950],
      ],
      [
        [READER_SEAT, { type: 'raise', to: 1_000 }],
        [3, { type: 'call' }],
      ],
    );
    const text = resultText(table, readerView(state));
    assert.match(text, /^You get back 50 units that nobody still in the hand matched\.$/m);
    assert.match(text, /wins? 1,900 units from the main pot\./);
    assert.doesNotMatch(text, /side pot/);
    assert.match(text, /^Hand 1 · Hand over · Pot 1,900 units$/m);
  });

  test('a side pot with a folded seat’s chips in it is split into what went back and what was won', () => {
    // Seat 4 raises to 800 and folds to the reader's 1,000, over seat 3's 700 all-in. Side pot 1 is
    // the reader's own 300 and seat 4's last 100.
    const state = scripted(
      4,
      [
        [READER_SEAT, 1_000],
        [3, 700],
        [4, 2_000],
      ],
      [
        [4, { type: 'raise', to: 800 }],
        [READER_SEAT, { type: 'raise', to: 1_000 }],
        [3, { type: 'call' }],
        [4, { type: 'fold' }],
      ],
    );
    const text = resultText(table, readerView(state));
    assert.match(text, /^You get back 300 units that nobody still in the hand matched\.$/m);
    assert.match(text, /^You win 100 units from side pot 1\.$/m);
    assert.match(text, /wins? 2,100 units from the main pot\./);
    assert.match(text, /· Pot 2,200 units$/m);
  });

  test('a fold-win is still a win: the main pot holds the blinds even with one seat eligible', () => {
    const state = scripted(
      READER_SEAT,
      [
        [READER_SEAT, 1_000],
        [3, 1_000],
      ],
      [
        [READER_SEAT, { type: 'raise', to: 30 }],
        [3, { type: 'fold' }],
      ],
    );
    const text = resultText(table, readerView(state));
    assert.match(text, /^You win 40 units from the main pot\.$/m);
    assert.doesNotMatch(text, /get back/);
    assert.match(text, /· Pot 40 units$/m);
  });
});

describe('the seat lines and the recap', () => {
  test('a settled seat carries no in-hand status, but a folded one still says so', () => {
    const state = scripted(
      4,
      [
        [READER_SEAT, 1_000],
        [3, 700],
        [4, 2_000],
      ],
      [
        [4, { type: 'raise', to: 800 }],
        [READER_SEAT, { type: 'raise', to: 1_000 }],
        [3, { type: 'call' }],
        [4, { type: 'fold' }],
      ],
    );
    const view = readerView(state);
    assert.ok(
      view.seats.some((seat) => seat.status === 'allIn'),
      'the hand under test has an all-in seat',
    );
    const text = resultText(table, view);
    assert.doesNotMatch(text, /· all-in|· to act/);
    assert.match(text, /Reading Pressure · [\d,]+ units · folded$/m);
  });

  test('an all-in is marked in the recap, and an ordinary raise is not', () => {
    const shove = scripted(
      3,
      [
        [READER_SEAT, 1_000],
        [3, 312],
      ],
      [[3, { type: 'raise', to: 312 }]],
    );
    assert.match(tableText(table, readerView(shove), null), /Calling Station raises to 312, all in\./);

    const open = scripted(
      3,
      [
        [READER_SEAT, 1_000],
        [3, 1_000],
      ],
      [[3, { type: 'raise', to: 30 }]],
    );
    assert.match(tableText(table, readerView(open), null), /Calling Station raises to 30\./);
  });

  test('a call that takes the whole stack is marked too', () => {
    const state = scripted(
      READER_SEAT,
      [
        [READER_SEAT, 1_000],
        [3, 950],
      ],
      [
        [READER_SEAT, { type: 'raise', to: 1_000 }],
        [3, { type: 'call' }],
      ],
    );
    assert.match(resultText(table, readerView(state)), /Calling Station calls, all in\./);
  });
});

test('bet sizes are laid out two to a row, so a phone does not cut a label off', () => {
  const state = scripted(
    READER_SEAT,
    [
      [READER_SEAT, 1_000],
      [3, 1_000],
      [4, 1_000],
    ],
    [],
  );
  const rows = actionButtons(readerView(state));
  const sizes = rows.flat().filter((button) => /raise to|All-in/i.test(button.label));
  assert.equal(sizes.length, 4, `expected four sizes, got ${sizes.map((button) => button.label)}`);
  for (const row of rows) assert.ok(row.length <= 2, `a row of ${row.map((button) => button.label)}`);
});

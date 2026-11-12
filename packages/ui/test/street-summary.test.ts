/**
 * The decision band's "who did what on this street" line (audit at 6b3886e, M3 and minor 2).
 *
 * M3: at the reader's decision most opponents' plates were off the screen — 1 of 5 visible at
 * 390x844, 2 of 5 at 1440x900, 0 of 2 at a private table — so "to continue 78 units" was on screen
 * with nobody visible who had bet. Minor 2: the plates start each street blank, so the call or bet
 * that CLOSED a street was on screen for about 200ms.
 *
 * Each block runs its detector over what the screen offered before as well — the plates, through
 * `lastActionsThisStreet` — and asserts it comes back without the fact this line exists to carry.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lastActionsThisStreet } from '../src/seat-actions.ts';
import { STREET_SUMMARY_LIMIT, streetSummary } from '../src/street-summary.ts';
import type { PlayerView } from '../src/view-types.ts';

type Logged = PlayerView['actions'][number];
type Seat = PlayerView['seats'][number];

function logged(
  street: Logged['street'],
  seat: number,
  action: Logged['action'],
  amountPaid: number,
): Logged {
  return {
    sequence: 0,
    street,
    seat,
    playerId: `p${seat}`,
    action,
    amountPaid,
    betLevelAfter: 0,
    potAfter: 0,
    wasAutomatic: false,
    actionId: null,
  } as Logged;
}

function seat(index: number, extra: Partial<Seat> = {}): Seat {
  return {
    seat: index,
    playerId: `p${index}`,
    stack: 900,
    committedThisStreet: 0,
    committedTotal: 0,
    status: 'active',
    position: null,
    holeCards: null,
    isSelf: false,
    isButton: false,
    isToAct: false,
    ...extra,
  } as Seat;
}

const NAMES = { 0: 'Guest 5E4D95', 2: 'Calling Station', 4: 'Nit' };

/** Blinds 5/10: seat 4 posts the small blind, seat 0 (the reader) the big. */
const BLINDS: PlayerView['forcedBets'] = [
  { kind: 'smallBlind', seat: 4, amount: 5, wasShort: false },
  { kind: 'bigBlind', seat: 0, amount: 10, wasShort: false },
] as unknown as PlayerView['forcedBets'];

const PREFLOP: readonly Logged[] = [
  logged('preflop', 2, { type: 'call' }, 10),
  logged('preflop', 4, { type: 'call' }, 5),
  logged('preflop', 0, { type: 'check' }, 0),
];

const FLOP: readonly Logged[] = [
  logged('flop', 4, { type: 'check' }, 0),
  logged('flop', 0, { type: 'check' }, 0),
  logged('flop', 2, { type: 'bet', to: 16 }, 16),
  logged('flop', 4, { type: 'call' }, 16),
];

function view(street: PlayerView['street'], actions: readonly Logged[], seats?: readonly Seat[]): PlayerView {
  return {
    street,
    actions,
    forcedBets: BLINDS,
    seats: seats ?? [seat(0, { isSelf: true }), seat(2), seat(4)],
  } as unknown as PlayerView;
}

const said = (line: ReturnType<typeof streetSummary>): string =>
  line === null ? '<nothing>' : `${line.label}: ${line.actions.join(' · ')}`;

describe('the line names who did what on the street being played', () => {
  it('names the bettor and the caller, with the amounts, at the reader’s decision', () => {
    const line = streetSummary(view('flop', [...PREFLOP, ...FLOP]), NAMES);
    assert.equal(
      said(line),
      'On the flop: You checked · Calling Station bet 16 · Nit called 16',
      'the latest three actions on the flop, oldest first',
    );
    assert.equal(line?.current, true);
    assert.equal(line?.earlier, 1, 'Nit’s opening check was left out and counted');
  });

  it('words a preflop call with the blind the seat had already posted', () => {
    // The small blind pays 5 to call 10. "Called 5" would contradict the price everyone saw.
    assert.equal(
      said(streetSummary(view('preflop', PREFLOP), NAMES)),
      'Preflop: Calling Station called 10 · Nit called 10 · You checked',
    );
  });

  it('says nothing before anybody has acted, or once the hand is over', () => {
    assert.equal(streetSummary(view('preflop', []), NAMES), null);
    assert.equal(streetSummary(view('complete', [...PREFLOP, ...FLOP]), NAMES), null);
    assert.equal(streetSummary(view('showdown', [...PREFLOP, ...FLOP]), NAMES), null);
  });

  it(`keeps it to ${String(STREET_SUMMARY_LIMIT)} actions, the latest ones`, () => {
    const many = [
      logged('flop', 4, { type: 'bet', to: 10 }, 10),
      logged('flop', 0, { type: 'raise', to: 30 }, 30),
      logged('flop', 2, { type: 'call' }, 30),
      logged('flop', 4, { type: 'raise', to: 90 }, 80),
      logged('flop', 0, { type: 'call' }, 60),
    ];
    const line = streetSummary(view('flop', many), NAMES);
    assert.equal(line?.actions.length, STREET_SUMMARY_LIMIT);
    assert.equal(line?.earlier, 2);
    assert.equal(said(line), 'On the flop: Calling Station called 30 · Nit raised to 90 · You called 90');
  });
});

describe('the action that closed a street stays said until the next street has one', () => {
  const turnSeats = [seat(0, { isSelf: true }), seat(2), seat(4)];

  it('describes the flop, by name, on a turn nobody has acted on yet', () => {
    const line = streetSummary(view('turn', [...PREFLOP, ...FLOP], turnSeats), NAMES);
    assert.equal(line?.current, false);
    // 16, not 0: every seat's `committedThisStreet` is 0 on the turn, which is what the plate reads.
    assert.equal(said(line), 'On the flop: You checked · Calling Station bet 16 · Nit called 16');
  });

  it('moves to the turn as soon as somebody acts on it', () => {
    const line = streetSummary(
      view('turn', [...PREFLOP, ...FLOP, logged('turn', 4, { type: 'check' }, 0)], turnSeats),
      NAMES,
    );
    assert.equal(said(line), 'On the turn: Nit checked');
    assert.equal(line?.current, true);
  });

  it('NEGATIVE CONTROL: the plates, which were all there was, say nothing of the closing call', () => {
    const plates = lastActionsThisStreet(view('turn', [...PREFLOP, ...FLOP], turnSeats));
    assert.deepEqual(plates, {}, 'a plate still carries the flop on the turn; the defect has changed');
    // And worded from the seat, as the plate words a call, the closing call reads 0.
    const fromSeat = lastActionsThisStreet({ ...view('flop', FLOP, turnSeats), street: 'flop' });
    assert.equal(fromSeat[4], 'called 0', 'the seat-read amount is no longer 0 on the next street');
  });
});

describe('a short all-in call', () => {
  it('says what the seat matched and that it was all in, on the last action only', () => {
    const actions = [
      logged('flop', 2, { type: 'bet', to: 100 }, 100),
      logged('flop', 4, { type: 'call' }, 30),
    ];
    const seats = [seat(0, { isSelf: true }), seat(2), seat(4, { status: 'allIn', stack: 0 })];
    assert.equal(
      said(streetSummary(view('flop', actions, seats), NAMES)),
      'On the flop: Calling Station bet 100 · Nit called 30, all in',
    );
  });

  it('does not call an earlier action all in because of what the seat did after it', () => {
    const actions = [
      logged('flop', 4, { type: 'bet', to: 20 }, 20),
      logged('flop', 2, { type: 'raise', to: 60 }, 60),
      logged('flop', 4, { type: 'call' }, 40),
    ];
    const seats = [seat(0, { isSelf: true }), seat(2), seat(4, { status: 'allIn', stack: 0 })];
    assert.equal(
      said(streetSummary(view('flop', actions, seats), NAMES)),
      'On the flop: Nit bet 20 · Calling Station raised to 60 · Nit called 60, all in',
    );
  });

  it('names a seat that has left the table by its number rather than dropping it', () => {
    const line = streetSummary(view('flop', [logged('flop', 5, { type: 'fold' }, 0)]), NAMES);
    assert.equal(said(line), 'On the flop: Seat 6 folded');
  });
});

/**
 * What a settled hand guarantees — and the one thing it very much does not.
 *
 * ## The defect this file closes
 *
 * `test/ws-socket.test.ts`'s journey test ("sits, plays to completion against a bot, and reports a
 * settled terminal state") closed on this:
 *
 * ```ts
 * const stacks = view.seats.map((seat) => seat.stack);
 * assert.ok(stacks.some((stack) => stack !== 1_000), `no stack changed across the hand: ...`);
 * ```
 *
 * with the comment "somebody's stack moved — a completed hand in which no chips changed hands
 * would mean the blinds were never posted". The intent was right and the check was not: *somebody
 * won* is not a property of a settled hand. A CHOPPED pot pays every seat back exactly what it put
 * in, so a completely normal hand closes with both seats on the stack they started with.
 *
 * That table is dealt from the CSPRNG, so the gate failed whenever the deal happened to chop —
 * measured at 2 of 40 runs of that file in isolation, and 15 of 400 hands of the same line-up
 * driven straight through the table. A release gate that fails nondeterministically cannot tell a
 * regression from noise, which is an audit finding in its own right (CHAL-C).
 *
 * The first test below is the counterexample, made deterministic: a real `LiveTable`, real blinds,
 * real actions, a real showdown — and every seat closing on precisely the 1,000 it sat down with.
 * Had it existed next to the journey test, the assertion above could not have been written. It
 * also pins the three checks that replaced it, on the same view, so the two files cannot drift:
 * the blinds were posted, every chip in every pot was awarded, and each seat closed on its
 * starting stack plus its net.
 *
 * ## The hypothesis this file also rules out
 *
 * The other way a hand could report `[1000, 1000]` would be a genuine defect: a hand dealt to ONE
 * live seat, which wins its own blind back for a net of zero. It cannot happen, and the second
 * suite here says so at the level that decides it. Three independent guards stand in the way —
 * `LiveTable.startHand` needs two entrants with chips, `LiveTable.nextRotation` restarts the game
 * rather than deal a hand the blind obligations would leave one-handed, and the engine's
 * `validateSeats` refuses fewer than two players outright (covered by `poker-engine`'s
 * `betting.test.ts` and `blind-rotation.test.ts`). The middle one — the deadlock guard, where a
 * two-handed table would otherwise be left with one live seat and one seat waiting for a big blind
 * that can never arrive — is the one this file drives directly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Card,
  createSecureRandom,
  DECK_SIZE,
  orderedDeck,
  type PlayerView,
  parseCards,
  type RandomSource,
} from '@prl/poker-engine';
import { isAppError } from '../src/errors.ts';
import { LiveTable } from '../src/rooms/table.ts';
import { systemClock } from '../src/rooms/timers.ts';

const CONFIG = { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 } as const;
const BUY_IN = 1_000;
const ADA = 'usr_z1_ada';
const BO = 'usr_z1_bo';
const CY = 'usr_z1_cy';

/**
 * A board that plays for every possible pair of hole cards, so the chop is a fact rather than a
 * coincidence of the deal order.
 *
 * `As Ks Qd Jc Th` is broadway in three suits. Nothing can beat it from two hole cards: a flush
 * needs five of a suit and the board offers two, a full house needs a pair on the board and there
 * is none, and the only straight the ranks allow is the one already lying there. So both seats
 * show down the board itself, whichever two of the four leading cards each of them was dealt —
 * which means this test does not depend on the deal order the engine happens to use.
 */
const CHOPPING_DECK = '2c 3d 4h 5s As Ks Qd Jc Th';

/**
 * A whole deck that begins with `prefix`, the rest following in ordered-deck order.
 *
 * The first four cards become the hole cards and the next five the board — see `machine.ts`, which
 * deals one card at a time twice round the table and then burns nothing.
 */
function deckStartingWith(prefix: string): Card[] {
  const front = parseCards(prefix);
  const used = new Set(front);
  assert.equal(used.size, front.length, 'the scripted prefix repeats a card');
  return [...front, ...orderedDeck().filter((card) => !used.has(card))];
}

/**
 * A `RandomSource` whose shuffle lands one chosen deck, every hand.
 *
 * `LiveTable` deliberately has no fixed-deck seam — `startHand`'s `fixedDeck` belongs to the
 * Scenario Lab, and a live table must deal from the CSPRNG — but the source itself is injected, so
 * this inverts the engine's shuffle instead of bypassing it. `shuffleInPlace` walks `i` from 51
 * down to 1 and swaps `items[i]` with `items[nextInt(i + 1)]`, which means the card at `i` is
 * final once that swap is done. Replaying that over the ordered deck and asking, at each `i`,
 * "where is the card that has to end up here?" gives the draw the shuffle must have made. The
 * script then repeats, so a second hand at the same table is dealt identically.
 */
function scriptedRandom(deck: readonly Card[]): RandomSource {
  assert.equal(deck.length, DECK_SIZE, 'a scripted deck is a whole deck');
  assert.equal(new Set(deck).size, DECK_SIZE, 'a scripted deck holds 52 distinct cards');

  const working = orderedDeck();
  const draws: number[] = [];
  for (let index = working.length - 1; index > 0; index -= 1) {
    const wanted = deck[index];
    assert.ok(wanted !== undefined, `no card scripted for deck position ${index}`);
    const from = working.indexOf(wanted);
    assert.ok(from >= 0 && from <= index, `card ${wanted} cannot be placed at position ${index}`);
    const displaced = working[index];
    assert.ok(displaced !== undefined, `deck position ${index} is empty`);
    draws.push(from);
    working[index] = wanted;
    working[from] = displaced;
  }

  let cursor = 0;
  let salt = 0x2f6e2b1;
  return {
    kind: 'deterministic-test-only',
    nextInt(boundExclusive: number): number {
      const draw = draws[cursor % draws.length];
      cursor += 1;
      assert.ok(draw !== undefined, 'the shuffle script ran dry');
      assert.ok(draw < boundExclusive, `scripted draw ${draw} is outside 0..${boundExclusive - 1}`);
      return draw;
    },
    bytes(count: number): Uint8Array {
      // Commitment salts. They only have to be reproducible and distinct — the proofs themselves
      // are the engine's `commitment.test.ts` business, and nothing here reads one.
      const out = new Uint8Array(count);
      for (let index = 0; index < count; index += 1) {
        salt = (salt * 1_103_515_245 + 12_345) % 2_147_483_648;
        out[index] = salt & 0xff;
      }
      return out;
    },
  };
}

let tableCount = 0;
function tableWith(random: RandomSource): LiveTable {
  tableCount += 1;
  const roomId = `room_z1_${tableCount}`;
  let hands = 0;
  return new LiveTable({
    roomId,
    config: CONFIG,
    clock: systemClock,
    random,
    nextHandId: () => {
      hands += 1;
      return `hand_z1_${tableCount}_${hands}`;
    },
    onProblem: (message, detail) => {
      assert.fail(`the table logged a problem: ${message} ${JSON.stringify(detail ?? {})}`);
    },
  });
}

/** Any seated user will do to read the public facts: the spectator view carries all of them. */
function viewOf(table: LiveTable, userId: string): PlayerView {
  const view = table.viewFor(userId);
  assert.ok(view !== null, `${userId} sees no hand`);
  return view;
}

/**
 * Checks when it is free and calls when it is not, until the hand is over.
 *
 * The same policy the journey test's `PASSIVE` drives over the socket, and for the same reason: it
 * never folds, so the hand is played out to a showdown rather than ended early.
 */
async function checkOrCallToShowdown(table: LiveTable, observer: string): Promise<void> {
  for (let guard = 0; guard <= 64; guard += 1) {
    const view = viewOf(table, observer);
    if (view.toAct === null) return;
    const actor = view.seats.find((seat) => seat.seat === view.toAct)?.playerId;
    assert.ok(actor !== undefined, `seat ${String(view.toAct)} is to act but holds no player`);
    const legal = new Set(viewOf(table, actor).legalActions.map((action) => action.type));
    const type = legal.has('check') ? 'check' : 'call';
    assert.ok(legal.has(type), `seat ${String(view.toAct)} may neither check nor call`);
    await table.submitAction(actor, {
      action: { type },
      actionId: `z1_${guard}_${String(view.actionSequence)}`,
      expectedSequence: view.actionSequence,
    });
  }
  assert.fail('a checked-down hand did not finish');
}

/** Folds every decision away, for a hand whose result is beside the point. */
async function foldItOut(table: LiveTable, observer: string): Promise<void> {
  for (let guard = 0; guard <= 64; guard += 1) {
    const view = viewOf(table, observer);
    if (view.toAct === null) return;
    const actor = view.seats.find((seat) => seat.seat === view.toAct)?.playerId;
    assert.ok(actor !== undefined, `seat ${String(view.toAct)} is to act but holds no player`);
    await table.submitAction(actor, {
      action: { type: 'fold' },
      actionId: `z1_fold_${guard}_${String(view.actionSequence)}`,
      expectedSequence: view.actionSequence,
    });
  }
  assert.fail('a folded hand did not finish');
}

// ---------------------------------------------------------------------------
// The counterexample
// ---------------------------------------------------------------------------

describe('a settled hand whose stacks did not move', () => {
  it('chops the pot and returns every seat to exactly the stack it started with', async () => {
    const table = tableWith(scriptedRandom(deckStartingWith(CHOPPING_DECK)));
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: BUY_IN });
    await table.sit({ userId: BO, displayName: 'Bo', seat: 1, stack: BUY_IN });
    await table.startHand();
    await checkOrCallToShowdown(table, ADA);

    const view = viewOf(table, ADA);
    assert.equal(view.street, 'complete', 'the terminal street is `complete`');
    const result = view.result;
    assert.ok(result !== null, 'a completed hand carries a result');

    // The hand was entirely ordinary. Both blinds were posted, both seats acted, both showed down,
    // and the pot was split because neither pair of hole cards could beat the board.
    const kinds = view.forcedBets.map((bet) => bet.kind).sort();
    assert.deepEqual(kinds, ['bigBlind', 'smallBlind'], 'both blinds were posted');
    assert.equal(result.endedByFold, false, 'nobody folded');
    assert.equal(result.showdowns.length, 2, 'both hands were shown down');
    const [first, second] = result.showdowns;
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(first.score, second.score, 'the board played for both, so the scores are equal');
    assert.deepEqual([...first.bestFive].sort(), [...view.board].sort(), 'the best five IS the board');
    assert.ok(
      result.awards.length === 2 && result.awards.every((award) => award.wasSplit),
      'the pot was chopped',
    );
    assert.ok(view.actions.length >= 4, 'the seats really played the hand out');

    // ## The counterexample itself
    //
    // This is the state `assert.ok(stacks.some((stack) => stack !== 1_000))` called a hand whose
    // blinds were never posted. Asserted the way round that documents it: after a legal, settled,
    // fully played hand, EVERY stack is untouched. Any future edit that reintroduces "somebody's
    // stack moved" as a proxy for "the hand really happened" fails right here, deterministically,
    // instead of once every twenty-odd runs of a CSPRNG-dealt gate.
    assert.deepEqual(
      view.seats.map((seat) => seat.stack),
      view.seats.map(() => BUY_IN),
      'a chopped pot returns every seat to exactly its starting stack',
    );
    assert.deepEqual(
      table.snapshot().seats.map((seat) => seat.stack),
      [BUY_IN, BUY_IN],
      'settlement wrote the same figures back to the seating',
    );

    // ## And the checks that replaced it, on the same view
    //
    // Each one is strictly stronger than "somebody's stack moved": a hand that never posted its
    // blinds commits nothing and fails the first, a pot that is formed and then not paid out fails
    // the second, and a settlement that pays the wrong seat fails the third.
    const committed = view.seats.reduce((total, seat) => total + seat.committedTotal, 0);
    assert.ok(
      committed >= CONFIG.smallBlind + CONFIG.bigBlind,
      `the blinds were never posted: the seats committed ${committed} in total`,
    );
    const awarded = result.awards.reduce((total, award) => total + award.amount, 0);
    const potted = result.pots.reduce((total, pot) => total + pot.amount, 0);
    assert.ok(awarded > 0, 'a completed hand awards the pot to somebody');
    assert.equal(awarded, potted, 'every chip in every pot is awarded to somebody');
    assert.deepEqual(
      view.seats.map((seat) => seat.stack),
      view.seats.map((seat) => BUY_IN + (result.netBySeat[seat.seat] ?? 0)),
      'every seat closes on the stack it started with plus its net for the hand',
    );
  });
});

// ---------------------------------------------------------------------------
// The hypothesis: could a hand ever be dealt to one live seat?
// ---------------------------------------------------------------------------

describe('a hand is never dealt to one live seat', () => {
  it('refuses to deal when only one seat could play', async () => {
    const table = tableWith(createSecureRandom());
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: BUY_IN });
    await assert.rejects(
      table.startHand(),
      (error: unknown) => isAppError(error) && error.code === 'illegal_action',
      'one seated player is not a hand',
    );

    // A seat with no chips is not an entrant either — it cannot post, so dealing it in would put a
    // player in a hand they can take no part in.
    await table.sit({ userId: BO, displayName: 'Bo', seat: 1, stack: 0 });
    await assert.rejects(
      table.startHand(),
      (error: unknown) => isAppError(error) && error.code === 'illegal_action',
      'a busted seat cannot make up the second player',
    );
    assert.equal(table.handId, null, 'no hand was dealt');
  });

  it('restarts the rotation rather than deal to the one seat that does not owe a blind', async () => {
    const table = tableWith(createSecureRandom());
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: BUY_IN });
    await table.sit({ userId: BO, displayName: 'Bo', seat: 1, stack: BUY_IN });
    await table.startHand();

    // Whoever posted the big blind, the next one goes to the other seat. Replacing *that* player is
    // what leaves a newcomer owing a blind they cannot be charged for two hands running, and it is
    // the shape that would deadlock a two-handed table: one seat live, one waiting, and no hand to
    // advance the rotation that would end the wait.
    const dealt = viewOf(table, ADA);
    const bigBlind = dealt.forcedBets.find((bet) => bet.kind === 'bigBlind');
    assert.ok(bigBlind !== undefined, 'every hand posts a big blind');
    const leavingUserId = dealt.seats.find((seat) => seat.seat === bigBlind.seat)?.playerId;
    assert.ok(leavingUserId !== undefined, 'the big blind belongs to a dealt seat');
    await foldItOut(table, ADA);

    // Banked before they leave: a player who stands up takes their chips off the table, so a
    // conservation check that only added up the seating would report every departure as chips
    // destroyed.
    const banked = table.snapshot().seats.find((seat) => seat.userId === leavingUserId)?.stack;
    assert.ok(banked !== undefined, 'the departing player holds a stack');
    await table.stand(leavingUserId);
    await table.sit({ userId: CY, displayName: 'Cy', seat: bigBlind.seat, stack: BUY_IN });
    assert.equal(table.owesBlind(CY), true, 'a newcomer to a running rotation owes the big blind');
    assert.deepEqual(
      table.snapshot().awaitingBigBlind,
      [bigBlind.seat],
      'and the table reports it, because a seated player receiving no cards needs explaining',
    );

    // The deadlock guard: honouring that obligation would leave one seat in the hand, so the game
    // restarts — every debt discharged, the rotation re-seeded, everybody posting normally. What it
    // must never do is deal the hand anyway with a single live seat, which would award that seat
    // its own blind back for a net of zero and read exactly like a hand that never happened.
    await table.startHand();
    const restarted = viewOf(table, CY);
    const playing = restarted.seats.filter((seat) => seat.status !== 'sittingOut');
    assert.equal(playing.length, 2, `a hand was dealt to ${playing.length} live seat(s)`);
    assert.deepEqual(
      restarted.forcedBets.map((bet) => bet.kind).sort(),
      ['bigBlind', 'smallBlind'],
      'a restarted game posts both blinds normally',
    );
    assert.equal(table.owesBlind(CY), false, 'the restart discharged the obligation');
    assert.deepEqual(table.snapshot().awaitingBigBlind, [], 'and nobody is left waiting');

    await foldItOut(table, CY);
    const onTable = table.snapshot().seats.reduce((total, seat) => total + seat.stack, 0);
    assert.equal(onTable + banked, 3 * BUY_IN, 'the restarted hand conserved chips');
  });
});

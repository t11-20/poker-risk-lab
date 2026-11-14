/**
 * A settled hand need not move any stack. A chopped pot pays every seat back what it put in.
 * Asserting "somebody's stack moved" fails on CSPRNG chops (2 of 40 runs), so this pins the
 * counterexample deterministically plus the checks to make instead.
 * It also drives the deadlock guard in `LiveTable.nextRotation`, which restarts the game rather than
 * deal a hand to one live seat.
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
 * Broadway in three suits with no pair on the board. No two hole cards can beat it, so both seats
 * play the board and the chop does not depend on the engine's deal order.
 */
const CHOPPING_DECK = '2c 3d 4h 5s As Ks Qd Jc Th';

/** The first four cards are the hole cards and the next five the board (`machine.ts` burns nothing). */
function deckStartingWith(prefix: string): Card[] {
  const front = parseCards(prefix);
  const used = new Set(front);
  assert.equal(used.size, front.length, 'the scripted prefix repeats a card');
  return [...front, ...orderedDeck().filter((card) => !used.has(card))];
}

/**
 * A `RandomSource` whose shuffle lands one chosen deck, every hand. `LiveTable` has no fixed-deck
 * seam by design, so this inverts the engine's Fisher-Yates (`i` from 51 down, card at `i` final
 * after its swap) to find the draws that produce `deck`.
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
      // Commitment salts. Nothing here reads them.
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

function viewOf(table: LiveTable, userId: string): PlayerView {
  const view = table.viewFor(userId);
  assert.ok(view !== null, `${userId} sees no hand`);
  return view;
}

/** Never folds, so the hand reaches a showdown. */
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

    // "Somebody's stack moved" is not a proxy for "the hand happened". Every stack is untouched here.
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

    // What a settled hand does mean: blinds are committed, every pot is paid out, and each stack
    // equals start plus net.
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

describe('a hand is never dealt to one live seat', () => {
  it('refuses to deal when only one seat could play', async () => {
    const table = tableWith(createSecureRandom());
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: BUY_IN });
    await assert.rejects(
      table.startHand(),
      (error: unknown) => isAppError(error) && error.code === 'illegal_action',
      'one seated player is not a hand',
    );

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

    // Replacing the big blind leaves a newcomer owing a blind, which would deadlock a two-handed table.
    const dealt = viewOf(table, ADA);
    const bigBlind = dealt.forcedBets.find((bet) => bet.kind === 'bigBlind');
    assert.ok(bigBlind !== undefined, 'every hand posts a big blind');
    const leavingUserId = dealt.seats.find((seat) => seat.seat === bigBlind.seat)?.playerId;
    assert.ok(leavingUserId !== undefined, 'the big blind belongs to a dealt seat');
    await foldItOut(table, ADA);

    // Read before standing, because a player who stands takes their chips off the table.
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

    // The guard restarts the game. Dealing to one live seat would return its own blind for a net of zero.
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

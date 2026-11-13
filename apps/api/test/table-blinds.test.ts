/**
 * Blinds and the button across a changing roster, the coverage hole in
 * `docs/audit/poker-correctness.md` (P1-1). The dead-button rule moves the big blind by exactly one
 * live player per hand, and the button follows from that. A dead small blind or button is correct.
 * Over the schedule, no player may pay the big blind twice running and no seat may be skipped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSecureRandom, nextOccupied } from '@prl/poker-engine';
import { LiveTable, type TableSeat } from '../src/rooms/table.ts';
import { systemClock } from '../src/rooms/timers.ts';

const CONFIG = { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 } as const;
const BUY_IN = 1_000;

function incrementingHandIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_blinds${count}`;
  };
}

interface HandRecord {
  readonly handNumber: number;
  /** Seated, with chips, not leaving. */
  readonly entrants: readonly number[];
  /** A subset of `entrants` once obligations exist. */
  readonly dealtIn: readonly number[];
  readonly buttonSeat: number | null;
  readonly smallBlindSeat: number | null;
  readonly bigBlindSeat: number;
  readonly bigBlindUserId: string;
  readonly smallBlindUserId: string | null;
  readonly posted: ReadonlyMap<string, number>;
}

/** Chips are banked when a player stands, or conservation would count each departure as lost chips. */
class Simulation {
  readonly table: LiveTable;
  readonly hands: HandRecord[] = [];
  private banked = 0;
  private boughtIn = 0;
  private actionCount = 0;

  constructor() {
    this.table = new LiveTable({
      roomId: 'room_blinds',
      config: CONFIG,
      clock: systemClock,
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
    });
  }

  async sit(userId: string, seat: number): Promise<void> {
    await this.table.sit({ userId, displayName: userId, seat, stack: BUY_IN });
    this.boughtIn += BUY_IN;
  }

  async stand(userId: string): Promise<void> {
    const seat = this.seatedAs(userId);
    assert.ok(seat !== undefined, `${userId} is not seated`);
    this.banked += seat.stack;
    await this.table.stand(userId);
  }

  private seatedAs(userId: string): TableSeat | undefined {
    return this.table.snapshot().seats.find((entry) => entry.userId === userId);
  }

  chipsInSystem(): number {
    const onTable = this.table.snapshot().seats.reduce((sum, seat) => sum + seat.stack, 0);
    return onTable + this.banked;
  }

  chipsBoughtIn(): number {
    return this.boughtIn;
  }

  async playHand(): Promise<HandRecord> {
    const before = this.table.snapshot();
    const entrants = before.seats
      .filter((seat) => seat.stack > 0 && !seat.leaving)
      .map((seat) => seat.seat)
      .sort((left, right) => left - right);

    await this.table.startHand();

    // The spectator view carries forced bets, roster and button. Nothing here reads a card.
    const observer = before.seats[0]?.userId;
    assert.ok(observer !== undefined, 'a hand needs somebody at the table');
    const view = this.table.viewFor(observer);
    assert.ok(view !== null, 'a dealt hand must produce a view');

    const userOfSeat = new Map(view.seats.map((seat) => [seat.seat, seat.playerId]));
    const posted = new Map<string, number>();
    let bigBlindSeat: number | null = null;
    let smallBlindSeat: number | null = null;
    for (const bet of view.forcedBets) {
      const userId = userOfSeat.get(bet.seat);
      assert.ok(userId !== undefined, `forced bet from unseated seat ${bet.seat}`);
      posted.set(userId, (posted.get(userId) ?? 0) + bet.amount);
      if (bet.kind === 'bigBlind') bigBlindSeat = bet.seat;
      if (bet.kind === 'smallBlind') smallBlindSeat = bet.seat;
    }
    assert.ok(bigBlindSeat !== null, 'every hand posts a big blind');
    const bigBlindUserId = userOfSeat.get(bigBlindSeat);
    assert.ok(bigBlindUserId !== undefined, 'the big blind must belong to a dealt seat');

    const record: HandRecord = {
      handNumber: view.handNumber,
      entrants,
      dealtIn: view.seats
        .filter((seat) => seat.status !== 'sittingOut')
        .map((seat) => seat.seat)
        .sort((left, right) => left - right),
      buttonSeat: this.table.snapshot().buttonSeat,
      smallBlindSeat,
      bigBlindSeat,
      bigBlindUserId,
      smallBlindUserId: smallBlindSeat === null ? null : (userOfSeat.get(smallBlindSeat) ?? null),
      posted,
    };
    this.hands.push(record);

    await this.foldItOut(observer);
    return record;
  }

  /** The subject is who was charged, not who won. `fold` is always legal. */
  private async foldItOut(observer: string): Promise<void> {
    for (let guard = 0; guard <= 64; guard += 1) {
      const view = this.table.viewFor(observer);
      if (view === null || view.toAct === null) return;
      const actor = view.seats.find((seat) => seat.seat === view.toAct)?.playerId;
      assert.ok(actor !== undefined, `seat ${String(view.toAct)} is to act but holds no player`);
      this.actionCount += 1;
      await this.table.submitAction(actor, {
        action: { type: 'fold' },
        actionId: `act_${this.actionCount}`,
        expectedSequence: view.actionSequence,
      });
    }
    assert.fail('a folded-round hand did not finish');
  }
}

function seatsJumped(from: number, to: number, entrants: readonly number[]): number[] {
  const jumped: number[] = [];
  for (let step = 1; step <= CONFIG.maxSeats; step += 1) {
    const candidate = (from + step) % CONFIG.maxSeats;
    if (candidate === to) return jumped;
    if (entrants.includes(candidate)) jumped.push(candidate);
  }
  return jumped;
}

interface Tally {
  readonly doubleBigBlinds: number;
  readonly skippedBigBlinds: number;
  readonly detail: readonly string[];
}

function tally(hands: readonly HandRecord[]): Tally {
  let doubleBigBlinds = 0;
  let skippedBigBlinds = 0;
  const detail: string[] = [];
  for (const [index, hand] of hands.entries()) {
    const previous = hands[index - 1];
    if (previous === undefined) continue;
    if (previous.bigBlindUserId === hand.bigBlindUserId) {
      doubleBigBlinds += 1;
      detail.push(
        `hand ${hand.handNumber}: ${hand.bigBlindUserId} paid the big blind twice in a row ` +
          `(seat ${previous.bigBlindSeat} then seat ${hand.bigBlindSeat})`,
      );
    }
    const jumped = seatsJumped(previous.bigBlindSeat, hand.bigBlindSeat, hand.entrants);
    if (jumped.length > 0) {
      skippedBigBlinds += jumped.length;
      detail.push(
        `hand ${hand.handNumber}: the big blind moved ${previous.bigBlindSeat} -> ` +
          `${hand.bigBlindSeat} and jumped seat(s) ${jumped.join(', ')}`,
      );
    }
  }
  return { doubleBigBlinds, skippedBigBlinds, detail };
}

/**
 * Applied before the numbered hand is dealt. Covers a join between button and blinds, a dead small
 * blind, a dead button, a stand-and-sit dodge, a drop to heads-up and a return to three-handed.
 */
const SCHEDULE: ReadonlyMap<number, readonly (readonly [string, number | null])[]> = new Map([
  [1, [['A', 0] as const, ['B', 1] as const, ['C', 3] as const]],
  // The audit's minimal repro.
  [2, [['D', 2] as const]],
  [5, [['E', 5] as const]],
  // Seat 3 is the small blind in hand 9, so it becomes dead.
  [9, [['C', null] as const]],
  [12, [['F', 4] as const]],
  // The P1-2 dodge.
  [15, [['A', null] as const]],
  [17, [['A', 0] as const]],
  [20, [['D', null] as const, ['E', null] as const]],
  [23, [['F', null] as const]],
  [26, [['G', 3] as const]],
  [30, [['B', null] as const]],
  [33, [['H', 1] as const]],
  [36, [['I', 5] as const]],
]);

async function applySchedule(simulation: Simulation, handNumber: number): Promise<void> {
  for (const [userId, seat] of SCHEDULE.get(handNumber) ?? []) {
    if (seat === null) await simulation.stand(userId);
    else await simulation.sit(userId, seat);
  }
}

describe('blinds and the button across a changing roster', () => {
  it('never charges the big blind twice in a row and never skips it, over 40 hands', async () => {
    const simulation = new Simulation();
    for (let handNumber = 1; handNumber <= 40; handNumber += 1) {
      await applySchedule(simulation, handNumber);
      await simulation.playHand();
      assert.equal(
        simulation.chipsInSystem(),
        simulation.chipsBoughtIn(),
        `chips were created or destroyed by hand ${handNumber}`,
      );
    }

    const counts = tally(simulation.hands);
    assert.equal(
      `${counts.doubleBigBlinds} double / ${counts.skippedBigBlinds} skipped`,
      '0 double / 0 skipped',
      `blind rotation broke over ${simulation.hands.length} hands:\n  ${counts.detail.join('\n  ')}`,
    );
  });

  it('advances the big blind by exactly one seat in the rotation, every hand', async () => {
    const simulation = new Simulation();
    for (let handNumber = 1; handNumber <= 40; handNumber += 1) {
      await applySchedule(simulation, handNumber);
      await simulation.playHand();
    }

    for (const [index, hand] of simulation.hands.entries()) {
      const previous = simulation.hands[index - 1];
      if (previous === undefined) continue;
      const expected = nextOccupied(previous.bigBlindSeat, CONFIG.maxSeats, hand.entrants);
      assert.equal(
        hand.bigBlindSeat,
        expected,
        `hand ${hand.handNumber}: the big blind should have moved from seat ${previous.bigBlindSeat} ` +
          `to seat ${expected} (rotation ${hand.entrants.join(',')}) but landed on ${hand.bigBlindSeat}`,
      );
    }
  });

  it('reproduces the audit repro with the button behind the big blind, not in front of it', async () => {
    const simulation = new Simulation();
    await simulation.sit('A', 0);
    await simulation.sit('B', 1);
    await simulation.sit('C', 3);

    const first = await simulation.playHand();
    assert.deepEqual(
      { button: first.buttonSeat, small: first.smallBlindSeat, big: first.bigBlindSeat },
      { button: 1, small: 3, big: 0 },
      'the first hand deals BTN 1 / SB 3 / BB 0',
    );

    // The old rule moved the button onto seat 2 and charged seat 0 a second big blind.
    await simulation.sit('D', 2);
    const second = await simulation.playHand();
    assert.notEqual(second.bigBlindSeat, first.bigBlindSeat, 'seat 0 must not pay the big blind twice');
    assert.equal(second.bigBlindSeat, 1, 'the big blind advances one live player, from seat 0 to seat 1');
    assert.equal(second.smallBlindSeat, 0, 'the small blind falls on the previous big blind, seat 0');
    assert.equal(second.buttonSeat, 3, 'the button falls on the previous small blind, seat 3');
  });

  it('leaves the small blind dead rather than moving it onto somebody who has already paid', async () => {
    const simulation = new Simulation();
    await simulation.sit('A', 0);
    await simulation.sit('B', 1);
    await simulation.sit('C', 2);
    await simulation.sit('D', 3);

    const first = await simulation.playHand();
    assert.equal(first.buttonSeat, 1);
    assert.equal(first.smallBlindSeat, 2);
    assert.equal(first.bigBlindSeat, 3);

    // Nobody sits in the next small blind's seat, so it is dead.
    await simulation.stand('D');
    const second = await simulation.playHand();
    assert.equal(second.bigBlindSeat, 0, 'the big blind advances to the next live player');
    assert.equal(second.smallBlindSeat, null, 'the small blind is dead: its seat is empty');
    assert.equal(second.buttonSeat, 2, 'the button falls on the previous small blind');
    assert.equal(second.posted.get('A'), CONFIG.bigBlind);
    assert.equal(second.posted.get('B'), undefined);
    assert.equal(second.posted.get('C'), undefined);
  });

  it('leaves the button dead rather than handing it to the wrong seat', async () => {
    const simulation = new Simulation();
    await simulation.sit('A', 0);
    await simulation.sit('B', 1);
    await simulation.sit('C', 2);
    await simulation.sit('D', 3);

    const first = await simulation.playHand();
    assert.equal(first.smallBlindSeat, 2);

    // Moving the button forward would move the blinds with it and charge somebody twice.
    await simulation.stand('C');
    const second = await simulation.playHand();
    assert.equal(second.bigBlindSeat, 0, 'the big blind advances to the next live player');
    assert.equal(second.smallBlindSeat, 3, 'the small blind falls on the previous big blind');
    assert.equal(second.buttonSeat, 2, 'the button stays on the empty seat 2: a dead button');
    assert.ok(!second.dealtIn.includes(2), 'the dead button seat holds no cards');
  });
});

describe('the blind obligation a newcomer owes', () => {
  it('does not deal a newcomer in until the big blind reaches them', async () => {
    const simulation = new Simulation();
    await simulation.sit('A', 0);
    await simulation.sit('B', 1);
    await simulation.sit('C', 2);
    await simulation.playHand();

    // Under the old rule this newcomer was dealt in for free, in position.
    await simulation.sit('N', 4);

    const dealtInBefore: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const hand = await simulation.playHand();
      if (hand.bigBlindSeat === 4) {
        assert.ok(hand.dealtIn.includes(4), 'the newcomer is dealt in on the hand they post the big blind');
        assert.equal(hand.posted.get('N'), CONFIG.bigBlind, 'and they post a full big blind for it');
        assert.deepEqual(dealtInBefore, [], 'the newcomer played no hand before posting');
        return;
      }
      if (hand.dealtIn.includes(4)) dealtInBefore.push(hand.handNumber);
    }
    assert.fail('the big blind never reached the newcomer');
  });

  it('cannot be dodged by standing up as the blinds approach and sitting back down', async () => {
    const simulation = new Simulation();
    await simulation.sit('A', 0);
    await simulation.sit('B', 1);
    await simulation.sit('C', 2);
    await simulation.sit('D', 3);

    let reached = false;
    for (let index = 0; index < 8 && !reached; index += 1) {
      const hand = await simulation.playHand();
      reached = hand.bigBlindSeat === 1;
    }
    assert.ok(reached, 'the big blind never reached seat 1');

    await simulation.stand('D');
    await simulation.sit('D', 3);

    // The obligation follows the person, not the chair.
    assert.ok(simulation.table.owesBlind('D'), 'the returning player owes a blind');
    const skipped = await simulation.playHand();
    assert.equal(skipped.bigBlindSeat, 2, 'the rotation carries on regardless');
    assert.ok(!skipped.dealtIn.includes(3), 'the returning player is not dealt a free hand');

    const paid = await simulation.playHand();
    assert.equal(paid.bigBlindSeat, 3, 'the big blind reaches the returning player');
    assert.ok(paid.dealtIn.includes(3), 'and they are dealt in on that hand');
    assert.equal(paid.posted.get('D'), CONFIG.bigBlind, 'having posted a full big blind for it');
    assert.ok(!simulation.table.owesBlind('D'), 'the obligation is discharged by posting');
  });
});

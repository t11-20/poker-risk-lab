/**
 * Blinds and the button across a CHANGING roster.
 *
 * ## Why this file exists
 *
 * Every other test of the table deals to a roster that is fixed before the first hand and never
 * moves again, so the only rotation they ever exercise is "button + 1 / button + 2 over the same
 * six seats" — which is correct, and which is also the one case in which the defect this file
 * covers cannot appear. `docs/audit/poker-correctness.md` (P1-1) called that the one genuine
 * coverage hole in the engine, measured it over 40 hands with a scripted join/leave schedule, and
 * found **6 players paying the big blind twice in a row and 1 skipping it entirely**.
 *
 * The old rule advanced the BUTTON by one occupied seat and then read the blinds off it as
 * button + 1 / button + 2 among whoever happened to be seated at that instant. Seat a player
 * between the button and the blinds and the whole assignment shifts backwards under the players
 * who had already paid: seats 0/1/3 deal `BTN 1 / SB 3 / BB 0`, somebody takes seat 2, and the
 * next hand deals `BTN 2 / SB 3 / BB 0` — seat 0 pays the big blind twice, and pays `2 × BB`
 * where the rules charge `BB + SB`.
 *
 * The rule that fixes it is the dead-button rule, and it is stated the other way round: the BIG
 * BLIND advances by exactly one live player per hand, and the button is whatever falls out of
 * that. A dead small blind (nobody posts it) and a dead button (it sits in an empty chair) are
 * legitimate outcomes, not errors.
 *
 * ## What is asserted
 *
 * The simulation below is not a smoke test. It counts, over the whole schedule:
 *
 *   - `doubleBigBlinds` — a player charged the big blind in two consecutive hands.
 *   - `skippedBigBlinds` — a seat in the rotation that the big blind jumped over.
 *
 * Both must be zero, and the counts are reported in the assertion message so a regression says
 * how bad it is rather than merely that it happened. On top of that: the big blind must land on
 * the very next seat in the rotation every single hand (the rule itself, asserted directly), a
 * newcomer must not be dealt a free hand, the obligation must survive a stand/sit cycle, and
 * chips must be conserved after every hand.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSecureRandom, nextOccupied } from '@prl/poker-engine';
import { LiveTable, type TableSeat } from '../src/rooms/table.ts';
import { systemClock } from '../src/rooms/timers.ts';

const CONFIG = { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 } as const;
const BUY_IN = 1_000;

/** Readable, sequential hand ids, so a failure names the hand it happened in. */
function incrementingHandIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_blinds${count}`;
  };
}

/** One dealt hand, reduced to the facts the blind rules are about. */
interface HandRecord {
  readonly handNumber: number;
  /** Seats in the blind rotation when the hand was dealt: seated, with chips, not leaving. */
  readonly entrants: readonly number[];
  /** Seats actually dealt cards. A subset of `entrants` once obligations exist. */
  readonly dealtIn: readonly number[];
  readonly buttonSeat: number | null;
  readonly smallBlindSeat: number | null;
  readonly bigBlindSeat: number;
  readonly bigBlindUserId: string;
  readonly smallBlindUserId: string | null;
  /** Chips each user posted as a forced bet in this hand. */
  readonly posted: ReadonlyMap<string, number>;
}

/**
 * A table plus the bookkeeping the assertions need.
 *
 * Chips are tracked by hand rather than read back out of the table, because a player who stands
 * up leaves the seating altogether: without banking their closing stack at that moment, a
 * conservation check would report every departure as destroyed chips.
 */
class Simulation {
  readonly table: LiveTable;
  readonly hands: HandRecord[] = [];
  /** Chips belonging to players who have stood up, so the total stays comparable. */
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

  /** Total chips in the system: everything on the table plus everything carried away. */
  chipsInSystem(): number {
    const onTable = this.table.snapshot().seats.reduce((sum, seat) => sum + seat.stack, 0);
    return onTable + this.banked;
  }

  chipsBoughtIn(): number {
    return this.boughtIn;
  }

  /** Deals one hand, records who paid what, then folds it round to a conclusion. */
  async playHand(): Promise<HandRecord> {
    const before = this.table.snapshot();
    const entrants = before.seats
      .filter((seat) => seat.stack > 0 && !seat.leaving)
      .map((seat) => seat.seat)
      .sort((left, right) => left - right);

    await this.table.startHand();

    // Any seated user will do: `forcedBets`, the seat roster and the button are public, and the
    // spectator view carries all three. Nothing here reads a card.
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

  /**
   * Folds every decision until the hand is over.
   *
   * Folding rather than calling keeps the hand short and the chip movement trivial, which is what
   * this file wants: the subject is who was CHARGED, not who won. `fold` is always in the legal
   * set (betting.ts offers it even when checking is free), so no policy is needed.
   */
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

/** Seats strictly between `from` and `to`, walking clockwise. The seats the big blind jumped. */
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
 * The schedule, applied BEFORE the numbered hand is dealt.
 *
 * Chosen to cover every case the rule has to survive rather than to be random: a join between the
 * button and the blinds (the audit's minimal repro), a departure from the small blind seat (a dead
 * small blind), a departure from the button seat (a dead button), a stand-and-sit straddling the
 * blinds (the dodge), a drop to heads-up and a return to three handed.
 */
const SCHEDULE: ReadonlyMap<number, readonly (readonly [string, number | null])[]> = new Map([
  [1, [['A', 0] as const, ['B', 1] as const, ['C', 3] as const]],
  // The audit's minimal repro: a newcomer takes the seat between the button and the blinds.
  [2, [['D', 2] as const]],
  [5, [['E', 5] as const]],
  // C holds seat 3, which is where the small blind falls in hand 9 — a dead small blind.
  [9, [['C', null] as const]],
  [12, [['F', 4] as const]],
  // A stands as the blinds approach and comes straight back: the dodge P1-2 describes.
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

    // The rule itself, asserted directly rather than through its symptoms. Everything else in
    // this file — no double, no skip, a fair share of the blinds — is a consequence of it.
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

    // The newcomer takes the seat between the button and the small blind. Under the old rule the
    // button moved onto seat 2 and dragged the blinds back onto seats 3 and 0, charging seat 0 a
    // second consecutive big blind.
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

    // The big blind leaves. The small blind for the next hand belongs to their seat, and there is
    // nobody in it: it is dead, and the three remaining players post one blind between them.
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

    // The small blind leaves, so the button — which belongs on their seat next hand — has nobody
    // to sit on. A dead button is the correct outcome; moving it forward would move the blinds
    // with it and charge somebody twice.
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

    // Seat 4 is two seats behind the blinds: under the old rule this newcomer was dealt straight
    // in, in position, having paid nothing.
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

    // Play until the big blind is on seat 1, which leaves D on seat 3 two hands away from paying
    // it — the moment the dodge is worth attempting.
    let reached = false;
    for (let index = 0; index < 8 && !reached; index += 1) {
      const hand = await simulation.playHand();
      reached = hand.bigBlindSeat === 1;
    }
    assert.ok(reached, 'the big blind never reached seat 1');

    await simulation.stand('D');
    await simulation.sit('D', 3);

    // The hand D was trying to buy: under the old rule they were seated and dealt straight back
    // in, having paid nothing and skipped nothing. The obligation follows the person, not the
    // chair, so the round trip bought them nothing at all.
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

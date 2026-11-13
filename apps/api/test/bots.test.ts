/**
 * What a bot can know, and that a bot-driven hand is a real hand. The `PolicyInput` type is only a
 * promise, so the first test walks the actual input a bot was handed for secret field names, a
 * 52-card permutation, and the other seat's two cards together. Cards are small integers, so a
 * blanket "no number equal to a card" scan would collide with seat indices and pot sizes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PolicyInput } from '@prl/poker-ai';
import { DIFFICULTY_SETTINGS, decide, expressTraits, OpponentModel, requireProfile } from '@prl/poker-ai';
import { cardToString, createSecureRandom, parseCards, redactFor, verifyDeckReveal } from '@prl/poker-engine';
import { AppError } from '../src/errors.ts';
import {
  BotRunner,
  buildHypotheticalState,
  buildPolicyInput,
  createSeededRandom,
  seedFor,
} from '../src/rooms/bots.ts';
import { LiveTable, type TableNotice } from '../src/rooms/table.ts';
import { createManualClock, type ManualClock } from '../src/rooms/timers.ts';

function incrementingHandIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_bot${count}`;
  };
}

const SECRET_FIELD_NAMES = ['deck', 'deckcursor', 'decksalts', 'salts', 'salt', 'commitmentsalt'];
const THINKING_DELAY_MS = 10;

interface Harness {
  readonly table: LiveTable;
  readonly runner: BotRunner;
  readonly clock: ManualClock;
  readonly inputs: PolicyInput[];
  readonly notices: TableNotice[];
  readonly problems: string[];
}

async function botTable(
  options: { readonly stack?: number; readonly profiles?: readonly [string, string] } = {},
): Promise<Harness> {
  const clock = createManualClock();
  const inputs: PolicyInput[] = [];
  const notices: TableNotice[] = [];
  const problems: string[] = [];
  const profiles = options.profiles ?? (['patient-technician', 'calling-station'] as const);

  const table = new LiveTable({
    roomId: 'room_bots',
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
    clock,
    random: createSecureRandom(),
    nextHandId: incrementingHandIds(),
    onProblem: (message) => problems.push(message),
  });
  table.subscribe((notice) => notices.push(notice));

  const runner = new BotRunner({
    table,
    clock,
    thinkingDelayMs: THINKING_DELAY_MS,
    onProblem: (message) => problems.push(message),
    onDecision: (input) => inputs.push(input),
  });

  for (const [index, profileId] of profiles.entries()) {
    const userId = `usr_bot${index}`;
    await table.sit({
      userId,
      displayName: `Bot ${index}`,
      seat: index,
      stack: options.stack ?? 1_000,
      isBot: true,
      botProfile: profileId,
    });
    runner.add({
      userId,
      seat: index,
      profileId,
      difficulty: 'educational',
      seed: seedFor('room_bots', index, 4_242),
    });
  }

  return { table, runner, clock, inputs, notices, problems };
}

async function playOut(harness: Harness, maxTicks = 400): Promise<number> {
  let ticks = 0;
  while (harness.table.handInProgress && ticks < maxTicks) {
    harness.clock.advance(THINKING_DELAY_MS);
    await new Promise((resolve) => setImmediate(resolve));
    ticks += 1;
  }
  assert.ok(!harness.table.handInProgress, `the hand did not finish within ${maxTicks} ticks`);
  return ticks;
}

interface Walked {
  readonly keys: Set<string>;
  readonly numberArrays: number[][];
  readonly strings: string[];
}

/**
 * Walks Maps, Sets and typed arrays by hand. `JSON.stringify` renders the opponent model's `Map` and
 * the random closure as `{}`, so the scan would pass without looking at anything.
 */
function walk(value: unknown, into: Walked, depth = 0, seen = new WeakSet<object>()): void {
  if (depth > 12) return;
  if (typeof value === 'string') {
    into.strings.push(value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (value instanceof Uint8Array) {
    into.numberArrays.push([...value]);
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === 'number')) into.numberArrays.push([...value]);
    for (const entry of value) walk(entry, into, depth + 1, seen);
    return;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (typeof key === 'string') into.keys.add(key.toLowerCase());
      walk(entry, into, depth + 1, seen);
    }
    return;
  }
  if (value instanceof Set) {
    for (const entry of value) walk(entry, into, depth + 1, seen);
    return;
  }
  // The prototype's names too, so a class holding private state is walked.
  const names = new Set<string>([
    ...Object.keys(value),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(value) ?? {}),
  ]);
  for (const name of names) {
    if (name === 'constructor') continue;
    into.keys.add(name.toLowerCase());
    let entry: unknown;
    try {
      entry = Reflect.get(value, name);
    } catch {
      continue;
    }
    if (typeof entry === 'function') continue;
    walk(entry, into, depth + 1, seen);
  }
}

function walked(value: unknown): Walked {
  const into: Walked = { keys: new Set<string>(), numberArrays: [], strings: [] };
  walk(value, into);
  return into;
}

describe('what a bot can see', () => {
  it('is handed a PolicyInput with no deck, no salts and no opponent hole cards', async () => {
    const harness = await botTable();
    await harness.table.startHand();
    // One tick, so a decision exists and no showdown has made any card public yet.
    harness.clock.advance(THINKING_DELAY_MS);
    await new Promise((resolve) => setImmediate(resolve));

    const input = harness.inputs.at(0);
    assert.ok(input !== undefined, 'a bot must have been asked to decide');

    const ownSeat = input.seat;
    const otherUserId = ownSeat === 0 ? 'usr_bot1' : 'usr_bot0';
    const otherView = harness.table.viewFor(otherUserId);
    assert.ok(otherView !== null);
    const otherCards = otherView.seats.find((seat) => seat.seat !== ownSeat)?.holeCards ?? null;
    assert.ok(otherCards !== null, 'the other seat must be holding two cards');

    assert.deepEqual(
      Object.keys(input).sort(),
      ['difficulty', 'holeCards', 'observations', 'random', 'seat', 'traits', 'view'],
      'a policy input must carry nothing beyond the contract',
    );
    assert.deepEqual(
      [...input.holeCards],
      [...(input.view.seats.find((seat) => seat.seat === ownSeat)?.holeCards ?? [])],
      'the seat’s own cards come from its own view and nowhere else',
    );

    const scan = walked(input);

    for (const name of SECRET_FIELD_NAMES) {
      assert.ok(!scan.keys.has(name), `a policy input must not carry a field named "${name}"`);
    }

    for (const array of scan.numberArrays) {
      const distinct = new Set(array);
      assert.ok(
        !(array.length === 52 && distinct.size === 52),
        'a policy input contained a full 52-card deck',
      );
    }

    // Exact, not "contains". One card matches lists of seat indices, and `'8c'` appears inside a hex
    // commitment root every few hundred hands. A leak is a pair in one array or a card-notation value.
    const [first, second] = otherCards;
    for (const array of scan.numberArrays) {
      assert.ok(
        !(array.includes(first) && array.includes(second)),
        `a policy input leaked ${cardToString(first)}${cardToString(second)} in one array`,
      );
    }
    const forbiddenNotations = new Set(otherCards.map((card) => cardToString(card)));
    for (const text of scan.strings) {
      assert.ok(!forbiddenNotations.has(text), `a policy input leaked the card "${text}" as a value`);
    }

    for (const seat of input.view.seats) {
      if (seat.seat === ownSeat) continue;
      assert.equal(seat.holeCards, null, `seat ${seat.seat} exposed its cards to seat ${ownSeat}`);
    }
    for (const card of input.view.board) {
      assert.ok(!otherCards.includes(card), 'a board card cannot also be an opponent card');
    }
    assert.equal(input.view.result, null, 'a live hand has no result to reveal');

    harness.table.close();
  });

  it('refuses to build an input from a view redacted for another seat', () => {
    const state = buildHypotheticalState({
      heroCards: parseCards('AhKh'),
      board: parseCards('Qh7h2c9s3d'),
      street: 'river',
      pot: 200,
      toCall: 100,
      heroStack: 900,
      opponentStack: 900,
      bigBlind: 10,
    });
    const profile = requireProfile('calling-station');
    const wrongSeatsView = redactFor(state, { viewerSeat: 0 });

    assert.throws(
      () =>
        buildPolicyInput({
          view: wrongSeatsView,
          // Seat 1's policy with seat 0's view would play somebody else's cards.
          seat: 1,
          traits: expressTraits(profile, 'educational'),
          difficulty: DIFFICULTY_SETTINGS.educational,
          observations: new OpponentModel(1),
          random: createSeededRandom(1),
        }),
      (error: unknown) => error instanceof AppError && error.code === 'internal_error',
    );
  });

  it('feeds the opponent models public actions that have nowhere to put a card', async () => {
    const harness = await botTable();
    await harness.table.startHand();
    await playOut(harness);

    const facts = harness.notices.flatMap((notice) => [...notice.publicActions]);
    assert.ok(facts.length > 0, 'a played hand produces public action facts');
    for (const fact of facts) {
      assert.deepEqual(
        Object.keys(fact).sort(),
        [
          'action',
          'amountPaid',
          'facingPreflopRaise',
          'handId',
          'potBefore',
          'raiseWasAvailable',
          'seat',
          'street',
          'toCall',
        ],
        'a public action fact carries only public fields',
      );
    }
    harness.table.close();
  });
});

describe('a bot-driven hand', () => {
  it('completes, conserves chips, and produces a reveal that verifies', async () => {
    // Plays until a hand reaches a flop, since a preflop end never exercises a street or a showdown.
    // The deck is random, so the cap sets the false-failure rate p^n. It failed once at 20 hands of
    // preflop folds, with every assertion passing, and 80 makes that negligible.
    const harness = await botTable({
      stack: 500,
      profiles: ['calling-station', 'reading-pressure-specialist'],
    });
    const total = harness.table.snapshot().seats.reduce((sum, seat) => sum + seat.stack, 0);
    let handsWithABoard = 0;
    let handsPlayed = 0;

    for (let hand = 0; hand < 80 && handsWithABoard === 0; hand += 1) {
      const playable = harness.table.snapshot().seats.filter((seat) => seat.stack > 0);
      if (playable.length < 2) break;
      await harness.table.startHand();
      await playOut(harness);
      handsPlayed += 1;

      const view = harness.table.viewFor('usr_bot0');
      assert.ok(view !== null);
      assert.equal(view.street, 'complete');
      assert.ok(view.actions.length > 0, 'a hand must record the actions that decided it');
      if (view.board.length >= 3) handsWithABoard += 1;

      const after = harness.table.snapshot().seats.reduce((sum, seat) => sum + seat.stack, 0);
      assert.equal(after, total, `chips must be conserved: ${total} became ${after}`);

      const reveal = view.result?.reveal;
      assert.ok(reveal !== undefined, 'a completed hand carries a reveal');
      const verification = verifyDeckReveal(reveal);
      assert.equal(verification.ok, true, `the reveal must verify: ${verification.reason ?? ''}`);
      assert.equal(reveal.complete, false, 'a hand reveal is never a full deck reveal');

      // Only the dealt board and the hole cards of seats that showed are proved.
      const shown = view.result?.showdowns.length ?? 0;
      assert.equal(
        reveal.cards.length,
        view.board.length + shown * 2,
        'the reveal proves exactly the public positions and no more',
      );
      assert.equal(
        verification.verifiedIndices.length,
        reveal.cards.length,
        'every proof in the reveal must check out',
      );
    }

    assert.ok(
      handsWithABoard > 0,
      `${handsPlayed} hands all ended before the flop, so no street transition was exercised. ` +
        'Every one of them still conserved chips and produced a verifying reveal, so this is a ' +
        'coverage failure rather than a correctness one: either the deal is astonishingly unlucky, ' +
        'or both bots have started folding preflop unconditionally. Check `harness.problems` and ' +
        'whether the policies are erroring into their fold fallback before assuming luck.',
    );
    assert.deepEqual(harness.problems, [], 'a clean run reports no problems');
    harness.table.close();
  });

  it('waits its thinking delay before acting', async () => {
    const harness = await botTable();
    await harness.table.startHand();
    const sequenceAtDeal = harness.table.viewFor('usr_bot0')?.actionSequence ?? -1;

    harness.clock.advance(THINKING_DELAY_MS - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      harness.table.viewFor('usr_bot0')?.actionSequence,
      sequenceAtDeal,
      'a bot must not act before its delay has passed',
    );

    harness.clock.advance(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      (harness.table.viewFor('usr_bot0')?.actionSequence ?? -1) > sequenceAtDeal,
      'and must act once it has',
    );
    harness.table.close();
  });

  it('stops scheduling once the room closes', async () => {
    const harness = await botTable();
    await harness.table.startHand();
    harness.runner.stop();
    harness.table.close();

    harness.clock.advance(THINKING_DELAY_MS * 50);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.clock.pending, 0, 'a stopped runner and a closed table leave nothing queued');
  });
});

describe('seeded decisions', () => {
  it('reproduces the same decision from the same seed, and differs from another seed', () => {
    const state = buildHypotheticalState({
      heroCards: parseCards('AhKh'),
      board: parseCards('Qh7h2c9s3d'),
      street: 'river',
      pot: 200,
      toCall: 100,
      heroStack: 900,
      opponentStack: 900,
      bigBlind: 10,
    });
    const view = redactFor(state, { viewerSeat: 0 });
    const profile = requireProfile('reading-pressure-specialist');
    const traits = expressTraits(profile, 'realistic');

    const run = (seed: number, trials: number): string[] => {
      const random = createSeededRandom(seed);
      const observations = new OpponentModel(0);
      const out: string[] = [];
      for (let trial = 0; trial < trials; trial += 1) {
        const decision = decide(
          buildPolicyInput({
            view,
            seat: 0,
            traits,
            difficulty: DIFFICULTY_SETTINGS.realistic,
            observations,
            random,
          }),
        );
        const action = decision.action;
        out.push('to' in action ? `${action.type}:${action.to}` : action.type);
      }
      return out;
    };

    const first = run(11, 8);
    const second = run(11, 8);
    assert.deepEqual(second, first, 'the same seed must replay the same decisions');

    const different = run(12, 8);
    assert.notDeepEqual(
      different,
      first,
      'two seeds producing an identical run of eight would mean the stream is not being used',
    );
  });
});

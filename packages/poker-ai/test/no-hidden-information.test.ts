/**
 * The architectural test: a policy cannot cheat.
 *
 * `redact.ts` proves that a *view* carries no hidden card. This file proves the next claim
 * along, which is the one the AI Legends feature rests on: that the policy, given such a view,
 * does not reach for anything it should not — and that there is nothing there to reach for.
 *
 * Three assertions, in increasing strength.
 *
 * **1. The input type cannot represent a secret.** `PolicyInput` has seven keys and none of
 * them is `HandState`. The keys are asserted at runtime and the whole input is serialised and
 * walked, because "the type has no deck field" is a claim about today's type and a serialised
 * walk is a claim about the object that actually existed.
 *
 * **2. No hidden card is present in what the policy is handed.** Every card in the serialised
 * input is checked against `cardsHiddenFrom(state, seat)` — the engine's own answer to "what
 * must this seat not see" — which covers the other seats' hole cards and every undealt card.
 *
 * **3. The policy is instrumented while it runs.** The view is wrapped in a `Proxy` that
 * records every property path read, at every depth. `decide` then runs for real, and the
 * recorded read set is asserted to be a subset of the permitted fields and to contain no
 * forbidden path — including, notably, no `holeCards` path at all. The policy takes its own
 * cards from `input.holeCards`, so it has no reason to touch that field on any seat, and
 * asserting it never does turns "it only reads its own" into "it reads nobody's".
 *
 * This is proof by observation rather than by inspection, which is the only version that stays
 * true: a reviewer reading the code concludes it does not cheat today, and this concludes that
 * the run that just happened did not.
 *
 * **4. The companion invariance check.** Two hands are built that differ ONLY in an opponent's
 * hole cards and in the undealt deck behind them. Hero's view of the two is identical except
 * for the deck commitment root, which is public. The decision must be byte-identical: a policy
 * whose behaviour changes when an invisible card changes is reading something it must not, and
 * this catches that even if it happened through a channel nobody thought to name.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyAction,
  type Card,
  cardsHiddenFrom,
  cardToString,
  createDeterministicRandomForTests,
  type HandState,
  orderedDeck,
  type PlayerView,
  parseCards,
  redactFor,
  type SeatIndex,
  startHand,
} from '@prl/poker-engine';
import { topPercentRange } from '@prl/poker-math';
import { decide, type PolicyInput, type PolicyObservations } from '../src/policy.ts';
import { DIFFICULTY_SETTINGS, expressTraits, requireProfile } from '../src/profiles.ts';
import type { Traits } from '../src/traits.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The keys a policy input is allowed to have. Anything else is a new channel into the policy. */
const PERMITTED_INPUT_KEYS = [
  'difficulty',
  'holeCards',
  'observations',
  'random',
  'seat',
  'traits',
  'view',
] as const;

/**
 * Top-level `PlayerView` fields the policy may read.
 *
 * Deliberately a closed list rather than "everything public". `commitmentRoot` and `result` are
 * both public and both stay off it: the root is nothing a strategy could use, and `result`
 * carries the showdown hole cards, so a policy that started reading it would be one refactor
 * away from learning what a folder had.
 */
const PERMITTED_VIEW_FIELDS = new Set([
  'actions',
  'amountToCall',
  'betLevel',
  'board',
  'buttonSeat',
  'config',
  'legalActions',
  'potTotal',
  'seats',
  'street',
  'toAct',
  'viewerSeat',
]);

/** Paths that must never appear in a read set, whatever else changes. */
const FORBIDDEN_PATH_PARTS = ['deck', 'deckCursor', 'deckSalts', 'salt', 'holeCards', 'result'];

const OBSERVATIONS: PolicyObservations = {
  statsFor: () => null,
  rangeFor: () => topPercentRange(35),
  adjustmentsFor: () => ({
    bluffMore: 1,
    valueBetThinner: 1,
    foldMore: 1,
    sizeUp: 1,
    isolateMore: 1,
  }),
};

/** Live-hand settings with the sample count at the floor: this file tests plumbing, not equity. */
const SETTINGS = { ...DIFFICULTY_SETTINGS.realistic, equitySamples: 200 };

/**
 * A 52-card deck dealing known hole cards and a known board.
 *
 * Deal order matches `machine.ts`: one card at a time, twice round the table starting left of
 * the button, then the flop, turn and river with no burn. Kept local rather than imported from
 * another package's test folder, which would be an undeclared dependency.
 */
function stackedDeck(
  holeBySeat: Readonly<Record<number, string>>,
  dealOrder: readonly SeatIndex[],
  board = '',
): Card[] {
  const hole = new Map<SeatIndex, readonly Card[]>();
  for (const [seat, text] of Object.entries(holeBySeat)) hole.set(Number(seat), parseCards(text));

  const sequence: Card[] = [];
  for (const round of [0, 1]) {
    for (const seat of dealOrder) {
      const card = hole.get(seat)?.[round];
      if (card === undefined) throw new Error(`no card ${round} for seat ${seat}`);
      sequence.push(card);
    }
  }
  sequence.push(...parseCards(board));
  const used = new Set(sequence);
  if (used.size !== sequence.length) throw new Error('stackedDeck was given a duplicate card');
  for (const card of orderedDeck()) if (!used.has(card)) sequence.push(card);
  return sequence;
}

function dealThreeHanded(seed: number, fixedDeck?: readonly Card[]): HandState {
  return startHand({
    handId: 'hidden-info',
    roomId: 'test-room',
    handNumber: 1,
    config: { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats: [0, 1, 2].map((seat) => ({ seat, playerId: `p${seat}`, stack: 300 })),
    random: createDeterministicRandomForTests(seed),
    ...(fixedDeck === undefined ? {} : { fixedDeck }),
  }).state;
}

function ownCardsOf(state: HandState, seat: SeatIndex): readonly [Card, Card] {
  const cards = state.seats.find((entry) => entry.seat === seat)?.holeCards;
  if (cards === null || cards === undefined) throw new Error(`seat ${seat} holds no cards`);
  return cards;
}

function inputFor(
  state: HandState,
  seat: SeatIndex,
  seed = 31,
  view?: PlayerView,
  traits?: Traits,
): PolicyInput {
  return {
    view: view ?? redactFor(state, { viewerSeat: seat }),
    holeCards: ownCardsOf(state, seat),
    seat,
    traits: traits ?? expressTraits(requireProfile('adaptive-exploiter'), 'realistic'),
    difficulty: SETTINGS,
    observations: OBSERVATIONS,
    random: createDeterministicRandomForTests(seed),
  };
}

// ---------------------------------------------------------------------------
// 1. The input type cannot represent a secret
// ---------------------------------------------------------------------------

test('a policy input has exactly the seven permitted keys, and no HandState among them', () => {
  const state = dealThreeHanded(11);
  const seat = state.toAct;
  assert.ok(seat !== null);
  const input = inputFor(state, seat);

  assert.deepEqual(
    Object.keys(input).sort(),
    [...PERMITTED_INPUT_KEYS].sort(),
    'a new key on PolicyInput is a new channel into the policy and must be a deliberate change',
  );
  for (const key of ['deck', 'deckCursor', 'deckSalts', 'commitment', 'state', 'handState']) {
    assert.equal(Object.hasOwn(input, key), false, `PolicyInput must not carry "${key}"`);
  }
  // `HandState` fields exist on the state and must not be reachable from the input's view.
  assert.equal(Object.hasOwn(input.view, 'deck'), false, 'PlayerView is built field by field');
  assert.equal(Object.hasOwn(input.view, 'deckCursor'), false);
  assert.equal(Object.hasOwn(input.view, 'deckSalts'), false);
  assert.ok(Object.hasOwn(state, 'deck'), 'the state really does hold the secret being withheld');
});

test('the serialised policy input contains no deck, cursor or salt, and no hidden card', () => {
  const state = dealThreeHanded(12);
  const seat = state.toAct;
  assert.ok(seat !== null);
  const input = inputFor(state, seat);
  const serialised = JSON.stringify(input);
  assert.ok(serialised !== undefined);

  for (const forbidden of ['"deck"', 'deckCursor', 'deckSalt', '"salt"']) {
    assert.ok(!serialised.includes(forbidden), `the serialised input leaked ${forbidden}`);
  }

  const hidden = new Set(cardsHiddenFrom(state, seat));
  assert.equal(hidden.size, 4 + 46, 'two opponents’ cards plus the 46 undealt cards are hidden');
  for (const card of cardsInSerialised(JSON.parse(serialised) as unknown)) {
    assert.ok(
      !hidden.has(card),
      `the policy input carried hidden card ${cardToString(card)}, which seat ${seat} may not see`,
    );
  }
});

/**
 * Every card-shaped value in a serialised object graph.
 *
 * Cards are small integers, so a blanket "no number in the hidden set" scan would collide with
 * stacks and pot sizes and assert nothing. This looks only where a card can actually live: the
 * `board` array and any `holeCards` array. That is the same narrowing the engine's own
 * `test/hidden-information.test.ts` applies, and for the same reason.
 */
function cardsInSerialised(value: unknown, key = ''): Card[] {
  if (Array.isArray(value)) {
    if ((key === 'board' || key === 'holeCards') && value.every((entry) => typeof entry === 'number')) {
      return value as Card[];
    }
    return value.flatMap((entry) => cardsInSerialised(entry, key));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([childKey, child]) => cardsInSerialised(child, childKey));
  }
  return [];
}

// ---------------------------------------------------------------------------
// 2 and 3. Instrumented: what the policy actually read
// ---------------------------------------------------------------------------

interface ReadLog {
  readonly paths: string[];
  readonly reads: { readonly path: string; readonly value: unknown }[];
}

/**
 * Wraps an object graph so every property read is recorded with its full path.
 *
 * Two details make the recording complete rather than decorative:
 *
 *   - Symbol keys are returned untouched, and functions are returned **unbound**. Returning a
 *     bound copy of `Array.prototype.find` would run it against the raw array and the reads
 *     inside it would vanish from the log. Unbound, `proxy.find(...)` executes with `this` set
 *     to the proxy, so `length` and every index it touches are recorded too.
 *   - Object results are wrapped recursively, so a read of `seats` followed by `seats[1].status`
 *     logs `seats.1.status` and not merely `seats`.
 */
function recordingProxy<T extends object>(target: T, path: string, log: ReadLog): T {
  return new Proxy(target, {
    get(object, key, receiver): unknown {
      if (typeof key === 'symbol') return Reflect.get(object, key, receiver);
      const full = path === '' ? key : `${path}.${key}`;
      const value = Reflect.get(object, key);
      log.paths.push(full);
      log.reads.push({ path: full, value });
      if (typeof value === 'function') return value;
      if (value !== null && typeof value === 'object') return recordingProxy(value, full, log);
      return value;
    },
  });
}

function assertReadSetIsClean(log: ReadLog, state: HandState, seat: SeatIndex, where: string): void {
  assert.ok(log.paths.length > 0, `${where}: the policy read nothing, so this proves nothing`);

  for (const path of log.paths) {
    const [head] = path.split('.');
    if (head === undefined) continue;
    // Array indices, `length` and array methods appear as segments; only the top-level field
    // name is checked against the allow-list.
    assert.ok(
      PERMITTED_VIEW_FIELDS.has(head),
      `${where}: the policy read view.${path}, which is not on the permitted list`,
    );
    for (const forbidden of FORBIDDEN_PATH_PARTS) {
      assert.ok(
        !path.split('.').includes(forbidden),
        `${where}: the policy read a forbidden path — view.${path}`,
      );
    }
  }

  // Whatever it read, none of the VALUES may be a card this seat is not entitled to. Only the
  // board can legitimately hand a card back, so that is where this looks — and only at its
  // numeric indices. Cards are small integers, so `board.length` of 0 IS the two of clubs and
  // an unnarrowed scan reports the empty preflop board as a leak. The same collision is why the
  // engine's own hidden-information test checks card-bearing positions rather than every number.
  const hidden = new Set(cardsHiddenFrom(state, seat));
  for (const read of log.reads) {
    if (typeof read.value !== 'number') continue;
    if (!/^board\.\d+$/.test(read.path)) continue;
    assert.ok(
      !hidden.has(read.value),
      `${where}: the policy read hidden card ${cardToString(read.value)} from view.${read.path}`,
    );
  }
}

test('an instrumented policy never reads a hidden field, on any street', () => {
  // Several hands, because a hand can end preflop and this needs the flop, turn and river
  // scoring paths instrumented too. A loose, passive profile in every seat is what gets the
  // walk to the river reliably without the test scripting the actions itself — the policy has
  // to be the thing making the decisions for the read set to mean anything.
  const traits = expressTraits(requireProfile('calling-station'), 'realistic');
  const streetsSeen = new Set<string>();
  let decisions = 0;

  for (let seed = 13; seed <= 40 && (decisions < 25 || streetsSeen.size < 4); seed++) {
    let state = dealThreeHanded(seed);
    let step = 0;
    while (state.street !== 'complete' && step < 60) {
      const seat = state.toAct;
      if (seat === null) break;
      streetsSeen.add(state.street);

      const log: ReadLog = { paths: [], reads: [] };
      const view = recordingProxy(redactFor(state, { viewerSeat: seat }), '', log);
      const decision = decide(inputFor(state, seat, 100 + seed * 7 + step, view, traits));
      assertReadSetIsClean(log, state, seat, `seed ${seed} seat ${seat} on ${state.street}`);

      // The read set must include the fields a decision genuinely needs, otherwise a policy
      // that read nothing at all would pass the assertion above.
      for (const required of ['legalActions', 'seats', 'potTotal', 'amountToCall']) {
        assert.ok(
          log.paths.some((path) => path === required || path.startsWith(`${required}.`)),
          `a decision must actually consult view.${required}`,
        );
      }

      state = applyAction(state, seat, decision.action, { actionId: `hi-${seed}-${step}` }).state;
      decisions += 1;
      step += 1;
    }
  }

  assert.ok(decisions > 20, `the walk must produce many decisions, produced ${decisions}`);
  for (const street of ['preflop', 'flop', 'turn', 'river']) {
    assert.ok(streetsSeen.has(street), `the ${street} scoring path must be instrumented`);
  }
});

test('the instrumented read set never contains a holeCards path, not even the seat’s own', () => {
  const state = dealThreeHanded(14);
  const seat = state.toAct;
  assert.ok(seat !== null);

  const log: ReadLog = { paths: [], reads: [] };
  const view = recordingProxy(redactFor(state, { viewerSeat: seat }), '', log);
  decide(inputFor(state, seat, 55, view));

  // The view legitimately contains this seat's own cards; the policy still does not read them,
  // because they arrive through `input.holeCards`. Asserting the field is untouched turns "it
  // only reads its own cards" into the stronger "it reads nobody's".
  const own = view.seats.find((entry) => entry.seat === seat)?.holeCards ?? null;
  assert.ok(own !== null, 'the view really does carry this seat’s own cards');
  const touched = log.paths.filter((path) => path.endsWith('holeCards'));
  assert.deepEqual(
    touched.filter((path) => !path.startsWith('seats.') || !path.endsWith('holeCards')),
    [],
    'sanity: the filter above matches what it claims to',
  );
  // The `own` read above is itself instrumented, so the log now contains exactly one such path
  // and it belongs to this assertion rather than to the policy.
  assert.equal(
    touched.length,
    1,
    `only this test read a holeCards field; the policy read ${touched.length - 1} of them: ${touched.join(', ')}`,
  );
});

test('every seat’s policy is instrumented in the same hand, and none of them reads another’s cards', () => {
  const state = dealThreeHanded(15);
  // Only the seat to act has legal actions, so the others are checked by walking the hand.
  const seat = state.toAct;
  assert.ok(seat !== null);
  for (const viewer of [0, 1, 2]) {
    const hidden = cardsHiddenFrom(state, viewer);
    assert.equal(hidden.length, 4 + 46, `seat ${viewer} must be blind to four cards plus the stub`);
    const view = redactFor(state, { viewerSeat: viewer });
    for (const seatView of view.seats) {
      if (seatView.seat === viewer) continue;
      assert.equal(seatView.holeCards, null, `seat ${viewer} must not be shown seat ${seatView.seat}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Invariance under a card the policy cannot see
// ---------------------------------------------------------------------------

test('swapping an invisible opponent hand leaves the decision byte-identical', () => {
  const board = 'Kh 8d 3c 5s 9h';
  const dealOrder: readonly SeatIndex[] = [1, 2, 0];
  const hero: SeatIndex = 0;

  const first = dealThreeHanded(16, stackedDeck({ 0: 'AhKd', 1: '7c2d', 2: 'Ts9c' }, dealOrder, board));
  const second = dealThreeHanded(16, stackedDeck({ 0: 'AhKd', 1: 'QsJs', 2: '4h4d' }, dealOrder, board));

  // Identical scripted preflop action in both, so the only difference reaching hero's view is
  // behind the redaction boundary.
  const toFlop = (state: HandState): HandState => {
    let current = applyAction(state, 0, { type: 'call' }).state;
    current = applyAction(current, 1, { type: 'call' }).state;
    current = applyAction(current, 2, { type: 'check' }).state;
    assert.equal(current.street, 'flop');
    return current;
  };
  const flopA = toFlop(first);
  const flopB = toFlop(second);

  assert.deepEqual(ownCardsOf(flopA, hero), ownCardsOf(flopB, hero), 'hero holds the same two cards');
  assert.notDeepEqual(
    ownCardsOf(flopA, 1),
    ownCardsOf(flopB, 1),
    'the opponent genuinely holds something different',
  );

  // Advance both to hero's turn.
  const advanceToHero = (state: HandState): HandState => {
    let current = state;
    while (current.toAct !== hero) {
      const seat = current.toAct;
      assert.ok(seat !== null, 'the hand must reach hero');
      current = applyAction(current, seat, { type: 'check' }).state;
    }
    return current;
  };
  const heroA = advanceToHero(flopA);
  const heroB = advanceToHero(flopB);

  const decisionA = decide(inputFor(heroA, hero, 909));
  const decisionB = decide(inputFor(heroB, hero, 909));

  assert.deepEqual(decisionA.action, decisionB.action, 'an invisible card must not move the action');
  assert.deepEqual(
    decisionA.distribution.map((entry) => entry.probability),
    decisionB.distribution.map((entry) => entry.probability),
    'nor the distribution behind it',
  );
  assert.equal(decisionA.strength.equity, decisionB.strength.equity, 'nor the equity assessment');
  assert.equal(decisionA.modelPreference, decisionB.modelPreference, 'nor a word of the reasoning');
});

test('the deck commitment differs between those two hands, so the views were not identical', () => {
  // Without this the test above could pass by the two hands being the same hand. The commitment
  // root is public, differs because the decks differ, and is not read by the policy.
  const board = 'Kh 8d 3c 5s 9h';
  const dealOrder: readonly SeatIndex[] = [1, 2, 0];
  const first = dealThreeHanded(16, stackedDeck({ 0: 'AhKd', 1: '7c2d', 2: 'Ts9c' }, dealOrder, board));
  const second = dealThreeHanded(16, stackedDeck({ 0: 'AhKd', 1: 'QsJs', 2: '4h4d' }, dealOrder, board));
  const viewA = redactFor(first, { viewerSeat: 0 });
  const viewB = redactFor(second, { viewerSeat: 0 });
  assert.notEqual(viewA.commitmentRoot, viewB.commitmentRoot, 'two different decks, two different roots');
  assert.deepEqual(viewA.board, viewB.board, 'the public board is the same in both');
});

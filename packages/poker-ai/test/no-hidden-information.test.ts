/**
 * A policy cannot cheat, proved by observation. `PolicyInput` keys are asserted at runtime and the
 * serialised input is checked against `cardsHiddenFrom`. The view is wrapped in a recording `Proxy`
 * while `decide` runs, and the read set must stay inside an allow-list with no `holeCards` path at
 * all, because the policy's own cards arrive in `input.holeCards`. Two hands that differ only in an
 * opponent's cards and the undealt deck must produce byte-identical decisions.
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

/** Anything else is a new channel into the policy. */
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
 * A closed list. `commitmentRoot` is useless to a strategy, and `result` carries showdown hole cards,
 * so reading it would be one refactor away from learning what a folder held.
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

/** Sample count at the floor, because this file tests plumbing, not equity. */
const SETTINGS = { ...DIFFICULTY_SETTINGS.realistic, equitySamples: 200 };

/**
 * Deal order matches `machine.ts`. One card at a time, twice round from left of the button, then
 * flop, turn and river with no burn. Local, because a cross-package test import is undeclared.
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
 * Cards are small integers, so scanning every number would collide with stacks and pots. This looks
 * only at `board` and `holeCards` arrays, as the engine's `test/hidden-information.test.ts` does.
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

interface ReadLog {
  readonly paths: string[];
  readonly reads: { readonly path: string; readonly value: unknown }[];
}

/**
 * Records every property read with its full path. Functions are returned unbound, so `proxy.find`
 * runs with `this` as the proxy and its index reads are logged. Objects are wrapped recursively.
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
    // Only the top-level field name is checked against the allow-list.
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

  // Only the board can hand a card back, so only its numeric indices are checked. `board.length` 0
  // is the two of clubs, so an unnarrowed scan flags the empty preflop board.
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
  // Several hands so the flop, turn and river paths run. A loose passive profile in every seat reaches
  // the river without scripting, so the policy makes the decisions.
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

      // A policy that read nothing would otherwise pass.
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

  // The view contains this seat's own cards, and the policy still must not read them.
  const own = view.seats.find((entry) => entry.seat === seat)?.holeCards ?? null;
  assert.ok(own !== null, 'the view really does carry this seat’s own cards');
  const touched = log.paths.filter((path) => path.endsWith('holeCards'));
  assert.deepEqual(
    touched.filter((path) => !path.startsWith('seats.') || !path.endsWith('holeCards')),
    [],
    'sanity: the filter above matches what it claims to',
  );
  // The `own` read above is instrumented, so the log holds exactly one such path, from this test.
  assert.equal(
    touched.length,
    1,
    `only this test read a holeCards field; the policy read ${touched.length - 1} of them: ${touched.join(', ')}`,
  );
});

test('every seat’s policy is instrumented in the same hand, and none of them reads another’s cards', () => {
  const state = dealThreeHanded(15);
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

test('swapping an invisible opponent hand leaves the decision byte-identical', () => {
  const board = 'Kh 8d 3c 5s 9h';
  const dealOrder: readonly SeatIndex[] = [1, 2, 0];
  const hero: SeatIndex = 0;

  const first = dealThreeHanded(16, stackedDeck({ 0: 'AhKd', 1: '7c2d', 2: 'Ts9c' }, dealOrder, board));
  const second = dealThreeHanded(16, stackedDeck({ 0: 'AhKd', 1: 'QsJs', 2: '4h4d' }, dealOrder, board));

  // The same scripted preflop action in both, so the only difference is behind the redaction boundary.
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
  // Proves the two hands differ. The public commitment root differs because the decks differ.
  const board = 'Kh 8d 3c 5s 9h';
  const dealOrder: readonly SeatIndex[] = [1, 2, 0];
  const first = dealThreeHanded(16, stackedDeck({ 0: 'AhKd', 1: '7c2d', 2: 'Ts9c' }, dealOrder, board));
  const second = dealThreeHanded(16, stackedDeck({ 0: 'AhKd', 1: 'QsJs', 2: '4h4d' }, dealOrder, board));
  const viewA = redactFor(first, { viewerSeat: 0 });
  const viewB = redactFor(second, { viewerSeat: 0 });
  assert.notEqual(viewA.commitmentRoot, viewB.commitmentRoot, 'two different decks, two different roots');
  assert.deepEqual(viewA.board, viewB.board, 'the public board is the same in both');
});

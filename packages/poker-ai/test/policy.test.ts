/**
 * What the policy engine promises, checked by playing hands rather than by inspecting code.
 *
 * ## The shape of these tests
 *
 * Almost everything here drives the real engine: `startHand`, then a loop of `redactFor` ->
 * `decide` -> `applyAction` until the hand completes. That matters because the strongest claim
 * in this file — "a proposed action is always legal" — is only worth making against the engine
 * that decides legality. `applyAction` re-validates through `validateAction`, so a policy that
 * proposed something illegal would throw rather than quietly pass an assertion here.
 *
 * ## Two deliberate choices about speed
 *
 * `strengthTable()` in `@prl/poker-math` costs a few seconds to build and is memoised once per
 * process, so the first preflop decision in this file pays for it and nothing else does.
 *
 * The randomised sweep runs with `equitySamples` at the floor (200) rather than the 4,000 to
 * 12,000 a live hand would use. That is honest for what this test asserts: legality, integer
 * sizes and a normalised distribution are properties of the scoring and clamping, not of the
 * sampling precision. The behavioural tests further down use the real difficulty settings,
 * because a claim about how a *style* behaves would be worth much less at a sample count no
 * style ever runs at.
 *
 * ## The observation stub, and why the real model is checked separately
 *
 * Most tests hand `decide` a fixed `PolicyObservations` with neutral multipliers, so a
 * behavioural difference between two profiles cannot be an artefact of one of them having
 * adapted to something. One test then asserts that the real `OpponentModel` from
 * `opponent-model.ts` satisfies the same interface and produces a decision, which is the
 * integration this package actually ships.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Action,
  applyAction,
  type Card,
  createDeterministicRandomForTests,
  type HandState,
  type LegalAction,
  orderedDeck,
  parseCards,
  redactFor,
  type SeatIndex,
  startHand,
  type TableConfig,
} from '@prl/poker-engine';
import { type ParsedRange, topPercentRange } from '@prl/poker-math';
import { findImpersonation } from '../src/labelling.ts';
import { createOpponentModel, type OpponentModel } from '../src/opponent-model.ts';
import {
  decide,
  type ObservedAdjustments,
  type ObservedSeatRead,
  type PolicyDecision,
  type PolicyInput,
  type PolicyObservations,
} from '../src/policy.ts';
import {
  DIFFICULTY_SETTINGS,
  type Difficulty,
  type DifficultySettings,
  expressTraits,
  requireProfile,
} from '../src/profiles.ts';
import type { Traits } from '../src/traits.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NEUTRAL_ADJUSTMENTS: ObservedAdjustments = {
  bluffMore: 1,
  valueBetThinner: 1,
  foldMore: 1,
  sizeUp: 1,
  isolateMore: 1,
};

/**
 * A fixed observation source: no read, every multiplier neutral, one range for every seat.
 *
 * Deliberately not the real opponent model. A behavioural assertion about two profiles has to
 * be about the profiles, and a live model would let one of them adapt to something the other
 * did not see.
 */
function stubObservations(range: ParsedRange, read: ObservedSeatRead | null = null): PolicyObservations {
  return {
    statsFor: () => read,
    rangeFor: () => range,
    adjustmentsFor: () => NEUTRAL_ADJUSTMENTS,
  };
}

/** The live-hand settings with the sample count at the floor. See the module comment. */
function fastSettings(difficulty: Difficulty): DifficultySettings {
  return { ...DIFFICULTY_SETTINGS[difficulty], equitySamples: 200 };
}

function traitsFor(profileId: string, difficulty: Difficulty = 'realistic'): Traits {
  return expressTraits(requireProfile(profileId), difficulty);
}

function config(overrides: Partial<TableConfig> = {}): TableConfig {
  return { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30, ...overrides };
}

function dealHand(options: {
  stacks: readonly number[];
  buttonSeat: number;
  seed: number;
  config?: Partial<TableConfig>;
  fixedDeck?: readonly Card[];
}): HandState {
  const cfg = config({ maxSeats: Math.max(2, options.stacks.length), ...options.config });
  return startHand({
    handId: `h${options.seed}`,
    roomId: 'test-room',
    handNumber: 1,
    config: cfg,
    buttonSeat: options.buttonSeat,
    seats: options.stacks.map((stack, index) => ({ seat: index, playerId: `p${index}`, stack })),
    random: createDeterministicRandomForTests(options.seed),
    ...(options.fixedDeck === undefined ? {} : { fixedDeck: options.fixedDeck }),
  }).state;
}

/**
 * Builds a 52-card deck that deals known hole cards and a known board.
 *
 * The deal order in `machine.ts` is one card at a time, twice round the table starting left of
 * the button, then the flop, turn and river with no burn. A local copy rather than an import
 * from another package's test folder: a cross-package test import would be a dependency the
 * package manifest does not declare.
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
      const cards = hole.get(seat);
      const card = cards?.[round];
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

function ownCardsOf(state: HandState, seat: SeatIndex): readonly [Card, Card] {
  const cards = state.seats.find((entry) => entry.seat === seat)?.holeCards;
  if (cards === null || cards === undefined) throw new Error(`seat ${seat} holds no cards`);
  return cards;
}

function inputFor(options: {
  state: HandState;
  seat: SeatIndex;
  traits: Traits;
  difficulty: DifficultySettings;
  seed: number;
  observations?: PolicyObservations;
}): PolicyInput {
  const { state, seat } = options;
  return {
    view: redactFor(state, { viewerSeat: seat }),
    holeCards: ownCardsOf(state, seat),
    seat,
    traits: options.traits,
    difficulty: options.difficulty,
    observations: options.observations ?? stubObservations(topPercentRange(35)),
    random: createDeterministicRandomForTests(options.seed),
  };
}

/** Everything asserted on every single decision the sweep produces. */
function assertDecisionIsWellFormed(
  decision: PolicyDecision,
  legal: readonly LegalAction[],
  where: string,
): void {
  const offered = new Map<string, LegalAction>(legal.map((entry) => [entry.type, entry]));

  assert.equal(
    decision.distribution.length,
    legal.length,
    `${where}: the distribution must cover the engine's legal set exactly`,
  );

  let total = 0;
  for (const entry of decision.distribution) {
    assert.ok(offered.has(entry.action.type), `${where}: ${entry.action.type} was never offered`);
    assert.ok(entry.probability >= 0, `${where}: negative probability ${entry.probability}`);
    assert.ok(entry.weight >= 0, `${where}: negative weight ${entry.weight}`);
    total += entry.probability;
    assertSizeIsLegal(entry.action, offered, `${where} (distribution entry)`);
    assert.deepEqual(
      findImpersonation(entry.rationale),
      [],
      `${where}: rationale must describe the model, not a person: ${entry.rationale}`,
    );
  }
  assert.ok(Math.abs(total - 1) < 1e-9, `${where}: probabilities summed to ${total}`);

  const chosen = offered.get(decision.action.type);
  assert.ok(chosen !== undefined, `${where}: sampled ${decision.action.type}, which was not offered`);
  assertSizeIsLegal(decision.action, offered, `${where} (sampled)`);

  assert.ok(decision.drivingTraits.length > 0, `${where}: a decision always has something driving it`);
  assert.ok(decision.whatChangedIt.length > 0, `${where}: whatChangedIt must name counterfactuals`);
  for (const note of decision.whatChangedIt) {
    assert.deepEqual(findImpersonation(note), [], `${where}: whatChangedIt impersonates: ${note}`);
  }
  assert.deepEqual(
    findImpersonation(decision.modelPreference),
    [],
    `${where}: modelPreference impersonates: ${decision.modelPreference}`,
  );
  assert.ok(
    decision.modelPreference.startsWith('This model prefers'),
    `${where}: the headline must be a statement about the model: ${decision.modelPreference}`,
  );
  assert.ok(
    decision.strength.equity > 0 && decision.strength.equity < 1,
    `${where}: equity ${decision.strength.equity} is outside (0, 1)`,
  );
}

function assertSizeIsLegal(action: Action, offered: Map<string, LegalAction>, where: string): void {
  if (action.type !== 'bet' && action.type !== 'raise') return;
  const entry = offered.get(action.type);
  assert.ok(entry !== undefined, `${where}: ${action.type} was not offered`);
  assert.ok(Number.isInteger(action.to), `${where}: ${action.type} to ${action.to} is not an integer`);
  assert.ok(
    entry.minTo !== undefined && action.to >= entry.minTo,
    `${where}: ${action.type} to ${action.to} is below minTo ${String(entry.minTo)}`,
  );
  assert.ok(
    entry.maxTo !== undefined && action.to <= entry.maxTo,
    `${where}: ${action.type} to ${action.to} is above maxTo ${String(entry.maxTo)}`,
  );
}

interface SweepTotals {
  decisions: number;
  hands: number;
  betsOrRaises: number;
  allIns: number;
  shortAllInSpots: number;
}

/** Plays one hand to completion with a policy in every seat. */
function playPolicyHand(
  totals: SweepTotals,
  options: {
    state: HandState;
    traitsBySeat: ReadonlyMap<SeatIndex, Traits>;
    difficulty: DifficultySettings;
    seed: number;
    where: string;
  },
): void {
  let state = options.state;
  let step = 0;
  while (state.street !== 'complete' && step < 200) {
    const seat = state.toAct;
    if (seat === null) break;
    const traits = options.traitsBySeat.get(seat);
    assert.ok(traits !== undefined, `${options.where}: no traits for seat ${seat}`);

    const input = inputFor({
      state,
      seat,
      traits,
      difficulty: options.difficulty,
      seed: options.seed * 1_000 + step,
    });
    const legal = input.view.legalActions;
    if (legal.some((entry) => entry.type === 'raise' && entry.minTo === entry.maxTo)) {
      totals.shortAllInSpots += 1;
    }
    const decision = decide(input);
    assertDecisionIsWellFormed(decision, legal, `${options.where} step ${step} seat ${seat}`);

    totals.decisions += 1;
    if (decision.action.type === 'bet' || decision.action.type === 'raise') {
      totals.betsOrRaises += 1;
      const maxTo = legal.find((entry) => entry.type === decision.action.type)?.maxTo;
      if (decision.action.to === maxTo) totals.allIns += 1;
    }

    // The engine is the authority: an illegal proposal throws here rather than being asserted
    // legal by this file's own reading of the rules.
    state = applyAction(state, seat, decision.action, { actionId: `t-${step}` }).state;
    step += 1;
  }
  totals.hands += 1;
}

// ---------------------------------------------------------------------------
// The randomised sweep
// ---------------------------------------------------------------------------

const SWEEP_PROFILES = [
  'disciplined-specialist',
  'calling-station',
  'reading-pressure-specialist',
  'adaptive-exploiter',
  'mixed-game-generalist',
  'fundamentals-coach',
] as const;

const SWEEP_STACKS: readonly (readonly number[])[] = [
  [200, 200],
  [16, 40],
  [200, 200, 200],
  [50, 120, 300],
  [200, 200, 200, 200],
  [30, 200, 75, 500, 120],
  [200, 200, 200, 200, 200, 200],
  [12, 26, 200, 60, 400, 90],
];

const SWEEP_DIFFICULTIES: readonly Difficulty[] = ['educational', 'realistic', 'expert'];

test('every proposed action is legal, integer-sized and inside the engine bounds, across thousands of decisions', () => {
  const totals: SweepTotals = { decisions: 0, hands: 0, betsOrRaises: 0, allIns: 0, shortAllInSpots: 0 };

  for (let round = 0; round < 100; round++) {
    for (const [index, stacks] of SWEEP_STACKS.entries()) {
      const seed = 1 + round * 97 + index * 13;
      const difficulty = SWEEP_DIFFICULTIES[(round + index) % SWEEP_DIFFICULTIES.length] ?? 'realistic';
      const traitsBySeat = new Map<SeatIndex, Traits>();
      for (let seat = 0; seat < stacks.length; seat++) {
        const profile = SWEEP_PROFILES[(seat + round) % SWEEP_PROFILES.length] ?? 'fundamentals-coach';
        traitsBySeat.set(seat, traitsFor(profile, difficulty));
      }
      const blinds = round % 3 === 0 ? { smallBlind: 25, bigBlind: 50 } : { smallBlind: 1, bigBlind: 2 };
      const state = dealHand({
        stacks: blinds.bigBlind === 50 ? stacks.map((stack) => stack * 25) : stacks,
        buttonSeat: round % stacks.length,
        seed,
        config: { ...blinds, ante: round % 4 === 0 ? 1 : 0 },
      });
      playPolicyHand(totals, {
        state,
        traitsBySeat,
        difficulty: fastSettings(difficulty),
        seed,
        where: `round ${round} stacks ${stacks.join('/')}`,
      });
    }
  }

  assert.ok(totals.decisions > 4_000, `expected thousands of decisions, ran ${totals.decisions}`);
  assert.ok(totals.hands >= 800, `expected the full sweep to complete, played ${totals.hands} hands`);
  // A sweep that never reached an aggressive action would pass every legality assertion above
  // while testing almost nothing, so the coverage itself is asserted.
  assert.ok(totals.betsOrRaises > 500, `the sweep must exercise sizing, saw ${totals.betsOrRaises} bets`);
  assert.ok(totals.allIns > 0, 'the sweep must exercise the all-in clamp at least once');
  assert.ok(
    totals.shortAllInSpots > 0,
    'the sweep must reach at least one spot where the only raise available is a short all-in',
  );
});

// ---------------------------------------------------------------------------
// Reproducible, and not scripted
// ---------------------------------------------------------------------------

/** A fixed heads-up flop spot: a real hand, a real board, nothing owed. */
function fixedFlopSpot(): { state: HandState; seat: SeatIndex } {
  const deck = stackedDeck({ 1: 'AhKd', 0: 'Qc7s' }, [1, 0], 'Kh 8d 3c');
  let state = dealHand({
    stacks: [400, 400],
    buttonSeat: 0,
    seed: 5,
    config: { maxSeats: 2 },
    fixedDeck: deck,
  });
  // Heads-up the button is the small blind and acts first preflop.
  state = applyAction(state, 0, { type: 'call' }).state;
  state = applyAction(state, 1, { type: 'check' }).state;
  assert.equal(state.street, 'flop');
  const seat = state.toAct;
  assert.ok(seat !== null, 'somebody must be to act on the flop');
  return { state, seat };
}

test('the same input with the same seed produces an identical decision', () => {
  const { state, seat } = fixedFlopSpot();
  const traits = traitsFor('adaptive-exploiter');
  const first = decide(inputFor({ state, seat, traits, difficulty: fastSettings('realistic'), seed: 4242 }));
  const second = decide(inputFor({ state, seat, traits, difficulty: fastSettings('realistic'), seed: 4242 }));

  assert.deepEqual(second.action, first.action, 'a seeded policy is a function of its input');
  assert.deepEqual(
    second.distribution.map((entry) => entry.probability),
    first.distribution.map((entry) => entry.probability),
  );
  assert.equal(second.modelPreference, first.modelPreference);
  assert.equal(second.strength.equity, first.strength.equity, 'even the equity estimate replays exactly');
});

test('the same input with different seeds does not always produce the same action', () => {
  const { state, seat } = fixedFlopSpot();
  const traits = traitsFor('adaptive-exploiter');
  const actions = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const decision = decide(inputFor({ state, seat, traits, difficulty: fastSettings('realistic'), seed }));
    actions.add(decision.action.type);
  }
  assert.ok(
    actions.size > 1,
    `a probabilistic policy must not be scripted; 40 seeds produced only ${[...actions].join(', ')}`,
  );
});

test('the pre-sampling distribution has more than one live action wherever more than one is legal', () => {
  const { state, seat } = fixedFlopSpot();
  const decision = decide(
    inputFor({
      state,
      seat,
      traits: traitsFor('patient-technician'),
      difficulty: fastSettings('expert'),
      seed: 9,
    }),
  );
  const live = decision.distribution.filter((entry) => entry.probability > 0);
  assert.ok(decision.distribution.length > 1, 'this spot offers a check and a bet');
  assert.ok(live.length > 1, 'a learner must be able to see that several actions were plausible');
});

// ---------------------------------------------------------------------------
// Styles differ, in the direction their cards claim
// ---------------------------------------------------------------------------

/** The same first-to-act preflop decision, over many deals. */
function preflopDecisionPoints(count: number): readonly { state: HandState; seat: SeatIndex }[] {
  const out: { state: HandState; seat: SeatIndex }[] = [];
  for (let seed = 1; seed <= count; seed++) {
    const state = dealHand({ stacks: [200, 200, 200, 200, 200, 200], buttonSeat: seed % 6, seed: seed * 31 });
    const seat = state.toAct;
    if (seat === null) continue;
    out.push({ state, seat });
  }
  return out;
}

function foldRateOver(
  spots: readonly { state: HandState; seat: SeatIndex }[],
  profileId: string,
  difficulty: Difficulty = 'realistic',
): number {
  let folds = 0;
  for (const [index, spot] of spots.entries()) {
    const decision = decide(
      inputFor({
        state: spot.state,
        seat: spot.seat,
        traits: traitsFor(profileId, difficulty),
        difficulty: fastSettings(difficulty),
        seed: 7_000 + index,
      }),
    );
    if (decision.action.type === 'fold') folds += 1;
  }
  return folds / spots.length;
}

test('a tight profile folds more preflop than a loose one in the same spots', () => {
  const spots = preflopDecisionPoints(150);
  const tight = foldRateOver(spots, 'disciplined-specialist');
  const loose = foldRateOver(spots, 'calling-station');
  assert.ok(
    tight > loose + 0.15,
    `the tightest profile (declared VPIP 0.15) folded ${tight.toFixed(3)} and the loosest ` +
      `(0.52) folded ${loose.toFixed(3)}; the gap must be unmistakable`,
  );
});

test('realised preflop entry frequency tracks the declared VPIP', () => {
  // Not a statistical-suite tolerance: 150 first-to-act decisions carry a 95% half-width of
  // about 0.08 on a frequency, so this asserts the ORDER and a loose band rather than a tight
  // match. `test/simulation/` is where the tight assertion belongs.
  const spots = preflopDecisionPoints(150);
  for (const profileId of ['disciplined-specialist', 'patient-technician', 'calling-station']) {
    const declared = requireProfile(profileId).traits.vpip;
    const entered = 1 - foldRateOver(spots, profileId);
    assert.ok(
      Math.abs(entered - declared) < 0.16,
      `${profileId} declares a VPIP of ${declared} and entered ${entered.toFixed(3)} of these spots`,
    );
  }
});

/** A fixed three-handed flop spot where the seat to act may check or bet. */
function threeHandedFlopSpot(seed: number): { state: HandState; seat: SeatIndex } {
  let state = dealHand({ stacks: [300, 300, 300], buttonSeat: 0, seed, config: { maxSeats: 3 } });
  state = applyAction(state, 0, { type: 'call' }).state;
  state = applyAction(state, 1, { type: 'call' }).state;
  state = applyAction(state, 2, { type: 'check' }).state;
  assert.equal(state.street, 'flop');
  const seat = state.toAct;
  assert.ok(seat !== null);
  return { state, seat };
}

test('an aggressive profile bets or raises more often than a passive one in the same spots', () => {
  const spots = Array.from({ length: 60 }, (_unused, index) => threeHandedFlopSpot(index * 17 + 3));
  const rateFor = (profileId: string): number => {
    let aggressive = 0;
    for (const [index, spot] of spots.entries()) {
      const decision = decide(
        inputFor({
          state: spot.state,
          seat: spot.seat,
          traits: traitsFor(profileId),
          difficulty: fastSettings('realistic'),
          seed: 11_000 + index,
        }),
      );
      if (decision.action.type === 'bet' || decision.action.type === 'raise') aggressive += 1;
    }
    return aggressive / spots.length;
  };
  const aggressive = rateFor('reading-pressure-specialist');
  const passive = rateFor('calling-station');
  assert.ok(
    aggressive > passive + 0.2,
    `declared aggression 0.74 bet ${aggressive.toFixed(3)} of the time and declared 0.16 bet ` +
      `${passive.toFixed(3)}; the gap must be unmistakable`,
  );
});

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

function entropyOf(decision: PolicyDecision): number {
  let total = 0;
  for (const entry of decision.distribution) {
    if (entry.probability <= 0) continue;
    total -= entry.probability * Math.log2(entry.probability);
  }
  return total;
}

/** A three-handed flop spot where the seat to act is facing a half-pot bet. */
function threeHandedFlopBetFaced(seed: number): { state: HandState; seat: SeatIndex } {
  const { state, seat } = threeHandedFlopSpot(seed);
  const pot = redactFor(state, { viewerSeat: seat }).potTotal;
  const withBet = applyAction(state, seat, { type: 'bet', to: Math.max(2, Math.round(pot / 2)) }).state;
  const next = withBet.toAct;
  assert.ok(next !== null, 'somebody must be facing the bet');
  return { state: withBet, seat: next };
}

/**
 * Postflop, because that is where the noise mixture runs across the whole legal set.
 *
 * On a preflop entry decision the mixture deliberately runs inside the entering and
 * non-entering groups instead, so that the declared VPIP survives it — see the module comment in
 * `policy.ts`. The next test asserts that property directly, and asserting it there rather than
 * blurring the two into one average is what keeps both claims meaningful.
 *
 * Half the spots face a bet, which matters more than it looks: a two-action spot whose scores
 * are already close sits near the one-bit maximum at every noise level, so a set made only of
 * those would measure almost nothing. The lopsided three-action spots are where a floor under
 * every action is visible.
 */
test('educational produces a measurably flatter postflop distribution than expert', () => {
  const spots = [
    ...Array.from({ length: 30 }, (_unused, index) => threeHandedFlopSpot(index * 23 + 5)),
    ...Array.from({ length: 30 }, (_unused, index) => threeHandedFlopBetFaced(index * 29 + 7)),
  ];

  const meanEntropy = (difficulty: Difficulty): number => {
    let total = 0;
    for (const [index, spot] of spots.entries()) {
      total += entropyOf(
        decide(
          inputFor({
            state: spot.state,
            seat: spot.seat,
            traits: traitsFor('adaptive-exploiter', difficulty),
            difficulty: fastSettings(difficulty),
            seed: 21_000 + index,
          }),
        ),
      );
    }
    return total / spots.length;
  };

  const educational = meanEntropy('educational');
  const expert = meanEntropy('expert');
  assert.ok(
    educational > expert + 0.05,
    `mean entropy was ${educational.toFixed(4)} bits at educational and ${expert.toFixed(4)} at expert; ` +
      'the noisier setting must be the flatter one',
  );
});

test('the difficulty noise does not move the declared preflop entry frequency', () => {
  // The same traits at two noise levels: the entry frequency must be identical, because the
  // mixture is applied inside the entering and non-entering groups rather than across the entry
  // decision. Mixing across it inflated every profile's realised VPIP by 0.05 to 0.06 — a tight
  // profile entering 21% of pots while its card said 15%.
  const traits = traitsFor('disciplined-specialist');
  const spots = preflopDecisionPoints(30);
  for (const [index, spot] of spots.entries()) {
    const entryMassAt = (difficulty: Difficulty): number =>
      decide(
        inputFor({
          state: spot.state,
          seat: spot.seat,
          traits,
          difficulty: fastSettings(difficulty),
          seed: 31_000 + index,
        }),
      )
        .distribution.filter((entry) => entry.action.type !== 'fold' && entry.action.type !== 'check')
        .reduce((sum, entry) => sum + entry.probability, 0);

    const noisy = entryMassAt('educational');
    const sharp = entryMassAt('expert');
    assert.ok(
      Math.abs(noisy - sharp) < 1e-9,
      `spot ${index}: entering ${noisy} at noise 0.18 and ${sharp} at noise 0.05 — the declared entry ` +
        'frequency must not depend on the difficulty setting',
    );
  }
});

test('every plausible action clears the difficulty noise floor, and a free fold never does', () => {
  const { state, seat } = fixedFlopSpot();
  const settings = fastSettings('educational');
  const decision = decide(
    inputFor({
      state,
      seat,
      traits: traitsFor('disciplined-specialist', 'educational'),
      difficulty: settings,
      seed: 3,
    }),
  );
  const live = decision.distribution.filter((entry) => entry.probability > 0);
  const floor = settings.noise / live.length;
  for (const entry of live) {
    assert.ok(
      entry.probability >= floor - 1e-12,
      `${entry.action.type} came back at ${entry.probability}, below the floor of ${floor}`,
    );
  }

  // Facing no bet, the engine still offers a fold. It must never be sampled, and it must be
  // reported at exactly zero rather than dropped from the list.
  const state2 = dealHand({ stacks: [200, 200, 200], buttonSeat: 0, seed: 77, config: { maxSeats: 3 } });
  let flop = applyAction(state2, 0, { type: 'call' }).state;
  flop = applyAction(flop, 1, { type: 'call' }).state;
  flop = applyAction(flop, 2, { type: 'check' }).state;
  const actor = flop.toAct;
  assert.ok(actor !== null);
  const free = decide(
    inputFor({
      state: flop,
      seat: actor,
      traits: traitsFor('calling-station', 'educational'),
      difficulty: settings,
      seed: 4,
    }),
  );
  const foldEntry = free.distribution.find((entry) => entry.action.type === 'fold');
  assert.ok(foldEntry !== undefined, 'the fold stays in the distribution so the legal set is visible');
  assert.equal(
    foldEntry.probability,
    0,
    'a fold that costs nothing to decline must never be resurrected by noise',
  );
  assert.equal(foldEntry.weight, 0);
});

// ---------------------------------------------------------------------------
// Reasoning output
// ---------------------------------------------------------------------------

test('the reasoning names driving traits, counterfactuals and the price', () => {
  const { state, seat } = fixedFlopSpot();
  const decision = decide(
    inputFor({
      state,
      seat,
      traits: traitsFor('mixed-game-generalist'),
      difficulty: fastSettings('realistic'),
      seed: 8,
    }),
  );

  assert.ok(decision.drivingTraits.length <= 3, 'the panel shows the few axes that mattered');
  for (const trait of decision.drivingTraits) {
    assert.ok(trait.label.length > 0, 'every axis carries the label the profile card uses');
    assert.ok(trait.value >= 0 && trait.value <= 1, 'trait values stay on the declared 0..1 scale');
  }
  const joined = decision.whatChangedIt.join(' | ');
  assert.match(joined, /Position:/, 'position is one of the counterfactuals');
  assert.match(joined, /Stack depth:/, 'stack depth is one of the counterfactuals');
  assert.match(joined, /Price:/, 'the price is one of the counterfactuals');
  assert.match(joined, /Opponent read:/, 'the state of the read is stated, including when there is none');
  // Counterfactuals have to contain arithmetic, not just a topic sentence.
  assert.match(joined, /\d/, 'a counterfactual without numbers teaches nothing');
});

test('a spot with no read says so, rather than implying one', () => {
  const { state, seat } = fixedFlopSpot();
  const decision = decide(
    inputFor({
      state,
      seat,
      traits: traitsFor('foundational-reader'),
      difficulty: fastSettings('realistic'),
      seed: 12,
    }),
  );
  const note = decision.whatChangedIt.find((entry) => entry.startsWith('Opponent read:'));
  assert.ok(note !== undefined);
  assert.match(note, /no read|nothing this model is willing to act on/i);
});

test('an observed read moves the reasoning and the multipliers it reports', () => {
  const { state, seat } = fixedFlopSpot();
  const read: ObservedSeatRead = {
    seat: 1,
    handsSeen: 220,
    vpip: 0.62,
    aggressionFrequency: 0.2,
    foldToBetFrequency: 0.72,
    confidenceHalfWidth: 0.066,
    reliability: 'reasonable',
  };
  const observations: PolicyObservations = {
    statsFor: () => read,
    rangeFor: () => topPercentRange(55),
    adjustmentsFor: (_seat, adaptation) => ({
      bluffMore: 1 + 0.5 * adaptation,
      valueBetThinner: 1 + 0.3 * adaptation,
      foldMore: 1,
      sizeUp: 1 + 0.2 * adaptation,
      isolateMore: 1 + 0.4 * adaptation,
    }),
  };
  const decision = decide(
    inputFor({
      state,
      seat,
      traits: traitsFor('adaptive-exploiter'),
      difficulty: fastSettings('realistic'),
      seed: 15,
      observations,
    }),
  );
  const note = decision.whatChangedIt.find((entry) => entry.startsWith('Opponent read:'));
  assert.ok(note !== undefined);
  assert.match(note, /220 observed hands/);
  assert.match(note, /72\.0% of bets/);
  assert.match(note, /bluff multiplier/);
  assert.deepEqual(findImpersonation(note), []);
});

// ---------------------------------------------------------------------------
// Adaptation: the read reaches a decision through exactly one gate
// ---------------------------------------------------------------------------

/**
 * A real `OpponentModel` carrying 200 hands of one extreme style, fed the way `bots.ts` feeds
 * one: `observeAction` per public action, then `observe` on the completed redacted view.
 *
 * Real hands rather than synthetic `PlayerView`s, because the claim under test is about what a
 * model that has actually watched a table does with a decision. `station` calls everything and
 * folds to nothing; `rock` folds every hand it is not given for free. Every seat gets the same
 * treatment, so whichever seat the policy picks as its primary opponent carries the same read.
 */
function modelAfterWatching(kind: 'station' | 'rock', ownSeat: SeatIndex, hands = 200): OpponentModel {
  const model = createOpponentModel(ownSeat);
  for (let hand = 0; hand < hands; hand++) {
    let state = dealHand({
      stacks: [300, 300, 300],
      buttonSeat: hand % 3,
      seed: 5_000 + hand,
      config: { maxSeats: 3 },
    });
    for (let step = 0; state.street !== 'complete' && step < 60; step++) {
      const seat = state.toAct;
      assert.ok(seat !== null, 'a live hand always has somebody to act');
      const view = redactFor(state, { viewerSeat: seat });
      const offered = new Set(view.legalActions.map((entry) => entry.type));
      const action: Action =
        kind === 'station'
          ? offered.has('check')
            ? { type: 'check' }
            : { type: 'call' }
          : offered.has('fold')
            ? { type: 'fold' }
            : { type: 'check' };
      const before = state;
      state = applyAction(state, seat, action, { actionId: `read-${hand}-${step}` }).state;
      const logged = state.actions[state.actions.length - 1];
      assert.ok(logged !== undefined);
      model.observeAction({
        handId: before.handId,
        seat,
        street: before.street as 'preflop' | 'flop' | 'turn' | 'river',
        action: action.type,
        toCall: view.amountToCall,
        potBefore: view.potTotal,
        amountPaid: logged.amountPaid,
        facingPreflopRaise: before.street === 'preflop' && before.betLevel > before.config.bigBlind,
        raiseWasAvailable: offered.has('bet') || offered.has('raise'),
      });
    }
    model.observe(redactFor(state, { viewerSeat: ownSeat }));
  }
  return model;
}

/**
 * The paired-decision measurement that proved defect 1, kept as the guard.
 *
 * Two `decide` calls per spot with byte-identical view, hole cards, traits, difficulty and
 * seeded generator, varying ONLY the opponent model. At a difficulty whose card says
 * "adaptation is off entirely" the two must agree on every single one, because there should be
 * no channel through which a read reaches the decision at all.
 *
 * Before the fix: `adjustmentsFor` was gated on the adaptation weight and `rangeFor` was gated
 * on nothing, so `assessPostflop` priced every decision against a range built from what the
 * model had watched. Measured over 350 real postflop spots at `educational`, the sampled action
 * differed in 209 of 1,050 paired decisions — `{bet, to: 166}` against a station read versus
 * `{check}` against a folder read in the same spot. After: 0 of 1,050, and 0 here.
 *
 * The `expert` half is the negative control, and it is the half that would catch a "fix" that
 * simply stopped reading the sample: adaptation is on there, so the two reads MUST diverge. A
 * mute rather than a gate passes the educational assertion and fails this one.
 */
test('at a difficulty with adaptation off, the opponent read cannot move a decision', () => {
  const spots = [
    ...Array.from({ length: 25 }, (_unused, index) => threeHandedFlopSpot(index * 23 + 5)),
    ...Array.from({ length: 25 }, (_unused, index) => threeHandedFlopBetFaced(index * 29 + 7)),
  ];
  const profiles = ['adaptive-exploiter', 'vocal-aggressor'];

  // Built once. `ownSeat` is only used by the `opponents` getter, which no policy reads, and
  // every seat was fed the same style anyway — so one model per style serves every spot.
  const station = modelAfterWatching('station', 0, 200);
  const rock = modelAfterWatching('rock', 0, 200);
  for (const seat of [0, 1, 2]) {
    assert.equal(
      station.statsOrNeutralFor(seat).reliability,
      'reasonable',
      'the station read has to be one this model is willing to act on, or nothing is being tested',
    );
    assert.ok(station.statsOrNeutralFor(seat).foldToBetFrequency < 0.1, 'the station folds to nothing');
    assert.ok(rock.statsOrNeutralFor(seat).foldToBetFrequency > 0.7, 'the rock folds to everything');
  }

  const describe = (action: Action): string =>
    action.type === 'bet' || action.type === 'raise' ? `${action.type}:${action.to}` : action.type;

  const disagreements = (difficulty: Difficulty): { differed: number; trials: number } => {
    let differed = 0;
    let trials = 0;
    for (const profileId of profiles) {
      const traits = traitsFor(profileId, difficulty);
      for (const [index, spot] of spots.entries()) {
        const seed = 41_000 + index;
        const sampled = (observations: OpponentModel): string =>
          describe(
            decide(
              inputFor({
                state: spot.state,
                seat: spot.seat,
                traits,
                difficulty: fastSettings(difficulty),
                seed,
                observations,
              }),
            ).action,
          );
        trials += 1;
        if (sampled(station) !== sampled(rock)) differed += 1;
      }
    }
    return { differed, trials };
  };

  const off = disagreements('educational');
  assert.equal(
    off.differed,
    0,
    'educational promises the learner that nothing they did in earlier hands moves this decision, ' +
      `and the read moved it in ${off.differed} of ${off.trials} paired decisions`,
  );

  const on = disagreements('expert');
  assert.ok(
    on.differed > 0,
    'expert adapts hard by design, so a 200-hand station read and a 200-hand rock read must not ' +
      'produce identical decisions everywhere — 0 disagreements here means the gate became a mute',
  );
});

test('the real opponent model satisfies the observation interface a policy asks for', () => {
  const { state, seat } = fixedFlopSpot();
  const model = createOpponentModel(seat);
  const decision = decide(
    inputFor({
      state,
      seat,
      traits: traitsFor('range-narrator'),
      difficulty: fastSettings('expert'),
      seed: 19,
      observations: model,
    }),
  );
  assertDecisionIsWellFormed(decision, redactFor(state, { viewerSeat: seat }).legalActions, 'live model');
  assert.equal(model.statsFor(1 - seat), null, 'an unobserved seat is unknown, not neutral-with-numbers');
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('a policy refuses a view that was redacted for a different seat', () => {
  const { state, seat } = fixedFlopSpot();
  const other = state.seats.find((entry) => entry.seat !== seat);
  assert.ok(other !== undefined);
  const input: PolicyInput = {
    view: redactFor(state, { viewerSeat: other.seat }),
    holeCards: ownCardsOf(state, seat),
    seat,
    traits: traitsFor('patient-technician'),
    difficulty: fastSettings('realistic'),
    observations: stubObservations(topPercentRange(35)),
    random: createDeterministicRandomForTests(1),
  };
  assert.throws(() => decide(input), /view redacted for/);
});

test('a policy refuses to act when the view says it is not its turn', () => {
  const { state, seat } = fixedFlopSpot();
  const other = state.seats.find((entry) => entry.seat !== seat);
  assert.ok(other !== undefined);
  const input: PolicyInput = {
    view: redactFor(state, { viewerSeat: other.seat }),
    holeCards: ownCardsOf(state, other.seat),
    seat: other.seat,
    traits: traitsFor('patient-technician'),
    difficulty: fastSettings('realistic'),
    observations: stubObservations(topPercentRange(35)),
    random: createDeterministicRandomForTests(1),
  };
  assert.throws(() => decide(input), /no legal actions|not its turn|turn/);
});

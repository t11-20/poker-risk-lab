/**
 * Every action the Coach can publish, handed to `@prl/poker-engine`, whose `legalActions` is the one
 * definition of legality. Every candidate is checked, folds included. Availability depends on more
 * than pot, stacks and big blind. The engine allows no aggression when every live opponent is all-in,
 * none after a short all-in this seat has already acted at (`mayRaise`), and nothing once betting is
 * closed.
 * Scenario JSON is parsed here, strictly, because `@prl/content` depends on this package.
 * Whether the product reaches this filter is tested end to end in `apps/api/test/coach-legality.test.ts`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyAction,
  type Card,
  contestablePotFor,
  createDeterministicRandomForTests,
  type HandState,
  legalActions,
  minimumRaiseTo,
  parseCards,
  redactFor,
  type SeatIndex,
  type SeatState,
  startHand,
  validateAction,
} from '@prl/poker-engine';
import {
  buildCoachReport,
  type CoachInput,
  deriveContestablePot,
  deriveLegalActions,
  maximumTo,
  minimumAggressiveTo,
  type Street,
} from '../src/coach.ts';
import { topPercentRange } from '../src/hand-ranking.ts';
import { exactRange, type ParsedRange, parseRange } from '../src/ranges.ts';

const SCENARIO_DIR = path.join(import.meta.dirname, '..', '..', 'content', 'data', 'scenarios');

// A few scenarios need the sampled path. No figure here depends on its precision.
const SAMPLES = 4_000;
const SEED = 20_260_818;

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where}: expected a number`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where}: expected a string`);
  return value;
}

function asArray(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array`);
  return value;
}

function asStreet(value: unknown, where: string): Street {
  const street = asString(value, where);
  if (street === 'preflop' || street === 'flop' || street === 'turn' || street === 'river') return street;
  throw new Error(`${where}: "${street}" is not a betting street`);
}

interface ScenarioSpot {
  readonly id: string;
  readonly street: Street;
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly opponentRange: ParsedRange;
  readonly pot: number;
  readonly toCall: number;
  readonly heroCommittedThisStreet: number;
  readonly heroStack: number;
  readonly opponentStacks: readonly number[];
  readonly bigBlind: number;
  readonly smallBlind: number;
}

function rangeOf(raw: Record<string, unknown>, id: string, blockers: readonly Card[]): ParsedRange {
  const kind = asString(raw.kind, `${id}.opponentRange.kind`);
  if (kind === 'exact') return exactRange(parseCards(asString(raw.cards, `${id}.opponentRange.cards`)));
  if (kind === 'notation') {
    return parseRange(asString(raw.notation, `${id}.opponentRange.notation`), blockers);
  }
  if (kind === 'topPercent') {
    const percent = asNumber(raw.percent, `${id}.opponentRange.percent`);
    return parseRange(topPercentRange(percent).notation, blockers);
  }
  throw new Error(`${id}: unknown opponent range kind "${kind}"`);
}

/**
 * One spot per shipped scenario, as `readSituation` in `@prl/content` produces them. `pot` is
 * everything in the middle before hero's call, hero's chips included, and `toCall` is what hero adds.
 * Hero's own share of this street is kept separately because a legal raise total needs it.
 */
function readScenarioSpots(): readonly ScenarioSpot[] {
  const spots: ScenarioSpot[] = [];
  for (const file of readdirSync(SCENARIO_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    const parsed = asArray(JSON.parse(readFileSync(path.join(SCENARIO_DIR, file), 'utf8')), file);
    for (const entry of parsed) {
      const scenario = asRecord(entry, file);
      const id = asString(scenario.id, `${file}: id`);
      const seats = asArray(scenario.seats, `${id}.seats`).map((seat) => asRecord(seat, `${id}.seats[]`));
      const hero = seats.find((seat) => seat.isHero === true);
      if (hero === undefined) throw new Error(`${id}: no hero seat`);

      const heroCards = parseCards(asString(hero.holeCards, `${id}: hero holeCards`));
      const board = parseCards(asString(scenario.board, `${id}.board`));
      const committed =
        scenario.committedThisStreet === undefined
          ? {}
          : asRecord(scenario.committedThisStreet, `${id}.committedThisStreet`);
      let committedTotal = 0;
      for (const [seat, value] of Object.entries(committed)) {
        committedTotal += asNumber(value, `${id}.committedThisStreet[${seat}]`);
      }
      const heroSeat = asNumber(hero.seat, `${id}: hero seat`);
      const heroCommitted = committed[String(heroSeat)];

      spots.push({
        id,
        street: asStreet(scenario.street, `${id}.street`),
        heroCards,
        board,
        opponentRange: rangeOf(asRecord(scenario.opponentRange, `${id}.opponentRange`), id, [
          ...heroCards,
          ...board,
        ]),
        pot: asNumber(scenario.potBeforeStreet, `${id}.potBeforeStreet`) + committedTotal,
        toCall: asNumber(scenario.toCall, `${id}.toCall`),
        heroCommittedThisStreet:
          heroCommitted === undefined ? 0 : asNumber(heroCommitted, `${id}: hero committed`),
        heroStack: asNumber(hero.stack, `${id}: hero stack`),
        opponentStacks: seats
          .filter((seat) => seat.isHero !== true)
          .map((seat) => asNumber(seat.stack, `${id}: opponent stack`)),
        bigBlind: asNumber(scenario.bigBlind, `${id}.bigBlind`),
        smallBlind: asNumber(scenario.smallBlind, `${id}.smallBlind`),
      });
    }
  }
  return spots;
}

function tuple(cards: readonly Card[], id: string): readonly [Card, Card] {
  const [first, second] = cards;
  if (first === undefined || second === undefined) throw new Error(`${id}: needs two hole cards`);
  return [first, second];
}

/**
 * A real hand with this street's betting reconstructed on top. Only the betting fields matter.
 * `lastFullRaiseIncrement` is `toCall`, which makes the engine's minimum as low as it can legitimately
 * be. Anything smaller would make this test easier to pass.
 */
function stateForSpot(spot: ScenarioSpot): HandState {
  const opponentStack = spot.opponentStacks[0] ?? 1_000;
  const started = startHand({
    handId: `legality-${spot.id}`,
    roomId: 'legality',
    handNumber: 1,
    config: {
      smallBlind: spot.smallBlind,
      bigBlind: spot.bigBlind,
      ante: 0,
      maxSeats: 2,
      actionTimeoutSeconds: 30,
    },
    buttonSeat: 0,
    seats: [
      { seat: 0, playerId: 'hero', stack: Math.max(spot.bigBlind, spot.heroStack) },
      { seat: 1, playerId: 'villain', stack: Math.max(spot.bigBlind, opponentStack) },
    ],
    random: createDeterministicRandomForTests(7),
  });

  const betLevel = spot.heroCommittedThisStreet + spot.toCall;
  const hero: SeatState = {
    seat: 0,
    playerId: 'hero',
    stack: spot.heroStack,
    committedThisStreet: spot.heroCommittedThisStreet,
    committedTotal: spot.heroCommittedThisStreet,
    holeCards: tuple(spot.heroCards, spot.id),
    status: 'active',
    lastActedAtBetLevel: null,
    isAllInThisHand: false,
  };
  const villain: SeatState = {
    seat: 1,
    playerId: 'villain',
    stack: opponentStack,
    committedThisStreet: betLevel,
    committedTotal: betLevel,
    holeCards: null,
    status: 'active',
    lastActedAtBetLevel: betLevel,
    isAllInThisHand: false,
  };

  return {
    ...started.state,
    street: spot.street,
    board: [...spot.board],
    seats: [hero, villain],
    toAct: 0,
    betLevel,
    lastFullRaiseBetLevel: betLevel,
    lastFullRaiseIncrement: spot.toCall,
    potFromPreviousStreets: spot.pot - betLevel,
  };
}

function coachInputFor(spot: ScenarioSpot, state: HandState): CoachInput {
  return {
    heroCards: spot.heroCards,
    board: spot.board,
    street: spot.street,
    opponents: [{ label: 'villain', range: spot.opponentRange }],
    pot: spot.pot,
    // A described scenario, so the derivation, as `POST /math/coach` does.
    contestablePot: deriveContestablePot(spot),
    toCall: spot.toCall,
    heroCommittedThisStreet: spot.heroCommittedThisStreet,
    heroStack: spot.heroStack,
    opponentStacks: spot.opponentStacks,
    bigBlind: spot.bigBlind,
    // The engine's own ruling, as `coachSpotForView` passes it.
    legalActions: legalActions(state, 0).map((entry) => entry.type),
    samples: SAMPLES,
    seed: SEED,
  };
}

/**
 * Hands every action in a report to the engine and returns the rejections, so a failure can count
 * affected scenarios. It asks whether the engine offers the action kind, whether the size is inside
 * its bounds, and whether `validateAction` accepts it with the same total and cost the Coach published.
 */
function rejectionsFor(
  state: HandState,
  seat: SeatIndex,
  report: ReturnType<typeof buildCoachReport>,
): string[] {
  const problems: string[] = [];
  const legal = legalActions(state, seat);
  const offered = new Set(legal.map((entry) => entry.type));

  const check = (
    action: 'fold' | 'check' | 'call' | 'bet' | 'raise',
    to: number | undefined,
    cost: number | undefined,
    what: string,
  ): void => {
    if (!offered.has(action)) {
      problems.push(
        `${what}: the engine offers no ${action} at all here (it offers ${
          legal.length === 0 ? 'nothing' : [...offered].join(', ')
        })`,
      );
      return;
    }
    const entry = legal.find((candidate) => candidate.type === action);
    // Bounds first, so a failure says which end was missed, then the engine's own validation.
    if (to !== undefined && entry?.minTo !== undefined && to < entry.minTo) {
      problems.push(`${what}: ${action} to ${to} is below the engine minimum of ${entry.minTo}`);
    }
    if (to !== undefined && entry?.maxTo !== undefined && to > entry.maxTo) {
      problems.push(`${what}: ${action} to ${to} is above the engine maximum of ${entry.maxTo}`);
    }
    try {
      const validated = validateAction(
        state,
        seat,
        to === undefined ? { type: action } : { type: action, to },
      );
      if (to !== undefined && validated.to !== to) {
        problems.push(`${what}: ${action} published to ${to}, the engine reads it as ${validated.to}`);
      }
      if (cost !== undefined && validated.cost !== cost) {
        problems.push(`${what}: ${action} published a cost of ${cost}, the engine charges ${validated.cost}`);
      }
    } catch (error) {
      problems.push(
        `${what}: ${action}${to === undefined ? '' : ` to ${to}`} rejected — ${(error as Error).message}`,
      );
    }
  };

  for (const candidate of report.candidates) {
    if (candidate.action === 'bet' || candidate.action === 'raise') {
      assert.ok(candidate.to !== undefined, 'an aggressive candidate must carry a total');
      assert.ok(Number.isInteger(candidate.to), `${candidate.action} to ${candidate.to} must be whole chips`);
    }
    check(candidate.action, candidate.to, candidate.cost, 'candidate');
  }

  const suggestion = report.suggestion;
  if (!offered.has(suggestion.action)) {
    problems.push(`suggestion: the engine offers no ${suggestion.action} at all here`);
  }
  const range = suggestion.sizeRange;
  if (range !== undefined && (suggestion.action === 'bet' || suggestion.action === 'raise')) {
    check(suggestion.action, range.min, undefined, 'sizeRange.min');
    check(suggestion.action, range.max, undefined, 'sizeRange.max');
  }
  return problems;
}

test('every action the Coach publishes for a shipped scenario is legal to the engine', () => {
  const spots = readScenarioSpots();
  // A sweep of nothing is not a pass.
  assert.ok(spots.length >= 30, `expected the shipped Scenario Lab, found ${spots.length} scenarios`);

  const failures: string[] = [];
  let checkedActions = 0;
  let checkedSizes = 0;
  let scenariosWithAggression = 0;

  for (const spot of spots) {
    const state = stateForSpot(spot);
    const report = buildCoachReport(coachInputFor(spot, state));
    const aggressive = report.candidates.filter(
      (candidate) => candidate.action === 'bet' || candidate.action === 'raise',
    );
    if (aggressive.length > 0) scenariosWithAggression += 1;
    checkedSizes += aggressive.length;
    checkedActions += report.candidates.length;

    const problems = rejectionsFor(state, 0, report);
    if (problems.length > 0) {
      failures.push(
        `${spot.id} (facing ${spot.toCall} with ${spot.heroCommittedThisStreet} out, engine minimum ` +
          `${minimumRaiseTo(state)}): ${problems.join('; ')}`,
      );
    }
  }

  assert.ok(scenariosWithAggression >= 30, `only ${scenariosWithAggression} scenarios offered aggression`);
  assert.ok(checkedSizes >= 60, `only ${checkedSizes} sizes were checked`);
  assert.ok(checkedActions >= 100, `only ${checkedActions} actions were checked`);
  assert.equal(
    failures.length,
    0,
    `${failures.length} of ${spots.length} scenarios publish an action the engine rejects:\n${failures.join('\n')}`,
  );
});

interface PlayedHand {
  readonly label: string;
  readonly state: HandState;
  readonly seat: SeatIndex;
}

/** Heads-up, blinds 5 and 10. Seat 0 has the button, posts the small blind and acts first preflop. */
function headsUp(stacks: readonly [number, number]): HandState {
  return startHand({
    handId: 'played',
    roomId: 'legality',
    handNumber: 1,
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats: [
      { seat: 0, playerId: 'button', stack: stacks[0] },
      { seat: 1, playerId: 'blind', stack: stacks[1] },
    ],
    random: createDeterministicRandomForTests(11),
  }).state;
}

function playedHands(): readonly PlayedHand[] {
  const hands: PlayedHand[] = [];

  // (i) Preflop. The button raises to 30. The big blind owes 20, and the minimum legal raise is to 50.
  {
    const opened = applyAction(headsUp([1_000, 1_000]), 0, { type: 'raise', to: 30 }).state;
    hands.push({ label: 'preflop, big blind facing a raise to 30', state: opened, seat: 1 });
  }

  // (ii) Hero bets the flop and is raised, so hero has chips out and faces a raise.
  {
    let state = headsUp([1_000, 1_000]);
    state = applyAction(state, 0, { type: 'call' }).state; // button limps
    state = applyAction(state, 1, { type: 'check' }).state; // blind checks the option
    assert.equal(state.street, 'flop', 'the hand should be on the flop');
    state = applyAction(state, 1, { type: 'bet', to: 20 }).state; // hero (seat 1) bets 20
    state = applyAction(state, 0, { type: 'raise', to: 80 }).state; // raised to 80
    hands.push({ label: 'flop, hero bet 20 and was raised to 80', state, seat: 1 });
  }

  // (iii) A short stack whose only aggression is an all-in below the minimum raise. The engine allows
  //       that as an incomplete raise, and the Coach must offer exactly it.
  {
    const opened = applyAction(headsUp([1_000, 95]), 0, { type: 'raise', to: 60 }).state;
    hands.push({ label: 'preflop, 95-chip big blind facing a raise to 60', state: opened, seat: 1 });
  }

  return hands;
}

/**
 * The Coach input for a played hand, built from the redacted view as `coachSpotForView` builds it.
 * `tellTheMinimum` passes the engine's `minimumRaiseTo`. Without it the Coach derives the floor, as
 * the ad-hoc calculator and the profile comparison must.
 */
function inputForPlayedHand(hand: PlayedHand, tellTheMinimum: boolean, tellTheActions = true): CoachInput {
  const view = redactFor(hand.state, { viewerSeat: hand.seat });
  const own = view.seats.find((seat) => seat.isSelf);
  const heroCards = own?.holeCards;
  assert.ok(
    own !== undefined && heroCards !== null && heroCards !== undefined,
    `${hand.label}: no hole cards`,
  );
  const street = view.street;
  assert.ok(street !== 'showdown' && street !== 'complete', `${hand.label}: no decision to analyse`);

  const live = view.seats.filter(
    (seat) => !seat.isSelf && (seat.status === 'active' || seat.status === 'allIn'),
  );
  return {
    heroCards,
    board: view.board,
    street,
    // Hero's cards and the board are removed as blockers, so no spot lacks a legal matchup.
    opponents: live.map((seat) => ({
      label: `seat ${seat.seat}`,
      range: parseRange('22+, A2s+, K9s+, QTs+, JTs, A9o+, KTo+, QJo', [...heroCards, ...view.board]),
    })),
    pot: view.potTotal,
    // From the engine's layering, as `coachSpotForView` does it. Some of these hands leave hero all-in
    // for less than the bet.
    contestablePot: contestablePotFor({
      seats: view.seats,
      heroSeat: own.seat,
      callAmount: view.amountToCall,
      potTotal: view.potTotal,
    }).contestable,
    toCall: view.amountToCall,
    heroCommittedThisStreet: own.committedThisStreet,
    heroStack: own.stack,
    opponentStacks: live.map((seat) => seat.stack),
    bigBlind: view.config.bigBlind,
    ...(tellTheMinimum ? { minimumRaiseTo: view.minimumRaiseTo } : {}),
    // `redactFor` fills `legalActions` only for the seat to act. `tellTheActions: false` is what a
    // caller with no `HandState` produces, and then the derivation runs.
    ...(tellTheActions ? { legalActions: view.legalActions.map((entry) => entry.type) } : {}),
    samples: SAMPLES,
    seed: SEED,
  };
}

test('every size the Coach publishes for a hand actually played is legal to the engine', () => {
  for (const hand of playedHands()) {
    const report = buildCoachReport(inputForPlayedHand(hand, true));

    const aggressive = report.candidates.filter(
      (candidate) => candidate.action === 'bet' || candidate.action === 'raise',
    );
    assert.ok(aggressive.length > 0, `${hand.label}: the spot should offer aggression`);

    const problems = rejectionsFor(hand.state, hand.seat, report);
    assert.deepEqual(problems, [], `${hand.label}: ${problems.join('; ')}`);

    // Apply the first aggressive size for real too. A size that validates but fails to apply is a defect.
    const first = aggressive[0];
    assert.ok(first?.to !== undefined);
    const applied = applyAction(hand.state, hand.seat, { type: first.action, to: first.to });
    assert.ok(applied.state.actionSequence > hand.state.actionSequence, `${hand.label}: the action applied`);

    const range = report.suggestion.sizeRange;
    if (range !== undefined && (report.suggestion.action === 'bet' || report.suggestion.action === 'raise')) {
      applyAction(hand.state, hand.seat, { type: report.suggestion.action, to: range.min });
      applyAction(hand.state, hand.seat, { type: report.suggestion.action, to: range.max });
    }
  }
});

/**
 * Three seats, blinds 5 and 10, so a seat can be all-in while somebody else still has a decision.
 * Heads-up, an all-in that is matched closes the betting for the whole hand.
 */
function threeHanded(stacks: readonly [number, number, number]): HandState {
  return startHand({
    handId: 'restricted',
    roomId: 'legality',
    handNumber: 1,
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 3, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats: stacks.map((stack, index) => ({ seat: index, playerId: `p${index}`, stack })),
    random: createDeterministicRandomForTests(11),
  }).state;
}

/**
 * Spots where the engine refuses hero a raise for reasons pot arithmetic does not reveal. The test
 * re-verifies each premise against `legalActions`.
 */
function restrictedHands(): readonly PlayedHand[] {
  const hands: PlayedHand[] = [];

  // (iv) Every live opponent is all-in. Seat 0 folds, seat 1 shoves its 40, and seat 2 has 990 behind
  //      facing 30. Nobody is left to call a raise. Engine: fold, call.
  {
    let state = threeHanded([1_000, 40, 1_000]);
    state = applyAction(state, 0, { type: 'fold' }).state;
    state = applyAction(state, 1, { type: 'raise', to: 40 }).state;
    hands.push({ label: 'every live opponent is all-in', state, seat: 2 });
  }

  // (v) A short all-in that does not reopen the action. Seat 0 raises to 30, seat 1 calls, seat 2 is
  //     all-in for 45, short of the 50 minimum, so `lastFullRaiseBetLevel` stays at 30 and seat 0's
  //     `mayRaise` is false. Engine: fold, call.
  {
    let state = threeHanded([1_000, 1_000, 45]);
    state = applyAction(state, 0, { type: 'raise', to: 30 }).state;
    state = applyAction(state, 1, { type: 'call' }).state;
    state = applyAction(state, 2, { type: 'raise', to: 45 }).state;
    hands.push({ label: 'a short all-in has closed the action to hero', state, seat: 0 });
  }

  return hands;
}

test('the Coach publishes no action the engine withholds, however affordable it looks', () => {
  const hands = restrictedHands();
  assert.equal(hands.length, 2, 'both restricted shapes must be exercised');

  for (const hand of hands) {
    const offered = legalActions(hand.state, hand.seat).map((entry) => entry.type);
    // The premise, asserted. If a rules change makes a raise legal here, this fails.
    assert.deepEqual(
      [...offered].sort(),
      ['call', 'fold'],
      `${hand.label}: the engine should offer only fold and call`,
    );

    const input = inputForPlayedHand(hand, true);
    // Hero can afford a raise, so affordability alone would wrongly allow one.
    assert.ok(
      input.heroStack - input.toCall > input.bigBlind * 2,
      `${hand.label}: hero must have chips behind for this to prove anything`,
    );

    const report = buildCoachReport(input);
    const aggressive = report.candidates.filter(
      (candidate) => candidate.action === 'bet' || candidate.action === 'raise',
    );
    assert.deepEqual(
      aggressive.map((candidate) => `${candidate.action} to ${String(candidate.to)}`),
      [],
      `${hand.label}: the Coach published aggression the engine refuses`,
    );
    assert.notEqual(report.suggestion.action, 'raise', `${hand.label}: suggested a raise`);
    assert.notEqual(report.suggestion.action, 'bet', `${hand.label}: suggested a bet`);
    assert.deepEqual(rejectionsFor(hand.state, hand.seat, report), [], hand.label);

    const suggested = report.suggestion.action;
    assert.ok(suggested === 'fold' || suggested === 'call', `${hand.label}: suggested ${suggested}`);
    applyAction(hand.state, hand.seat, { type: suggested });
  }
});

test('an empty legal-action list is refused rather than answered', () => {
  // `legalActions` is empty when betting is closed or it is not this seat's turn. Any action would be
  // rejected, so the Coach must not report. `redactFor` produces this for every seat not to act.
  const [first] = restrictedHands();
  assert.ok(first !== undefined);
  const bystander = redactFor(first.state, { viewerSeat: 1 });
  assert.deepEqual([...bystander.legalActions], [], 'a seat that is not to act is offered nothing');

  assert.throws(
    () =>
      buildCoachReport({
        ...inputForPlayedHand(first, true),
        legalActions: [],
      }),
    /no legal action/i,
  );
});

test('a legal-action list that disagrees with the spot is refused, not silently applied', () => {
  // Filtering against a stale list would publish a report for a different decision point. Both
  // directions are checked.
  const [restricted] = restrictedHands();
  assert.ok(restricted !== undefined);
  const facingABet = inputForPlayedHand(restricted, true);
  assert.ok(facingABet.toCall > 0, 'this fixture faces a bet');

  assert.throws(
    () => buildCoachReport({ ...facingABet, legalActions: ['fold', 'check'] }),
    /different decision points/,
  );
  assert.throws(
    () => buildCoachReport({ ...facingABet, toCall: 0, legalActions: ['fold', 'call'] }),
    /different decision points/,
  );
});

test('the smallest raise the Coach offers is never below the engine minimum, told it or not', () => {
  // The derived floor must clear the engine's minimum on its own, because two callers cannot supply it.
  const smallest = (report: ReturnType<typeof buildCoachReport>): number =>
    Math.min(
      ...report.candidates
        .filter((candidate) => candidate.action === 'bet' || candidate.action === 'raise')
        .map((candidate) => candidate.to ?? Number.POSITIVE_INFINITY),
    );

  for (const hand of playedHands()) {
    const derived = buildCoachReport(inputForPlayedHand(hand, false));
    const told = buildCoachReport(inputForPlayedHand(hand, true));

    const engineMinimum = legalActions(hand.state, hand.seat).find(
      (entry) => entry.type === 'bet' || entry.type === 'raise',
    )?.minTo;
    assert.ok(engineMinimum !== undefined, `${hand.label}: the engine should offer aggression`);
    for (const [what, report] of [
      ['derived', derived],
      ['supplied', told],
    ] as const) {
      assert.ok(
        smallest(report) >= engineMinimum,
        `${hand.label}: the ${what} floor produced ${smallest(report)} against an engine minimum of ${engineMinimum}`,
      );
      assert.deepEqual(rejectionsFor(hand.state, hand.seat, report), [], `${hand.label}: ${what} floor`);
    }
    assert.ok(
      smallest(derived) >= smallest(told),
      `${hand.label}: the derived floor must never sit below the engine's own minimum`,
    );
  }
});

function engineOffers(state: HandState, seat: SeatIndex): readonly string[] {
  return legalActions(state, seat)
    .map((entry) => entry.type)
    .sort();
}

test('the derived legal set reproduces the engine on every state this file builds', () => {
  // The derivation is checked against the engine on the scenario reconstructions and the played hands.
  const spots = readScenarioSpots();
  assert.ok(spots.length >= 30, `expected the shipped Scenario Lab, found ${spots.length}`);

  const mismatches: string[] = [];
  for (const spot of spots) {
    const state = stateForSpot(spot);
    // The reconstruction is heads-up, so the derivation is asked about the same one opponent.
    const derived = [
      ...deriveLegalActions({
        toCall: spot.toCall,
        heroCommittedThisStreet: spot.heroCommittedThisStreet,
        heroStack: spot.heroStack,
        opponentStacks: [spot.opponentStacks[0] ?? 0],
      }),
    ].sort();
    const offered = engineOffers(state, 0);
    if (derived.join(',') !== offered.join(',')) {
      mismatches.push(`${spot.id}: derived ${derived.join('+')}, engine ${offered.join('+')}`);
    }
  }

  for (const hand of playedHands()) {
    const input = inputForPlayedHand(hand, true, false);
    const derived = [...deriveLegalActions(input)].sort();
    const offered = engineOffers(hand.state, hand.seat);
    if (derived.join(',') !== offered.join(',')) {
      mismatches.push(`${hand.label}: derived ${derived.join('+')}, engine ${offered.join('+')}`);
    }
  }

  assert.deepEqual(mismatches, [], `the derivation disagreed with the engine:\n${mismatches.join('\n')}`);
});

test('the derivation matches the engine when nobody is left to call, and is knowingly wider only for mayRaise', () => {
  const [everyoneAllIn, shortAllIn] = restrictedHands();
  assert.ok(everyoneAllIn !== undefined && shortAllIn !== undefined);

  // (iv) Only `opponentStacks` shows a raise is unavailable, and the derivation reads it.
  const allInInput = inputForPlayedHand(everyoneAllIn, true, false);
  assert.ok(
    allInInput.opponentStacks.some((stack) => stack === 0),
    'the live opponent is all-in',
  );
  assert.deepEqual(
    [...deriveLegalActions(allInInput)].sort(),
    engineOffers(everyoneAllIn.state, everyoneAllIn.seat),
  );

  // (v) The one case the derivation cannot see. It depends on `lastFullRaiseBetLevel` and
  // `lastActedAtBetLevel`, which a spot description does not carry. Asserted as a known, bounded gap.
  const shortInput = inputForPlayedHand(shortAllIn, true, false);
  assert.deepEqual(engineOffers(shortAllIn.state, shortAllIn.seat), ['call', 'fold']);
  assert.deepEqual([...deriveLegalActions(shortInput)].sort(), ['call', 'fold', 'raise']);
  assert.ok(
    shortInput.opponentStacks.some((stack) => stack > 0),
    'this gap exists precisely because somebody here does still have chips behind',
  );
});

test('with no legal-action list at all, the Coach still withholds a raise nobody could call', () => {
  // Absent `legalActions` once disabled the filter, and this input published three raises.
  const [everyoneAllIn] = restrictedHands();
  assert.ok(everyoneAllIn !== undefined);

  const withoutTheList = inputForPlayedHand(everyoneAllIn, true, false);
  assert.equal(withoutTheList.legalActions, undefined, 'this is the shape the wire used to produce');
  assert.ok(
    withoutTheList.heroStack - withoutTheList.toCall > withoutTheList.bigBlind * 2,
    'hero can plainly afford a raise — affordability was the only thing the old guard checked',
  );

  const report = buildCoachReport(withoutTheList);
  assert.deepEqual(
    report.candidates
      .filter((candidate) => candidate.action === 'bet' || candidate.action === 'raise')
      .map((candidate) => `${candidate.action} to ${String(candidate.to)}`),
    [],
    'the Coach published aggression against a table that had nothing left to call with',
  );
  assert.ok(
    report.suggestion.action === 'fold' || report.suggestion.action === 'call',
    `headlined ${report.suggestion.action}`,
  );
  assert.deepEqual(rejectionsFor(everyoneAllIn.state, everyoneAllIn.seat, report), []);
});

test('with no legal-action list, an ordinary spot is not over-restricted either', () => {
  // The other direction. A guard that closes on everything shows the learner lines that do not exist.
  for (const hand of playedHands()) {
    const derived = buildCoachReport(inputForPlayedHand(hand, true, false));
    const told = buildCoachReport(inputForPlayedHand(hand, true, true));
    assert.deepEqual(
      [...new Set(derived.candidates.map((candidate) => candidate.action))].sort(),
      [...new Set(told.candidates.map((candidate) => candidate.action))].sort(),
      `${hand.label}: the derived set and the engine's set produced different action kinds`,
    );
    assert.deepEqual(rejectionsFor(hand.state, hand.seat, derived), [], hand.label);
  }
});

test('no candidate costs more than hero has behind, or reaches a total hero cannot reach', () => {
  // `heroStack` is chips behind, so `cost` is checked against it and `to` against
  // `heroCommittedThisStreet + heroStack`. The data includes spots with and without a posted blind.
  const spots = readScenarioSpots();
  const problems: string[] = [];
  let withCommitment = 0;

  for (const spot of spots) {
    if (spot.heroCommittedThisStreet > 0) withCommitment += 1;
    const state = stateForSpot(spot);
    const report = buildCoachReport(coachInputFor(spot, state));
    const maxTo = spot.heroCommittedThisStreet + spot.heroStack;
    for (const candidate of report.candidates) {
      if (candidate.cost > spot.heroStack) {
        problems.push(
          `${spot.id}: ${candidate.action} costs ${candidate.cost} with ${spot.heroStack} behind`,
        );
      }
      if (candidate.to !== undefined && candidate.to > maxTo) {
        problems.push(
          `${spot.id}: ${candidate.action} reaches ${candidate.to} against a maximum of ${maxTo}`,
        );
      }
    }
  }

  assert.ok(withCommitment >= 3, `only ${withCommitment} scenarios have hero committed on the street`);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test("the bounds a grader holds a learner to are the engine's own maxTo, and never below its minTo", () => {
  // The Scenario Lab's attempt endpoint refuses sizes outside these bounds, so both are measured
  // against the engine. `maximumTo` must equal the engine's `maxTo` exactly. `minimumAggressiveTo` may
  // sit at or above `minTo`, never below. It can be above when the facing bet is not the last full raise.
  let checked = 0;
  for (const hand of playedHands()) {
    const input = inputForPlayedHand(hand, false);
    const aggressive = legalActions(hand.state, hand.seat).find(
      (entry) => entry.type === 'bet' || entry.type === 'raise',
    );
    assert.ok(aggressive !== undefined, `${hand.label}: the engine should offer aggression`);
    assert.ok(aggressive.minTo !== undefined && aggressive.maxTo !== undefined);

    assert.equal(
      maximumTo(input),
      aggressive.maxTo,
      `${hand.label}: the ceiling a submitted size is held to must be the engine's own maximum`,
    );
    assert.ok(
      minimumAggressiveTo(input) >= aggressive.minTo,
      `${hand.label}: derived floor ${minimumAggressiveTo(input)} sits below the engine minimum of ${aggressive.minTo}`,
    );
    // Told the engine's figure, the floor is exact.
    assert.equal(minimumAggressiveTo(inputForPlayedHand(hand, true)), aggressive.minTo);
    checked += 1;
  }
  assert.ok(checked >= 3, `only ${checked} hands exercised the bounds`);

  // A stack too short to reach the minimum may still shove, so the floor clamps to the all-in.
  const short = {
    toCall: 40,
    heroCommittedThisStreet: 10,
    heroStack: 25,
    opponentStacks: [500],
    bigBlind: 20,
  };
  assert.equal(maximumTo(short), 35);
  assert.equal(minimumAggressiveTo(short), 35, 'clamped to the shove rather than left above it');
});

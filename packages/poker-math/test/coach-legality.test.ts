/**
 * Every ACTION the Coach can publish, handed to the engine that would have to accept it.
 *
 * ## Why this test exists
 *
 * `coach.test.ts` used to check that a candidate's `to` was an integer. That is a check on
 * the *type* of the number and says nothing about whether it is a legal action, and it
 * passed happily while the Coach published raise sizes below the minimum legal raise in 20
 * of the 34 shipped scenarios that face a bet — including the size it printed as the
 * headline of its own suggestion. A learner following the panel would have had the action
 * rejected by the server with a `BettingRuleError`.
 *
 * That was fixed at the level of the *size*. This file now covers the level above it, which
 * was still open: whether the action is **available at all**. Legality is not a function of
 * the pot, the stacks and the big blind, and three of the engine's rules are invisible from
 * them —
 *
 *   - no bet or raise when every live opponent is all-in, because nobody could call it;
 *   - no bet or raise when the last increase was a short all-in and this seat has already
 *     acted at that level (`mayRaise`);
 *   - no action of any kind, not even a fold, once betting is closed for the hand.
 *
 * — so the Coach's only guard, `if (maxRaiseBy > 0)`, could not see any of them. Measured
 * before the fix, in a three-handed preflop spot with one seat folded and the other all-in:
 * the engine offered `fold, call`, the Coach published three raises, and its headline
 * suggestion was "raise to 80-100" at "reasonable confidence".
 *
 * So this file does not re-derive what "legal" means. It asks `@prl/poker-engine`, whose
 * `legalActions` is the single definition of legality in this codebase and is exercised
 * here through both `validateAction` (the same function `applyAction` calls) and, in the
 * played-out cases below, `applyAction` itself. Every candidate is checked, not only the
 * aggressive ones: a fold the engine refuses is as wrong as a raise it refuses.
 *
 * ## The three halves
 *
 * 1. **Every shipped scenario.** The Scenario Lab's data files are read from disk and each
 *    one's street is reconstructed as a `HandState`. Reading `@prl/content` would be
 *    circular — that package depends on this one — so the JSON is parsed here, strictly,
 *    and a shape this file does not recognise fails the test rather than being skipped.
 *    The engine's own `legalActions` for that reconstructed state is handed to the Coach,
 *    which is exactly what `coachForView` does with a live view.
 * 2. **Hands actually played.** Blinds posted and actions applied through `applyAction`,
 *    then the Coach is built from `redactFor(state, seat)` exactly as the live WebSocket
 *    caller builds it. This is the half that would catch a mistake in the reconstruction
 *    of half one.
 * 3. **Hands the engine restricts.** The two spots above, played out, where the engine
 *    withholds aggression for a reason nothing in the pot or the stacks reveals.
 * 4. **The derivation, measured against the engine.** `deriveLegalActions` is what the
 *    callers with no `HandState` are given instead of the engine's list. It is only worth
 *    having if it agrees with the engine, so it is run against the engine's own answer for
 *    every state this file builds — and the single case where it is knowingly wider is
 *    named, asserted, and explained rather than left to be discovered.
 *
 * ## What this file could NOT catch, and where that is caught instead
 *
 * Every case here hands `buildCoachReport` its own input. That is the right shape for
 * testing a filter and the wrong shape for testing whether the *product* reaches the
 * filter: the field was optional, `CoachTask` had no slot for it, and four of the five
 * Coach surfaces therefore analysed with the guard disabled while this file passed. The
 * end-to-end half lives in `apps/api/test/coach-legality.test.ts`, which drives the real
 * task builders through a real worker pool. Both are needed; neither replaces the other.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyAction,
  type Card,
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
import { buildCoachReport, type CoachInput, deriveLegalActions, type Street } from '../src/coach.ts';
import { topPercentRange } from '../src/hand-ranking.ts';
import { exactRange, type ParsedRange, parseRange } from '../src/ranges.ts';

const SCENARIO_DIR = path.join(import.meta.dirname, '..', '..', 'content', 'data', 'scenarios');

// The scenarios have wide ranges on early streets, so a few need the sampled path. The
// count only has to be enough to produce a report; no figure here depends on its precision.
const SAMPLES = 4_000;
const SEED = 20_260_818;

// ---------------------------------------------------------------------------
// Reading the shipped scenarios, strictly
// ---------------------------------------------------------------------------

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
 * One spot per shipped scenario, in the same terms `readSituation` in `@prl/content`
 * produces them: `pot` is everything in the middle before hero's call — chips carried in
 * from earlier streets plus everything committed on this street by anybody, hero included
 * — and `toCall` is what hero adds on top. Hero's own share of this street's commitments
 * is kept separately, because that is the part a legal raise total needs.
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

// ---------------------------------------------------------------------------
// Turning a spot into a state the betting rules can be asked about
// ---------------------------------------------------------------------------

function tuple(cards: readonly Card[], id: string): readonly [Card, Card] {
  const [first, second] = cards;
  if (first === undefined || second === undefined) throw new Error(`${id}: needs two hole cards`);
  return [first, second];
}

/**
 * A real hand, with this street's betting reconstructed on top of it.
 *
 * The deck, salts and commitment come from `startHand` and are never consulted: the only
 * question asked of this state is "what may this seat do now", which `betting.ts` answers
 * from the seats' commitments, the bet level, the last full raise increment and the big
 * blind. Those five are exactly what is set here.
 *
 * `lastFullRaiseIncrement` is set to `toCall`, which is the tightest reconstruction the
 * stored data supports and the one that makes the engine's minimum as *low* as it can
 * legitimately be: in a two-handed street the last complete raise took the level from
 * hero's own commitment to the level now in force, so its increment is exactly `toCall`.
 * Anything smaller would raise the engine's minimum and make this test easier to pass.
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
    toCall: spot.toCall,
    heroCommittedThisStreet: spot.heroCommittedThisStreet,
    heroStack: spot.heroStack,
    opponentStacks: spot.opponentStacks,
    bigBlind: spot.bigBlind,
    // The engine's own ruling, exactly as `coachForView` passes it from a live view.
    legalActions: legalActions(state, 0).map((entry) => entry.type),
    samples: SAMPLES,
    seed: SEED,
  };
}

/**
 * Hands every action in a report to the engine. Returns the rejections rather than throwing,
 * so a failure can report how many scenarios are affected instead of stopping at the first.
 *
 * Three separate questions, and all three have to be asked:
 *
 *   1. Does the engine offer this action *kind* at all? A `raise` candidate in a spot whose
 *      `legalActions` is `[fold, call]` is refused before any size is looked at, so a
 *      size-only check reports it as "below the minimum of undefined" or not at all.
 *   2. Is the size inside the engine's own bounds?
 *   3. Does `validateAction` — the function `applyAction` itself calls — accept it, and does
 *      the total and the cost it computes match what the Coach published? A candidate whose
 *      `to` the engine accepts but reinterprets is a panel showing a learner one number and
 *      the table charging them another.
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
    // Bounds first, so a failure says which end was missed, then the engine's own
    // validation, which is the authority and covers everything else (integrality, the
    // stack, whose turn it is).
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

// ---------------------------------------------------------------------------
// Half one: every shipped scenario
// ---------------------------------------------------------------------------

test('every action the Coach publishes for a shipped scenario is legal to the engine', () => {
  const spots = readScenarioSpots();
  // A guard on the guard: if the data moves or the parser silently drops rows, this test
  // would pass by checking nothing at all.
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

// ---------------------------------------------------------------------------
// Half two: hands actually played
// ---------------------------------------------------------------------------

interface PlayedHand {
  readonly label: string;
  readonly state: HandState;
  readonly seat: SeatIndex;
}

/**
 * Heads-up, blinds 5 and 10. Seat 0 has the button, so it posts the small blind and acts
 * first preflop; seat 1 is the big blind.
 */
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

  // (i) Preflop from the blinds. The button raises to 30; the big blind has 10 out
  //     already and owes 20, and the minimum legal raise is to 50 — not to 20 + a ladder
  //     rung, which is what the Coach used to publish and the engine used to refuse.
  {
    const opened = applyAction(headsUp([1_000, 1_000]), 0, { type: 'raise', to: 30 }).state;
    hands.push({ label: 'preflop, big blind facing a raise to 30', state: opened, seat: 1 });
  }

  // (ii) Hero bets the flop and is raised, so hero has chips out AND faces a raise — the
  //      case where the two halves of the old bug compounded.
  {
    let state = headsUp([1_000, 1_000]);
    state = applyAction(state, 0, { type: 'call' }).state; // button limps
    state = applyAction(state, 1, { type: 'check' }).state; // blind checks the option
    assert.equal(state.street, 'flop', 'the hand should be on the flop');
    state = applyAction(state, 1, { type: 'bet', to: 20 }).state; // hero (seat 1) bets 20
    state = applyAction(state, 0, { type: 'raise', to: 80 }).state; // raised to 80
    hands.push({ label: 'flop, hero bet 20 and was raised to 80', state, seat: 1 });
  }

  // (iii) A short stack whose only aggression is an all-in *below* the minimum raise. The
  //       engine allows that as an incomplete raise; the Coach must offer exactly it and
  //       nothing smaller.
  {
    const opened = applyAction(headsUp([1_000, 95]), 0, { type: 'raise', to: 60 }).state;
    hands.push({ label: 'preflop, 95-chip big blind facing a raise to 60', state: opened, seat: 1 });
  }

  return hands;
}

/**
 * The Coach input for a played hand, built from the redacted view exactly as
 * `coachForView` in `apps/api/src/ws/router.ts` builds it — which is the point: if the
 * live caller can construct an illegal size, so can this.
 *
 * `tellTheMinimum` is the one variation. With it, the engine's own `minimumRaiseTo` is
 * passed through; without it, the Coach has to derive a floor from the betting rules.
 * Both are real code paths (the WebSocket caller has a hand state, the ad-hoc calculator
 * and the profile comparison do not) and both are tested.
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
    // A wide range with hero's own cards and the board removed as blockers, so no spot can
    // fail for want of a legal matchup.
    opponents: live.map((seat) => ({
      label: `seat ${seat.seat}`,
      range: parseRange('22+, A2s+, K9s+, QTs+, JTs, A9o+, KTo+, QJo', [...heroCards, ...view.board]),
    })),
    pot: view.potTotal,
    toCall: view.amountToCall,
    heroCommittedThisStreet: own.committedThisStreet,
    heroStack: own.stack,
    opponentStacks: live.map((seat) => seat.stack),
    bigBlind: view.config.bigBlind,
    ...(tellTheMinimum ? { minimumRaiseTo: view.minimumRaiseTo } : {}),
    // The view's own list, which is `legalActions(state, seat)` — populated by `redactFor`
    // only for the seat that is to act. This is the line `coachForView` has too.
    //
    // `tellTheActions: false` is the other real code path, not a hypothetical: it is what a
    // caller with no `HandState` produces, and what the Coach then has to answer for itself.
    // Leaving the field off used to mean "every action is legal"; it now means the derivation
    // runs, and the cases below check that the two answers agree.
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

    // `validateAction` is what `applyAction` calls, but run the real thing at least once
    // per hand as well: a size that validates and then fails to apply would be a defect
    // no amount of validation caught.
    const first = aggressive[0];
    assert.ok(first?.to !== undefined);
    const applied = applyAction(hand.state, hand.seat, { type: first.action, to: first.to });
    assert.ok(applied.state.actionSequence > hand.state.actionSequence, `${hand.label}: the action applied`);

    // The suggestion's own headline size, applied for real too, when it has one.
    const range = report.suggestion.sizeRange;
    if (range !== undefined && (report.suggestion.action === 'bet' || report.suggestion.action === 'raise')) {
      applyAction(hand.state, hand.seat, { type: report.suggestion.action, to: range.min });
      applyAction(hand.state, hand.seat, { type: report.suggestion.action, to: range.max });
    }
  }
});

// ---------------------------------------------------------------------------
// Half three: the spots where the engine withholds aggression
// ---------------------------------------------------------------------------

/**
 * Three seats, blinds 5 and 10, so a seat can be all-in while a live decision remains for
 * somebody else. Two seats cannot produce either of the states below: heads-up, a seat
 * that is all-in and matched closes the betting for the whole hand and the board simply
 * runs out.
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
 * Spots the engine will not let hero raise in, for reasons no amount of pot arithmetic
 * reveals. Both were verified against `legalActions` when they were written; the assertion
 * inside the test re-verifies it rather than trusting the comment, so a change to the
 * betting rules turns this into a failure instead of a test that quietly checks nothing.
 */
function restrictedHands(): readonly PlayedHand[] {
  const hands: PlayedHand[] = [];

  // (iv) Every live opponent is all-in. Seat 0 folds, seat 1 shoves its 40, and seat 2 has
  //      990 behind facing 30 to call — plenty for a raise by any arithmetic the Coach can
  //      do, and nobody left who could call one. Engine: fold, call.
  {
    let state = threeHanded([1_000, 40, 1_000]);
    state = applyAction(state, 0, { type: 'fold' }).state;
    state = applyAction(state, 1, { type: 'raise', to: 40 }).state;
    hands.push({ label: 'every live opponent is all-in', state, seat: 2 });
  }

  // (v) A short all-in that does not reopen the action. Seat 0 raises to 30, seat 1 calls,
  //     seat 2 is all-in for 45 — short of the 50 minimum, so it is an incomplete raise and
  //     `lastFullRaiseBetLevel` stays at 30. Seat 0 last acted at 30, so `mayRaise` is
  //     false: it may call the extra 15 or fold, and nothing else. Engine: fold, call.
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
    // The premise of the spot, asserted rather than assumed. If a rules change ever makes
    // a raise legal here, this fails loudly instead of leaving a test that proves nothing.
    assert.deepEqual(
      [...offered].sort(),
      ['call', 'fold'],
      `${hand.label}: the engine should offer only fold and call`,
    );

    const input = inputForPlayedHand(hand, true);
    // Hero can plainly afford a raise. That is the whole point: affordability was the only
    // thing the Coach used to check.
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

    // And the suggestion is applicable for real, not merely validatable.
    const suggested = report.suggestion.action;
    assert.ok(suggested === 'fold' || suggested === 'call', `${hand.label}: suggested ${suggested}`);
    applyAction(hand.state, hand.seat, { type: suggested });
  }
});

test('an empty legal-action list is refused rather than answered', () => {
  // `legalActions` returns nothing in two states: betting is closed for the hand, and it is
  // not this seat's turn. In both, every action the Coach could name would be rejected, so
  // a report is not a weaker answer than usual — it is a wrong one. `redactFor` produces
  // exactly this for any seat that is not to act, which is how a live caller reaches it.
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
  // Filtering against a stale list would drop the one candidate hero actually has and
  // publish a report built from a different decision point. Both directions are checked
  // because a caller can pair either with the wrong `toCall`.
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
  // The derived floor has to hold up on its own, because two callers legitimately cannot
  // supply the engine's figure. Same spots, once with `minimumRaiseTo` and once without:
  // both must clear the engine's minimum, and the derived one must never undercut it.
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

// ---------------------------------------------------------------------------
// Half four: the derivation the callers with no hand state are given
// ---------------------------------------------------------------------------

/** The engine's own answer, as a sorted list of action names. */
function engineOffers(state: HandState, seat: SeatIndex): readonly string[] {
  return legalActions(state, seat)
    .map((entry) => entry.type)
    .sort();
}

test('the derived legal set reproduces the engine on every state this file builds', () => {
  // The derivation is only worth having if it agrees with the authority. Both halves of the
  // file are re-used rather than re-stated: the scenario reconstructions (heads-up, hero to
  // act) and the hands actually played through `applyAction`.
  const spots = readScenarioSpots();
  assert.ok(spots.length >= 30, `expected the shipped Scenario Lab, found ${spots.length}`);

  const mismatches: string[] = [];
  for (const spot of spots) {
    const state = stateForSpot(spot);
    // The reconstruction is heads-up, so the derivation is asked about the same one opponent
    // rather than about the whole multiway seat list — like against like, or a disagreement
    // here would be about the fixture and not about the rule.
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
  // The two restricted shapes, one each way, so the derivation's limits are a measured claim
  // rather than a sentence in a doc comment.
  const [everyoneAllIn, shortAllIn] = restrictedHands();
  assert.ok(everyoneAllIn !== undefined && shortAllIn !== undefined);

  // (iv) The rule this fix exists for. Nothing in the pot, the price or hero's own stack says
  // a raise is unavailable — only `opponentStacks` does, and the derivation reads it.
  const allInInput = inputForPlayedHand(everyoneAllIn, true, false);
  assert.ok(
    allInInput.opponentStacks.some((stack) => stack === 0),
    'the live opponent is all-in',
  );
  assert.deepEqual(
    [...deriveLegalActions(allInInput)].sort(),
    engineOffers(everyoneAllIn.state, everyoneAllIn.seat),
  );

  // (v) The one case the derivation cannot see: a short all-in that did not reopen the action.
  // It depends on `lastFullRaiseBetLevel` and `lastActedAtBetLevel`, neither of which survives
  // into a description of a spot. Asserted as a known, bounded gap — if it ever closes, or ever
  // widens to something else, this fails instead of quietly drifting.
  const shortInput = inputForPlayedHand(shortAllIn, true, false);
  assert.deepEqual(engineOffers(shortAllIn.state, shortAllIn.seat), ['call', 'fold']);
  assert.deepEqual([...deriveLegalActions(shortInput)].sort(), ['call', 'fold', 'raise']);
  assert.ok(
    shortInput.opponentStacks.some((stack) => stack > 0),
    'this gap exists precisely because somebody here does still have chips behind',
  );
});

test('with no legal-action list at all, the Coach still withholds a raise nobody could call', () => {
  // The regression that shipped. `legalActions` was optional and its absence disabled the
  // filter, so this exact input published three raises and headlined one of them. Every caller
  // that crosses `CoachTask` used to produce exactly this input.
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
  // The other direction. A fail-closed guard that closes on everything teaches a learner that
  // lines exist which do not, and the fix would have traded one wrong panel for another.
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

// ---------------------------------------------------------------------------
// Half five: nothing published costs more than hero has
// ---------------------------------------------------------------------------

test('no candidate costs more than hero has behind, or reaches a total hero cannot reach', () => {
  // `heroStack` is chips BEHIND, so `cost` is measured against it directly and `to` — a whole
  // street commitment — against `heroCommittedThisStreet + heroStack`. Confusing the two is a
  // double-count in one direction and a needless refusal in the other, which is why both are
  // checked here on data that exercises both: scenarios where hero has posted a blind, and
  // scenarios where hero has not.
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

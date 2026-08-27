/**
 * Turning a stored scenario into live maths, and checking that its teaching claims
 * are actually true.
 *
 * ## Why this file exists
 *
 * Content stores *situations*, never answers (ADR 0006). That is only worth the extra
 * effort if something verifies the teaching point, and this is that something:
 * `analyseScenario` computes the real figures, and `checkScenarioClaims` asserts the
 * scenario's `expectedInsight` against them. A scenario whose claim stops being true
 * fails the build rather than quietly misleading a learner.
 *
 * ## The two kinds of claim, kept honest
 *
 * The distinction matters and is easy to blur, so it is stated here and in ADR 0006:
 *
 * * **Qualitative** claims — `equityExceedsBreakEven`, `breakEvenExceedsEquity`,
 *   `callEvSign`, `cleanOutsEquals` — are *genuine independent verification*. A human
 *   asserted a teaching point; the maths confirms or refutes it. These catch real
 *   errors.
 * * **Quantitative** claims — `equityBetween`, `breakEvenEquityBetween`, `sprBetween`,
 *   `ruleOf24ErrorAtMost`, `dirtyOutsAtLeast` — are *regression locks*. Their bounds
 *   are derived from computed output, so they detect a change in behaviour but do not
 *   independently confirm correctness. Calling them verification would overstate the
 *   guarantee.
 *
 * This module lives in `@prl/content` rather than `@prl/poker-math` because it is the
 * bridge between the two: the maths package must not know what a "scenario" is, and
 * the content package must not reimplement any maths.
 */

import type { Scenario, ScenarioClaim } from '@prl/contracts';
import { type Card, parseCards } from '@prl/poker-engine';
import {
  computeOuts,
  deriveContestablePot,
  type EquityResult,
  effectiveStack,
  equity,
  evOfCall,
  exactRange,
  type OutsResult,
  type ParsedRange,
  parseRange,
  potOdds,
  ruleOfThumbFor,
  stackToPotRatio,
  topPercentRange,
} from '@prl/poker-math';

export class ScenarioAnalysisError extends Error {
  override readonly name = 'ScenarioAnalysisError';
}

export interface ScenarioSituation {
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly opponentRange: ParsedRange;
  /** True when the opponent's exact holding is known. */
  readonly opponentIsExact: boolean;
  /** Chips in the middle before hero acts, including this street's commitments. */
  readonly pot: number;
  readonly toCall: number;
  readonly heroStack: number;
  readonly opponentStacks: readonly number[];
  readonly cardsToCome: 1 | 2 | null;
}

/**
 * Reads the situation out of a scenario.
 *
 * The pot figure is the one place a mistake would silently poison every downstream
 * number, so it is spelled out: `pot` is everything already in the middle *before*
 * hero's pending call — chips carried from earlier streets, plus everything committed
 * on this street by anyone, hero included. `toCall` is then what hero must add on top.
 */
/**
 * The sampling this analysis is defined by, owned here because four places need the same pair.
 *
 * `analyseScenario` is what VALIDATES a scenario's claims; `routes/content.ts` is what serves the
 * numbers a student reads; `scripts/regenerate-web-fixtures.mjs` bakes them into the offline
 * fixture; and `apps/api/test/web-fixture-figures.test.ts` checks that fixture. All four have to
 * sample identically or the figure the build verifies is not the figure the page prints.
 *
 * They agreed by coincidence and by four separate literals. The test carried the comment "the
 * sample count and seed the fixture header names, and the API's own CONTENT_SAMPLES/CONTENT_SEED"
 * above its own copy, imported neither, and could not have: they were not exported. That is this
 * branch's most common defect exactly — a copy with a comment asserting an agreement nothing
 * enforces — and it was found by measuring the two analyses against each other across all 36
 * scenarios, which came back identical to the last digit (0.2836375 both, on
 * `fl-same-cards-under-the-gun`). Identical today; joined now.
 */
export const SCENARIO_ANALYSIS_SAMPLES = 40_000;
export const SCENARIO_ANALYSIS_SEED = 20_260_817;

export function readSituation(scenario: Scenario): ScenarioSituation {
  const hero = scenario.seats.find((seat) => seat.isHero === true);
  if (hero === undefined) throw new ScenarioAnalysisError(`scenario "${scenario.id}" has no hero seat`);
  if (hero.holeCards === undefined) {
    throw new ScenarioAnalysisError(`scenario "${scenario.id}" hero seat has no hole cards`);
  }

  const heroCards = parseCards(hero.holeCards);
  const board = parseCards(scenario.board);
  const blockers: Card[] = [...heroCards, ...board];

  let opponentRange: ParsedRange;
  let opponentIsExact = false;
  switch (scenario.opponentRange.kind) {
    case 'exact': {
      opponentRange = exactRange(parseCards(scenario.opponentRange.cards));
      opponentIsExact = true;
      break;
    }
    case 'notation':
      opponentRange = parseRange(scenario.opponentRange.notation, blockers);
      break;
    default:
      // topPercentRange builds its notation from the computed strength table, then goes
      // through the same parseRange path, so there is one way to construct a range.
      opponentRange = parseRange(topPercentRange(scenario.opponentRange.percent).notation, blockers);
      break;
  }

  const committed = scenario.committedThisStreet ?? {};
  const committedTotal = Object.values(committed).reduce((sum, value) => sum + value, 0);
  const pot = scenario.potBeforeStreet + committedTotal;

  const opponentStacks = scenario.seats.filter((seat) => seat.isHero !== true).map((seat) => seat.stack);
  if (opponentStacks.length === 0) {
    throw new ScenarioAnalysisError(`scenario "${scenario.id}" has no opponents`);
  }

  const cardsToCome: 1 | 2 | null = scenario.street === 'flop' ? 2 : scenario.street === 'turn' ? 1 : null;

  return {
    heroCards,
    board,
    opponentRange,
    opponentIsExact,
    pot,
    toCall: scenario.toCall,
    heroStack: hero.stack,
    opponentStacks,
    cardsToCome,
  };
}

export interface ScenarioAnalysis {
  readonly situation: ScenarioSituation;
  readonly equity: EquityResult;
  readonly heroEquity: number;
  readonly breakEvenEquity: number;
  readonly callEv: number;
  readonly spr: number;
  readonly outs: OutsResult | null;
  readonly ruleOf24ErrorPoints: number | null;
}

export interface AnalyseOptions {
  /** Monte Carlo samples when the exact path does not fit. */
  readonly samples?: number;
  readonly seed?: number;
}

/** Computes every figure a scenario's claims can refer to. */
export function analyseScenario(scenario: Scenario, options: AnalyseOptions = {}): ScenarioAnalysis {
  const situation = readSituation(scenario);

  const heroRange = exactRange(situation.heroCards);
  const result = equity(
    {
      players: [
        { label: 'hero', range: heroRange },
        { label: 'opponent', range: situation.opponentRange },
      ],
      board: situation.board,
    },
    {
      samples: options.samples ?? SCENARIO_ANALYSIS_SAMPLES,
      seed: options.seed ?? SCENARIO_ANALYSIS_SEED,
    },
  );
  const hero = result.players[0];
  if (hero === undefined) throw new ScenarioAnalysisError(`equity for "${scenario.id}" produced no hero`);

  // The pot hero could actually WIN, which is `situation.pot` in every ordinary spot and less
  // than it when hero is all-in for less than the bet in front of them: the excess of that bet is
  // a side pot hero is not eligible for. Capping `toCall` at the stack — which the call below has
  // always done — fixes the price hero pays and says nothing about the pot they are paying it
  // into, and pricing the call against the whole middle is what let the Coach tell a learner they
  // needed 8.6% where they needed 37.5%. This module is the second producer of that figure (it
  // verifies a scenario's stated claims), so it has to answer the same way `buildCoachReport`
  // does or a bundled claim could be checked against a price no learner is ever shown.
  //
  // Derived rather than layered: a scenario is a described spot with no complete per-seat record
  // of the street — see the note in `apps/api/src/routes/content.ts`.
  const contestablePot = deriveContestablePot({
    pot: situation.pot,
    toCall: situation.toCall,
    heroCommittedThisStreet: 0,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
  });
  const odds = potOdds(contestablePot, situation.toCall);
  const callEv =
    situation.toCall === 0
      ? 0
      : evOfCall({
          pot: contestablePot,
          toCall: Math.min(situation.toCall, situation.heroStack),
          equity: hero.equity,
        }).ev;

  const effective = effectiveStack(situation.heroStack, situation.opponentStacks);
  const spr = stackToPotRatio(effective.effective, Math.max(1, situation.pot)).spr;

  // Outs are only well defined with cards still to come. Against a range the count is
  // reported but the content validator refuses to let a scenario *assert* an exact
  // clean-out count unless the opponent holding is exact — see validate.ts.
  let outs: OutsResult | null = null;
  if (situation.cardsToCome !== null) {
    outs = computeOuts({
      heroCards: situation.heroCards,
      board: situation.board,
      opponent: situation.opponentRange,
    });
  }

  // `ruleOfThumbFor` in `@prl/poker-math` is the single gate on this shortcut, and it is
  // used here rather than `ruleOf24Accuracy` directly for a reason this file demonstrated:
  // the old line multiplied `totalOuts` — clean outs PLUS dirty ones, on a shortcut whose
  // own printed explanation says to count clean outs only — and published whatever came
  // out. One shipped scenario reaches 47 outs, and 47 x 4 is "188%", which is not a
  // probability at all. The gate applies the shortcut only to a draw with clean outs still
  // to come, compares it against the exact chance of hitting one of them rather than
  // against hero's equity, and answers `null` everywhere else. `null` already means "no
  // out count available" to the claim checker below, which is the honest reading.
  const ruleOf24ErrorPoints = ruleOfThumbFor(outs, situation.cardsToCome)?.errorPoints ?? null;

  return {
    situation,
    equity: result,
    heroEquity: hero.equity,
    breakEvenEquity: odds.breakEvenEquity,
    callEv,
    spr,
    outs,
    ruleOf24ErrorPoints,
  };
}

export interface ClaimResult {
  readonly claim: ScenarioClaim;
  readonly kind: ScenarioClaim['kind'];
  /** True independent verification, or a regression lock. */
  readonly strength: 'verification' | 'regression-lock';
  readonly passed: boolean;
  /** What was actually computed, for the failure message. */
  readonly actual: string;
  readonly detail: string;
}

const QUALITATIVE: ReadonlySet<ScenarioClaim['kind']> = new Set([
  'equityExceedsBreakEven',
  'breakEvenExceedsEquity',
  'callEvSign',
  'cleanOutsEquals',
]);

/**
 * Checks each claim against the computed analysis.
 *
 * `breakEven` for `callEvSign` uses a tolerance of one hundredth of a chip. An exactly
 * zero EV is a measure-zero event with real numbers, so demanding exact equality would
 * make the claim unusable; a hundredth of a chip is far below anything a learner could
 * act on.
 */
export function checkScenarioClaims(scenario: Scenario, analysis: ScenarioAnalysis): ClaimResult[] {
  const results: ClaimResult[] = [];
  const strengthOf = (kind: ScenarioClaim['kind']): ClaimResult['strength'] =>
    QUALITATIVE.has(kind) ? 'verification' : 'regression-lock';

  for (const claim of scenario.expectedInsight) {
    switch (claim.kind) {
      case 'equityExceedsBreakEven': {
        const passed = analysis.heroEquity > analysis.breakEvenEquity;
        results.push({
          claim,
          kind: claim.kind,
          strength: strengthOf(claim.kind),
          passed,
          actual: `equity ${(analysis.heroEquity * 100).toFixed(2)}% vs break-even ${(analysis.breakEvenEquity * 100).toFixed(2)}%`,
          detail: 'the scenario claims calling is profitable against the stated range',
        });
        break;
      }
      case 'breakEvenExceedsEquity': {
        const passed = analysis.breakEvenEquity > analysis.heroEquity;
        results.push({
          claim,
          kind: claim.kind,
          strength: strengthOf(claim.kind),
          passed,
          actual: `break-even ${(analysis.breakEvenEquity * 100).toFixed(2)}% vs equity ${(analysis.heroEquity * 100).toFixed(2)}%`,
          detail: 'the scenario claims calling is unprofitable against the stated range',
        });
        break;
      }
      case 'callEvSign': {
        const tolerance = 0.01;
        const passed =
          claim.expect === 'positive'
            ? analysis.callEv > tolerance
            : claim.expect === 'negative'
              ? analysis.callEv < -tolerance
              : Math.abs(analysis.callEv) <= tolerance;
        results.push({
          claim,
          kind: claim.kind,
          strength: strengthOf(claim.kind),
          passed,
          actual: `EV of calling = ${analysis.callEv.toFixed(3)} chips`,
          detail: `the scenario claims the EV of calling is ${claim.expect}`,
        });
        break;
      }
      case 'cleanOutsEquals': {
        const actualClean = analysis.outs?.cleanCount ?? -1;
        results.push({
          claim,
          kind: claim.kind,
          strength: strengthOf(claim.kind),
          passed: actualClean === claim.outs,
          actual: `${actualClean} clean outs (${analysis.outs?.dirtyCount ?? 0} dirty)`,
          detail: `the scenario claims exactly ${claim.outs} clean outs`,
        });
        break;
      }
      case 'dirtyOutsAtLeast': {
        const actualDirty = analysis.outs?.dirtyCount ?? -1;
        results.push({
          claim,
          kind: claim.kind,
          strength: strengthOf(claim.kind),
          passed: actualDirty >= claim.outs,
          actual: `${actualDirty} dirty outs`,
          detail: `the scenario claims at least ${claim.outs} dirty outs`,
        });
        break;
      }
      case 'equityBetween': {
        results.push({
          claim,
          kind: claim.kind,
          strength: strengthOf(claim.kind),
          passed: analysis.heroEquity >= claim.min && analysis.heroEquity <= claim.max,
          actual: `equity ${(analysis.heroEquity * 100).toFixed(2)}%`,
          detail: `expected between ${(claim.min * 100).toFixed(1)}% and ${(claim.max * 100).toFixed(1)}%`,
        });
        break;
      }
      case 'breakEvenEquityBetween': {
        results.push({
          claim,
          kind: claim.kind,
          strength: strengthOf(claim.kind),
          passed: analysis.breakEvenEquity >= claim.min && analysis.breakEvenEquity <= claim.max,
          actual: `break-even ${(analysis.breakEvenEquity * 100).toFixed(2)}%`,
          detail: `expected between ${(claim.min * 100).toFixed(1)}% and ${(claim.max * 100).toFixed(1)}%`,
        });
        break;
      }
      case 'sprBetween': {
        results.push({
          claim,
          kind: claim.kind,
          strength: strengthOf(claim.kind),
          passed: analysis.spr >= claim.min && analysis.spr <= claim.max,
          actual: `SPR ${analysis.spr.toFixed(2)}`,
          detail: `expected between ${claim.min} and ${claim.max}`,
        });
        break;
      }
      default: {
        const error = analysis.ruleOf24ErrorPoints;
        results.push({
          claim,
          kind: claim.kind,
          strength: strengthOf(claim.kind),
          passed: error !== null && Math.abs(error) <= claim.maxErrorPoints,
          actual: error === null ? 'no out count available' : `error ${error.toFixed(2)} points`,
          detail: `expected the rule-of-2/4 error within ${claim.maxErrorPoints} points`,
        });
        break;
      }
    }
  }
  return results;
}

/** A one-line human summary of a scenario's computed figures, for reports. */
export function describeAnalysis(analysis: ScenarioAnalysis): string {
  const method = analysis.equity.method === 'exact-enumeration' ? 'exact' : 'sampled';
  const interval =
    analysis.equity.confidence === null
      ? ''
      : ` ±${analysis.equity.confidence.halfWidthPoints.toFixed(2)}pts`;
  const outsText =
    analysis.outs === null
      ? 'no outs (river)'
      : `${analysis.outs.cleanCount} clean / ${analysis.outs.dirtyCount} dirty`;
  return (
    `equity ${(analysis.heroEquity * 100).toFixed(1)}% (${method}${interval}), ` +
    `needs ${(analysis.breakEvenEquity * 100).toFixed(1)}%, ` +
    `call EV ${analysis.callEv >= 0 ? '+' : ''}${analysis.callEv.toFixed(1)}, ` +
    `SPR ${analysis.spr.toFixed(1)}, ${outsText}`
  );
}

/**
 * Turns a stored scenario into live maths and checks its `expectedInsight` against it, so a claim
 * that stops being true fails the build (ADR 0006).
 * Qualitative claims (`equityExceedsBreakEven`, `breakEvenExceedsEquity`, `callEvSign`,
 * `cleanOutsEquals`) are independent verification. Quantitative ones (`*Between`,
 * `ruleOf24ErrorAtMost`, `dirtyOutsAtLeast`) take bounds from computed output, so they are
 * regression locks. It lives here because poker-math must not know what a scenario is.
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
 * The sampling the claim check, `routes/content.ts`, `scripts/regenerate-web-fixtures.mjs` and
 * `web-fixture-figures.test.ts` all import, so the figure the build verifies is the one the page prints.
 */
export const SCENARIO_ANALYSIS_SAMPLES = 40_000;
export const SCENARIO_ANALYSIS_SEED = 20_260_817;

/**
 * `pot` is everything in the middle before hero's pending call, this street's commitments by anyone
 * included. `toCall` is what hero adds on top.
 */
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
      // Through the same parseRange path, so there is one way to construct a range.
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
        { label: 'you', range: heroRange },
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

  // The pot hero can win, smaller than `situation.pot` when hero is all-in short of the bet. Using
  // the whole middle once told a learner 8.6% where 37.5% was needed. It must match
  // `buildCoachReport`, and is derived because a scenario has no per-seat record of the street.
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

  // validate.ts refuses an exact clean-out claim unless the opponent holding is exact.
  let outs: OutsResult | null = null;
  if (situation.cardsToCome !== null) {
    outs = computeOuts({
      heroCards: situation.heroCards,
      board: situation.board,
      opponent: situation.opponentRange,
    });
  }

  // `ruleOfThumbFor` is the single gate, not `ruleOf24Accuracy`, because multiplying `totalOuts`
  // once published 47 x 4 = "188%". It answers null unless clean outs remain to come.
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
  readonly strength: 'verification' | 'regression-lock';
  readonly passed: boolean;
  /** What was computed, for the failure message. */
  readonly actual: string;
  readonly detail: string;
}

const QUALITATIVE: ReadonlySet<ScenarioClaim['kind']> = new Set([
  'equityExceedsBreakEven',
  'breakEvenExceedsEquity',
  'callEvSign',
  'cleanOutsEquals',
]);

/** `callEvSign`'s `breakEven` allows 0.01 chips, because an exactly zero EV almost never occurs. */
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

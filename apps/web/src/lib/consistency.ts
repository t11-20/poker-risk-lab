/**
 * The display shape over `judgeConsistency` in `@prl/poker-math`, the rule the API also applies, so
 * the screen and the stored attempt cannot disagree. The rule asks whether the action does at least as
 * well as folding, within one big blind. It never measures against the best row.
 * Every screen shows the verdict beside the figures it follows from, so a reader can see which number
 * to dispute. Nothing here is a score (see `isDefensible`).
 */

import type { ActionCandidate, CoachReport } from '@prl/contracts';
import {
  type ConsistencyPricing,
  judgeConsistency as judgeShared,
  nearestPricedSizes,
  pricedSizesFor,
} from '@prl/poker-math';
import { formatUnits } from '@prl/ui/format';

/** The action names a learner can commit to. Matches `ScenarioAttemptRequest.action`. */
export type ScenarioAction = ActionCandidate['action'];

export interface Consistency {
  /** True when the chosen action is defensible against the stated range. From the shared rule. */
  readonly consistent: boolean;
  /** The chosen action's EV, or null when the report has no candidate for it. */
  readonly chosenEv: number | null;
  /** The best EV in the candidate table. Folding is always available at 0, so this is never below 0. */
  readonly bestEv: number;
  /** The row that carries `bestEv`, named as `rowName` names it. */
  readonly bestName: string | null;
  /** `bestEv - chosenEv`. Shown, but NOT what decides `consistent`, which measures against folding. */
  readonly gapUnits: number | null;
  /** The margin the verdict used, one big blind, in chips. Shown so a reader can argue with it. */
  readonly toleranceUnits: number;
  /**
   * How far outside the allowance the action came out, in chips. Zero when consistent, so it is never
   * printed. The panel prints `behindBenchmarkUnits` and `withinAllowance` instead.
   */
  readonly shortfallUnits: number;
  /**
   * Zero for any action but a fold, since the rule asks whether it beats folding. For a fold, the best
   * row that does not rest on an assumed fold frequency (`measuredBestEv`).
   */
  readonly benchmarkEv: number;
  /**
   * Whether the analysis priced this decision, and if not, which half was missing. A screen must read
   * it, because the Coach prices discrete rungs while the ActionBar accepts any size in a range.
   */
  readonly pricing: ConsistencyPricing;
  /**
   * `benchmarkEv - chosenEv`, signed, null when unpriced. Not `shortfallUnits`, which is zero inside the
   * allowance and would print 0.0 for an action 2.9 units behind folding.
   */
  readonly behindBenchmarkUnits: number | null;
  /** Whether `behindBenchmarkUnits` fits `toleranceUnits`, which is the verdict. Null when unpriced. */
  readonly withinAllowance: boolean | null;
  /** For an unpriced size, the priced sizes either side of it, so the refusal names a next step. */
  readonly nearestPriced: { readonly below: number | null; readonly above: number | null } | null;
}

/**
 * Every caller should pass `bigBlind`. Without it the shared rule falls back to one chip, the
 * strictest margin, while the API grades at the real big blind.
 */
export function judgeConsistency(
  report: CoachReport,
  action: ScenarioAction,
  to?: number,
  bigBlind?: number,
): Consistency {
  const verdict = judgeShared({
    report,
    action,
    ...(to === undefined ? {} : { to }),
    ...(bigBlind === undefined ? {} : { bigBlind }),
  });
  const chosenEv = verdict.chosen === null ? null : verdict.chosen.ev;
  const best = verdict.best;
  const benchmarkEv = action === 'fold' ? verdict.measuredBestEv : 0;

  return {
    consistent: verdict.consistent,
    chosenEv,
    bestEv: verdict.bestEv,
    bestName: best === null ? null : rowName({ ...best, to: best.to ?? null }, formatUnits),
    gapUnits: chosenEv === null ? null : verdict.bestEv - chosenEv,
    toleranceUnits: verdict.marginUnits,
    shortfallUnits: verdict.shortfallUnits,
    benchmarkEv,
    pricing: verdict.pricing,
    behindBenchmarkUnits: chosenEv === null ? null : benchmarkEv - chosenEv,
    withinAllowance: chosenEv === null ? null : verdict.consistent,
    nearestPriced:
      verdict.pricing === 'sizing-not-priced' && to !== undefined
        ? nearestPricedSizes(to, pricedSizesFor(report, action))
        : null,
  };
}

const ROW_WORD: Readonly<Record<ScenarioAction, string>> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

/** A call's `to` is the street total, so a call is named by its cost, as its Call button is. */
export function rowName(
  row: {
    readonly action: ScenarioAction;
    readonly to: number | null;
    readonly cost: number;
    readonly allIn?: true;
  },
  units: (value: number) => string,
): string {
  if (row.action === 'call') return `Call ${row.allIn === true ? 'all in, ' : ''}${units(row.cost)}`;
  return row.to === null ? ROW_WORD[row.action] : `${ROW_WORD[row.action]} to ${units(row.to)}`;
}

/** Outside the component so `node:test` can run it. `units` is passed in because `@prl/ui` carries JSX. */
export function nearestPricedSentence(
  action: ScenarioAction,
  nearest: { readonly below: number | null; readonly above: number | null },
  units: (value: number) => string,
): string {
  const word = action === 'bet' ? 'bet' : 'raise';
  const sides: string[] = [];
  if (nearest.below !== null) sides.push(`${word} to ${units(nearest.below)}`);
  if (nearest.above !== null) sides.push(`${word} to ${units(nearest.above)}`);
  const where =
    sides.length === 0
      ? `It priced no ${word} sizes at all.`
      : `The priced sizes nearest yours are ${sides.join(' and ')}.`;
  return `${where} Every preset button sets a size the analysis priced, so choosing again with one of them gives you a figure to compare.`;
}

/**
 * The actions whose rows rest on an assumed fold frequency, in table order. Tested by
 * `foldEquityAssumed`, not the action name, because some spots have bet rows or no aggressive row.
 */
export function foldAssumingActions(report: CoachReport): readonly ScenarioAction[] {
  const actions: ScenarioAction[] = [];
  for (const candidate of report.candidates) {
    const assumesFolds = candidate.foldEquityAssumed !== undefined && candidate.foldEquityAssumed > 0;
    if (assumesFolds && !actions.includes(candidate.action)) actions.push(candidate.action);
  }
  return actions;
}

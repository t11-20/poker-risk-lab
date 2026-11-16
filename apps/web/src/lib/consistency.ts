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
  suggestedCandidate,
} from '@prl/poker-math';
import { formatUnits } from '@prl/ui/format';

/** The action names a learner can commit to. Matches `ScenarioAttemptRequest.action`. */
export type ScenarioAction = ActionCandidate['action'];

export interface Consistency {
  /** True when the chosen action is defensible against the stated range. From the shared rule. */
  readonly consistent: boolean;
  /** The chosen action's EV, or null when the report has no candidate for it. */
  readonly chosenEv: number | null;
  /**
   * The row the Coach's reading stands on (`suggestedCandidate`), named as `rowName` names it, not the
   * table's highest: a row the reading set aside, above pot or ahead only on the assumed fold rate,
   * would be a second answer on the page. Shown for comparison, and NOT what decides `consistent`.
   */
  readonly reading: { readonly ev: number; readonly name: string } | null;
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
  const reading = suggestedCandidate(report);
  const benchmarkEv = action === 'fold' ? verdict.measuredBestEv : 0;

  return {
    consistent: verdict.consistent,
    chosenEv,
    reading:
      reading === null
        ? null
        : { ev: reading.ev, name: rowName({ ...reading, to: reading.to ?? null }, formatUnits) },
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

/**
 * A call's `to` is the street total, so a call is named by its cost, as its Call button is. All in is
 * worded as the button words it.
 */
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
  if (row.to === null) return ROW_WORD[row.action];
  return `${ROW_WORD[row.action]} to ${units(row.to)}${row.allIn === true ? ', all in' : ''}`;
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

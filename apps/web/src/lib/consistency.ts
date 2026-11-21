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
  /** The chosen action's EV, or null when the report has no candidate for it or the scenario set it aside. */
  readonly chosenEv: number | null;
  /**
   * The row the Coach's reading stands on (`suggestedCandidate`), named as `rowName` names it, not the
   * table's highest: a row the reading set aside, above pot or ahead only on the assumed fold rate,
   * would be a second answer on the page. Shown for comparison, and NOT what decides `consistent`.
   */
  readonly reading: {
    readonly ev: number;
    readonly name: string;
    /** The bet or raise sizes the reading spans, as the Coach names them. Null for one size. */
    readonly span: { readonly action: 'bet' | 'raise'; readonly min: number; readonly max: number } | null;
  } | null;
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
   * The scenario's assumptions set this action aside, so its rows, still shown in the Coach's table,
   * were left out of the verdict. `pricing` is then `'action-not-priced'`.
   */
  readonly setAside: boolean;
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
 * strictest margin, while the API grades at the real big blind. A scenario caller passes its
 * `actionsSetAside` too, or the screen grades an action the API leaves out.
 */
export function judgeConsistency(
  report: CoachReport,
  action: ScenarioAction,
  to?: number,
  bigBlind?: number,
  setAside?: readonly ScenarioAction[],
): Consistency {
  const verdict = judgeShared({
    report,
    action,
    ...(to === undefined ? {} : { to }),
    ...(bigBlind === undefined ? {} : { bigBlind }),
    ...(setAside === undefined ? {} : { setAside }),
  });
  const chosenEv = verdict.chosen === null ? null : verdict.chosen.ev;
  const suggested = suggestedCandidate(report);
  // A reading the scenario sets aside is not offered beside the verdict, which leaves it out.
  const reading = suggested !== null && setAside?.includes(suggested.action) === true ? null : suggested;
  const benchmarkEv = action === 'fold' ? verdict.measuredBestEv : 0;

  return {
    consistent: verdict.consistent,
    chosenEv,
    reading:
      reading === null
        ? null
        : {
            ev: reading.ev,
            name: rowName({ ...reading, to: reading.to ?? null }, formatUnits),
            span: spanOf(report.suggestion),
          },
    toleranceUnits: verdict.marginUnits,
    shortfallUnits: verdict.shortfallUnits,
    benchmarkEv,
    pricing: verdict.pricing,
    setAside: setAside?.includes(action) ?? false,
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

function spanOf(suggestion: CoachReport['suggestion']): NonNullable<Consistency['reading']>['span'] {
  const { action, sizeRange } = suggestion;
  if ((action !== 'bet' && action !== 'raise') || sizeRange === undefined) return null;
  return sizeRange.min === sizeRange.max ? null : { action, ...sizeRange };
}

/** Said under the reading's row, so the Lab names the range the Coach panel names beside it. */
export function readingSpanWords(
  span: NonNullable<Consistency['reading']>['span'],
  units: (value: number) => string,
): string {
  if (span === null) return '';
  return `The highest of the ${span.action} sizes from ${span.min} to ${units(span.max)}.`;
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

/**
 * The fold-assumption sentence, naming the rows it moves. The next panel changes one fold frequency,
 * so it is pointed at only where the table has one: a row priced against the hands that continue has
 * a rate of its own.
 */
export function foldAssumptionSentence(report: CoachReport): string {
  const opening =
    'Both figures come from the candidate table further down, and both rest on the assumptions you read at the top';
  const actions = foldAssumingActions(report);
  if (actions.length === 0) {
    return `${opening}. No row in this table assumes the opponent folds, so its figures move with the range and the price: if you think either is wrong, disagreeing with them on those grounds is exactly the reasoning this scenario is for.`;
  }
  const rows = actions.map((action) => ROW_WORD[action].toLowerCase()).join(' and ');
  if (report.candidates.some((candidate) => candidate.continuingShare !== undefined)) {
    return `${opening} — including how often the opponent folds to each size, which is assumed and not measured. If you think those fold rates are too generous, the rows they move are the ${rows} rows. Disagreeing with them on those grounds is exactly the reasoning this scenario is for.`;
  }
  return `${opening} — including the assumed fold frequency, which somebody chose. If you think that fold assumption is too generous, the rows it moves are the ${rows} rows: change it in the next panel and watch them move. Disagreeing with it on those grounds is exactly the reasoning this scenario is for.`;
}

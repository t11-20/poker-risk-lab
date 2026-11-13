/**
 * The one rule for "is this action consistent with the analysis?", shared by `apps/api` and
 * `apps/web` so the recorded verdict and the shown verdict cannot disagree. It lives here because
 * this package is pure and both apps already import it (`@prl/content` reads from disk). Prose stays
 * with each caller. Only the decision and its figures are shared.
 */

import type { ActionCandidate, CoachReport } from '@prl/contracts';

export class ConsistencyError extends Error {
  override readonly name = 'ConsistencyError';
}

/** The action names an analysis can price. Matches `ScenarioAttemptRequest.action`. */
export type ConsistencyAction = ActionCandidate['action'];

/**
 * How far from folding an action may sit and still count as indifferent, in big blinds. It matches
 * the one big blind at which `buildCoachReport` calls a gap close to indifferent.
 */
export const CONSISTENCY_MARGIN_BIG_BLINDS = 1;

/** The margin in chips, floored at one chip so a `bigBlind` of 0 cannot reduce it to nothing. */
export function consistencyMarginUnits(bigBlind: number): number {
  if (!Number.isFinite(bigBlind)) throw new ConsistencyError('bigBlind must be a finite number');
  return CONSISTENCY_MARGIN_BIG_BLINDS * Math.max(1, bigBlind);
}

/**
 * The candidate row for one action.
 *
 * Without a `to`, the most favourable row for that action name is used, since several sizings share
 * a name. With a `to`, an exact sizing match is required and there is no fallback. An unmatched size
 * returns `null`, because grading it against another row answered a different question (a
 * 26,000-chip raise with 500 behind was once scored as consistent). Callers should reject an
 * unpayable size first with `minimumAggressiveTo` and `maximumTo` in `./coach.ts`.
 */
export function candidateFor(report: CoachReport, action: string, to?: number): ActionCandidate | null {
  if (to !== undefined) {
    return report.candidates.find((candidate) => candidate.action === action && candidate.to === to) ?? null;
  }
  let best: ActionCandidate | null = null;
  for (const candidate of report.candidates) {
    if (candidate.action !== action) continue;
    if (best === null || candidate.ev > best.ev) best = candidate;
  }
  return best;
}

/**
 * Every size the analysis priced for one action name, in pricing order. Empty for an unpriced action
 * and for `fold` and `check`, which carry no `to`.
 */
export function pricedSizesFor(report: CoachReport, action: string): readonly number[] {
  const sizes: number[] = [];
  for (const candidate of report.candidates) {
    if (candidate.action !== action || candidate.to === undefined) continue;
    if (!sizes.includes(candidate.to)) sizes.push(candidate.to);
  }
  return sizes;
}

/** The highest-EV row in the table, or null when the report published no candidates. */
export function bestCandidate(report: CoachReport): ActionCandidate | null {
  let best: ActionCandidate | null = null;
  for (const candidate of report.candidates) {
    if (best === null || candidate.ev > best.ev) best = candidate;
  }
  return best;
}

/**
 * True for a bet or raise priced with fold equity above zero. It reads the `foldEquityAssumed`
 * marker that `buildCoachReport` sets on rows whose EV contains the `f x pot` term.
 */
function restsOnAssumedFoldEquity(candidate: ActionCandidate): boolean {
  const assumed = candidate.foldEquityAssumed;
  return assumed !== undefined && assumed > 0;
}

/**
 * The highest-EV row that does not rest on an assumed fold frequency, or null. This is the benchmark
 * a fold is judged against. `DEFAULT_ASSUMED_FOLD_EQUITY` is an input, not a measurement, so a fold
 * is not marked wrong because a bluff-raise wins under it (two shipped scenarios did exactly that).
 * Non-fold actions are still judged against folding at zero.
 */
export function bestMeasuredCandidate(report: CoachReport): ActionCandidate | null {
  let best: ActionCandidate | null = null;
  for (const candidate of report.candidates) {
    if (restsOnAssumedFoldEquity(candidate)) continue;
    if (best === null || candidate.ev > best.ev) best = candidate;
  }
  return best;
}

/**
 * Is this action defensible against the stated range? The test is against folding, which is
 * exactly zero, not against the highest-EV row.
 *
 * - A non-fold action is consistent when it does at least as well as folding, within the margin.
 * - A fold is consistent when no measured row (see `bestMeasuredCandidate`) clearly beats it.
 * - A fold is never defensible while checking is free. A check dominates a fold outright, and the EV
 *   gap can sit inside the margin. `buildCoachReport` enforces the same invariant.
 */
export function isDefensible(report: CoachReport, candidate: ActionCandidate, marginUnits: number): boolean {
  if (candidate.action === 'fold') {
    if (report.candidates.some((row) => row.action === 'check')) return false;
    const best = bestMeasuredCandidate(report);
    return best === null || best.ev <= marginUnits;
  }
  return candidate.ev >= -marginUnits;
}

/** Every action the analysis supports, in the order the report priced them. Usually more than one. */
export function defensibleActions(report: CoachReport, marginUnits: number): readonly string[] {
  const actions = [...new Set(report.candidates.map((candidate) => candidate.action))];
  return actions.filter((action) => {
    const candidate = candidateFor(report, action);
    return candidate !== null && isDefensible(report, candidate, marginUnits);
  });
}

/**
 * Whether the analysis priced the submitted action.
 *
 * - `'priced'` means a row exists for this exact decision.
 * - `'action-not-priced'` means no row exists for this action name.
 * - `'sizing-not-priced'` means the action was priced, but at other sizes.
 *
 * In the last two `consistent` is `false` as "not established", never as "wrong". A caller writing a
 * nullable match column must write NULL for both.
 */
export type ConsistencyPricing = 'priced' | 'action-not-priced' | 'sizing-not-priced';

/** The verdict, and every figure it rests on. Both callers render from these; neither recomputes. */
export interface ConsistencyVerdict {
  readonly consistent: boolean;
  /** Whether the analysis priced this exact decision, and if not, in which of the two ways. */
  readonly pricing: ConsistencyPricing;
  /** The row the chosen action was judged on, or null when the analysis did not price it. */
  readonly chosen: ActionCandidate | null;
  /** Sizes priced for the submitted action name. Empty when none were priced or it moves no chips. */
  readonly pricedSizes: readonly number[];
  /** The highest-EV row in the table, or null when the report published none. */
  readonly best: ActionCandidate | null;
  /** The best EV available, floored at zero because folding is always available at 0. */
  readonly bestEv: number;
  /**
   * The best EV among rows that do not rest on an assumed fold frequency, floored at zero. This is
   * the figure a fold was judged against. See `bestMeasuredCandidate`.
   */
  readonly measuredBestEv: number;
  /** The margin in chips this verdict used, for showing the reader the threshold they were held to. */
  readonly marginUnits: number;
  readonly supportedActions: readonly string[];
  /** Every action the analysis priced at all, supported or not. */
  readonly availableActions: readonly string[];
  /**
   * True when exactly one action is defensible. Stored as `scenario_attempts.matched_expected` only
   * when it holds, NULL otherwise. Never shown as a score.
   */
  readonly claimsOneAction: boolean;
  /** Chips behind the indifference point. Zero when consistent and when the action was not priced. */
  readonly shortfallUnits: number;
}

export interface ConsistencyInput {
  readonly report: CoachReport;
  /** A `string` because the API receives it off the wire, so an unpriced action is a real case. */
  readonly action: string;
  readonly to?: number;
  /**
   * The stakes the margin is in. Defaults to one chip, the strictest margin, so an unstated big blind
   * cannot widen the threshold. Every caller passes it.
   */
  readonly bigBlind?: number;
}

/**
 * Judges one action against the report's own candidate table. A decision with no row gets
 * `consistent: false`, `chosen: null` and a `pricing` naming the gap. That `false` means
 * "not established", so a caller must read `pricing` before rendering it.
 */
export function judgeConsistency(input: ConsistencyInput): ConsistencyVerdict {
  const { report, action, to } = input;
  const bigBlind = input.bigBlind ?? 1;
  const marginUnits = consistencyMarginUnits(bigBlind);

  const chosen = candidateFor(report, action, to);
  const best = bestCandidate(report);
  const bestEv = Math.max(0, best === null ? 0 : best.ev);
  const measured = bestMeasuredCandidate(report);
  const measuredBestEv = Math.max(0, measured === null ? 0 : measured.ev);
  const supportedActions = defensibleActions(report, marginUnits);
  const availableActions = [...new Set(report.candidates.map((candidate) => candidate.action))];
  const claimsOneAction = supportedActions.length === 1;
  const pricedSizes = pricedSizesFor(report, action);

  if (chosen === null) {
    // Decided on the rows, not on `pricedSizes`, because fold and check are priced without a size.
    const pricing: ConsistencyPricing = report.candidates.some((candidate) => candidate.action === action)
      ? 'sizing-not-priced'
      : 'action-not-priced';
    return {
      consistent: false,
      pricing,
      chosen: null,
      pricedSizes,
      best,
      bestEv,
      measuredBestEv,
      marginUnits,
      supportedActions,
      availableActions,
      claimsOneAction,
      shortfallUnits: 0,
    };
  }

  const consistent = isDefensible(report, chosen, marginUnits);
  // A fold is behind by the best measured row. Anything else is behind by how far below zero it sits.
  // `measuredBestEv`, not `bestEv`, so the shortfall shown is the one the verdict used.
  const shortfall = chosen.action === 'fold' ? measuredBestEv : -chosen.ev;
  return {
    consistent,
    pricing: 'priced',
    chosen,
    pricedSizes,
    best,
    bestEv,
    measuredBestEv,
    marginUnits,
    supportedActions,
    availableActions,
    claimsOneAction,
    shortfallUnits: consistent ? 0 : Math.max(0, shortfall),
  };
}

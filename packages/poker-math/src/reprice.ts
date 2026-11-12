/**
 * A Coach report's candidate table, re-priced at a different assumed fold frequency.
 *
 * ## Why this exists
 *
 * Every scenario's assumptions say the fold frequency behind its bet and raise rows is "an input
 * you can change, not something measured", and the Lab's own tagline is "change one input, watch
 * the maths move". After deciding, the page offered no input at all. This is the arithmetic for
 * one: the same `evOfBet` and `evOfRaise` the Coach priced the rows with, re-run in the browser at
 * the reader's own frequency, from nothing but the report already on the page.
 *
 * ## What it reads, and why that is enough
 *
 * A bet or raise row's EV is a function of five figures: the pot it can win, the price faced, the
 * increment, hero's equity when called, and the fold frequency. The report carries all of them:
 * `potOdds.pot` is the contestable pot the Coach priced into (`buildCoachReport` hands it the
 * same `contestablePot`), `toCall` is the price, a raise's increment is `cost - toCall` because
 * `cost` is `evOfRaise`'s `risk`, a bet's is its `cost`, and `potShareIfCalled` is the equity. The
 * fold, call and check rows do not read a fold frequency at all, so they are returned unchanged.
 *
 * ## It refuses rather than approximates
 *
 * Before re-pricing anything it re-prices every row at the frequency the report says it used, and
 * compares with the report's own figure. If any row does not come back to within a millionth of a
 * unit, the reconstruction is wrong for this report and the answer is `unavailable` with the
 * reason — never a table of figures that only look like the Coach's. A control that silently
 * disagreed with the analysis beside it would teach the reader that the analysis is arbitrary.
 */

import type { ActionCandidate, CoachReport } from '@prl/contracts';
import { evOfBet, evOfRaise } from './ev.ts';

export interface RepricedRow {
  readonly action: ActionCandidate['action'];
  readonly to: number | null;
  /** The figure the analysis published, at its own assumed fold frequency. */
  readonly analysedEv: number;
  /** The figure at the frequency asked for. Equal to `analysedEv` for a row that reads none. */
  readonly ev: number;
  /** Whether this row's figure depends on the fold frequency at all. */
  readonly readsFoldEquity: boolean;
}

export type FoldEquityRepricing =
  | {
      readonly kind: 'available';
      /** The frequency the analysis was priced at, as a fraction. */
      readonly analysedFoldEquity: number;
      /** The frequency these figures are priced at, as a fraction in 0..1. */
      readonly foldEquity: number;
      /** Every candidate, in the report's own order. */
      readonly rows: readonly RepricedRow[];
      /** The highest-EV row at `foldEquity`, and at the analysed frequency. */
      readonly best: RepricedRow;
      readonly analysedBest: RepricedRow;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** A millionth of a unit: far below anything printed, far above floating-point noise. */
const REPRODUCTION_TOLERANCE = 1e-6;

/** The EV of one fold-reading row at frequency `f`, or null when the row cannot be reconstructed. */
function rowEvAt(candidate: ActionCandidate, report: CoachReport, f: number): number | null {
  const equity = candidate.potShareIfCalled;
  if (equity === undefined) return null;
  const pot = report.potOdds.pot;
  try {
    if (candidate.action === 'bet') {
      return evOfBet({ pot, betSize: candidate.cost, foldProbability: f, equityWhenCalled: equity }).ev;
    }
    if (candidate.action === 'raise') {
      return evOfRaise({
        pot,
        toCall: report.toCall,
        raiseBy: candidate.cost - report.toCall,
        foldProbability: f,
        equityWhenCalled: equity,
      }).ev;
    }
  } catch {
    // An input `ev.ts` refuses (a non-positive increment, say) means this is not a row the Coach
    // could have priced from these figures, which is a reconstruction failure, not a zero.
    return null;
  }
  return null;
}

/** The Coach's own tiebreak (`TIEBREAK_RANK` in `./coach.ts`): on a tie, giving up the hand loses. */
const TIEBREAK: Readonly<Record<ActionCandidate['action'], number>> = {
  raise: 4,
  bet: 4,
  call: 3,
  check: 2,
  fold: 1,
};

function bestOf(rows: readonly RepricedRow[], pick: (row: RepricedRow) => number): RepricedRow {
  let best = rows[0] as RepricedRow;
  for (const row of rows) {
    const ahead = pick(row) > pick(best);
    const tiedAndKeepsTheHand = pick(row) === pick(best) && TIEBREAK[row.action] > TIEBREAK[best.action];
    if (ahead || tiedAndKeepsTheHand) best = row;
  }
  return best;
}

/**
 * The candidate table at fold frequency `foldEquity` (a fraction; clamped into 0..1, and a
 * non-finite value is treated as the analysed frequency), or the reason it cannot be re-priced.
 */
export function repriceAtFoldEquity(report: CoachReport, foldEquity: number): FoldEquityRepricing {
  const reading = report.candidates.filter((candidate) => candidate.foldEquityAssumed !== undefined);
  if (reading.length === 0 || report.candidates.length === 0) {
    return {
      kind: 'unavailable',
      reason:
        'No row in this table assumes the opponent folds — there is no bet or raise to price — so every ' +
        'figure here rests on the range and the price, and a fold frequency has nothing to move.',
    };
  }
  const analysed = reading[0]?.foldEquityAssumed as number;
  if (reading.some((candidate) => candidate.foldEquityAssumed !== analysed)) {
    return {
      kind: 'unavailable',
      reason:
        'The rows in this table were priced at more than one fold frequency, so there is no single input ' +
        'here to change.',
    };
  }
  for (const candidate of reading) {
    const reproduced = rowEvAt(candidate, report, analysed);
    if (reproduced === null || Math.abs(reproduced - candidate.ev) > REPRODUCTION_TOLERANCE) {
      return {
        kind: 'unavailable',
        reason:
          `The ${candidate.action} row could not be reproduced from the figures on this page, so re-pricing ` +
          'it here would show numbers that are not the analysis’s.',
      };
    }
  }

  const f = Number.isFinite(foldEquity) ? Math.min(1, Math.max(0, foldEquity)) : analysed;
  const rows: RepricedRow[] = report.candidates.map((candidate) => {
    const readsFoldEquity = candidate.foldEquityAssumed !== undefined;
    return {
      action: candidate.action,
      to: candidate.to ?? null,
      analysedEv: candidate.ev,
      ev: readsFoldEquity ? (rowEvAt(candidate, report, f) as number) : candidate.ev,
      readsFoldEquity,
    };
  });
  return {
    kind: 'available',
    analysedFoldEquity: analysed,
    foldEquity: f,
    rows,
    best: bestOf(rows, (row) => row.ev),
    analysedBest: bestOf(rows, (row) => row.analysedEv),
  };
}

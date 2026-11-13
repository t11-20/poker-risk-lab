/**
 * A Coach report's candidate table, re-priced at a different assumed fold frequency, in the browser.
 *
 * It reruns `evOfBet` and `evOfRaise` from figures the report carries. `potOdds.pot` is the
 * contestable pot, a raise's increment is `cost - toCall` (`cost` is `evOfRaise`'s `risk`), and
 * `potShareIfCalled` is the equity. Fold, call and check rows read no fold frequency and pass
 * through. Every row is first reproduced at the analysed frequency to within 1e-6. If any fails, the
 * result is `unavailable`, never figures that only look like the Coach's.
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
  readonly readsFoldEquity: boolean;
}

export type FoldEquityRepricing =
  | {
      readonly kind: 'available';
      /** The frequency the analysis was priced at, as a fraction. */
      readonly analysedFoldEquity: number;
      /** The frequency these figures are priced at, as a fraction in 0..1. */
      readonly foldEquity: number;
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
    // `ev.ts` refused the input, so the Coach could not have priced this row from these figures.
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

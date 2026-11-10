/**
 * What the Coach panel beside the table holds, decided once.
 *
 * ## The defect this module exists for
 *
 * The panel used to show a report whenever it was handed one, whatever the table was doing. A
 * report prices one decision, and a finished hand has none left. So `/play?state=complete` put the
 * flop decision's whole report, headline and all, beside a table already settled and paid out. The
 * live table never did that, because `use-live-table.ts` keys a report on the decision it was
 * computed for. But with no report it fell through to `coachUnavailableProps`, which printed the
 * mid-hand sentence. Measured against the running API in Chrome 151, after a hand folded out
 * preflop: "There is no analysis of this spot. The Coach prices a decision, so it is computed when
 * one is yours to make — use "Refresh the analysis" to ask for it now." `ConnectionPanel` hides
 * that button between hands.
 *
 * A finished hand is therefore checked first, before whether there is a report.
 *
 * ## Why this is a leaf module
 *
 * `components/TableStage.tsx` imports `@prl/ui`, whose entry re-exports `.tsx`, and `node --test`
 * cannot load that. Same shape and reason as `lib/quiz-tolerance.ts`.
 */

/** The table statuses this rule reads. Mirrors `TableStageStatus` in `components/TableStage.tsx`. */
export type CoachBodyStatus = 'idle' | 'loading' | 'ready' | 'error' | 'complete';

export type CoachBody = 'hand-over' | 'report' | 'skeleton' | 'unavailable';

export function coachBodyFor(status: CoachBodyStatus, hasReport: boolean): CoachBody {
  if (status === 'complete') return 'hand-over';
  if (hasReport) return 'report';
  if (status === 'loading') return 'skeleton';
  return 'unavailable';
}

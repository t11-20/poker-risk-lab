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

import type { PlayerView } from '@prl/poker-engine';

/** The table statuses this rule reads. Mirrors `TableStageStatus` in `components/TableStage.tsx`. */
export type CoachBodyStatus = 'idle' | 'loading' | 'ready' | 'error' | 'complete';

export type CoachBody = 'hand-over' | 'report' | 'skeleton' | 'unavailable';

export function coachBodyFor(status: CoachBodyStatus, hasReport: boolean): CoachBody {
  if (status === 'complete') return 'hand-over';
  if (hasReport) return 'report';
  if (status === 'loading') return 'skeleton';
  return 'unavailable';
}

/**
 * Where a finished hand's review is, for a reader who was dealt into it, and nothing otherwise.
 *
 * `GET /hands/:id` answers only somebody with a `hand_seats` row in that hand (`findOwnHand` in
 * `apps/api/src/routes/hands.ts`), and a spectator's completed view carries the hand's id all the
 * same. So the link a watcher was offered led to "There is nothing at this address". `viewerSeat`
 * is resolved against the hand's own dealt roster, not the current chairs: it is null for a
 * watcher and for a seat that sat the hand out, and it is kept by a player who stood up after the
 * deal, whose review exists.
 */
export function reviewHrefFor(view: PlayerView | null): string | undefined {
  if (view === null || view.viewerSeat === null) return undefined;
  return `/review/${encodeURIComponent(view.handId)}`;
}

/**
 * What the Coach panel beside the table holds. A finished hand is checked before whether there is a
 * report, because a report prices a decision and a finished hand has none left.
 * A leaf module, because `TableStage.tsx` imports `@prl/ui`'s `.tsx`, which `node --test` cannot load.
 */

import type { PlayerView } from '@prl/poker-engine';

/** Mirrors `TableStageStatus` in `components/TableStage.tsx`. */
export type CoachBodyStatus = 'idle' | 'loading' | 'ready' | 'error' | 'complete';

export type CoachBody = 'hand-over' | 'report' | 'skeleton' | 'unavailable';

export function coachBodyFor(status: CoachBodyStatus, hasReport: boolean): CoachBody {
  if (status === 'complete') return 'hand-over';
  if (hasReport) return 'report';
  if (status === 'loading') return 'skeleton';
  return 'unavailable';
}

/**
 * Only a reader dealt into the hand can open its review (`findOwnHand` in the API), so a spectator
 * gets no link. `viewerSeat` follows the dealt roster, so a player who stood up after the deal keeps it.
 */
export function reviewHrefFor(view: PlayerView | null): string | undefined {
  if (view === null || view.viewerSeat === null) return undefined;
  return `/review/${encodeURIComponent(view.handId)}`;
}

/** Dealt in, not folded, not all in. Only then is there anything for the Coach to price. */
export function readerHasDecisions(view: Pick<PlayerView, 'seats'> | null): boolean {
  return view?.seats.find((seat) => seat.isSelf)?.status === 'active';
}

/**
 * A sentence true of the reader's seat. Only a reader still in the hand is told to press
 * "Refresh the analysis".
 */
export function noAnalysisReason(view: Pick<PlayerView, 'seats'>): string {
  const reader = view.seats.find((seat) => seat.isSelf);
  if (reader === undefined || reader.status === 'sittingOut') {
    return (
      'You were not dealt into this hand, so there is no decision of yours in it to price. The ' +
      'analysis comes with the next hand you are dealt.'
    );
  }
  if (reader.status === 'folded') {
    return (
      'You are out of this hand, so there is no decision of yours left in it to price. The analysis ' +
      'comes back with the next hand you are dealt, and once this one is over its review prices every ' +
      'decision you made in it.'
    );
  }
  if (reader.status === 'allIn') {
    return (
      'You are all in, so there is nothing left for you to decide in this hand and nothing to price. ' +
      'Once it is over, its review prices the decisions that got you here.'
    );
  }
  return (
    'There is no analysis of this spot. The Coach prices a decision, so it is computed when one is ' +
    'yours to make — use "Refresh the analysis" to ask for it now.'
  );
}

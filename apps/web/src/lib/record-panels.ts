/**
 * The numbers on `/record`'s panels, for the panels that state actually renders.
 * Signed out still numbers the deletion panel: its receipt stays after the account is gone,
 * so that page is 01 and 02 rather than a lone 02.
 */

export type RecordViewState = 'signedOut' | 'unavailable' | 'ready';

export interface RecordPanelNumbers {
  /** Null when the counts panel is not on the page. */
  readonly covered: number | null;
  readonly reset: number;
  readonly deletion: number;
}

export function recordPanelNumbers(state: RecordViewState): RecordPanelNumbers {
  if (state === 'ready') return { covered: 1, reset: 2, deletion: 3 };
  return { covered: null, reset: 1, deletion: 2 };
}

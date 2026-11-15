/**
 * Whether a count may be called "outs". When hero is already past the equity bar every unseen card
 * qualifies, so a two-pair flop would be headed "47 cards in total".
 * `computeOuts` refuses at source too. This guard covers stale JSON and fixtures, as in `probability.ts`.
 * The threshold is copied, not imported, because `@prl/poker-math` links `@prl/poker-engine` and its
 * secrets must not reach a browser. `test/outs-count.test.ts` pins it to `DEFAULT_AHEAD_THRESHOLD`.
 */

import { isProbabilityFraction } from './probability.ts';

/** A hand past this needs no card, so nothing that arrives is an out. */
export const ALREADY_AHEAD_EQUITY = 0.5;

/**
 * `false` means the counts are cards that keep hero in front, and the page may not sum them as outs.
 * A non-probability returns `true`, because it proves nothing about being ahead and has its own refusal.
 */
export function countsAsOuts(heroEquity: number): boolean {
  if (!isProbabilityFraction(heroEquity)) return true;
  return heroEquity < ALREADY_AHEAD_EQUITY;
}

export type OutsWithheld = 'no-board-yet' | 'board-complete' | 'several-opponents';

/**
 * Why `buildCoachReport` sent no outs: it counts them only on the flop or turn against one opponent.
 * `null` means it would have counted them, so a missing breakdown has no reason to give.
 */
export function outsWithheldBecause(street: string, opponents: number): OutsWithheld | null {
  if (street === 'preflop') return 'no-board-yet';
  if (street === 'river') return 'board-complete';
  return opponents > 1 ? 'several-opponents' : null;
}

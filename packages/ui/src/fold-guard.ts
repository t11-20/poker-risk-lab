/**
 * Where Check is free, a pointer press on Fold first relabels it "Fold anyway". The second folds.
 * Nothing changes shape, so the sticky row's height (`apps/web/src/styles/play.css` 3.1) holds.
 * Pointer only, because the failure is a mis-tap. A keyboard reader has just heard the label.
 * A pointer click has `detail >= 1`. Enter, Space and a script's `.click()` have `detail === 0`, so
 * the `scripts/` harnesses fold in one press. A harness driving a real mouse must press twice.
 * The arming is stamped with `spotSignature`, so it is never read as consent in another spot.
 */

import type { LegalAction } from './view-types.ts';

export type FoldPress = 'arm' | 'fold';

export interface FoldPressInput {
  /** Check is among the legal actions, so folding saves nothing. */
  readonly canCheck: boolean;
  /** The press came from a pointer (`MouseEvent.detail > 0`), not from a key or a script. */
  readonly pointer: boolean;
  /** Fold was already pressed once, by pointer, in this same spot. */
  readonly armed: boolean;
}

export function foldPress({ canCheck, pointer, armed }: FoldPressInput): FoldPress {
  return canCheck && pointer && !armed ? 'arm' : 'fold';
}

/** Built from values, not identity, because every state frame is a fresh `legalActions` array. */
export function spotSignature(
  legalActions: readonly LegalAction[],
  toCall: number,
  pot: number,
  committedThisStreet: number,
): string {
  const actions = legalActions.map(
    (action) => `${action.type}:${String(action.minTo ?? '')}-${String(action.maxTo ?? '')}`,
  );
  return [actions.join(','), String(toCall), String(pot), String(committedThisStreet)].join('|');
}

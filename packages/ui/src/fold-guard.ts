/**
 * Whether a press on Fold folds, or first asks — the one guard on the action row.
 *
 * ## The defect this exists for
 *
 * The audit at 308fadf: "Fold can be pressed when checking is free. It sits next to Check with no
 * confirmation, so a free hand can be thrown away by a mis-tap." On a phone the row is Fold and
 * Check side by side, a thumb's width apart, and the engine offers Fold even where checking costs
 * nothing (it is legal, with the note "Legal, but checking costs nothing."). A mis-tap there is the
 * one decision on this table that loses something for no saving at all.
 *
 * ## The guard: a pointer press on Fold, where Check is free, asks once
 *
 * The first press relabels the same button "Fold anyway"; the second folds. Nothing else changes
 * shape — no dialog, no new line in the sticky row, no new live region — so the row's height and
 * the scroll arithmetic built on it (`apps/web/src/styles/play.css`, section 3.1) are untouched.
 * A browser `confirm()` was not considered: it is modal, it stops the turn clock's rendering, and
 * on a teaching table it reads as an alarm about a move that is legal and sometimes taught.
 *
 * **Pointer only, on purpose.** The failure is a mis-TAP: a finger or cursor landing on the key
 * beside the one meant. A keyboard reader reaches Fold by Tab and has just heard its label, which
 * already says "checking also costs 0 units" — that label is their guard, and asking them twice
 * adds a step without preventing anything. The browser tells the two apart for us: a click a
 * pointer made carries `detail >= 1` (the click count), and the click a browser synthesises for
 * Enter or Space on a button carries `detail === 0`, as does a script's `element.click()`.
 *
 * That last fact is a consequence, and it is stated rather than left to be found: every harness in
 * `scripts/` that folds at the table (`ax-assertions.mjs`'s `foldOnce`, `actAtTheTable` and
 * `foldTwiceInOneTask`, `keyboard-audit.mjs`'s `activateByLabel`) presses by real key or by
 * `.click()`, so each still folds in one press, deterministically, whatever spot the bots leave.
 * A future harness that drives a real mouse must press Fold twice in a spot where Check is free.
 *
 * ## The arming belongs to one spot
 *
 * Stamped with `spotSignature` the way the bet draft is stamped with its bounds (`bet-sizing.ts`),
 * so an arming from one decision is never read as consent on another. Every whole-state frame is a
 * fresh `legalActions` array, which is why the stamp is built from values rather than identity.
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

/** Everything the action row is drawn from, as one string, so a changed spot reads as changed. */
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

/**
 * Who acted at a replay step, what the marker says about it, and which step the replay opens on.
 *
 * Lifted out of `HandReplay.tsx` so it can be tested, and two of these decisions were defects
 * measured on the running page (`/review/hand-0042` on the fixture, and a live hand at 308fadf):
 *
 *  1. **The timeline named actions and not actors.** Every marker read "FOLD", "RAISE 20",
 *     "CALL 10" with no player on it, so a reader looking for their own decisions had to open each
 *     one. The name was in the visually-hidden sentence only. `markerActor` puts it on screen.
 *  2. **The replay opened on somebody else's decision.** Step 1 is the first action of the hand,
 *     which is a bot's unless the reader is first to act — so the first Coach panel anybody saw was
 *     "This decision belongs to <bot>, and it is not analysed". `openingStepIndex` opens on the
 *     reader's own first decision; step 1 stays one Home key, one marker or "Previous decision" away.
 *
 * ## Why this is a leaf module
 *
 * Nothing is imported here except types, which are erased. `HandReplay.tsx` imports `@prl/ui`,
 * whose entry point re-exports `.tsx`, and Node's type stripping cannot load a `.tsx` under
 * `node --test` — so the sentences that format an amount stay in the component, and everything
 * that does not is here. Same shape and same reason as `lib/quiz-tolerance.ts`.
 */

import type { HandReplay, ReplayStep } from './hand-replay.ts';

/** Who acted at a step: "You", the seat's name, or "Seat N" when the review carries no name. */
export function markerActor(step: ReplayStep, names: Readonly<Record<number, string>>): string | null {
  const decision = step.decision;
  if (decision === null) return null;
  if (step.isViewerDecision) return 'You';
  return names[decision.seat] ?? `Seat ${decision.seat + 1}`;
}

/** The compressed action on a marker. Amounts are what left the stack, which is what a reader tracks. */
export function markerShort(step: ReplayStep): string {
  const decision = step.decision;
  if (decision === null) return 'END';
  const word = decision.action.toUpperCase();
  if (decision.action === 'raise' && decision.to !== null) return `${word} ${decision.to}`;
  if (decision.amountPaid > 0) return `${word} ${decision.amountPaid}`;
  return word;
}

/**
 * The step the replay opens on: the reader's first own decision, or step 1 when they had none.
 *
 * A reader opens a hand from their own history to see their own play, and the analysis exists only
 * for their own decisions. A hand the reader never acted in — everybody folded to their big blind —
 * still opens at the start, which is the only honest place for it to open.
 */
export function openingStepIndex(replay: Pick<HandReplay, 'steps'>): number {
  return replay.steps.find((step) => step.isViewerDecision)?.index ?? 0;
}

/**
 * How many decisions the replay steps through: every step but the terminal "settled" frame.
 *
 * The hand's summary and the transport both count from this, so they cannot disagree. They did: the
 * summary printed `review.decisions.length` as "DECISIONS 13" while the transport counted steps,
 * terminal frame included, as "STEP 2 / 14" — two numbers for one hand, side by side (audit at
 * 6b3886e, `shots/d-dark-replay-0.png`).
 */
export function decisionCount(replay: Pick<HandReplay, 'steps'>): number {
  return replay.steps.filter((step) => step.decision !== null).length;
}

/**
 * What the transport's counter shows: "Decision 2 / 13", or "Result" on the terminal frame.
 *
 * The terminal frame is not a decision, so it is not given a number that would make it the
 * fourteenth of thirteen. Its value slot still holds a word, so the counter keeps its height and the
 * row does not move when the reader steps onto it.
 *
 * Visible text only. The live region still announces "Step N of M." over every frame, terminal
 * included: that sentence is what `scripts/ax-assertions.mjs` (J6) holds the announcement to, and
 * "step 14 of 14" is true of the frame it describes.
 */
export function stepCounter(
  step: Pick<ReplayStep, 'index' | 'decision'>,
  replay: Pick<HandReplay, 'steps'>,
): { readonly label: string; readonly value: string } {
  if (step.decision === null) return { label: 'Result', value: 'Settled' };
  return { label: 'Decision', value: `${step.index + 1} / ${decisionCount(replay)}` };
}

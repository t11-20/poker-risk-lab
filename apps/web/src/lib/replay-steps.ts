/**
 * Who acted at a replay step, what its marker says, and which step the replay opens on.
 * A leaf module with type-only imports, because `HandReplay.tsx` pulls in `@prl/ui`'s `.tsx`, which
 * `node --test` cannot load.
 */

import type { HandReplay, ReplayStep } from './hand-replay.ts';

/** "You", the seat's name, or "Seat N" when the review carries no name. */
export function markerActor(step: ReplayStep, names: Readonly<Record<number, string>>): string | null {
  const decision = step.decision;
  if (decision === null) return null;
  if (step.isViewerDecision) return 'You';
  return names[decision.seat] ?? `Seat ${decision.seat + 1}`;
}

/** Amounts are what left the stack, which is what a reader tracks. */
export function markerShort(step: ReplayStep): string {
  const decision = step.decision;
  if (decision === null) return 'END';
  const word = decision.action.toUpperCase();
  if (decision.action === 'raise' && decision.to !== null) return `${word} ${decision.to}`;
  if (decision.amountPaid > 0) return `${word} ${decision.amountPaid}`;
  return word;
}

/** The reader's first own decision, because only theirs are analysed, or step 1 when they had none. */
export function openingStepIndex(replay: Pick<HandReplay, 'steps'>): number {
  return replay.steps.find((step) => step.isViewerDecision)?.index ?? 0;
}

/** Every step but the terminal frame. The summary and the transport both count from this. */
export function decisionCount(replay: Pick<HandReplay, 'steps'>): number {
  return replay.steps.filter((step) => step.decision !== null).length;
}

/**
 * The terminal frame shows "Result" rather than a fourteenth of thirteen. Visible text only, because
 * the live region still announces "Step N of M." on every frame, as `ax-assertions.mjs` (J6) expects.
 */
export function stepCounter(
  step: Pick<ReplayStep, 'index' | 'decision'>,
  replay: Pick<HandReplay, 'steps'>,
): { readonly label: string; readonly value: string } {
  if (step.decision === null) return { label: 'Result', value: 'Settled' };
  return { label: 'Decision', value: `${step.index + 1} / ${decisionCount(replay)}` };
}

/**
 * The server also folds, with the same `wasAutomatic` flag, for a player who stood up or left, so the
 * sentence follows `automaticReason` (migration 0009). An older row with no reason gets the sentence
 * true of every automatic decision, never a guess. Empty for a decision a person made.
 */
export function automaticSentence(step: ReplayStep): string {
  const decision = step.decision;
  if (decision === null || !decision.wasAutomatic) return '';
  switch (decision.automaticReason) {
    case 'timeout':
      return ' The clock ran out and the server acted.';
    case 'departed':
      return step.isViewerDecision
        ? ' You had already stood up or left the table, so the server folded for you.'
        : ' They had already left the table, so the server folded for them.';
    default:
      return ' The server made this decision automatically.';
  }
}

/** The same fact as `automaticSentence`, short enough for the transport's headline. */
export function automaticAside(step: ReplayStep): string {
  const decision = step.decision;
  if (decision === null || !decision.wasAutomatic) return '';
  switch (decision.automaticReason) {
    case 'timeout':
      return ' (the clock ran out)';
    case 'departed':
      return step.isViewerDecision ? ' (you had stood up)' : ' (they had left the table)';
    default:
      return ' (made automatically)';
  }
}

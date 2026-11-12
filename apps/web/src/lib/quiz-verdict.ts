/**
 * The words and the mark a quiz verdict carries.
 *
 * A leaf module for the same reason `quiz-tolerance.ts` is one: `QuizRunner.tsx` cannot be loaded
 * under `node --test`, and the sentence below is exactly the sort of thing that has to be pinned by
 * a test that reads it. Nothing is imported here, so nothing can stop that.
 */

/** The marks the option chips carry: the lesson's answer, and a different pick of the reader's. */
export const CHOICE_MARKER = { lesson: '◆', yours: '✕' } as const;

export type ChoiceMarker = (typeof CHOICE_MARKER)[keyof typeof CHOICE_MARKER];

/**
 * The mark a verdict carries: the same one as the chip it agrees with.
 *
 * The two multiple-choice verdicts used to sit in one identical neutral box with no glyph, so they
 * could only be told apart by reading them — and at 360x640 the box is 1060–1210px down the page,
 * under the options. A match takes the lesson's `◆` and a miss takes the `✕` already drawn on the
 * option the reader picked, so the box and the chip say the same thing in the same shape.
 */
export function verdictMarker(matched: boolean): ChoiceMarker {
  return matched ? CHOICE_MARKER.lesson : CHOICE_MARKER.yours;
}

export interface NumericVerdictInput {
  /** The reader's answer, formatted with its unit. */
  readonly yours: string;
  /** The figure the comparison was made against, formatted with its unit. */
  readonly computed: string;
  /** The tolerance the comparison applied, formatted with its unit. */
  readonly tolerance: string;
  readonly matched: boolean;
}

/**
 * The sentence about one numeric answer that could be compared.
 *
 * It used to read "35.0 % is outside the tolerance of 33.3 %" — measured on `/learn/pot-odds`,
 * answering 35 to `pot-odds-q2` — which names the TARGET as the tolerance and never says what the
 * tolerance is, so a reader could tell neither how far out they were nor how close they had to be.
 * It now states both: the computed figure as the computed figure, and the band as a ± band.
 *
 * Takes formatted strings rather than numbers because the formatters live in
 * `learn-calculations.ts`, which imports `@prl/ui` and so cannot be loaded by a test; the caller
 * formats, and this decides only what is said.
 */
export function numericVerdictSentence(input: NumericVerdictInput): string {
  const { yours, computed, tolerance, matched } = input;
  if (matched) return `${yours} is within ±${tolerance} of the computed ${computed}.`;
  return (
    `${yours} is more than ±${tolerance} from the computed ${computed}. Nothing is deducted for that — the working is ` +
    'below, and the gap is usually one step of the method rather than the whole of it.'
  );
}

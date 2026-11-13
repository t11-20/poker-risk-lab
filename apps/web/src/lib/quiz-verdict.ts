/** The words and the mark a quiz verdict carries. A leaf module, so `node --test` can pin the sentence. */

/** The lesson's answer, and a different pick of the reader's. */
export const CHOICE_MARKER = { lesson: '◆', yours: '✕' } as const;

export type ChoiceMarker = (typeof CHOICE_MARKER)[keyof typeof CHOICE_MARKER];

/** The same mark as the chip it agrees with, so a verdict reads at a glance below the options. */
export function verdictMarker(matched: boolean): ChoiceMarker {
  return matched ? CHOICE_MARKER.lesson : CHOICE_MARKER.yours;
}

export interface NumericVerdictInput {
  readonly yours: string;
  readonly computed: string;
  readonly tolerance: string;
  readonly matched: boolean;
}

/**
 * States the computed figure and the ± band separately. Takes formatted strings, because the
 * formatters live in `learn-calculations.ts`, which a test cannot load.
 */
export function numericVerdictSentence(input: NumericVerdictInput): string {
  const { yours, computed, tolerance, matched } = input;
  if (matched) return `${yours} is within ±${tolerance} of the computed ${computed}.`;
  return (
    `${yours} is more than ±${tolerance} from the computed ${computed}. Nothing is deducted for that — the working is ` +
    'below, and the gap is usually one step of the method rather than the whole of it.'
  );
}

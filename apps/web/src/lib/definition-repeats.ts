/**
 * Whether a lesson has already shown a calculation's "How it is defined" box.
 *
 * Identical text, never "the same kind of calculation". Most kinds have one fixed definition, and
 * repeating it is noise: /learn/pot-odds printed the same box under three calculators in a row.
 * But risk of ruin writes the example's own numbers into its definition and has no other working,
 * so a same-kind rule took the working off the second and third examples of
 * sample-size-and-risk-of-ruin. That shipped for one commit and was caught in review on #13.
 *
 * A leaf module, imports and all, for the reason `quiz-tolerance.ts` gives: `learn-calculations.ts`
 * imports runtime values from `@prl/ui`, so no test under `node --test` can load it, and this
 * decision is exactly the kind that needs one.
 */

export interface Definition {
  readonly expression: string;
  readonly explanation: string;
}

export function shownAbove(definition: Definition, earlier: readonly (Definition | null)[]): boolean {
  return earlier.some(
    (shown) =>
      shown !== null &&
      shown.expression === definition.expression &&
      shown.explanation === definition.explanation,
  );
}

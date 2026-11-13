/**
 * Whether a lesson already showed this exact "How it is defined" box. Identical text, not the same
 * kind, because risk of ruin writes the example's own numbers into its definition. A leaf, so
 * `node --test` can load it.
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

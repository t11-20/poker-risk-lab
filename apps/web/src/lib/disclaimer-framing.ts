/**
 * Which of a profile's disclaimers a `/legends` card prints in full, and which it points to.
 * Only an entry byte-identical to the text printed above the grid becomes a one-line pointer, never
 * nothing, so a cropped card still carries its framing (ADR 0011). Every other entry prints in full,
 * in order. The profile page and compare columns print the whole array.
 */

export interface DisclaimerFraming {
  /** True when the card should print the one-line pointer in place of the page-level text. */
  readonly pointer: boolean;
  readonly inFull: readonly string[];
}

export function disclaimerFraming(
  disclaimers: readonly string[],
  shownAbove: string | undefined,
): DisclaimerFraming {
  if (shownAbove === undefined || shownAbove === '') return { pointer: false, inFull: disclaimers };
  const inFull = disclaimers.filter((entry) => entry !== shownAbove);
  return { pointer: inFull.length < disclaimers.length, inFull };
}

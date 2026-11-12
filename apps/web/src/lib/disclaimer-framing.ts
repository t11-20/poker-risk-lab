/**
 * Which of a profile's disclaimers a card on `/legends` prints in full, and which it points to.
 *
 * ## Why a card may point at all
 *
 * `/legends` prints the universal disclaimer once, in full, above the grid — the
 * `LegendProfilesResponse.universalDisclaimer` field exists for exactly that. It then printed the
 * same sentence again, in full, on every one of the twelve cards. Measured on the running build at
 * 360px: thirteen identical "What these profiles are" blocks, 5,202 of the page's 19,174px (27%),
 * and the first "Play this style" at y=3,422 — 5.3 screens down. The repetition was not making any
 * card better labelled; it was pushing the action off the page.
 *
 * ## What is not allowed to change, which is what this function is for
 *
 * The guardrail is that a profile is never shown without its framing (ADR 0011; option B there
 * was rejected because "a screenshot of a seat plate carries the name and not the footer"). So:
 *
 *  - Only an entry **byte-identical** to the text the page already printed above may be replaced,
 *    and it is replaced by a visible one-line statement of the same fact plus a link to the full
 *    text — never by nothing. A card cropped out of a screenshot still says "not a real person".
 *  - **Every other entry is printed in full**, in its original order: the attribution disclaimer
 *    when a deployment shows attributed names, and the course disclaimer on the course-derived
 *    profile, are specific to that card and appear nowhere above it.
 *  - If the server ever sends a card a universal text that differs from the page's — reworded,
 *    translated, one character apart — it is not "the same", so it is printed in full.
 *
 * The profile page and the compare columns do not use this: each of those shows a profile without
 * the page-level block above it, so they print the whole array, as `ProfileDisclaimers` always did.
 */

export interface DisclaimerFraming {
  /** True when the card should print the one-line pointer in place of the page-level text. */
  readonly pointer: boolean;
  /** The entries to print in full, in order. */
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

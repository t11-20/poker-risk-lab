/**
 * Number formatting for the sentences a learner reads.
 *
 * `ev.ts` and `stacks.ts` each carried a byte-identical copy of these helpers, each
 * with a comment saying the copies should be folded together "once the package has an
 * index". The package has an index now, so this is that file. Nothing here is part of
 * the public API — `index.ts` deliberately does not re-export it — because these are
 * presentation details of the explanation strings, not maths anybody should build on.
 *
 * ## Why the other modules are NOT wired into this file
 *
 * `odds.ts`, `outs.ts`, `variance.ts` and `icm.ts` also turn numbers into text, and
 * they round differently on purpose: `odds.ts` always shows a percentage to one
 * decimal ("50.0%"), `variance.ts` widens to an exponent for a tail probability and
 * labels an underflow in words, and `outs.ts` gains a decimal below 10% so a four-out
 * draw does not render as a flat "9%". Those are different decisions about what a
 * reader needs to see, not accidental drift, and pulling them behind one function
 * would silently rewrite figures the tests pin and learners read. Only the two
 * genuinely identical copies were merged.
 *
 * ## -0
 *
 * Every helper maps a negative zero to zero before formatting. `(-0).toFixed(2)` is
 * "-0.00", and a figure that reads "-0 chips" looks like a bug in the arithmetic to
 * exactly the reader least able to tell that it is not.
 */

/** Drops trailing zeros left by `toFixed`, and the lone dot they leave behind. */
function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

/** The shared rounding behind `chips` and `ratio`: at most 2 decimal places. */
function atMostTwoDecimals(value: number): string {
  const safe = value === 0 ? 0 : value;
  return trimZeros(safe.toFixed(2));
}

/**
 * Chips, to at most 2 decimal places.
 *
 * Bets are whole chips everywhere in this app, but an EV or an average is not, and
 * quoting "33.33" rather than "33.3333333333" is the difference between a figure a
 * learner can check by hand and one they cannot.
 */
export function chips(value: number): string {
  return atMostTwoDecimals(value);
}

/**
 * Chips, bracketed when negative, for use inside a written-out sum. Without this a
 * derivation reads "50 + -25", which looks like a typo rather than arithmetic.
 */
export function signedChips(value: number): string {
  return value < 0 ? `(${chips(value)})` : chips(value);
}

/**
 * A ratio to at most 2 decimal places: an SPR of 13/4 prints as "3.25".
 *
 * Same rounding as `chips` today, and a separate function on purpose: an SPR, an M
 * and a stack in big blinds are not chip amounts, and the day one of the two wants a
 * different number of digits, the call sites already say which is which.
 */
export function ratio(value: number): string {
  return atMostTwoDecimals(value);
}

/** A probability as a decimal fraction, to at most 4 places: 1/3 becomes "0.3333". */
export function frac(value: number): string {
  const safe = value === 0 ? 0 : value;
  return trimZeros(safe.toFixed(4));
}

/**
 * A probability as a percentage. Widens to 3 decimal places below a tenth of a point
 * so a small but real frequency is not flattened into "0%", which would read as
 * "never" when it means "seldom".
 */
export function percent(value: number): string {
  const points = value === 0 ? 0 : value * 100;
  const digits = points !== 0 && Math.abs(points) < 0.1 ? 3 : 1;
  return `${trimZeros(points.toFixed(digits))}%`;
}

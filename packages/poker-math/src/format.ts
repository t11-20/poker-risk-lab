/**
 * Number formatting for explanation strings. Not re-exported from `index.ts`.
 *
 * `odds.ts`, `outs.ts`, `variance.ts` and `icm.ts` keep their own formatting on purpose, because
 * they round differently and the tests pin their output. Every helper here maps -0 to 0, since
 * "-0 chips" reads as an arithmetic bug.
 */

function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

function atMostTwoDecimals(value: number): string {
  const safe = value === 0 ? 0 : value;
  return trimZeros(safe.toFixed(2));
}

/** Chips, to at most 2 decimal places. Bets are whole chips, but an EV or an average is not. */
export function chips(value: number): string {
  return atMostTwoDecimals(value);
}

/** Chips, bracketed when negative, so a written-out sum reads "50 + (-25)", not "50 + -25". */
export function signedChips(value: number): string {
  return value < 0 ? `(${chips(value)})` : chips(value);
}

/**
 * A ratio to at most 2 decimal places, so an SPR of 13/4 prints as "3.25". Separate from `chips`
 * because an SPR or an M is not a chip figure.
 */
export function ratio(value: number): string {
  return atMostTwoDecimals(value);
}

/** A probability as a decimal fraction, to at most 4 places: 1/3 becomes "0.3333". */
export function frac(value: number): string {
  const safe = value === 0 ? 0 : value;
  return trimZeros(safe.toFixed(4));
}

/** A probability as a percentage. Below a tenth of a point it widens to 3 decimals, not "0%". */
export function percent(value: number): string {
  const points = value === 0 ? 0 : value * 100;
  const digits = points !== 0 && Math.abs(points) < 0.1 ? 3 : 1;
  return `${trimZeros(points.toFixed(digits))}%`;
}

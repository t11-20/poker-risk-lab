/**
 * The words around the Lab's fold-frequency control, kept out of the component so they can be
 * tested — JSX cannot run under `node:test` here.
 *
 * The arithmetic is `repriceAtFoldEquity` in `@prl/poker-math`, which re-runs the Coach's own
 * `evOfBet`/`evOfRaise` and refuses a report it cannot reproduce. This module only names rows and
 * says what moved. Formatters are passed in because `@prl/ui`'s entry point carries JSX this
 * module's tests cannot load; the component hands it `formatUnits` and `formatSignedUnits`.
 */

import type { FoldEquityRepricing, RepricedRow } from '@prl/poker-math';

export interface Formatters {
  /** `formatUnits`: "200 units". */
  readonly units: (value: number) => string;
  /** `formatSignedUnits` at one decimal: "+41.4 units", "-8.4 units". */
  readonly signed: (value: number) => string;
}

const WORD: Readonly<Record<RepricedRow['action'], string>> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

/** "Raise to 200 units", "Call to 100 units", "Fold". */
export function rowName(row: RepricedRow, format: Formatters): string {
  return row.to === null ? WORD[row.action] : `${WORD[row.action]} to ${format.units(row.to)}`;
}

/** A fraction as a whole percentage, the precision the control moves in. */
export function percentText(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** What happened to one row: the analysed figure, the figure now, and the change — or why none. */
export function rowChangeText(row: RepricedRow, format: Formatters): string {
  if (!row.readsFoldEquity) {
    return `${format.signed(row.analysedEv)} — does not depend on the fold frequency, so it does not move`;
  }
  const change = row.ev - row.analysedEv;
  // Rounded to the precision printed, so a change too small to show is not printed as "+0.0".
  if (Number(Math.abs(change).toFixed(1)) === 0) return `${format.signed(row.ev)}, as analysed`;
  return `${format.signed(row.analysedEv)} as analysed, ${format.signed(row.ev)} now (${format.signed(change)})`;
}

/**
 * The one-sentence summary, announced politely as the control moves: the frequency, the highest
 * row at it, and — when that is a different row — the highest row as analysed.
 */
export function repricingSummary(
  repriced: Extract<FoldEquityRepricing, { kind: 'available' }>,
  format: Formatters,
): string {
  const at = percentText(repriced.foldEquity);
  const analysedAt = percentText(repriced.analysedFoldEquity);
  const best = `${rowName(repriced.best, format)}, worth ${format.signed(repriced.best.ev)}`;
  if (repriced.foldEquity === repriced.analysedFoldEquity) {
    return `At the analysed ${analysedAt}, the highest row is ${best}.`;
  }
  const sameRow =
    repriced.best.action === repriced.analysedBest.action && repriced.best.to === repriced.analysedBest.to;
  return sameRow
    ? `At ${at}, the highest row is still ${best}.`
    : `At ${at}, the highest row is ${best}. At the analysed ${analysedAt} it was ${rowName(repriced.analysedBest, format)}.`;
}

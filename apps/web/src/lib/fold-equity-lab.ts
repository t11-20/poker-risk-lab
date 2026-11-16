/**
 * The words around the Lab's fold-frequency control, outside the component so `node:test` can run
 * them. The arithmetic is `repriceAtFoldEquity` in `@prl/poker-math`. Formatters are passed in
 * because `@prl/ui` carries JSX.
 */

import type { ActionCandidate } from '@prl/contracts';
import type { FoldEquityRepricing, RepricedRow } from '@prl/poker-math';
import { rowName } from './consistency.ts';

export interface Formatters {
  readonly units: (value: number) => string;
  /** `formatSignedUnits` at one decimal: "+41.4 units", "-8.4 units". */
  readonly signed: (value: number) => string;
}

/** A fraction as a whole percentage, the precision the control moves in. */
export function percentText(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

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
 * Announced politely as the control moves. The Verdict panel above names the Coach's reading, so the
 * reading's row leads wherever a higher row would otherwise read as a second answer. At the analysed
 * frequency any row above the reading is one it set aside; at another, the reading was not remade.
 */
export function repricingSummary(
  repriced: Extract<FoldEquityRepricing, { kind: 'available' }>,
  reading: Pick<ActionCandidate, 'action' | 'to'> | null,
  format: Formatters,
): string {
  const analysed = repriced.foldEquity === repriced.analysedFoldEquity;
  const at = analysed
    ? `the analysed ${percentText(repriced.analysedFoldEquity)}`
    : percentText(repriced.foldEquity);
  const worth = (row: RepricedRow) => `${rowName(row, format.units)}, worth ${format.signed(row.ev)}`;
  const top = repriced.best;
  const stands = repriced.rows.find(
    (row) => row.action === reading?.action && row.to === (reading.to ?? null),
  );
  if (stands === undefined) return `At ${at}, the highest row is ${worth(top)}.`;
  if (stands === top)
    return `At ${at}, the highest row is ${worth(top)}, and the Coach’s reading stands on it.`;
  return analysed
    ? `At ${at}, the Coach’s reading stands on ${worth(stands)}. The highest row, ${worth(top)}, is one the reading sets aside, and the Coach says why.`
    : `At ${at}, the row the Coach’s reading stands on, ${rowName(stands, format.units)}, is worth ${format.signed(stands.ev)}, and the highest row is ${worth(top)}.`;
}

import type { ActionCandidate, CoachReport } from '@prl/contracts';
import { formatChips } from '@prl/ui/format';
import { rowName } from './consistency.ts';

/** The post-hand table names a row as the Lab does, so a call reads what its button cost. */
export function pricedRowName(candidate: ActionCandidate): string {
  return rowName({ ...candidate, to: candidate.to ?? null }, formatChips);
}

export function equityMethodNote(report: {
  readonly equity: Pick<CoachReport['equity'], 'method' | 'trials' | 'confidenceHalfWidthPoints'>;
}): string {
  const { method, trials } = report.equity;
  if (method === 'exact-enumeration') {
    return `Exact enumeration over ${formatChips(trials)} showdowns. No sampling error.`;
  }
  if (report.equity.confidenceHalfWidthPoints === null) {
    return `Sampled over ${formatChips(trials)} runs, and the interval was not reported — treat this figure as approximate.`;
  }
  return `Monte Carlo over ${formatChips(trials)} sampled runs, so the figure carries the interval beside it.`;
}

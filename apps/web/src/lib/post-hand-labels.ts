import type { ActionCandidate } from '@prl/contracts';
import { formatChips } from '@prl/ui/format';
import { rowName } from './consistency.ts';

/** The post-hand table names a row as the Lab does, so a call reads what its button cost. */
export function pricedRowName(candidate: ActionCandidate): string {
  return rowName({ ...candidate, to: candidate.to ?? null }, formatChips);
}

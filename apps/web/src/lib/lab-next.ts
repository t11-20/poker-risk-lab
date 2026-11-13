/**
 * Where "Next scenario" goes. The live `GET /content/scenarios` list in its arrival order, which the
 * Lab index numbers, or the bundled `@prl/content` list, the same scenarios in the same order.
 * Server-only, because the whole bundle has no business in a client chunk.
 */

import { scenarios } from '@prl/content';
import type { ScenarioSummary } from '@prl/contracts';

/** Null for the last one, an unknown id or an empty list. A missing button, never a guessed destination. */
export function nextScenarioHref(
  id: string,
  live: readonly Pick<ScenarioSummary, 'id'>[] | null,
): string | null {
  const ordered = live ?? scenarios();
  const at = ordered.findIndex((candidate) => candidate.id === id);
  if (at < 0) return null;
  const next = ordered[at + 1];
  return next === undefined ? null : `/lab/${encodeURIComponent(next.id)}`;
}

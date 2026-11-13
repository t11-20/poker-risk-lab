/**
 * A scenario's title and question by id, from `scenarios()` in `@prl/content`, the list the routes
 * and the API both use. The offline fixtures carry different ids. Server-only, because it reads the
 * bundle with `node:fs`.
 */

import { scenarios } from '@prl/content';

export interface ScenarioTitle {
  readonly id: string;
  readonly title: string;
  readonly question: string;
}

export function bundledScenarioTitle(id: string): ScenarioTitle | null {
  const scenario = scenarios().find((candidate) => candidate.id === id);
  if (scenario === undefined) return null;
  return { id: scenario.id, title: scenario.title, question: scenario.question };
}

/** "Not found" is true for an id the bundle lacks, since `dynamicParams` is false. */
export function scenarioPageMetadata(id: string): { readonly title: string; readonly description?: string } {
  const found = bundledScenarioTitle(id);
  if (found === null) return { title: 'Scenario not found' };
  return { title: found.title, description: found.question };
}

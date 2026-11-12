/**
 * A scenario's title and question by id, from the bundled content — server-side only.
 *
 * ## The defect this replaced
 *
 * `/lab/[scenarioId]`'s `generateMetadata` and its "could not be loaded" screen both looked the id
 * up in `LAB_SCENARIO_SUMMARIES`, and that is the summary list of the six OFFLINE FIXTURES in
 * `src/fixtures/scenarios.ts` — whose ids are not the ids the API serves. So every one of the 36
 * real scenario pages, all of them generated from `scenarios()` by `generateStaticParams`, was
 * titled "Scenario", and the unavailable screen that a comment said could name "all thirty-six"
 * could name none of them.
 *
 * `scenarios()` from `@prl/content` is the list `generateStaticParams` builds the routes from and
 * the list the API serves, so it is the one list that names every page this route can render. It
 * reads the bundle from disk with `node:fs`, which is why this module is imported only by the
 * server component; a client component that imported it would put a Node builtin in the browser.
 */

import { scenarios } from '@prl/content';

export interface ScenarioTitle {
  readonly id: string;
  readonly title: string;
  readonly question: string;
}

/** The bundled scenario's title and question, or null for an id the bundle does not carry. */
export function bundledScenarioTitle(id: string): ScenarioTitle | null {
  const scenario = scenarios().find((candidate) => candidate.id === id);
  if (scenario === undefined) return null;
  return { id: scenario.id, title: scenario.title, question: scenario.question };
}

/**
 * The page metadata for `/lab/[scenarioId]`: the scenario's own title, or "Scenario not found".
 *
 * The fallback was "Scenario", which the audit at 6b3886e heard announced over the 404 body at
 * `/lab/nope`. "Not found" is a claim this module can make: the bundle is the list
 * `generateStaticParams` builds the routes from and `dynamicParams` is false, so an id it does not
 * carry is not a page this route serves.
 */
export function scenarioPageMetadata(id: string): { readonly title: string; readonly description?: string } {
  const found = bundledScenarioTitle(id);
  if (found === null) return { title: 'Scenario not found' };
  return { title: found.title, description: found.question };
}

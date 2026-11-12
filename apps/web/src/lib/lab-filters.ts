/**
 * The Scenario Lab index's facets: which scenarios a selection shows, and what each option would show.
 *
 * Out of `app/lab/page.tsx` because a page module may export only what Next reads from it, so the
 * counting there could not be tested — and the counting is the part a reader acts on.
 */

import type { ScenarioSummary } from '@prl/contracts';
import { DIFFICULTY_ORDER, STREET_ORDER } from './lab-labels.ts';

/**
 * The sentinel for "no filter". A value rather than an absent parameter, so the control has a state.
 *
 * Declared here rather than in `ScenarioFilters.tsx` so this module stays loadable by `node --test`,
 * which strips types and cannot transform JSX.
 */
export const FILTER_ANY = 'any';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
  /** How many scenarios this option would show, given the other two filters. */
  readonly count: number;
}

/**
 * The id of the Lab's result count, which sits directly above the results.
 *
 * The filter form's action carries it as a fragment and the Intro shortcut links to it, so either
 * one lands the reader on the answer rather than on the top of a reloaded page.
 */
export const LAB_RESULTS_ID = 'lab-results';

export interface LabSelection {
  readonly topic: string;
  readonly difficulty: string;
  readonly street: string;
}

export function matchesSelection(scenario: ScenarioSummary, selection: LabSelection): boolean {
  if (selection.topic !== FILTER_ANY && scenario.topic !== selection.topic) return false;
  if (selection.difficulty !== FILTER_ANY && scenario.difficulty !== selection.difficulty) return false;
  if (selection.street !== FILTER_ANY && scenario.street !== selection.street) return false;
  return true;
}

/**
 * The facets with a natural order, and that order. Topic has none a reader would recognise from the
 * dropdown alone, so it stays alphabetical by label.
 */
const FACET_ORDER: Partial<Record<keyof LabSelection, readonly string[]>> = {
  difficulty: DIFFICULTY_ORDER,
  street: STREET_ORDER,
};

/** A value's place in its facet's order, with anything unranked after everything ranked. */
function rankIn(order: readonly string[], value: string): number {
  const at = order.indexOf(value);
  return at < 0 ? order.length : at;
}

/**
 * Options for one facet, counted against the other two.
 *
 * The facet being built is set to `any` inside its own count, which is what makes the number a
 * prediction of "if I pick this" rather than of "if I pick this and nothing else".
 *
 * Difficulty is ordered Intro, Core, Advanced and streets in the order they are dealt; a value
 * neither list knows is kept and sorted last, by label, rather than dropped.
 */
export function optionsFor(
  scenarios: readonly ScenarioSummary[],
  selection: LabSelection,
  facet: keyof LabSelection,
  label: (id: string) => string,
): readonly FilterOption[] {
  const relaxed: LabSelection = { ...selection, [facet]: FILTER_ANY };
  const counts = new Map<string, number>();
  for (const scenario of scenarios) {
    const value = scenario[facet];
    if (!counts.has(value)) counts.set(value, 0);
    if (matchesSelection(scenario, relaxed)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const order = FACET_ORDER[facet] ?? [];
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: label(value), count }))
    .sort((a, b) => rankIn(order, a.value) - rankIn(order, b.value) || a.label.localeCompare(b.label, 'en'));
}

/**
 * What the facet's "any" option would show: everything the OTHER two filters allow.
 *
 * Counted the same way as the options beside it. It used to be the size of the whole list, so with
 * Intro selected the topic control read "Every topic (36)" above a page showing 6 — the one option
 * in the control whose number was not a prediction of what choosing it would show.
 */
export function anyCountFor(
  scenarios: readonly ScenarioSummary[],
  selection: LabSelection,
  facet: keyof LabSelection,
): number {
  const relaxed: LabSelection = { ...selection, [facet]: FILTER_ANY };
  return scenarios.filter((scenario) => matchesSelection(scenario, relaxed)).length;
}

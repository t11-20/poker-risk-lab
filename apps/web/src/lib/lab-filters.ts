/**
 * The Scenario Lab index's facets. Out of `app/lab/page.tsx`, because a page module may export only
 * what Next reads, so its counting could not be tested.
 */

import type { ScenarioSummary } from '@prl/contracts';
import { DIFFICULTY_ORDER, STREET_ORDER } from './lab-labels.ts';

/** A value rather than an absent parameter, so the control has a state. Here so `node --test` loads it. */
export const FILTER_ANY = 'any';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
  /** How many scenarios this option would show, given the other two filters. */
  readonly count: number;
}

/** The filter form's action and the Intro shortcut both land on it, not on the top of the page. */
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

/** Topic has no natural order a reader would recognise, so it stays alphabetical by label. */
const FACET_ORDER: Partial<Record<keyof LabSelection, readonly string[]>> = {
  difficulty: DIFFICULTY_ORDER,
  street: STREET_ORDER,
};

function rankIn(order: readonly string[], value: string): number {
  const at = order.indexOf(value);
  return at < 0 ? order.length : at;
}

/**
 * The facet being built is relaxed to `any` in its own count, so each number predicts picking it.
 * A value neither order knows is sorted last by label, never dropped.
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

/** Counted like the options beside it, so it predicts what choosing it would show. */
export function anyCountFor(
  scenarios: readonly ScenarioSummary[],
  selection: LabSelection,
  facet: keyof LabSelection,
): number {
  const relaxed: LabSelection = { ...selection, [facet]: FILTER_ANY };
  return scenarios.filter((scenario) => matchesSelection(scenario, relaxed)).length;
}

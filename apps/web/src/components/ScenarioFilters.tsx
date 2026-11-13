/**
 * The Scenario Lab's filters, a plain GET form with native `<select>`s and no JavaScript. The URL is
 * linkable and it works before hydration. A submit replaces the document, so no live region can
 * announce the new count. The `<title>` built in `app/lab/page.tsx` carries it instead.
 * Each option's count is computed against the other two filters, so an empty combination shows first.
 */

import type { ReactElement } from 'react';
import { FILTER_ANY, type FilterOption, LAB_RESULTS_ID } from '../lib/lab-filters.ts';

export interface ScenarioFilterSelection {
  readonly topic: string;
  readonly difficulty: string;
  readonly street: string;
}

export interface ScenarioFilterSelectionCounts {
  readonly topic: number;
  readonly difficulty: number;
  readonly street: number;
}

export interface ScenarioFiltersProps {
  readonly topics: readonly FilterOption[];
  readonly difficulties: readonly FilterOption[];
  readonly streets: readonly FilterOption[];
  readonly selected: ScenarioFilterSelection;
  readonly matching: number;
  readonly totalAvailable: number;
  /** Not `totalAvailable`. See `anyCountFor` in `lib/lab-filters.ts`. */
  readonly anyCounts: ScenarioFilterSelectionCounts;
  readonly action: string;
}

/** Shared with the document title so the announced count and the printed one cannot drift. */
export function scenarioCountPhrase(matching: number, totalAvailable: number): string {
  return matching === totalAvailable ? `all ${totalAvailable}` : `${matching} of ${totalAvailable}`;
}

/** Shared with the title for the same reason, so "is this view filtered" has one answer. */
export function isFilteredSelection(selection: ScenarioFilterSelection): boolean {
  return (
    selection.topic !== FILTER_ANY || selection.difficulty !== FILTER_ANY || selection.street !== FILTER_ANY
  );
}

interface FilterFieldProps {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly anyLabel: string;
  readonly options: readonly FilterOption[];
  readonly value: string;
}

function FilterField({ id, name, label, anyLabel, options, value }: FilterFieldProps): ReactElement {
  return (
    <p className="prl-field prl-lab-filters__field">
      <label className="prl-field__label" htmlFor={id}>
        {label}
      </label>
      <select className="prl-select" id={id} name={name} defaultValue={value}>
        <option value={FILTER_ANY}>{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {`${option.label} (${option.count})`}
          </option>
        ))}
      </select>
    </p>
  );
}

export function ScenarioFilters(props: ScenarioFiltersProps): ReactElement {
  const { topics, difficulties, streets, selected, matching, totalAvailable, anyCounts, action } = props;
  const isFiltered = isFilteredSelection(selected);

  return (
    // A GET submit keeps the action's fragment, so the new page opens at the count. Without it, at
    // 360x640 the first result loaded below the fold.
    <form className="prl-lab-filters" method="get" action={`${action}#${LAB_RESULTS_ID}`}>
      <fieldset className="prl-lab-filters__set">
        <legend className="prl-lab-filters__legend">Filter the scenarios</legend>

        <div className="prl-lab-filters__row">
          <FilterField
            id="prl-filter-topic"
            name="topic"
            label="Topic"
            anyLabel={`Every topic (${anyCounts.topic})`}
            options={topics}
            value={selected.topic}
          />
          <FilterField
            id="prl-filter-difficulty"
            name="difficulty"
            label="Difficulty"
            anyLabel={`Every level (${anyCounts.difficulty})`}
            options={difficulties}
            value={selected.difficulty}
          />
          <FilterField
            id="prl-filter-street"
            name="street"
            label="Street"
            anyLabel={`Every street (${anyCounts.street})`}
            options={streets}
            value={selected.street}
          />
        </div>

        <div className="prl-lab-filters__actions">
          <button className="prl-btn prl-btn--primary" type="submit">
            Apply filters
          </button>
          {/* A link, because a reset button restores defaults without navigating. */}
          {isFiltered ? (
            <a className="prl-btn prl-btn--ghost" href={action}>
              Clear all filters
            </a>
          ) : null}

          {/* No live region. One that loads holding its text announces nothing (certification 4.2). */}
          <p className="prl-lab-filters__summary" id={LAB_RESULTS_ID}>
            Showing{' '}
            <span className="prl-lab-filters__count">{scenarioCountPhrase(matching, totalAvailable)}</span>{' '}
            scenarios.
          </p>
        </div>
      </fieldset>
    </form>
  );
}

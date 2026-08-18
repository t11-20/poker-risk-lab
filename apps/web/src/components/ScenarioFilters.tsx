/**
 * The Scenario Lab's filters: topic, difficulty and street.
 *
 * ## Why this is a plain GET form with no JavaScript at all
 *
 * The brief asks for real form controls, keyboard operable, with the selection reflected in the URL
 * so a filtered view is linkable. A `<form method="get">` satisfies all three by construction — the
 * browser serialises the controls into the query string and navigates — and it keeps working with
 * scripting off, on a slow connection before hydration, and in a text browser.
 *
 * The alternative was a client component calling `router.replace` on every `change`. It filters
 * without a submit press, which is nicer, and it costs: a client bundle, a hydration boundary, a
 * `useSearchParams` subscription, and a control that does nothing at all until the JavaScript
 * arrives. For three `<select>`s over six scenarios that is a bad trade. This component ships no
 * JavaScript and has no `'use client'`.
 *
 * ## Native `<select>`, not a custom listbox
 *
 * `packages/ui/src/styles/components.css` keeps the platform's own arrow and its own keyboard
 * handling for exactly this reason: a redrawn select has to reimplement type-ahead, arrow
 * navigation, `Home`/`End`, the mobile picker and the forced-colors treatment, and it gets at least
 * one of them wrong. `.prl-select` styles the box and leaves the behaviour alone.
 *
 * ## Counts on the options
 *
 * Every option carries how many scenarios it would show, so a reader can see that a combination is
 * empty before they choose it rather than after. The count is computed against the *other* two
 * filters, which is what makes it a useful prediction instead of a constant.
 */

import type { ReactElement } from 'react';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
  /** How many scenarios this option would show, given the other two filters. */
  readonly count: number;
}

export interface ScenarioFilterSelection {
  readonly topic: string;
  readonly difficulty: string;
  readonly street: string;
}

export interface ScenarioFiltersProps {
  readonly topics: readonly FilterOption[];
  readonly difficulties: readonly FilterOption[];
  readonly streets: readonly FilterOption[];
  readonly selected: ScenarioFilterSelection;
  /** How many scenarios the current selection matches, for the summary line. */
  readonly matching: number;
  readonly totalAvailable: number;
  /** Where the form submits. The route that renders it, so the query lands on the same page. */
  readonly action: string;
}

/** The sentinel for "no filter". A value rather than an absent parameter, so the control has a state. */
export const FILTER_ANY = 'any';

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
  const { topics, difficulties, streets, selected, matching, totalAvailable, action } = props;
  const isFiltered =
    selected.topic !== FILTER_ANY || selected.difficulty !== FILTER_ANY || selected.street !== FILTER_ANY;

  return (
    <form className="prl-lab-filters" method="get" action={action}>
      <fieldset className="prl-lab-filters__set">
        <legend className="prl-lab-filters__legend">Filter the scenarios</legend>

        <div className="prl-lab-filters__row">
          <FilterField
            id="prl-filter-topic"
            name="topic"
            label="Topic"
            anyLabel={`Every topic (${totalAvailable})`}
            options={topics}
            value={selected.topic}
          />
          <FilterField
            id="prl-filter-difficulty"
            name="difficulty"
            label="Difficulty"
            anyLabel={`Every level (${totalAvailable})`}
            options={difficulties}
            value={selected.difficulty}
          />
          <FilterField
            id="prl-filter-street"
            name="street"
            label="Street"
            anyLabel={`Every street (${totalAvailable})`}
            options={streets}
            value={selected.street}
          />
        </div>

        <div className="prl-lab-filters__actions">
          <button className="prl-btn prl-btn--primary" type="submit">
            Apply filters
          </button>
          {/* A link, not a reset button: `type="reset"` restores the control's default value without
              navigating, so the page would still show the old filtered list. */}
          {isFiltered ? (
            <a className="prl-btn prl-btn--ghost" href={action}>
              Clear all filters
            </a>
          ) : null}

          {/* The count sits on the action row rather than below the form, because it is the answer
              to the question the button asks and it was previously two blocks away from it. Still
              `aria-live`, so a submit that narrows the list to nothing is announced rather than
              left to be discovered by scrolling. */}
          <p className="prl-lab-filters__summary" role="status" aria-live="polite">
            {matching === totalAvailable ? (
              <>
                Showing all <span className="prl-lab-filters__count">{totalAvailable}</span> scenarios.
              </>
            ) : (
              <>
                Showing <span className="prl-lab-filters__count">{`${matching} of ${totalAvailable}`}</span>{' '}
                scenarios.
              </>
            )}
          </p>
        </div>
      </fieldset>
    </form>
  );
}

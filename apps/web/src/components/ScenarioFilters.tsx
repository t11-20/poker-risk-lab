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
 * ## What that costs a screen reader, and where the cost is paid
 *
 * A GET submit replaces the document, which destroys every live region on the page along with the
 * context that would have written to one. So this component cannot announce the new count, and no
 * amount of ARIA on the summary line below changes that — see the comment on it. The count is
 * announced by the document title instead, which is the one thing a new document does announce;
 * `app/lab/page.tsx` builds it, and `scenarioCountPhrase` below is the figure both of them share.
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

/**
 * The counted part of the summary — "12 of 36", or "all 36" when nothing has been filtered out.
 *
 * Exported because the Lab's document TITLE now carries the same string, and the two must not be
 * able to drift. A title that disagreed with the line printed on the page would be worse than the
 * silence it replaced: the reader would be told one count and shown another, and would have no way
 * to tell which one was the bug. The words around it differ ("Showing 12 of 36 scenarios." on the
 * page, "Scenario Lab — 12 of 36 scenarios" in the title); the figure is one function.
 *
 * See `app/lab/page.tsx` on why the title is the channel at all — measured in Chrome 151, a submit
 * of this form is a full document load, and the live region below arrives already holding its text.
 */
export function scenarioCountPhrase(matching: number, totalAvailable: number): string {
  return matching === totalAvailable ? `all ${totalAvailable}` : `${matching} of ${totalAvailable}`;
}

/**
 * Whether any of the three facets is set to something other than "any".
 *
 * Exported for the same reason as the phrase above: the page's title is filtered-only, so "is this
 * view filtered" is now asked in two files and must be one answer. Two spellings of it is how a
 * "Clear all filters" link appears on a page whose title says nothing was filtered.
 */
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
  const { topics, difficulties, streets, selected, matching, totalAvailable, action } = props;
  const isFiltered = isFilteredSelection(selected);

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

          {/*
            The count sits on the action row rather than below the form, because it is the answer to
            the question the button asks and it was previously two blocks away from it.

            It used to carry `role="status" aria-live="polite"`, and the comment here used to say
            that a submit which narrows the list to nothing is therefore "announced rather than left
            to be discovered by scrolling". That was false, and it was false by construction rather
            than by accident: this form is a plain GET, so a submit REPLACES the document. Measured
            in Chrome 151 against a production build — the JavaScript context was destroyed
            (a `window` marker set before the submit was gone afterwards), and the new document's
            summary took ZERO mutations because it arrived already holding "Showing 14 of 36
            scenarios." A live region that arrives with its text announces nothing; that is the same
            fact assertion 3.3 was fixed for, and here there is no surviving context in which to
            mount the region empty and write into it a moment later.

            So the live-region attributes are gone rather than left as a promise nothing keeps, and
            the count is announced by the one channel a new document does announce: the `<title>`.
            See `app/lab/page.tsx`. Certification assertion 4.2.
          */}
          <p className="prl-lab-filters__summary">
            Showing{' '}
            <span className="prl-lab-filters__count">{scenarioCountPhrase(matching, totalAvailable)}</span>{' '}
            scenarios.
          </p>
        </div>
      </fieldset>
    </form>
  );
}

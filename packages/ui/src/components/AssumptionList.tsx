/**
 * The assumptions behind a number, always visible.
 *
 * ## The one thing not to change here
 *
 * There is no `<details>`, no "show assumptions" toggle, and no truncation. A figure
 * whose assumptions are one click away is a figure presented as fact, and the product
 * guardrails are explicit: state the assumptions with every number, surface the
 * uncertainty, never claim universal optimality. Collapsing this list would quietly
 * breach all three.
 *
 * If the list is ever too long for the layout, the fix is a shorter list from the
 * server, not a disclosure widget.
 *
 * ## Why an empty list renders a warning rather than nothing
 *
 * `CoachReport.assumptions` is documented as never empty. If it arrives empty, the
 * honest rendering is to say so — an analysis with no stated assumptions cannot be
 * checked by the reader. Rendering `null` would hide a server bug behind a
 * plausible-looking panel.
 *
 * ## Heading level
 *
 * Takes a `headingLevel` (default 3) instead of hard-coding one. A reusable block
 * cannot know how deeply it is nested, and an out-of-order heading is worse for
 * screen-reader navigation than a slightly generic one. This package never emits an
 * `h1`: a page owns its single `h1`.
 *
 * ## Why the rows are numbered
 *
 * `01 02 03` in the index voice (§1) turns a list of caveats into a system a reader can refer
 * to — "the second assumption" is a sentence someone can say out loud in a review. The markers
 * are `aria-hidden` and the list stays a `<ul>`: a screen reader already announces "list, four
 * items, item two", so reading the marker as well would be the same information twice, and an
 * `<ol>` would claim these have an order that matters when they do not.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatIndex } from '../format.ts';
import { withKeys } from '../keys.ts';

export type HeadingLevel = 2 | 3 | 4 | 5 | 6;

export interface AssumptionListProps {
  /** Plain-language statements. Rendered in the order given. */
  readonly items: readonly string[];
  readonly title?: string;
  /** One sentence before the list, e.g. why these matter. */
  readonly intro?: string;
  readonly headingLevel?: HeadingLevel;
  readonly className?: string;
}

export function AssumptionList(props: AssumptionListProps): ReactElement {
  const {
    items,
    title = 'What these numbers assume',
    intro = 'Change any of these and the figures above change with it.',
    headingLevel = 3,
    className,
  } = props;

  // `h2`..`h6` from the level. The template-literal type keeps this an intrinsic
  // element name rather than an arbitrary string, so a typo is a compile error.
  const Heading = `h${headingLevel}` as const;
  const keyed = withKeys(items, 'assumption');

  return (
    <section className={cx('prl-assumptions', className)}>
      <Heading className="prl-assumptions__title">{title}</Heading>
      {keyed.length === 0 ? (
        <p className="prl-assumptions__intro">
          No assumptions were reported with this analysis, which means the numbers above cannot be checked
          against the situation they came from. Treat them as unverified.
        </p>
      ) : (
        <>
          <p className="prl-assumptions__intro">{intro}</p>
          <ul className="prl-assumptions__list">
            {keyed.map((entry, position) => (
              <li className="prl-assumptions__item" key={entry.key}>
                <span className="prl-assumptions__index prl-index" aria-hidden="true">
                  {formatIndex(position + 1)}
                </span>
                <span className="prl-assumptions__text">{entry.value}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

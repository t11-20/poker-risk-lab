/**
 * The assumptions behind a number, always visible. Never add a `<details>`, toggle or truncation:
 * a figure whose assumptions are one click away is presented as fact. A long list needs a shorter
 * list from the server. An empty list renders a warning, because `CoachReport.assumptions` is never
 * meant to be empty. Rows are a `<ul>` with `aria-hidden` indexes, since the order carries no meaning.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatIndex } from '../format.ts';
import { withKeys } from '../keys.ts';

export type HeadingLevel = 2 | 3 | 4 | 5 | 6;

export interface AssumptionListProps {
  readonly items: readonly string[];
  readonly title?: string;
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

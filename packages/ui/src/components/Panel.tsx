/**
 * A hairlined surface with an optional header: the container everything else sits in.
 *
 * ## Depth is a surface step and a hairline, never a shadow
 *
 * `tone` picks a step on the neutral ramp — `raised`, `panel`, `inset` — and the stylesheet
 * pairs it with a 1px hairline. There is no elevation prop and no shadow token to pass,
 * because there is no shadow in this system (§4.1). Beyond taste that is a performance
 * decision: a six-seat table with a live Coach rail is exactly the scene where large blurred
 * layers cost frames on a mid-range laptop.
 *
 * ## Why the header is a slot rather than three components
 *
 * A panel header is an index, an eyebrow, a title and an actions area, in that order, and
 * every one of them is optional. Composing that from separate exports would let a caller put
 * them in a different order in different places, and the numbered-system motif (§9) only
 * reads as a system when `01` is always in the same position.
 *
 * ## Two accessibility decisions
 *
 *  - **No `aria-label` or `aria-labelledby` on the element.** A `<section>` becomes a `region`
 *    landmark only once it has an accessible name, so an unnamed section is exactly what is
 *    wanted here: the heading is in the document outline, and a page with nine panels does not
 *    put nine competing landmarks in a screen-reader's rotor. Pages own landmarks in this
 *    codebase; components do not create them.
 *  - **`headingLevel` is a prop, defaulting to 2, and can never be 1.** A reusable container
 *    cannot know how deeply it is nested, and an out-of-order heading is worse for navigation
 *    than a slightly generic one. A page owns its single `h1`.
 *
 * The index is `aria-hidden`: "zero two" before every panel title is noise, and the ordering
 * it expresses is already carried by the document order. Where a number is genuinely part of
 * the content — a side pot, a lesson step — that number belongs in the text, not here.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement, ReactNode } from 'react';
import { cx } from '../cx.ts';
import { formatIndex } from '../format.ts';
import type { HeadingLevel } from './AssumptionList.tsx';

/** Which step of the surface ramp the panel sits on. */
export type PanelTone = 'panel' | 'raised' | 'inset';

export interface PanelProps {
  readonly children: ReactNode;
  /** Rendered as the heading. Without it, no heading is emitted at all. */
  readonly title?: string;
  readonly headingLevel?: HeadingLevel;
  /** Small uppercase kicker above the title, e.g. "COACH". */
  readonly eyebrow?: string;
  /** The `01 02 03` motif. A number is padded to two digits; a string is used as given. */
  readonly index?: number | string;
  readonly tone?: PanelTone;
  /** Controls that belong to the panel, laid out at the end of its header. */
  readonly actions?: ReactNode;
  /** `article` for a self-contained card, `div` where a heading outline is not wanted. */
  readonly as?: 'section' | 'article' | 'div';
  readonly id?: string;
  readonly className?: string;
}

/** A number is padded by `formatIndex`; a string (`"1a"`, `"IV"`) is the caller's own form. */
function indexText(index: number | string): string {
  return typeof index === 'string' ? index : formatIndex(index);
}

export function Panel(props: PanelProps): ReactElement {
  const {
    children,
    title,
    headingLevel = 2,
    eyebrow,
    index,
    tone = 'panel',
    actions,
    as = 'section',
    id,
    className,
  } = props;

  // A union of intrinsic tag names, so a typo is a compile error rather than a `<sektion>`.
  const Tag = as;
  const Heading = `h${headingLevel}` as const;
  const hasHeader =
    title !== undefined || eyebrow !== undefined || index !== undefined || actions !== undefined;

  return (
    <Tag className={cx('prl-panel', className)} data-tone={tone} id={id}>
      {hasHeader ? (
        <header className="prl-panel__header">
          <div className="prl-panel__heading">
            {index === undefined ? null : (
              <span className="prl-panel__index prl-index" aria-hidden="true">
                {indexText(index)}
              </span>
            )}
            {eyebrow === undefined ? null : <span className="prl-panel__eyebrow prl-label">{eyebrow}</span>}
            {title === undefined ? null : <Heading className="prl-panel__title">{title}</Heading>}
          </div>
          {actions === undefined ? null : <div className="prl-panel__actions">{actions}</div>}
        </header>
      ) : null}
      <div className="prl-panel__body">{children}</div>
    </Tag>
  );
}

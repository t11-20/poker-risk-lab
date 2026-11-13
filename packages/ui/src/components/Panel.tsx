/**
 * A hairlined surface with an optional header. Depth is a surface step and a hairline, never a shadow
 * (§4.1). The header is one slot so the `01` index is always in the same position (§9).
 * No accessible name on the `<section>`, so it does not become a `region` landmark; pages own landmarks.
 * `headingLevel` defaults to 2 and can never be 1. The index is `aria-hidden`.
 */

import type { ReactElement, ReactNode } from 'react';
import { cx } from '../cx.ts';
import { formatIndex } from '../format.ts';
import type { HeadingLevel } from './AssumptionList.tsx';

export type PanelTone = 'panel' | 'raised' | 'inset';

export interface PanelProps {
  readonly children: ReactNode;
  /** Without it, no heading is emitted. */
  readonly title?: string;
  readonly headingLevel?: HeadingLevel;
  readonly eyebrow?: string;
  /** A number is padded to two digits; a string is used as given. */
  readonly index?: number | string;
  readonly tone?: PanelTone;
  readonly actions?: ReactNode;
  /** `div` where a heading outline is not wanted. */
  readonly as?: 'section' | 'article' | 'div';
  readonly id?: string;
  readonly className?: string;
}

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

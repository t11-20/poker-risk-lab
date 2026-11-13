/**
 * A formula with the sentence that explains it. The explanation is required so a formula cannot be
 * decoration. Expressions are plain text in a `<pre>` that wraps rather than clips on a phone, and
 * plain text leaves no injection surface.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';

export interface FormulaProps {
  readonly expression: string;
  readonly explanation: string;
  /** A label-voice kicker such as "POT ODDS". Not a heading, because a formula is not a section. */
  readonly eyebrow?: string;
  readonly className?: string;
}

export function Formula(props: FormulaProps): ReactElement {
  const { expression, explanation, eyebrow, className } = props;
  return (
    <figure className={cx('prl-formula', className)}>
      {eyebrow === undefined ? null : <span className="prl-formula__eyebrow prl-label">{eyebrow}</span>}
      <pre className="prl-formula__expression">
        <code>{expression}</code>
      </pre>
      <figcaption className="prl-formula__explanation">{explanation}</figcaption>
    </figure>
  );
}

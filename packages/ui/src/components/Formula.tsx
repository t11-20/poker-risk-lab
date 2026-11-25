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

/**
 * One block per written line, so a wrapped line can hang its continuation. Each keeps its newline, so
 * the text a reader copies is the expression unchanged.
 */
export function expressionLines(expression: string): readonly { offset: number; text: string }[] {
  const lines: { offset: number; text: string }[] = [];
  let offset = 0;
  for (const text of expression.split(/(?<=\n)/u)) {
    lines.push({ offset, text });
    offset += text.length;
  }
  return lines;
}

export function Formula(props: FormulaProps): ReactElement {
  const { expression, explanation, eyebrow, className } = props;
  return (
    <figure className={cx('prl-formula', className)}>
      {eyebrow === undefined ? null : <span className="prl-formula__eyebrow prl-label">{eyebrow}</span>}
      <pre className="prl-formula__expression">
        {/* The block is outside `code`, so its line boxes keep the `pre` font's strut and pitch. */}
        {expressionLines(expression).map((line) => (
          <span className="prl-formula__line" key={line.offset}>
            <code>{line.text}</code>
          </span>
        ))}
      </pre>
      <figcaption className="prl-formula__explanation">{explanation}</figcaption>
    </figure>
  );
}

/**
 * A formula with the sentence that explains it.
 *
 * ## Why the explanation is not optional
 *
 * `break-even equity = call / (pot + call)` on its own teaches nobody anything; it
 * teaches a reader who already knows. The prop is required so a formula cannot be
 * dropped into a page as decoration. That is the same principle as
 * `CoachReport.assumptions` never being empty, applied at the component level.
 *
 * ## Markup
 *
 * `<figure>` + `<figcaption>` gives the expression a caption relationship that is in
 * the DOM rather than implied by proximity, and names the figure for screen-reader
 * navigation with no ARIA.
 *
 * The expression is a `<pre><code>`, so its spacing is preserved — alignment is often
 * the only thing distinguishing a numerator from a denominator in plain text. It wraps
 * (`white-space: pre-wrap`) instead of scrolling, because a formula broken across two
 * lines is still readable while one clipped at the edge of a phone is not.
 *
 * Expressions are plain text. No MathML, no LaTeX, no `dangerouslySetInnerHTML` — the
 * content package stores them as strings (`LessonBlock` of kind `formula` carries
 * `expression`), and rendering them as text means there is no injection surface here
 * at all.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';

export interface FormulaProps {
  /** Plain text, e.g. "break-even equity = call / (pot + call)". */
  readonly expression: string;
  /** What the formula means, in words. Required by design — see above. */
  readonly explanation: string;
  /**
   * Optional technical kicker above the expression, e.g. "POT ODDS". Rendered in the label
   * voice (§3.2) so a derivation can be identified at a glance in a dense panel. It is not a
   * heading: a formula is not a section, and this package never invents headings a page did
   * not ask for.
   */
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

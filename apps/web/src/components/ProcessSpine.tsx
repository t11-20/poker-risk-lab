/**
 * `01 LEARN → 02 CALCULATE → 03 DECIDE → 04 REVIEW` — the educational loop as a numbered spine.
 *
 * ## Why the loop is drawn at all
 *
 * The reference this design system was extracted from tells a process story, and the numbered
 * spine is how it tells it (§9.1). Ours is not a manufacturing sequence: it is the claim that
 * playing a hand is one step in a four-step loop, and that the step most products skip is the last
 * one. Drawing it makes the product's argument visible before the reader has clicked anything.
 *
 * It is a *loop*, and the copy says so — step 04 leads back to 01. That matters more than it
 * sounds: a linear four-step graphic implies you are finished at the end, which is precisely the
 * belief the review step exists to correct.
 *
 * ## Why an ordered list, and why the connector is a pseudo-element
 *
 * The steps are ordered and the order is the content, so `<ol>` is the honest element — a screen
 * reader announces "list, 4 items" and the position of each one, which is the same information the
 * numerals carry visually. The `01…04` numerals are therefore `aria-hidden`: the list already says
 * "item 2 of 4" and hearing "zero two" before it is noise.
 *
 * The connecting hairline and the arrows are drawn in CSS on pseudo-elements, so no decorative
 * glyph enters the accessibility tree and there is no icon package to install (§12, and the
 * dependency policy). Under `forced-colors` the hairline is a real border rather than a background
 * strip, so it survives being repainted.
 *
 * ## Two contexts, one component
 *
 * The home page renders it as a section-level graphic. Inside a hand it is a breadcrumb, where one
 * step is current — hence `current`, which sets `aria-current="step"` and a visual mark. Without
 * it, no step is current, which is the right answer on a page where the reader has not started.
 *
 * No state, no effects: a server component, so nothing about it costs the client any JavaScript.
 */

import { formatIndex } from '@prl/ui';
import type { ReactElement } from 'react';

export interface ProcessStep {
  readonly label: string;
  /** One line on what the step actually involves. Never a slogan. */
  readonly detail: string;
}

/**
 * The four steps. Exported because a hand's breadcrumb needs the same names in the same order, and
 * a second copy of a four-item list is a second thing to keep in step.
 */
export const PROCESS_STEPS: readonly ProcessStep[] = [
  { label: 'Learn', detail: 'What the number means, and what it assumes.' },
  { label: 'Calculate', detail: 'Equity, outs, pot odds and break-even — computed, never looked up.' },
  { label: 'Decide', detail: 'Act on the price in front of you, with the cost of every option shown.' },
  { label: 'Review', detail: 'Price the decision after the fact, separately from how it turned out.' },
];

export interface ProcessSpineProps {
  /** The step in progress, matched against `ProcessStep.label`. Absent means none is current. */
  readonly current?: string;
  /** An accessible name, when the spine is used as a breadcrumb rather than as a page graphic. */
  readonly label?: string;
  readonly className?: string;
}

export function ProcessSpine(props: ProcessSpineProps): ReactElement {
  const { current, label, className } = props;

  return (
    <ol
      aria-label={label}
      className={className === undefined ? 'prl-spine' : `prl-spine ${className}`}
      data-marked={current === undefined ? 'false' : 'true'}
    >
      {PROCESS_STEPS.map((step, position) => {
        const isCurrent = current !== undefined && current === step.label;
        return (
          <li
            aria-current={isCurrent ? 'step' : undefined}
            className="prl-spine__step"
            data-current={isCurrent ? 'true' : 'false'}
            key={step.label}
          >
            <span aria-hidden="true" className="prl-spine__index prl-index">
              {formatIndex(position + 1)}
            </span>
            <span className="prl-spine__label prl-label prl-label--strong">{step.label}</span>
            <span className="prl-spine__detail">{step.detail}</span>
          </li>
        );
      })}
    </ol>
  );
}

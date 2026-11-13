/**
 * The learn, calculate, decide, review loop as a numbered spine (§9.1). An `<ol>`, so the numerals
 * are `aria-hidden` because the list already announces position. Connectors are CSS pseudo-elements,
 * so no glyph enters the accessibility tree (§12). `current` makes it a breadcrumb with
 * `aria-current="step"`. Server component.
 */

import { formatIndex } from '@prl/ui';
import type { ReactElement } from 'react';
import { SuitMark } from '@/components/SuitMark.tsx';
import type { NavArea } from '@/lib/nav.ts';

export interface ProcessStep {
  readonly label: string;
  readonly area: NavArea;
  readonly detail: string;
}

export const PROCESS_STEPS: readonly ProcessStep[] = [
  { label: 'Learn', area: 'learn', detail: 'What the number means, and what it assumes.' },
  {
    label: 'Calculate',
    area: 'lab',
    detail: 'Equity, outs, pot odds and break-even — computed, never looked up.',
  },
  {
    label: 'Decide',
    area: 'play',
    detail: 'Act on the price in front of you, with the cost of every option shown.',
  },
  {
    label: 'Review',
    area: 'review',
    detail: 'Price the decision after the fact, separately from how it turned out.',
  },
];

export interface ProcessSpineProps {
  /** Matched against `ProcessStep.label`. */
  readonly current?: string;
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
            <span className="prl-spine__label prl-label prl-label--strong">
              <SuitMark area={step.area} className="prl-spine__mark" />
              {step.label}
            </span>
            <span className="prl-spine__detail">{step.detail}</span>
          </li>
        );
      })}
    </ol>
  );
}

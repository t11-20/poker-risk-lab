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
  { label: 'Learn', area: 'learn', detail: 'Core concepts, with every assumption stated.' },
  {
    label: 'Calculate',
    area: 'lab',
    detail: 'Equity, outs, and break-even computed live.',
  },
  {
    label: 'Decide',
    area: 'play',
    detail: 'Act with every option’s price in view.',
  },
  {
    label: 'Review',
    area: 'review',
    detail: 'Judge each decision apart from the runout.',
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

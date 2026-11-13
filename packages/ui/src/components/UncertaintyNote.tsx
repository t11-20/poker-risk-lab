/**
 * How the numbers were produced and how far they can be trusted. Never collapsed. The interval line
 * is always present, and a sampled figure with no interval is called out as approximate.
 */

import type { UncertaintyNote as UncertaintyNoteData } from '@prl/contracts';
import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatPoints } from '../format.ts';
import { withKeys } from '../keys.ts';
import { isProbabilityFraction, isProbabilityPoints } from '../probability.ts';
import type { HeadingLevel } from './AssumptionList.tsx';
import { Chip, type ChipTone } from './Chip.tsx';

export interface UncertaintyNoteProps {
  readonly note: UncertaintyNoteData;
  readonly title?: string;
  readonly headingLevel?: HeadingLevel;
  readonly className?: string;
}

/** The glyphs carry the method in shape alone, `=` for exact and `≈` for sampled (§6.2). */
const METHOD_CHIP: Readonly<
  Record<
    UncertaintyNoteData['method'],
    { readonly label: string; readonly tone: ChipTone; readonly glyph: string }
  >
> = {
  'exact-enumeration': { label: 'exact enumeration', tone: 'accent', glyph: '=' },
  'monte-carlo': { label: 'Monte Carlo sampling', tone: 'info', glyph: '≈' },
};

/**
 * Both figures are range-checked again here (`../probability.ts`), because a `level` of 1.6 renders as
 * a 160% confidence interval. A refused interval never falls back to the no-sampling-error sentence,
 * which would be a stronger claim.
 */
function intervalSentence(note: UncertaintyNoteData): string {
  const interval = note.confidenceInterval;
  if (interval !== null) {
    const levelIsReal = isProbabilityFraction(interval.level);
    const spreadIsReal = isProbabilityPoints(interval.halfWidthPoints);
    if (levelIsReal && spreadIsReal) {
      const level = Math.round(interval.level * 100);
      return `${level}% confidence interval: ± ${formatPoints(Math.abs(interval.halfWidthPoints))}.`;
    }
    return (
      'An interval was reported with this figure, but its confidence level or its width is not a ' +
      'possible one, so it is not being shown. Treat the figure as approximate rather than precise.'
    );
  }
  if (note.method === 'exact-enumeration') {
    return 'Every remaining board was enumerated, so there is no sampling error in this figure.';
  }
  return 'This figure was sampled but no interval was reported with it, so treat it as approximate rather than precise.';
}

export function UncertaintyNote(props: UncertaintyNoteProps): ReactElement {
  const { note, title = 'How certain is this?', headingLevel = 3, className } = props;
  const Heading = `h${headingLevel}` as const;
  const limitations = withKeys(note.limitations, 'limitation');
  const method = METHOD_CHIP[note.method];

  return (
    <section className={cx('prl-uncertainty', className)}>
      <Heading className="prl-uncertainty__title">
        {title}
        <Chip className="prl-uncertainty__method" tone={method.tone} glyph={method.glyph}>
          {method.label}
        </Chip>
      </Heading>
      <p className="prl-uncertainty__summary">{note.summary}</p>
      <p className="prl-uncertainty__interval">{intervalSentence(note)}</p>
      {limitations.length === 0 ? (
        <p className="prl-uncertainty__summary">
          No limitations were reported with this analysis. Every model has them, so read this as a gap in the
          report rather than as a guarantee.
        </p>
      ) : (
        <>
          <p className="prl-uncertainty__summary">What this analysis does not account for:</p>
          <ul className="prl-uncertainty__limitations">
            {limitations.map((entry) => (
              <li key={entry.key}>{entry.value}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

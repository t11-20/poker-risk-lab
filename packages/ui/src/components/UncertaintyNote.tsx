/**
 * How the numbers were produced and how far they can be trusted.
 *
 * Renders `UncertaintyNote` from `@prl/contracts`: the method, a plain-language
 * summary, the confidence interval, and the named limitations.
 *
 * ## Rules this component enforces, not just displays
 *
 *  - **Never collapsed.** Like `AssumptionList`, there is no toggle. An error bar
 *    behind a disclosure control is an error bar nobody reads.
 *  - **The interval line is always present.** For `monte-carlo` it shows the interval;
 *    for `exact-enumeration` it says there is no sampling error, which is a different
 *    statement from "no interval was reported" and must not be conflated with it.
 *  - **A sampled figure with a missing interval is called out as such.** `null`
 *    `confidenceInterval` on a Monte Carlo result is a gap in the data, and the reader
 *    is told to treat the figure as approximate rather than being shown a bare number.
 *
 * The imported contract type is aliased to `UncertaintyNoteData` because the component
 * and the type would otherwise share a name — the type is the payload, this is the
 * thing that draws it.
 *
 * Server-render safe: no state, no effects.
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

/**
 * The method, as a chip.
 *
 * §6.2 asks for the method beside every figure, and the glyphs are chosen to carry the actual
 * distinction in shape alone: `=` for a figure that is exactly this, `≈` for one that is
 * approximately this. A reader who cannot tell the accent chip from the info chip can still
 * tell an enumeration from a sample.
 */
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
 * The interval sentence. Written as a function so the cases are visibly exhaustive rather
 * than buried in nested ternaries inside JSX.
 *
 * ## Why the figures are range-checked here too
 *
 * Both halves of an interval have a range they cannot leave, and each is checked against its
 * own: `level` is a probability (0..1, rendered as a percentage), `halfWidthPoints` is
 * already in percentage points (±100 at the very widest, since that is the entire span the
 * figure lives on). A `level` of 1.6 renders as "160% confidence interval" — an impossible
 * claim about certainty, sitting directly under the equity it is supposed to qualify, which
 * is the worst possible place for one. See `../probability.ts`: the producer refuses these at
 * source, and this refuses them again at the point they would be read.
 *
 * A refused interval does not fall back to the exact-enumeration sentence. "There is no
 * sampling error" would be a *stronger* claim than the one being withdrawn.
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

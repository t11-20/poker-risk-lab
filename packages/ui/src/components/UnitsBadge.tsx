'use client';

/**
 * A play-units balance, with the explanation of what units are attached to it.
 *
 * ## What this component is for
 *
 * The product guardrails are unambiguous: units are free, resettable and valueless,
 * there is no purchase, no cash-out, no transfer. This badge is where that promise is
 * made in the interface. The word "units" is always rendered next to the number — never
 * a bare figure, never a currency symbol, never the word "chips" or "balance", which
 * are the words that make play money feel like money.
 *
 * ## Why a disclosure button and not a `title` tooltip
 *
 * A `title` attribute is unreachable by keyboard, invisible on touch, and unstyleable.
 * Essential information may not live there, so this uses the standard disclosure
 * pattern instead:
 *
 *  - The explanation is a real element with a stable id.
 *  - The toggle is a real `<button>`, so it is tab-reachable and Enter/Space operable
 *    for free, with `aria-expanded` and `aria-controls` describing its effect.
 *  - The button also carries `aria-describedby` pointing at the explanation, so a
 *    screen reader hears the full text on arrival *whether or not* it is expanded —
 *    referencing a hidden element from `aria-describedby` is supported and is exactly
 *    the case it exists for. Sighted users expand it; non-visual users already have it.
 *
 * The button is 28px square with a 24px floor from `--prl-target-min`, meeting WCAG 2.2
 * Target Size (Minimum).
 *
 * ## Why this is a client component
 *
 * `useId` and `useState`. The id must be identical on the server and in the browser or
 * hydration warns, which is precisely what `useId` guarantees and what a module-level
 * counter would get wrong under concurrent rendering.
 */

import { type ReactElement, useId, useState } from 'react';
import { cx } from '../cx.ts';
import { formatChips } from '../format.ts';

/**
 * The wording of the promise. Exported so a page can restate it in its footer or its
 * terms without the two copies drifting apart.
 */
export const UNITS_EXPLANATION =
  'Units are free practice chips. They have no monetary value, they cannot be bought, sold, ' +
  'transferred or cashed out, and you can reset them to the starting amount at any time.';

export interface UnitsBadgeProps {
  readonly units: number;
  /** Prefix, e.g. "Your balance". Rendered as visually hidden context for the figure. */
  readonly label?: string;
  readonly className?: string;
}

export function UnitsBadge(props: UnitsBadgeProps): ReactElement {
  const { units, label = 'Practice units', className } = props;
  const noteId = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <span className={cx('prl-units', className)}>
      <span className="prl-units__value">
        <span className="prl-visually-hidden">{`${label}: `}</span>
        {/* Its own element so the stylesheet can give it tabular figures: this number changes
            hand by hand, and proportional digits would make the header twitch (§3.3). */}
        <span className="prl-units__figure">{formatChips(units)}</span>
        {/* Never abbreviated, never dropped: the word is the guardrail. */}
        <span className="prl-units__word prl-label">units</span>
      </span>
      <button
        type="button"
        className="prl-units__toggle"
        aria-expanded={expanded}
        aria-controls={noteId}
        aria-describedby={noteId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span aria-hidden="true">i</span>
        <span className="prl-visually-hidden">What “units” means</span>
      </button>
      <span className="prl-units__note" id={noteId} hidden={!expanded}>
        {UNITS_EXPLANATION}
      </span>
    </span>
  );
}

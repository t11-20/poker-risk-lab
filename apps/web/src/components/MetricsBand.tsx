'use client';

/**
 * The four project figures, counting up when the band is scrolled to.
 *
 * ## Every number here is a real, checkable fact
 *
 * | Figure | Where it comes from | How you check it |
 * | --- | --- | --- |
 * | 133,784,560 | `packages/poker-engine/test/exhaustive/seven-card-distribution.test.ts` | `pnpm run test:exhaustive` |
 * | 36 | `packages/content/data/scenarios/` | `pnpm --filter @prl/content test` |
 * | 12 | `PROFILES` in `packages/poker-ai/src/profiles.ts` | `docs/AI-LEGENDS.md` §"The twelve profiles" |
 * | 0 | there is no odds table in the repository | `docs/THREAT-MODEL.md` |
 *
 * There is no fifth figure about users, downloads or hands played by other people, because that is
 * social proof rather than evidence and the design system rules it out.
 *
 * The "0 hard-coded odds" tile is the interesting one: it is a claim about an *absence*, and it
 * counts from zero to zero, which is to say it does not animate at all. That is correct and it is
 * left as it is — a zero that flickered upwards to prove it was alive would be theatre.
 *
 * ## Why counting up needs a client component, and why the value is not simply faked
 *
 * `useCountUp` in `@prl/ui` seeds its state with the value at first render, deliberately: that is
 * what makes a metric server-renderable and what stops a page whose whole subject is a number
 * flashing `0%` on arrival. The consequence is that a figure only counts when it *changes* after
 * mount — so a band that is meant to count up on reveal has to change its value on reveal.
 *
 * Three states, in order, and the middle one is the reason this is not a one-liner:
 *
 *  1. **Server render, and any browser with JavaScript off.** `mounted` is false, so the real
 *     figure is rendered. This is the state that matters most for correctness: without the
 *     `mounted` gate, the server's HTML would say `0` seven-card hands verified, and a reader
 *     without JavaScript would be shown a false claim about the product's own verification. A
 *     wrong number is a far worse defect than a missing animation.
 *  2. **Mounted, not yet revealed.** The figure drops to zero, which is only ever true while the
 *     band is `opacity: 0` and cannot be read.
 *  3. **Revealed.** The figure returns to its real value and `useCountUp` interpolates towards it.
 *
 * Under reduced motion `useReveal` resolves to revealed on mount, so state 2 never happens and the
 * real figure is there from the first client render — no fake value ever enters the DOM for a
 * reader who asked for no motion.
 *
 * ## The one wrinkle worth knowing about
 *
 * `Metric`'s count-up puts the true value in a visually-hidden `aria-live="polite"` node and hides
 * the animated copy from assistive tech, which is what stops a screen reader reading eleven wrong
 * numbers (§5.2). Because the value passed in is briefly zero during state 2, that live node is
 * briefly zero too. Live regions are not announced for content present when they are inserted, so
 * in practice a screen-reader user hears the figure once, correctly, when the band reveals. The
 * clean fix is a `countFrom` option on `Metric` so the interpolation's starting point never has to
 * masquerade as the value — `@prl/ui`'s to make, noted rather than worked around here.
 */

import { Metric, useReveal } from '@prl/ui';
import { type ReactElement, useEffect, useState } from 'react';

interface ProjectFigure {
  readonly label: string;
  readonly value: number;
  /** Where the figure comes from. A number without its provenance is a marketing claim. */
  readonly note: string;
}

const FIGURES: readonly ProjectFigure[] = [
  {
    label: 'Seven-card hands verified',
    value: 133_784_560,
    note: 'Every hand in the deck, classified and matched against the published category frequencies.',
  },
  {
    label: 'Teaching scenarios',
    value: 36,
    note: 'Each carrying a claim the maths re-checks on every build, so a scenario cannot go stale quietly.',
  },
  {
    label: 'Opponent profiles',
    value: 12,
    note: 'Strategy simulations, each a vector across sixteen behavioural axes. Styles, not people.',
  },
  {
    label: 'Hard-coded odds',
    value: 0,
    note: 'There is no odds table in this product. Every figure is computed from the deck on request.',
  },
];

export function MetricsBand(): ReactElement {
  const { ref, revealed } = useReveal<HTMLDivElement>();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="prl-reveal prl-metrics" data-revealed={revealed ? 'true' : 'false'} ref={ref}>
      {FIGURES.map((figure) => (
        <Metric
          countUp={mounted}
          key={figure.label}
          label={figure.label}
          note={figure.note}
          size="lg"
          unit={null}
          value={mounted && !revealed ? 0 : figure.value}
        />
      ))}
    </div>
  );
}

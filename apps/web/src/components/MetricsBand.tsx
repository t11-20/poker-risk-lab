'use client';

/**
 * The four project figures, counting up when the band is revealed. Each is checkable. The hand count
 * is `pnpm run test:exhaustive`, the scenarios are `packages/content`, the profiles are `PROFILES`.
 * The zero claims only that no figure is produced by a lookup, since the bundled fallback stores some.
 * `useCountUp` seeds with the first value, so the figure must change after mount to count. The server
 * and no-script render show the real figure. It drops to zero only while the band is hidden, and
 * under reduced motion never.
 */

import { Metric, useReveal } from '@prl/ui';
import { type ReactElement, useEffect, useState } from 'react';

interface ProjectFigure {
  readonly label: string;
  readonly value: number;
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
    label: 'Figures read from an odds table',
    value: 0,
    note: 'Every figure is computed from the deck on request. Where the calculator cannot be reached a bundled example is shown instead, and the page says so.',
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

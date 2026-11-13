/**
 * The worked example, at a URL that says demo. Nothing routes here on failure. The hand is 1.06 big
 * blinds behind (`slightly-off`), so the result-versus-reasoning callout does not appear.
 * `HAND_COMPARISON_BIG_BLIND` is passed only here, because only this hand's blind level is known.
 */

import { Callout } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { PostHandComparison } from '@/components/PostHandComparison.tsx';
import { HAND_COMPARISON_BIG_BLIND } from '@/fixtures/legends.ts';
import { demoHandComparison } from '@/lib/legends-data.ts';
import { HandReviewHeader } from '../page.tsx';

export const metadata: Metadata = {
  title: 'A finished hand, reviewed — worked example',
  description:
    'A bundled sample hand, reviewed decision by decision. Not one of yours: this is the worked ' +
    'example, at a demo address.',
};

const REVIEW_PATH = '/review';

export default function HandReviewDemoPage(): ReactElement {
  return (
    <div className="prl-legend-page">
      <HandReviewHeader />
      <Callout tone="warning" title="This is a bundled sample hand, not one of yours">
        <p>
          Nobody at this deployment played it. It is a real worked example, shipped with the app so that the
          analysis can be read before you have a hand of your own to put through it.
        </p>
        <p>
          To review one of yours, open it from <Link href={REVIEW_PATH}>your hand history</Link>.
        </p>
      </Callout>
      <PostHandComparison bigBlind={HAND_COMPARISON_BIG_BLIND} comparison={demoHandComparison()} />
    </div>
  );
}

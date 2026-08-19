/**
 * `/legends/hand-review/demo` — the worked example, at a URL that says so.
 *
 * ## Why the sample gets its own route
 *
 * It used to be what `/legends/hand-review` served to everybody, for every hand id, with a banner
 * explaining that it was a sample. The banner was honest and the arrangement was still wrong: a
 * reader who followed a link to *their* hand and landed on somebody else's had nothing to tell
 * them apart except a callout they had every reason to skim past.
 *
 * Demo data is worth keeping. A learner who has not played a hand yet should still be able to read
 * what this analysis looks like, and a reviewer should be able to see the component rendered in CI
 * without a database. The rule is that it must be *asked for*: the word `demo` is in the address,
 * it is in the heading, it is in the page title, and nothing routes here on failure. See the header
 * of `../page.tsx` for the route that no longer falls back.
 *
 * ## What this hand is
 *
 * A whole stack lost. Its line — raise, bet, call — is the line the analysis prices best at all
 * three scored decisions; what it gave up is entirely bet sizing, twice choosing a smaller size
 * than the table prices highest. Recomputed from `@prl/poker-math`, the hand is 1.06 big blinds
 * behind, which `@prl/poker-ai` bands as `slightly-off` — so `outcomeVersusQualityNote` is null and
 * the "the result and the reasoning point in opposite directions" callout does not appear. That
 * note is reserved for a hand that was right and lost, so it does not become wallpaper.
 *
 * `HAND_COMPARISON_BIG_BLIND` is passed here and only here: the bundled hand is the one whose
 * blind level this client knows independently, which is what lets the component state the scale
 * the quality bands are measured in.
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

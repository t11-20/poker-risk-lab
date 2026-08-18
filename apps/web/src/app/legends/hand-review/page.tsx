/**
 * `/legends/hand-review` — a finished hand, reviewed decision by decision.
 *
 * ## Why this route exists
 *
 * `PostHandComparison` renders a `HandComparison`, and its real home is the moment a hand ends,
 * which belongs to the play and review screens another team owns. Until that flow exists this route
 * is where the component can be built, reviewed, rendered in CI and read by a learner — and it is
 * worth keeping afterwards, because a worked example nobody has to lose a hand to see is the
 * cheapest way to teach the one idea this feature is built around:
 *
 *   **The result of a hand is not evidence about the reasoning behind it.**
 *
 * The sample hand lost a whole stack. Its line — raise, bet, call — is the line the analysis prices
 * best at all three scored decisions; what it gave up, 21.2 units across the hand, is entirely bet
 * sizing, twice choosing a smaller size than the table prices highest.
 *
 * That is a weaker claim than this comment used to make, and it is the true one. It said "every
 * scored decision landed within 0.4 units of the best expected value the report priced", which came
 * from EV literals in the fixture that did not reproduce: recomputed from `@prl/poker-math`, the
 * hand is 1.06 big blinds behind, which `@prl/poker-ai` bands as `slightly-off`. The consequence is
 * visible on this page — `outcomeVersusQualityNote` is null for that band by design, so the "the
 * result and the reasoning point in opposite directions" callout does not appear. That note is
 * reserved for a hand that was right and lost, so that it does not become wallpaper, and this hand
 * no longer qualifies. Correcting the arithmetic and leaving the claim would have been the worse
 * of the two options available.
 *
 * ## `?hand=` is accepted so this route survives becoming real
 *
 * The hand id comes from the query string with the sample as its default, so the day the API can
 * serve a learner's own hand, linking to it here needs no new route and no new component.
 */

import { Callout } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { PostHandComparison } from '@/components/PostHandComparison.tsx';
import { HAND_COMPARISON_BIG_BLIND } from '@/fixtures/legends.ts';
import {
  LEGENDS_COMPARE_PATH,
  LEGENDS_PATH,
  loadHandComparison,
  SAMPLE_HAND_ID,
  type SearchParams,
} from '@/lib/legends-data.ts';

export const metadata: Metadata = {
  title: 'A finished hand, reviewed',
  description:
    'One completed hand against a modelled style, with the maths at every decision, the actions that ' +
    'were not taken, and the chip result kept strictly separate from the decision quality.',
};

function readHandId(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.trim() === '' ? SAMPLE_HAND_ID : value.trim();
}

export default async function HandReviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const query = await searchParams;
  const handId = readHandId(query['hand']);
  // Not awaited: there is no request behind it. The API serves no per-hand comparison route yet, so
  // this returns the bundled worked example with a notice saying so. See `loadHandComparison`.
  const review = loadHandComparison(handId);

  return (
    <div className="prl-legend-page">
      <div className="prl-legend-head">
        <span aria-hidden="true" className="prl-index">
          04
        </span>
        <h1 className="prl-legend-head__title prl-display-2">A finished hand, reviewed</h1>
        <p className="prl-legend-head__standfirst">
          Every decision in one hand, in order: what was done, what the analysis priced at the time, what the
          other actions were worth, and — for the model's decisions — the weights it sampled its action from.
          The chip result and the decision quality are reported separately, and neither is used to explain the
          other.
        </p>
        <nav aria-label="Legends navigation" className="prl-legend-nav">
          <Link href={LEGENDS_PATH}>All profiles</Link>
          <Link href={LEGENDS_COMPARE_PATH}>Compare styles on one spot</Link>
        </nav>
      </div>

      {review.fallbackReason === null ? null : (
        <Callout tone="warning" title="This is a bundled sample hand">
          <p>{review.fallbackReason}</p>
        </Callout>
      )}

      {/*
        The blind level is passed only for the bundled hand, where it is known. `HandComparison` does
        not carry one, so claiming a scale for a hand that came from the API would be inventing the
        number the quality bands are measured in — the component omits the sentence instead.
      */}
      <PostHandComparison
        comparison={review.data}
        {...(review.source === 'fixture' ? { bigBlind: HAND_COMPARISON_BIG_BLIND } : {})}
      />
    </div>
  );
}

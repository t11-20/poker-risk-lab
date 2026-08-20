/**
 * `/legends/hand-review` — one of the reader's OWN finished hands, reviewed decision by decision.
 *
 * ## What this route used to be, and why that was a defect
 *
 * It rendered `HAND_COMPARISON_FIXTURE` for every hand id anybody asked for. `loadHandComparison`
 * ignored its argument — the parameter was underscored — and the page's own header explained that
 * the API had never registered a per-hand comparison route, which was true: `buildHandComparison`
 * sat in `@prl/poker-ai`, complete and tested, with nothing in front of it.
 *
 * A banner said "this is a bundled sample hand", so nobody was lied to. But the one screen whose
 * entire purpose is *how did YOU play this hand* showed the same worked example to every reader,
 * and the honesty of the banner is not a substitute for the feature.
 *
 * `GET /legends/hands/:handId/comparison` now exists, scoped to a seat the caller actually held.
 * This page requests it, and every way that can fail gets its own sentence:
 *
 *   - no `?hand=` at all → an empty state that explains what this page needs and links to the
 *     reader's hand history and to the demo;
 *   - a hand that does not exist, or is not theirs → the app's 404 body, which is the same answer
 *     for both, because a distinguishable "it exists but is not yours" confirms a hand id;
 *   - a hand that exists and cannot be compared (still in progress, no modelled seat in it, or a
 *     record the server cannot replay) → the specific reason, from the API;
 *   - no session on this render, or the API unreachable → said plainly.
 *
 * **None of them falls back to the sample.** That is the rule this file exists to hold. The worked
 * example is still worth reading and still shipped — at `/legends/hand-review/demo`, a URL that
 * says demo — and the only way to reach it is to ask for it by name.
 */

import { Callout } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { NotFoundBody } from '@/app/not-found.tsx';
import { PostHandComparison } from '@/components/PostHandComparison.tsx';
import {
  type HandComparisonProblem,
  LEGENDS_COMPARE_PATH,
  LEGENDS_PATH,
  loadHandComparison,
  type SearchParams,
} from '@/lib/legends-data.ts';
import { readerCallOptions } from '@/lib/server-session.ts';

export const metadata: Metadata = {
  title: 'A finished hand, reviewed',
  description:
    'One of your completed hands against a modelled style, with the maths at every decision, the ' +
    'actions that were not taken, and the chip result kept strictly separate from the decision quality.',
};

/** The reader's own hand history, which is where a hand id on this page comes from. */
const REVIEW_PATH = '/review';
/** The worked example. Says demo in the URL, because that is the only honest way to ship one. */
export const HAND_REVIEW_DEMO_PATH = '/legends/hand-review/demo';

function readHandId(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function HandReviewHeader(): ReactElement {
  return (
    <div className="prl-legend-head">
      <span aria-hidden="true" className="prl-index">
        04
      </span>
      <h1 className="prl-legend-head__title prl-display-2">A finished hand, reviewed</h1>
      <p className="prl-legend-head__standfirst">
        Every decision in one hand, in order: what was done, what the analysis priced at the time, and what
        the other actions were worth. Stored hands record the action taken, not the distribution a model
        sampled from, so live reviews do not invent those weights. The chip result and the decision quality
        are reported separately, and neither is used to explain the other.
      </p>
      <nav aria-label="Legends navigation" className="prl-legend-nav">
        <Link href={LEGENDS_PATH}>All profiles</Link>
        <Link href={LEGENDS_COMPARE_PATH}>Compare styles on one spot</Link>
        <Link href={REVIEW_PATH}>Your hand history</Link>
      </nav>
    </div>
  );
}

/** The empty state: no hand was named, so there is nothing to be wrong about yet. */
function NoHandChosen(): ReactElement {
  return (
    <div className="prl-legend-page">
      <HandReviewHeader />
      <Callout tone="insight" title="Choose a hand to review">
        <p>
          This page reviews one of your own finished hands, so it needs to know which. Open a hand from{' '}
          <Link href={REVIEW_PATH}>your hand history</Link> and it will arrive here with the hand id in the
          address.
        </p>
        <p>
          Hands played against an AI Legends profile are the ones this page has most to say about, because it
          can name the style you were up against at every decision.
        </p>
        <p>
          If you have not played one yet, there is a <Link href={HAND_REVIEW_DEMO_PATH}>worked example</Link>{' '}
          — somebody else's hand, clearly labelled as such.
        </p>
      </Callout>
    </div>
  );
}

/**
 * A hand that is the reader's and cannot be shown, with the reason.
 *
 * Deliberately not a 404 and deliberately not the sample: the hand is real, the reader can see it
 * in their history, and telling them it does not exist would be a worse answer than the true one.
 */
function CannotCompare({
  problem,
  handId,
}: {
  readonly problem: HandComparisonProblem;
  readonly handId: string;
}): ReactElement {
  const [title, body] = messageFor(problem);
  return (
    <div className="prl-legend-page">
      <HandReviewHeader />
      <Callout tone="warning" title={title}>
        <p>{body}</p>
        <p>
          <Link href={REVIEW_PATH}>Back to your hand history</Link>
          {' · '}
          <span className="prl-mono">{handId}</span>
        </p>
      </Callout>
    </div>
  );
}

function messageFor(problem: HandComparisonProblem): readonly [string, string] {
  switch (problem.kind) {
    case 'signed-out':
      return [
        'This page could not read your session',
        'A hand review is private to the person who played it, and this render arrived without a session ' +
          'to identify you. Open the page again from your hand history; if it keeps happening, your session ' +
          'has expired and playing or reading anything will start a new one.',
      ];
    case 'not-comparable':
      return ['This hand cannot be compared', problem.reason];
    case 'unavailable':
      return [
        'The analysis service could not be reached',
        'Nothing is shown rather than something approximate, because every figure on this page comes from ' +
          `that analysis. The server said: ${problem.detail}`,
      ];
    // `not-found` never reaches here — the caller renders the 404 body for it.
    case 'not-found':
      return ['That hand could not be found', 'There is no hand at this address that you played.'];
  }
}

export default async function HandReviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const query = await searchParams;
  const handId = readHandId(query['hand']);
  if (handId === null) return <NoHandChosen />;

  // The session travels with the request: this route is scoped to a seat the caller held, and a
  // server render has no cookie jar of its own. See `src/lib/server-session.ts`.
  const result = await loadHandComparison(handId, await readerCallOptions());

  // One answer for "no such hand" and "not yours", matching the API. `NotFoundBody` rather than
  // `notFound()`, which Next 16 renders as an empty document from inside a page.
  if (!result.ok && result.problem.kind === 'not-found') return <NotFoundBody />;
  if (!result.ok) return <CannotCompare handId={handId} problem={result.problem} />;

  return (
    <div className="prl-legend-page">
      <HandReviewHeader />
      {/*
        No `bigBlind` prop. The blind level is not part of `HandComparison`, and the bundled sample
        is the only hand whose scale this client knows independently — claiming one for a hand that
        came from the API would be inventing the unit the quality bands are measured in. The
        component omits that sentence instead.
      */}
      <PostHandComparison comparison={result.comparison} />
    </div>
  );
}

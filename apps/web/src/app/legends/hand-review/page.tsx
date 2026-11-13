/**
 * `/legends/hand-review`, one of the reader's own finished hands. Each failure gets its own sentence,
 * and none falls back to the sample, which lives only at `/legends/hand-review/demo`. "No such hand"
 * and "not yours" share the 404 body, because telling them apart would confirm a hand id.
 */

import { Callout } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { NotFoundBody } from '@/app/not-found.tsx';
import { PostHandComparison } from '@/components/PostHandComparison.tsx';
import { SuitMark } from '@/components/SuitMark.tsx';
import {
  type HandComparisonProblem,
  LEGENDS_COMPARE_PATH,
  LEGENDS_PATH,
  loadHandComparison,
  profileHref,
  type SearchParams,
} from '@/lib/legends-data.ts';
import { readerCallOptions } from '@/lib/server-session.ts';

export const metadata: Metadata = {
  title: 'A finished hand, reviewed',
  description:
    'One of your completed hands against a modelled style, with the maths at every decision, the ' +
    'actions that were not taken, and the chip result kept strictly separate from the decision quality.',
};

const REVIEW_PATH = '/review';
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
      <SuitMark area="legends" />
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

/** Not a 404 and not the sample, because the hand is real. */
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

  const result = await loadHandComparison(handId, await readerCallOptions());

  // Not `notFound()`, which Next 16 renders as an empty document from inside a page.
  if (!result.ok && result.problem.kind === 'not-found') return <NotFoundBody />;
  if (!result.ok) return <CannotCompare handId={handId} problem={result.problem} />;

  return (
    <div className="prl-legend-page">
      <HandReviewHeader />
      {/* No `bigBlind` prop, because `HandComparison` carries no blind level to state. */}
      <PostHandComparison comparison={result.comparison} />
      {/* `profileId` is the server's record of the style in the seat, so this invents nothing. */}
      <nav aria-label="After this hand" className="prl-legend-nav">
        <Link href={profileHref(result.comparison.profileId)}>
          {`${result.comparison.disclosure.archetypeName}, in full`}
        </Link>
        <Link href={LEGENDS_PATH}>Choose another opponent</Link>
      </nav>
    </div>
  );
}

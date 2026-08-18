/**
 * One hand, replayed.
 *
 * The page loads the review, reconstructs the table state at every decision, and hands both to
 * `HandReplay`. The reconstruction runs here rather than in the client component on purpose — see
 * the header of `src/lib/hand-replay.ts` — so that the only engine code reaching the browser is the
 * one function `CommitmentVerifier` genuinely needs.
 *
 * ## What the header states before the replay starts
 *
 * The net result, with its sign and the word beside it; whether the hand ended by folding; and,
 * where the reconstruction had to derive something the review payload does not carry, that it did.
 * A reader looking at a stack figure is entitled to know it was rebuilt from an action log rather
 * than read off the wire.
 */

import type { HandReviewResponse } from '@prl/contracts';
import { Chip, formatSignedUnits, formatUnits } from '@prl/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { HandReplay } from '../../../components/HandReplay.tsx';
import { handReviewFixture } from '../../../fixtures/review.ts';
import { API_PATHS, apiGet, isApiUnavailable, isMissingResource, isSignedOut } from '../../../lib/api.ts';
import { buildHandReplay } from '../../../lib/hand-replay.ts';
import { formatTimestamp } from '../../../lib/lab-labels.ts';
import { readerCallOptions } from '../../../lib/server-session.ts';
import '../../../styles/page.css';
import '../../../styles/review.css';

interface RouteParams {
  readonly handId: string;
}

interface ReviewData {
  readonly review: HandReviewResponse;
  readonly fromFixture: boolean;
}

async function loadReview(handId: string): Promise<ReviewData | null> {
  try {
    // The reader's own session cookie, forwarded from the incoming request — a server-side `fetch`
    // has no cookie jar, so without this the API could only ever answer `not_authenticated` and a
    // signed-in reader could never see their own hand. See `src/lib/server-session.ts`.
    const review = await apiGet<HandReviewResponse>(API_PATHS.hand(handId), await readerCallOptions());
    return { review, fromFixture: false };
  } catch (error) {
    // `handId` came from the URL, so 404 is the API answering "you have no such hand", and `null` is
    // the page's own not-found screen. `not_authenticated` is not an outage either — it now means
    // this reader is not signed in, which is a real state rather than a property of the renderer.
    if (isMissingResource(error)) return null;
    if (!isSignedOut(error) && !isApiUnavailable(error)) throw error;
    const fixture = handReviewFixture(handId);
    return fixture === null ? null : { review: fixture, fromFixture: true };
  }
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { handId } = await params;
  const fixture = handReviewFixture(handId);
  if (fixture === null) return { title: 'Hand replay' };
  return {
    title: `Hand ${fixture.hand.handNumber}`,
    description: `Replay of hand ${fixture.hand.handNumber}, decision by decision, with the analysis for your own choices.`,
  };
}

export default async function HandReviewPage({
  params,
}: {
  readonly params: Promise<RouteParams>;
}): Promise<ReactElement> {
  const { handId } = await params;
  const data = await loadReview(handId);
  if (data === null) notFound();

  const { review } = data;
  const replay = buildHandReplay(review);
  const net = review.hand.heroNet;

  return (
    // See `/review`'s own page: the route class is what lets `review.css` own this opener's layout
    // without reaching into `page.css`, which the Lab screens share.
    <div className="prl-container prl-review-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <a className="prl-crumb" href="/review">
            Hand history
          </a>
          {' · '}
          {formatTimestamp(review.hand.startedAt)}
        </p>
        <h1 className="prl-display-2 prl-page-head__title">{`Hand ${review.hand.handNumber}`}</h1>
        <ul className="prl-review-summary">
          <li>
            <span className="prl-label">Pot</span>
            <span className="prl-review-summary__value">{formatUnits(review.hand.potTotal)}</span>
          </li>
          <li>
            <span className="prl-label">Net to you</span>
            <span
              className="prl-review-summary__value prl-review-net"
              data-sign={net === null ? 'unknown' : net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral'}
            >
              {net === null ? 'not settled' : formatSignedUnits(net)}
              {net === null ? null : (
                <span className="prl-review-net__word">
                  {net > 0 ? 'gained' : net < 0 ? 'lost' : 'level'}
                </span>
              )}
            </span>
          </li>
          <li>
            <span className="prl-label">Ending</span>
            <Chip
              tone={review.hand.endedByFold ? 'neutral' : 'info'}
              glyph={review.hand.endedByFold ? '⤶' : '⇄'}
            >
              {review.hand.endedByFold ? 'folded out' : 'showdown'}
            </Chip>
          </li>
          <li>
            <span className="prl-label">Decisions</span>
            <span className="prl-review-summary__value">{String(review.decisions.length)}</span>
          </li>
        </ul>
      </header>

      {data.fromFixture ? (
        <p className="prl-source-note prl-note">
          <span className="prl-label prl-label--accent">Fixture data</span> The hands API is not reachable, so
          this replay comes from <code className="prl-mono">src/fixtures/review.ts</code>. That fixture was
          generated by running the real <code className="prl-mono">buildHandReview</code> over hand-shaped
          rows, so the hole-card rule, the per-decision analysis and the Merkle proofs below are the
          endpoint&rsquo;s own output rather than an imitation of it.
        </p>
      ) : null}

      {replay.forcedBetsApproximate ? (
        <p className="prl-source-note prl-note">
          <span className="prl-label">Derived figures</span> This hand had more than one winning seat, so the
          blinds could not be attributed exactly from the review payload — it carries no row for a forced bet.
          The stacks below are within the split of the pot; the pot itself is the server&rsquo;s own figure
          and is exact.
        </p>
      ) : null}

      <HandReplay review={review} replay={replay} />

      <nav className="prl-page-nav" aria-label="Hand history">
        <a href="/review">All hands</a>
        <a href="/lab">Scenario Lab</a>
      </nav>
    </div>
  );
}

/**
 * One hand, replayed. The reconstruction runs here, not in the client, so the only engine code in the
 * browser is what `CommitmentVerifier` needs (`src/lib/hand-replay.ts`). "No such hand" and "could not
 * find out" are different screens, and `missing` comes only from the API's own 404. `unavailable` renders a
 * 200, because a server component can set 401 only through the experimental `unauthorized()`.
 */

import type { HandReviewResponse } from '@prl/contracts';
import { Chip, formatSignedUnits, formatUnits } from '@prl/ui';
import type { Metadata } from 'next';
import { cache, type ReactElement } from 'react';
import { HandReplay } from '../../../components/HandReplay.tsx';
import { handReviewFixture } from '../../../fixtures/review.ts';
import {
  API_PATHS,
  apiGet,
  EXPENSIVE_READ_TIMEOUT_MS,
  isApiUnavailable,
  isMissingResource,
  isSignedOut,
  safeFetch,
} from '../../../lib/api.ts';
import { buildHandReplay } from '../../../lib/hand-replay.ts';
import { formatTimestamp } from '../../../lib/lab-labels.ts';
import { netWord } from '../../../lib/net-words.ts';
import { decisionCount } from '../../../lib/replay-steps.ts';
import { reviewPageMetadata } from '../../../lib/review-titles.ts';
import { readerCallOptions } from '../../../lib/server-session.ts';
import { NotFoundBody } from '../../not-found.tsx';
import '../../../styles/page.css';
import '../../../styles/review.css';

interface RouteParams {
  readonly handId: string;
}

/** Two causes, because each needs its own sentence on screen. */
type ReviewFallbackCause = 'unreachable' | 'signedOut';

type ReviewState =
  | { readonly state: 'live'; readonly review: HandReviewResponse }
  /** The bundled copy carries this hand. Labelled on the page. */
  | {
      readonly state: 'sampled';
      readonly review: HandReviewResponse;
      readonly cause: ReviewFallbackCause;
      readonly detail: string;
    }
  /** The API said 404. The only route to the not-found body. */
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable'; readonly cause: ReviewFallbackCause; readonly detail: string };

async function loadReview(handId: string): Promise<ReviewState> {
  // A server-side `fetch` has no cookie jar, so the reader's cookie is forwarded.
  const reader = await readerCallOptions();
  const result = await safeFetch<HandReviewResponse>(() =>
    // The server builds the review under an eight-second budget, longer than the default deadline.
    apiGet<HandReviewResponse>(API_PATHS.hand(handId), {
      ...reader,
      timeoutMs: EXPENSIVE_READ_TIMEOUT_MS,
    }),
  );
  if (result.ok) return { state: 'live', review: result.data };

  const error = result.error;
  // The API also answers 404 for somebody else's hand. To this reader it does not exist.
  if (isMissingResource(error)) return { state: 'missing' };
  // Anything else is a defect, for the error boundary with its request id.
  if (!isSignedOut(error) && !isApiUnavailable(error)) throw error;

  const cause: ReviewFallbackCause = isSignedOut(error) ? 'signedOut' : 'unreachable';
  const fixture = handReviewFixture(handId);
  if (fixture !== null) return { state: 'sampled', review: fixture, cause, detail: error.message };
  return { state: 'unavailable', cause, detail: error.message };
}

/** One load per request for the title and the page. The build measured about 1.8s to first byte. */
const loadReviewOnce = cache(loadReview);

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { handId } = await params;
  const data = await loadReviewOnce(handId);
  if (data.state === 'live' || data.state === 'sampled') {
    return reviewPageMetadata({ state: data.state, handNumber: data.review.hand.handNumber });
  }
  return reviewPageMetadata(data.state === 'missing' ? data : { state: data.state, cause: data.cause });
}

/**
 * Not the 404 page and not the error boundary. It prints the client's own transport message, which
 * carries no request content, because "aborted due to timeout" tells a reader to retry.
 */
function ReviewUnavailable({
  handId,
  cause,
  detail,
}: {
  readonly handId: string;
  readonly cause: ReviewFallbackCause;
  readonly detail: string;
}): ReactElement {
  return (
    <div className="prl-container prl-review-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <a className="prl-crumb" href="/review">
            Hand history
          </a>
        </p>
        <h1 className="prl-display-2 prl-page-head__title">
          {cause === 'signedOut' ? 'This replay needs a session' : 'This hand could not be loaded'}
        </h1>
        <p className="prl-page-head__standfirst">
          {cause === 'signedOut'
            ? 'A hand replay is one player’s own history, and this browser is not carrying a session — so ' +
              'there was nothing to look this hand up with. That is a fact about this browser, not about ' +
              'the hand: nothing here has established whether it exists.'
            : 'The hands service did not answer, so this replay could not be built. That is not the same ' +
              'as the hand not existing — nothing here has established whether it does. Opening a hand ' +
              'is a read, so asking again changes nothing and is safe.'}
        </p>
      </header>

      <p className="prl-note">
        <span className="prl-label">Hand</span> <code className="prl-mono">{handId}</code>
      </p>
      <p className="prl-note">
        <span className="prl-label">What happened</span> <span className="prl-mono">{detail}</span>
      </p>
      <p className="prl-note">
        {cause === 'signedOut'
          ? 'Opening a table creates a guest session in one request, with no email and no password. Hands ' +
            'you played in a session this browser no longer holds cannot be recovered from here.'
          : 'A replay is rebuilt from the action log on every request — nothing about it is stored — so a ' +
            'hand with several decisions in it is real work for the server, and a slow answer is a slow ' +
            'answer rather than a missing hand.'}
      </p>

      <nav className="prl-page-nav" aria-label="Hand history">
        <a href={`/review/${encodeURIComponent(handId)}`}>Try this hand again</a>
        <a href="/review">All hands</a>
        {cause === 'signedOut' ? <a href="/play">Open a table</a> : <a href="/lab">Scenario Lab</a>}
      </nav>
    </div>
  );
}

export default async function HandReviewPage({
  params,
}: {
  readonly params: Promise<RouteParams>;
}): Promise<ReactElement> {
  const { handId } = await params;
  const data = await loadReviewOnce(handId);
  // Next 16 `notFound()` from a page returns empty HTML, and hand ids cannot be enumerated at build
  // time, so this renders the routing-level 404 body.
  if (data.state === 'missing') return <NotFoundBody />;
  if (data.state === 'unavailable') {
    return <ReviewUnavailable handId={handId} cause={data.cause} detail={data.detail} />;
  }

  const { review } = data;
  const replay = buildHandReplay(review);
  const net = review.hand.heroNet;

  return (
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
              {net === null ? null : <span className="prl-review-net__word">{netWord(net)}</span>}
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
            {/* Counted as the transport counts them (`decisionCount`). */}
            <span className="prl-review-summary__value">{String(decisionCount(replay))}</span>
          </li>
        </ul>
      </header>

      {data.state === 'sampled' ? (
        <p className="prl-source-note prl-note">
          <span className="prl-label prl-label--accent">Fixture data</span>{' '}
          {data.cause === 'signedOut'
            ? 'This browser is not carrying a session, so the hands API had nothing to look your history up with, and this replay is a sample hand rather than one of yours.'
            : 'The hands API is not reachable, so this replay is a bundled sample rather than one of your hands.'}{' '}
          It comes from <code className="prl-mono">src/fixtures/review.ts</code>, which was generated by
          running the real <code className="prl-mono">buildHandReview</code> over hand-shaped rows — so the
          hole-card rule, the per-decision analysis and the Merkle proofs below are the endpoint&rsquo;s own
          output rather than an imitation of it.
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

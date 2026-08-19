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
 *
 * ## "There is no such hand" and "we could not find out" are different screens
 *
 * They used to be the same one, and it was this route's worst defect. `loadReview` returned `null`
 * for four unrelated conditions — the API said 404, the API could not be reached, the reader has no
 * session, the bundled fixture does not carry this id — and the page turned every one of them into
 * `notFound()`. So a reader whose hand took longer to analyse than the client's deadline allowed
 * was told, in the product's own words, that "there is nothing at this address" about a hand that
 * demonstrably exists. That is the single claim this product cannot afford to get wrong, and it was
 * being made about the hands most worth opening: the deck-commitment proof lives at the bottom of
 * this page, and the hands with enough decisions to be worth verifying were exactly the slow ones.
 * See `EXPENSIVE_READ_TIMEOUT_MS` in `lib/api.ts` for the other half of that fix.
 *
 * `ReviewState` below is the shape that makes the conflation impossible to reintroduce: `missing`
 * is the only member the page is allowed to answer 404 for, and it is reachable only from a 404 the
 * API itself sent about an id the reader supplied.
 *
 * ### The status code, which is honest but not complete
 *
 * `missing` answers a real `404`. `unavailable` renders a `200` carrying an explanation, and that
 * is a known shortfall rather than an oversight: a server component can set a status only through
 * `notFound()`, or through `unauthorized()`/`forbidden()`, which are experimental and need
 * `experimental.authInterrupts` turned on in `next.config.ts`. A wrong status on a page whose text
 * is true is a much smaller failure than the reverse, which is what this replaces. Anyone enabling
 * that flag should route `signedOut` through `unauthorized()`.
 */

import type { HandReviewResponse } from '@prl/contracts';
import { Chip, formatSignedUnits, formatUnits } from '@prl/ui';
import type { Metadata } from 'next';
import type { ReactElement } from 'react';
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
import { readerCallOptions } from '../../../lib/server-session.ts';
import { NotFoundBody } from '../../not-found.tsx';
import '../../../styles/page.css';
import '../../../styles/review.css';

interface RouteParams {
  readonly handId: string;
}

/**
 * Why the live answer could not be used.
 *
 * Two causes, and they are not interchangeable on screen: one says the service did not answer, the
 * other says this browser had nothing to identify the reader with. A single "unavailable" would
 * make the page guess which sentence to print.
 */
type ReviewFallbackCause = 'unreachable' | 'signedOut';

type ReviewState =
  /** The API answered. */
  | { readonly state: 'live'; readonly review: HandReviewResponse }
  /** The API did not, and the bundled copy happens to carry this hand. Labelled on the page. */
  | {
      readonly state: 'sampled';
      readonly review: HandReviewResponse;
      readonly cause: ReviewFallbackCause;
      readonly detail: string;
    }
  /** The API said 404 about an id the reader supplied. The only route to `notFound()`. */
  | { readonly state: 'missing' }
  /** Nothing could be established about this hand, and the page says which of the two happened. */
  | { readonly state: 'unavailable'; readonly cause: ReviewFallbackCause; readonly detail: string };

async function loadReview(handId: string): Promise<ReviewState> {
  // The reader's own session cookie, forwarded from the incoming request — a server-side `fetch`
  // has no cookie jar, so without this the API could only ever answer `not_authenticated` and a
  // signed-in reader could never see their own hand. See `src/lib/server-session.ts`.
  const reader = await readerCallOptions();
  const result = await safeFetch<HandReviewResponse>(() =>
    // This endpoint BUILDS the review rather than fetching it — a Monte Carlo run per hero decision,
    // under a budget the server itself sets at eight seconds. The default four-second deadline was
    // shorter than that budget, so the client aborted healthy work and read its own abort as "there
    // is no API". `EXPENSIVE_READ_TIMEOUT_MS` carries the arithmetic.
    apiGet<HandReviewResponse>(API_PATHS.hand(handId), {
      ...reader,
      timeoutMs: EXPENSIVE_READ_TIMEOUT_MS,
    }),
  );
  if (result.ok) return { state: 'live', review: result.data };

  const error = result.error;
  // `handId` came from the URL, so 404 is the API answering "you have no such hand" — the one
  // condition that deserves the not-found screen. Note that the API answers 404 for a hand that
  // belongs to somebody else too, deliberately (`apps/api/src/routes/hands.ts`), and that is still
  // the right screen: to this reader the hand does not exist.
  if (isMissingResource(error)) return { state: 'missing' };
  // Anything else that is neither an outage nor a missing session is a defect rather than a fact
  // about this hand, and it belongs in the error boundary with its request id.
  if (!isSignedOut(error) && !isApiUnavailable(error)) throw error;

  const cause: ReviewFallbackCause = isSignedOut(error) ? 'signedOut' : 'unreachable';
  const fixture = handReviewFixture(handId);
  if (fixture !== null) return { state: 'sampled', review: fixture, cause, detail: error.message };
  return { state: 'unavailable', cause, detail: error.message };
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

/**
 * The screen for "we could not establish anything about this hand".
 *
 * It is deliberately NOT the 404 page and deliberately not the error boundary. It names the hand
 * the reader asked for, says what actually happened, says what is still unknown — in particular
 * that nothing here has established the hand does not exist — and offers the two things that
 * help: the same URL again, and the list.
 *
 * The transport message is printed rather than summarised. It is this client's own sentence about
 * its own request (`ApiRequestError` from `lib/api.ts`, built before any server was involved), so
 * it carries no request content and nothing a reader should not see; and "could not reach the API
 * at …: The operation was aborted due to timeout" is the difference between a reader retrying and
 * a reader concluding their hand history has been lost.
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
  const data = await loadReview(handId);
  // The ONLY route to the not-found screen: the API itself said 404 about this id. Every other way
  // of failing to produce a replay now has a screen that says what it was.
  // Next 16 `notFound()` from a page returns empty HTML. Hand ids cannot be enumerated at
  // build time, so render the same 404 body the routing-level page uses.
  if (data.state === 'missing') return <NotFoundBody />;
  if (data.state === 'unavailable') {
    return <ReviewUnavailable handId={handId} cause={data.cause} detail={data.detail} />;
  }

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

      {data.state === 'sampled' ? (
        <p className="prl-source-note prl-note">
          <span className="prl-label prl-label--accent">Fixture data</span>{' '}
          {/* The reason is read off the failure rather than assumed. This notice used to state that the
              hands API was not reachable in both cases, which was false half the time: a reader with no
              session got a working API and a sample hand described as an outage. */}
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

/**
 * A refusal that means "there is no session here" must reach a screen, not the error boundary.
 *
 * ## What went wrong
 *
 * The API splits the 401 in two deliberately (`requireSession`, `apps/api/src/auth/session.ts`):
 * `not_authenticated` when no session cookie was presented or it was not ours, `session_expired`
 * when a cookie this deployment signed no longer resolves to a live session. The comment on that
 * function says what the split is for — a client that knows to open a fresh guest session "rather
 * than showing a dead end".
 *
 * `isSignedOut` in `lib/api.ts` matched only the first of the two, so the dead end is what the
 * client showed. `loadRecord`, `/review` and `/review/[handId]` each check that predicate and
 * re-throw anything it does not recognise, which means a reader holding a swept guest session — or
 * any cookie older than the database it was issued against — got the error boundary, an incident
 * reference and "something went wrong while rendering this page" for the entirely ordinary
 * condition of an expired session. It was found while verifying that `/record` shows the lessons a
 * learner has finished: that page is the one screen whose whole job is reporting the reader's own
 * record, and it was the loudest of the three failures.
 *
 * ## Why this is a widening and not a loosening
 *
 * Nothing in this predicate decides whether to trust a caller; the API settles that on its own and
 * answers 401 either way. All this chooses is which of two truthful screens to draw. The assertions
 * below therefore pin both directions: every code that means "no usable session" is one, and the
 * codes that mean something else — an outage, a refusal, a bad request — are still not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ErrorCode } from '@prl/contracts';
import { ApiRequestError, isApiUnavailable, isMissingResource, isSignedOut } from '../src/lib/api.ts';

/** A refusal as `lib/api.ts` builds one from the contract's error envelope. */
const refusal = (code: ErrorCode | 'transport', status: number): ApiRequestError =>
  new ApiRequestError({ message: `refused: ${code}`, status, code, requestId: 'req_test' });

describe('both of the API’s 401 codes are read as "there is no session"', () => {
  it('recognises a caller who presented no session', () => {
    assert.equal(isSignedOut(refusal('not_authenticated', 401)), true);
  });

  it('recognises a caller whose session has expired', () => {
    // The case that produced a 500. A guest session that has been swept, or a cookie signed
    // against a database that has since been replaced, is an ordinary thing for a reader to be
    // holding — and there is a screen for it saying exactly that, which they never reached.
    assert.equal(isSignedOut(refusal('session_expired', 401)), true);
  });
});

describe('nothing else is quietly turned into a signed-out screen', () => {
  it('does not swallow a refusal that has a different cause', () => {
    // Rendering "you are not signed in" over any of these would be a lie about what happened, and
    // the two that are outages have their own predicate and their own fallback.
    for (const [code, status] of [
      ['forbidden', 403],
      ['invalid_request', 400],
      ['rate_limited', 429],
      ['content_not_found', 404],
      ['internal_error', 500],
      ['service_unavailable', 503],
      ['transport', 0],
    ] as const) {
      assert.equal(isSignedOut(refusal(code, status)), false, `${code} is not a signed-out state`);
    }
  });

  it('is not fooled by something that is not an ApiRequestError at all', () => {
    // A `TypeError` from a bug in this client is a defect to fix, not a fact about the session.
    assert.equal(isSignedOut(new Error('not_authenticated')), false);
    assert.equal(isSignedOut('not_authenticated'), false);
    assert.equal(isSignedOut(null), false);
  });

  it('leaves the neighbouring predicates alone', () => {
    // The three are read together at every call site, and a 401 belongs to exactly one of them.
    // In particular an expired session is not an outage: the API answered, and it answered clearly.
    const expired = refusal('session_expired', 401);
    assert.equal(isApiUnavailable(expired), false);
    assert.equal(isMissingResource(expired), false);
  });
});

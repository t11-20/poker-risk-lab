/**
 * A refusal that means "there is no session here" must reach a screen, not the error boundary.
 * `requireSession` splits the 401 into `not_authenticated` and `session_expired`, and both count.
 * The predicate only picks which truthful screen to draw, so both directions are pinned.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ErrorCode } from '@prl/contracts';
import { ApiRequestError, isApiUnavailable, isMissingResource, isSignedOut } from '../src/lib/api.ts';

const refusal = (code: ErrorCode | 'transport', status: number): ApiRequestError =>
  new ApiRequestError({ message: `refused: ${code}`, status, code, requestId: 'req_test' });

describe('both of the API’s 401 codes are read as "there is no session"', () => {
  it('recognises a caller who presented no session', () => {
    assert.equal(isSignedOut(refusal('not_authenticated', 401)), true);
  });

  it('recognises a caller whose session has expired', () => {
    // A swept guest session, or a cookie signed against a replaced database, is ordinary to hold.
    assert.equal(isSignedOut(refusal('session_expired', 401)), true);
  });
});

describe('nothing else is quietly turned into a signed-out screen', () => {
  it('does not swallow a refusal that has a different cause', () => {
    // The two outages have their own predicate and their own fallback.
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
    assert.equal(isSignedOut(new Error('not_authenticated')), false);
    assert.equal(isSignedOut('not_authenticated'), false);
    assert.equal(isSignedOut(null), false);
  });

  it('leaves the neighbouring predicates alone', () => {
    // A 401 belongs to exactly one of the three. An expired session is not an outage, since the API answered.
    const expired = refusal('session_expired', 401);
    assert.equal(isApiUnavailable(expired), false);
    assert.equal(isMissingResource(expired), false);
  });
});

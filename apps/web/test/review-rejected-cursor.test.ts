/**
 * A hand-history cursor the API refuses is an old or edited link, not an outage.
 *
 * ## The failure this is written against
 *
 * `/review?cursor=zzz` — or a bare hand id pasted where a cursor goes — rendered the error boundary.
 * The API answers a cursor it did not mint with `400 invalid_request` and
 * `fields: { 'query.cursor': … }` (`decodeCursor` and `cursorFor` in `apps/api/src/routes/hands.ts`),
 * and `loadHistory` rethrew everything that was neither an outage nor a signed-out reader. Measured
 * by the audit at 308fadf with a guest session: HTTP 500 and the "something went wrong" screen, for
 * a link a reader can produce by editing one query parameter.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiRequestError, isRejectedCursor } from '../src/lib/api.ts';

function refusal(status: number, code: ApiRequestError['code'], fields?: Record<string, string>) {
  return new ApiRequestError({
    message: 'refused',
    status,
    code,
    ...(fields === undefined ? {} : { fields }),
  });
}

describe('a rejected hand-history cursor', () => {
  it('is recognised from the API refusal for that one field (REGRESSION)', () => {
    assert.equal(
      isRejectedCursor(
        refusal(400, 'invalid_request', { 'query.cursor': 'is not a cursor this endpoint issued' }),
      ),
      true,
    );
    // One that fails the query schema's pattern is refused before the route, under the schema's key.
    assert.equal(
      isRejectedCursor(refusal(400, 'invalid_request', { 'querystring.cursor': 'must match pattern' })),
      true,
    );
    // `cursorFor` refuses a real cursor replayed into a different ordering with the same field.
    assert.equal(
      isRejectedCursor(
        refusal(400, 'invalid_request', {
          'query.cursor': 'was issued for a different ordering than sort=oldest',
        }),
      ),
      true,
    );
  });

  it('is not any other refusal, which still reaches the error boundary', () => {
    assert.equal(
      isRejectedCursor(refusal(400, 'invalid_request', { 'query.sort': 'must be one of …' })),
      false,
    );
    assert.equal(isRejectedCursor(refusal(400, 'invalid_request')), false, 'no fields at all');
    assert.equal(isRejectedCursor(refusal(401, 'not_authenticated')), false);
    assert.equal(isRejectedCursor(refusal(0, 'transport')), false);
    assert.equal(isRejectedCursor(refusal(500, 'internal_error', { 'query.cursor': 'x' })), false);
    assert.equal(isRejectedCursor(new Error('query.cursor')), false, 'not an API refusal at all');
  });
});

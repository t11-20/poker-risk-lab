/**
 * A hand-history cursor the API refuses is an old or edited link, not an outage. The API answers a
 * cursor it did not mint with `400 invalid_request` on the cursor field
 * (`apps/api/src/routes/hands.ts`), and `loadHistory` once rethrew that into the error boundary.
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
    // A cursor failing the schema's pattern is refused before the route, under the schema's key.
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

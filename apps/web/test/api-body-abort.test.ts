/**
 * A response whose headers arrived and whose body did not is a transport failure like any other. A
 * deadline or reset mid-body must come back from `safeFetch` as a value, because its callers render
 * that value and none of them catch.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { apiGet, isApiUnavailable, safeFetch } from '../src/lib/api.ts';

function bodyThatFails(error: Error): Response {
  const body = new ReadableStream({
    pull(controller) {
      controller.error(error);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('a body that fails while it is being read', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  for (const [name, error] of [
    ['a deadline', new DOMException('The operation timed out.', 'TimeoutError')],
    ['an abort', new DOMException('This operation was aborted', 'AbortError')],
    ['a reset', new TypeError('terminated')],
  ] as const) {
    it(`comes back from safeFetch as a transport failure after ${name}`, async () => {
      globalThis.fetch = (() => Promise.resolve(bodyThatFails(error))) as typeof fetch;
      const result = await safeFetch(() => apiGet('/api/v1/auth/session'));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, 'transport');
      assert.equal(isApiUnavailable(result.error), true);
      assert.match(result.error.message, new RegExp(error.message));
    });
  }
});

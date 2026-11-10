#!/usr/bin/env node
/**
 * Tests for the deck-reveal corrupting proxy.
 *
 * Run with:  node --test scripts/review-proxy.test.mjs
 *
 * ## What these are written against
 *
 * The proxy is the fixture behind certification assertion 6.7, and a fixture has two failure modes
 * that a green check cannot tell apart from a healthy application:
 *
 *  1. **It forwards the bytes unchanged and says nothing.** The review page then renders a
 *     perfectly good proof, `J6.7` looks at a screen with no alert on it, and the failure reads as
 *     an application defect. Every path that cannot corrupt the payload must therefore REFUSE, in
 *     words, and the common case — a hand everybody folded out of, whose reveal proves nothing —
 *     is the one most likely to arrive.
 *  2. **It changes more than it claims to.** The whole argument for this fixture is that it never
 *     authors a payload, so it cannot go stale against `packages/contracts`. A `JSON.parse` /
 *     `JSON.stringify` round trip would quietly make key order, number formatting and string
 *     escaping this repository's choices rather than the API's. So the edit is a splice into the
 *     response TEXT, and the test that matters is a byte count.
 *
 * The end-to-end claim — that a flipped salt reaches `mismatch` rather than `other-hand` or
 * `unreadable` — is not asserted here and deliberately so: it is a fact about the real engine on a
 * real hand, and `J6.7` asserts it in real Chrome on every run of `pnpm run test:ax` rather than
 * against a payload this file wrote.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';
import { corruptOneByteOfReveal, REVIEW_REQUEST, startReviewProxy } from './review-proxy.mjs';

/** 32 hex bytes, in the shape `DeckReveal.cards[].saltHex` is pinned to by the engine. */
const salt = (seed) => seed.repeat(64).slice(0, 64);

/** A review body in the shape `HandReviewResponse` publishes, as TEXT — the proxy edits text. */
function reviewBody(overrides = {}) {
  return JSON.stringify({
    hand: { id: 'prl-hand-1', roomId: 'prl-room-1' },
    commitmentRoot: 'a'.repeat(64),
    commitmentContext: 'prl-room-1:7:prl-hand-1',
    reveal: {
      commitment: { algorithm: 'sha256', version: 'deck-merkle-1', root: 'a'.repeat(64), context: 'ctx' },
      cards: [
        { index: 4, card: 17, saltHex: salt('b'), proof: [salt('c')] },
        { index: 9, card: 3, saltHex: salt('d'), proof: [salt('e')] },
      ],
      complete: false,
      ...overrides,
    },
    verification: { ok: true, verifiedPositions: 2 },
  });
}

describe('the edit is one byte, inside the reveal, and nowhere else', () => {
  it('flips exactly one character and changes nothing else (REGRESSION)', () => {
    const original = reviewBody();
    const result = corruptOneByteOfReveal(original);
    assert.ok('corrupted' in result, `refused: ${result.refused}`);
    assert.equal(result.corrupted.length, original.length, 'the body changed length');
    const differing = [...original].reduce(
      (count, char, at) => count + (char === result.corrupted[at] ? 0 : 1),
      0,
    );
    assert.equal(differing, 1, `${differing} bytes differ; the promise is one`);
    assert.equal(original[result.record.byteOffset], result.record.before);
    assert.equal(result.corrupted[result.record.byteOffset], result.record.after);
  });

  it('leaves a salt that is still 32 hex bytes, so the engine reaches the HASH check', () => {
    // A salt the engine refuses on SHAPE produces `salt for position N is not 32 hex bytes`, which
    // is a parse-shaped refusal and not the mismatch 6.7 is about.
    const result = corruptOneByteOfReveal(reviewBody());
    const after = JSON.parse(result.corrupted).reveal.cards[0].saltHex;
    assert.match(after, /^[0-9a-f]{64}$/u);
    assert.notEqual(after, JSON.parse(reviewBody()).reveal.cards[0].saltHex);
  });

  it('touches the FIRST proof only, and leaves the commitment and the server verdict alone', () => {
    const before = JSON.parse(reviewBody());
    const after = JSON.parse(corruptOneByteOfReveal(reviewBody()).corrupted);
    // The binding must survive: a changed root or context would reach `other-hand`, which says
    // "this proof is for a different hand" — a different sentence, a different row, a different bug.
    assert.equal(after.commitmentRoot, before.commitmentRoot);
    assert.equal(after.commitmentContext, before.commitmentContext);
    assert.deepEqual(after.reveal.commitment, before.reveal.commitment);
    assert.deepEqual(after.reveal.cards[1], before.reveal.cards[1]);
    assert.deepEqual(after.verification, before.verification);
  });

  it('reports what it did, including the server verdict it did not change', () => {
    const { record } = corruptOneByteOfReveal(reviewBody());
    assert.equal(record.handId, 'prl-hand-1');
    assert.equal(record.positions, 2);
    assert.equal(record.position, 4);
    assert.equal(record.serverOk, true);
    assert.equal(record.serverPositions, 2);
  });
});

describe('every payload it cannot corrupt is REFUSED, in words', () => {
  it('a hand that proves no deck position (NEGATIVE CONTROL — the common case)', () => {
    // A hand everybody folded out of. `CommitmentVerifier` treats an empty reveal as the CORRECT
    // outcome, so this is the payload most likely to arrive and the one that must never be mistaken
    // for a successful corruption.
    const result = corruptOneByteOfReveal(reviewBody({ cards: [] }));
    assert.ok('refused' in result);
    assert.match(result.refused, /no deck position/u);
  });

  it('a payload with no reveal at all', () => {
    const body = JSON.stringify({ hand: { id: 'x' }, verification: { ok: true, verifiedPositions: 0 } });
    assert.match(corruptOneByteOfReveal(body).refused, /no reveal object/u);
  });

  it('a body that is not JSON, and one that is not an object', () => {
    assert.match(corruptOneByteOfReveal('<!doctype html>').refused, /not JSON/u);
    assert.match(corruptOneByteOfReveal('[1,2,3]').refused, /not a JSON object/u);
  });

  it('a salt that is not 32 lowercase hex bytes', () => {
    const body = reviewBody({
      cards: [{ index: 0, card: 1, saltHex: 'NOT-HEX', proof: [] }],
    });
    assert.match(corruptOneByteOfReveal(body).refused, /not 32 lowercase hex bytes/u);
  });

  it('a salt that appears twice, because the offset would be a guess', () => {
    const twice = reviewBody({
      cards: [
        { index: 0, card: 1, saltHex: salt('b'), proof: [salt('b')] },
        { index: 1, card: 2, saltHex: salt('d'), proof: [] },
      ],
    });
    assert.match(corruptOneByteOfReveal(twice).refused, /more than once/u);
  });
});

describe('the request pattern selects reviews and only reviews', () => {
  it('matches a hand review and not the list beside it (REGRESSION)', () => {
    assert.ok(REVIEW_REQUEST.test('/api/v1/hands/prl-hand-1'));
    // The list endpoint shares the prefix and carries no reveal. A pattern that matched it would
    // record a refusal on every page that lists hands, which is noise indistinguishable from the
    // refusal that matters.
    assert.equal(REVIEW_REQUEST.test('/api/v1/hands'), false);
    assert.equal(REVIEW_REQUEST.test('/api/v1/rooms/abc'), false);
  });
});

describe('everything that is not a review is forwarded byte for byte', () => {
  const started = [];
  after(() => {
    for (const stop of started) stop();
  });

  /** An upstream that answers three shapes: a review, a list, and some bytes that are not JSON. */
  async function upstream() {
    const server = createServer((request, response) => {
      if (request.url === '/api/v1/hands/prl-hand-1') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(reviewBody());
        return;
      }
      if (request.url === '/api/v1/hands') {
        response.writeHead(200, { 'content-type': 'application/json', 'x-prl-test': 'kept' });
        response.end(JSON.stringify({ hands: [{ id: 'prl-hand-1' }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.from([0, 1, 2, 250, 251, 252]));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    started.push(() => {
      server.closeAllConnections();
      server.close();
    });
    return `http://127.0.0.1:${server.address().port}`;
  }

  it('leaves a non-review JSON response and its headers untouched', async () => {
    const proxy = await startReviewProxy({ upstream: await upstream(), port: 0 });
    started.push(proxy.close);
    const response = await fetch(`${proxy.origin}/api/v1/hands`);
    assert.equal(await response.text(), JSON.stringify({ hands: [{ id: 'prl-hand-1' }] }));
    assert.equal(response.headers.get('x-prl-test'), 'kept');
    assert.equal(proxy.log.reviews, 0, 'the list endpoint was read as a review');
    assert.deepEqual(proxy.log.mutated, []);
  });

  it('leaves a non-JSON body byte for byte, including bytes that are not text', async () => {
    const proxy = await startReviewProxy({ upstream: await upstream(), port: 0 });
    started.push(proxy.close);
    const body = Buffer.from(await (await fetch(`${proxy.origin}/anything`)).arrayBuffer());
    assert.deepEqual([...body], [0, 1, 2, 250, 251, 252]);
  });

  it('corrupts the review, records the byte, and forwards a body of the same length', async () => {
    const proxy = await startReviewProxy({ upstream: await upstream(), port: 0 });
    started.push(proxy.close);
    const text = await (await fetch(`${proxy.origin}/api/v1/hands/prl-hand-1`)).text();
    assert.equal(text.length, reviewBody().length);
    assert.notEqual(text, reviewBody());
    assert.equal(proxy.log.reviews, 1);
    assert.equal(proxy.log.mutated.length, 1);
    assert.equal(proxy.log.mutated[0].handId, 'prl-hand-1');
    assert.deepEqual(proxy.log.refused, []);
  });

  it('records a refusal and forwards the ORIGINAL bytes when it cannot corrupt (NEGATIVE CONTROL)', async () => {
    // The dangerous shape: the page renders a good proof and the check would see no alert. What
    // makes that decidable is this log entry, which `J6.7` requires to be absent for the hand it
    // scores.
    const empty = reviewBody({ cards: [] });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(empty);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    started.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const proxy = await startReviewProxy({
      upstream: `http://127.0.0.1:${server.address().port}`,
      port: 0,
    });
    started.push(proxy.close);
    assert.equal(await (await fetch(`${proxy.origin}/api/v1/hands/x`)).text(), empty);
    assert.deepEqual(proxy.log.mutated, []);
    assert.equal(proxy.log.refused.length, 1);
    assert.match(proxy.log.refused[0].why, /no deck position/u);
  });

  it('answers an unreachable upstream with an empty 502 rather than a payload of its own', async () => {
    // 127.0.0.1:1 needs root to bind, so "nothing is listening" is a property of the operating
    // system rather than an assumption about this host — the same argument `ax-tree-audit.mjs`
    // makes for 8.2's dead API origin.
    const proxy = await startReviewProxy({ upstream: 'http://127.0.0.1:1', port: 0 });
    started.push(proxy.close);
    const response = await fetch(`${proxy.origin}/api/v1/hands/x`);
    assert.equal(response.status, 502);
    assert.equal(await response.text(), '');
    assert.equal(proxy.log.upstreamErrors.length, 1);
  });

  it('refuses an upstream that is not an http origin', () => {
    // Before it listens, so a misconfigured caller gets a boot failure rather than a proxy that
    // answers 502 to everything. "Prefer refusing to warning", applied to a fixture.
    assert.throws(() => startReviewProxy({ upstream: 'ftp://example.test', port: 0 }), /not an http/u);
  });
});

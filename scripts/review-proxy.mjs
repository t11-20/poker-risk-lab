#!/usr/bin/env node
/**
 * A pass-through proxy that flips ONE BYTE inside a hand review's deck reveal.
 *
 * This is the fixture for certification assertion **6.7** — "a verification failure announces as an
 * alert" — and it exists because every other route to that state was refused on its merits.
 * `docs/production/accessibility-certification.md` §5 records the argument in full; the short
 * version is that `CommitmentVerifier`'s `mismatch` branch is reachable only from a reveal whose
 * proofs do not reach the root its own hand published, and:
 *
 *   - **The browser cannot be made to receive one.** `/review/<handId>` is a server component. The
 *     reveal arrives as a prop from the WEB SERVER's own fetch, so `Network.setBlockedURLs` — the
 *     trick 3.20 uses to make a fetch fail — leaves the render untouched.
 *   - **The product must not contain a switch that produces one.** A production code path that can
 *     lie about a deal is the single thing this component exists to detect. Its own header says a
 *     server that dealt dishonestly is exactly the server whose self-assessment cannot be trusted.
 *   - **A hand-built `HandReviewResponse` checks the shape of its own fixture.** It would go stale
 *     against `packages/contracts` the moment either side moved, and a green check over a payload
 *     the gate wrote itself establishes nothing about the payload the API sends.
 *
 * What is left is this: a third `next start` off the same build whose `PRL_API_ORIGIN` points here,
 * while this forwards the REAL API's REAL review response with one character of one salt flipped.
 * It never authors a payload, so it cannot go stale against the contract — every field except one
 * hex digit is the bytes the API sent. And the state it reaches is honest: the leaf hash for that
 * position no longer walks to the published root, `verifyDeckReveal` answers
 * `position N does not prove against the published root`, and the reader's own browser says so
 * while the server's verdict on the same screen still reads "verified". That disagreement is the
 * thing `CommitmentVerifier` was written for, and 6.7 is the row that asks whether a reader hears it.
 *
 * ## The edit is made to the RESPONSE TEXT, not to a re-serialised object
 *
 * `JSON.parse` then `JSON.stringify` would re-author the whole body: key order, number formatting
 * and string escaping would all become this file's choices rather than the API's, and "it forwards
 * the real response" would stop being literally true. So the parse here is read-only — it is how the
 * salt is FOUND — and the edit is a one-character splice into the original text. `corruptOneByteOfReveal`
 * asserts the result before returning it: same length, and exactly one differing byte, at the offset
 * it meant to change. A splice that touched anything else is refused rather than forwarded.
 *
 * ## Refusing is the safe direction, and it has to be LOUD
 *
 * The dangerous failure of a corrupting proxy is that it silently forwards the bytes unchanged: the
 * page then renders a perfectly good proof, the check looks at a screen with no alert on it, and
 * whether that is a defect or a fixture that stopped working is undecidable from the screen alone.
 * A hand where nobody showed has an EMPTY reveal and nothing to flip, which is not hypothetical —
 * it is the common case for a hand that ends preflop.
 *
 * So every refusal is recorded with its reason, nothing is invented to paper over it, and
 * `J6.7` in `scripts/ax-assertions.mjs` requires this log to name the hand that is on screen before
 * it will read anything off that screen. "A sweep of nothing is not a pass" applies to a fixture as
 * much as to a scanner.
 *
 * On an upstream transport failure this answers 502 with **no body at all** rather than a JSON error
 * of its own. A proxy whose whole promise is that it never authors a payload should not author one
 * on its worst day either; the web app reads an empty 502 as an unreachable API, which is true.
 *
 * ## Scope
 *
 * A private module of `pnpm run test:ax`, like `scripts/ax-assertions.mjs` — one consumer,
 * `scripts/ax-tree-audit.mjs`, which owns its lifetime and closes it in a `finally`. It listens on
 * 127.0.0.1 only. Nothing in the application, in a deployment or in another gate may import it: a
 * thing that corrupts deck proofs has exactly one legitimate caller.
 */

import { createServer } from 'node:http';

/**
 * A review request, which is the ONLY response this proxy is allowed to touch.
 *
 * `/api/v1/hands/<id>` and not `/api/v1/hands` — the list endpoint shares the prefix and carries no
 * reveal, and a pattern that matched it would report a refusal on every page that lists hands.
 */
export const REVIEW_REQUEST = /^\/api\/v1\/hands\/[^/]+$/u;

/** Hex digit to hex digit with the low bit flipped: one character, one byte, still valid hex. */
const FLIPPED_NIBBLE = new Map(
  [...'0123456789abcdef'].map((digit, value) => [digit, '0123456789abcdef'[value ^ 1]]),
);

/** The offset of the only byte at which two strings differ, or null when that is not the case. */
function soleDifference(before, after) {
  if (before.length !== after.length) return null;
  let found = null;
  for (let at = 0; at < before.length; at += 1) {
    if (before[at] === after[at]) continue;
    if (found !== null) return null;
    found = at;
  }
  return found;
}

/**
 * One hex digit of one salt, flipped in place in the response text.
 *
 * The salt rather than the card id or a sibling hash, for two reasons. A card id is an integer with
 * a meaning — `verifyDeckReveal` refuses an out-of-range one with `invalid card id`, which is a
 * PARSE-shaped refusal and not the mismatch 6.7 is about. A salt stays 32 hex bytes under this edit,
 * so every shape check in the engine still passes and the only thing that changes is the leaf hash:
 * the walk reaches a different root and the failure is exactly `position N does not prove against
 * the published root`.
 *
 * Returns `{ corrupted, record }` or `{ refused }`. Never throws on a payload it does not recognise
 * — an unrecognised payload is a refusal with words, because the caller has to be able to say which
 * of the two happened.
 */
export function corruptOneByteOfReveal(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    return { refused: `the response body is not JSON (${error instanceof Error ? error.message : error})` };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { refused: 'the response body is not a JSON object, so it is not a hand review' };
  }
  const reveal = Reflect.get(payload, 'reveal');
  if (reveal === null || reveal === undefined || typeof reveal !== 'object') {
    return { refused: 'this hand published no reveal object, so there is nothing in it to corrupt' };
  }
  const cards = Reflect.get(reveal, 'cards');
  if (!Array.isArray(cards) || cards.length === 0) {
    // The common case, and the one that must never be mistaken for success: a hand everybody folded
    // out of proves no deck position at all. See `CommitmentVerifier`'s header on why that is the
    // CORRECT outcome for such a hand — which is exactly why it is the wrong hand for this fixture.
    return { refused: 'this hand proves no deck position, so there is no reveal byte to flip' };
  }
  const first = cards[0];
  const salt = first === null || typeof first !== 'object' ? undefined : Reflect.get(first, 'saltHex');
  if (typeof salt !== 'string' || !/^[0-9a-f]{64}$/u.test(salt)) {
    return { refused: `the first proof's salt is not 32 lowercase hex bytes (${JSON.stringify(salt)})` };
  }

  const at = rawBody.indexOf(salt);
  if (at === -1) {
    return { refused: 'the salt the parse found does not appear literally in the response text' };
  }
  if (rawBody.indexOf(salt, at + 1) !== -1) {
    // 32 random bytes twice in one body is not a thing that happens; if it ever does, the offset is
    // ambiguous and a guess about which one to edit is a guess about what was forwarded.
    return { refused: 'the salt appears more than once in the response text, so the edit is ambiguous' };
  }
  const before = salt[0];
  const after = FLIPPED_NIBBLE.get(before);
  const corrupted = `${rawBody.slice(0, at)}${after}${rawBody.slice(at + 1)}`;

  // The self-check, and it is the whole reason the edit is a splice rather than a re-serialisation.
  // If this ever fails the proxy has changed something it did not mean to, and forwarding it would
  // make every claim in this file's header false.
  const changed = soleDifference(rawBody, corrupted);
  if (changed !== at) {
    return { refused: `the splice changed ${changed === null ? 'more than one byte' : `byte ${changed}`}` };
  }

  const commitment = Reflect.get(reveal, 'commitment');
  const read = (source, key) =>
    source === null || source === undefined || typeof source !== 'object'
      ? undefined
      : Reflect.get(source, key);
  const verification = Reflect.get(payload, 'verification');
  return {
    corrupted,
    record: {
      handId: read(Reflect.get(payload, 'hand'), 'id'),
      // A code-unit offset into the response text, which is the same as a byte offset only for a
      // body that is pure ASCII — a display name with an accent in it earlier in the payload would
      // shift the two apart. The one-byte CLAIM does not depend on that: the character replaced is
      // a hex digit, so both encodings differ at exactly one byte and the length is unchanged.
      byteOffset: at,
      before,
      after,
      position: Reflect.get(first, 'index'),
      positions: cards.length,
      root: read(commitment, 'root'),
      context: read(commitment, 'context'),
      // The server's own verdict on the UNCORRUPTED payload, kept so the check can require the two
      // answers on screen to disagree. A run where the server also said "not verified" would be
      // measuring a broken API rather than a corrupted reveal.
      serverOk: read(verification, 'ok'),
      serverPositions: read(verification, 'verifiedPositions'),
    },
  };
}

/** Headers that belong to one hop and must not be copied onto the next one. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });

/**
 * Start the proxy. Resolves once it is listening; the caller must `close()` it in a `finally`.
 *
 * `log` is live and is the fixture's own account of what it did: how many requests it forwarded, how
 * many review responses it saw, which of them it corrupted (with the byte), and which it refused
 * and why. `J6.7` reads it, and refuses to score the screen unless the hand on that screen is in
 * `mutated`.
 */
export function startReviewProxy({ upstream, host = '127.0.0.1', port }) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`review proxy: upstream ${upstream} is not an http(s) origin`);
  }
  const log = { forwarded: 0, reviews: 0, mutated: [], refused: [], upstreamErrors: [] };

  const handle = async (request, response) => {
    const url = new URL(request.url ?? '/', target);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (HOP_BY_HOP.has(name) || name === 'host' || name === 'content-length') continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === 'string') headers.append(name, item);
      }
    }
    // Identity, always. The review body is edited as TEXT, and an editor that cannot read what it
    // forwards would either splice into a gzip stream or hand the app a body whose declared length
    // no longer matches it. This is transport negotiation, not a change to any payload.
    headers.set('accept-encoding', 'identity');

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? await readBody(request) : undefined;
    const upstreamResponse = await fetch(url, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });
    const raw = Buffer.from(await upstreamResponse.arrayBuffer());

    let out = raw;
    const contentType = upstreamResponse.headers.get('content-type') ?? '';
    const isReview =
      request.method === 'GET' &&
      REVIEW_REQUEST.test(url.pathname) &&
      upstreamResponse.status === 200 &&
      contentType.includes('json');
    if (isReview) {
      log.reviews += 1;
      const attempt = corruptOneByteOfReveal(raw.toString('utf8'));
      if ('corrupted' in attempt) {
        out = Buffer.from(attempt.corrupted, 'utf8');
        log.mutated.push({ path: url.pathname, ...attempt.record });
      } else {
        log.refused.push({ path: url.pathname, why: attempt.refused });
      }
    }

    const outHeaders = {};
    for (const [name, value] of upstreamResponse.headers) {
      if (HOP_BY_HOP.has(name) || name === 'content-length' || name === 'content-encoding') continue;
      if (name === 'set-cookie') continue;
      outHeaders[name] = value;
    }
    const cookies = upstreamResponse.headers.getSetCookie();
    if (cookies.length > 0) outHeaders['set-cookie'] = cookies;
    outHeaders['content-length'] = String(out.byteLength);
    log.forwarded += 1;
    response.writeHead(upstreamResponse.status, outHeaders);
    response.end(request.method === 'HEAD' ? undefined : out);
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      log.upstreamErrors.push({
        path: request.url ?? '',
        why: error instanceof Error ? error.message : String(error),
      });
      // No body. See the header: a proxy that never authors a payload does not start on its worst
      // day, and an empty 502 is read by the web app as an API it could not reach — which is true.
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve({
        origin: `http://${host}:${server.address().port}`,
        log,
        close() {
          try {
            server.closeAllConnections();
            server.close();
          } catch {
            // Already closed. Cleanup runs from a `finally` that may run twice on an error path,
            // and a throw there would replace the real failure with this one.
          }
        },
      });
    });
  });
}

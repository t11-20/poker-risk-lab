#!/usr/bin/env node
/**
 * A pass-through proxy for `pnpm run test:ax` that flips one hex digit of one salt in a hand
 * review's deck reveal, so certification assertion 6.7 can see `CommitmentVerifier` report a mismatch.
 * The product has no code path that can lie about a deal, so the fixture lives here.
 * The edit is a splice into the real response text, self-checked at exactly one differing byte, so
 * it never authors a payload. Every refusal is logged, and `J6.7` scores only a hand the log names.
 * Its one consumer is `scripts/ax-tree-audit.mjs`. It listens on 127.0.0.1 only.
 */

import { createServer } from 'node:http';

// The list endpoint shares the prefix and carries no reveal.
export const REVIEW_REQUEST = /^\/api\/v1\/hands\/[^/]+$/u;

const FLIPPED_NIBBLE = new Map(
  [...'0123456789abcdef'].map((digit, value) => [digit, '0123456789abcdef'[value ^ 1]]),
);

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
 * Flips one hex digit of one salt. A flipped card id fails as `invalid card id`, a parse error, while
 * a salt keeps every shape check passing and changes only the leaf hash.
 * Returns `{ corrupted, record }` or `{ refused }`, and never throws.
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
    // A hand everybody folded out of proves no deck position, so there is nothing to flip.
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
    return { refused: 'the salt appears more than once in the response text, so the edit is ambiguous' };
  }
  const before = salt[0];
  const after = FLIPPED_NIBBLE.get(before);
  const corrupted = `${rawBody.slice(0, at)}${after}${rawBody.slice(at + 1)}`;

  // A splice that changed anything but one byte is refused, not forwarded.
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
      // A code-unit offset. The replaced character is a hex digit, so both encodings differ at one byte.
      byteOffset: at,
      before,
      after,
      position: Reflect.get(first, 'index'),
      positions: cards.length,
      root: read(commitment, 'root'),
      context: read(commitment, 'context'),
      // The server's verdict on the uncorrupted payload. The check requires the two verdicts to disagree.
      serverOk: read(verification, 'ok'),
      serverPositions: read(verification, 'verifiedPositions'),
    },
  };
}

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
 * Resolves once listening; the caller must `close()` it in a `finally`. `log` records what was
 * forwarded, corrupted and refused, and `J6.7` reads it.
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
    // Identity, so the body is plain text the splice can edit.
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
      // No body. The web app reads an empty 502 as an unreachable API, which is true.
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
            // Cleanup may run twice on an error path; a throw here would hide the real failure.
          }
        },
      });
    });
  });
}

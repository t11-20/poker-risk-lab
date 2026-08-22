/**
 * Per-request identity: a request id that is ours, and a client key that is not an IP.
 *
 * ## Why the request id is generated and never accepted
 *
 * Fastify will happily adopt an inbound `request-id` header as `request.id` — that is
 * its default. We turn that off (`requestIdHeader: false` in `app.ts`) and generate a
 * UUID per request instead, because `request.id` appears on every log line and in every
 * error body. A client-supplied id lets a caller forge log entries, collide two
 * unrelated requests onto one id so a support investigation reads the wrong request, or
 * push a megabyte of text into the logging pipeline. There is no upside that a separate,
 * explicitly-trusted correlation header could not provide later.
 *
 * The id is echoed back as `x-request-id`, and it is set in `onRequest` rather than
 * `onSend` so that it is present even on responses that never reach a handler: a CORS
 * preflight rejection, a rate-limit 429, a 404.
 *
 * ## Why there is a client key instead of an IP
 *
 * Rate limiting and abuse investigation need a stable per-caller identifier. Raw IP
 * addresses in a log file are personal data with a long retention tail and no
 * operational benefit over a keyed hash, so what gets stored is
 * `HMAC-SHA256(secret, "client:" + ip)` truncated to 16 hex characters.
 *
 * Be honest about what that does and does not achieve. It is pseudonymisation, not
 * anonymisation: anyone holding the secret can confirm a guessed IP. What it buys is
 * that a leaked log file, a screenshot or a metrics label does not hand out a list of
 * addresses, and that the key is still stable enough to rate-limit on. It is keyed
 * rather than a plain SHA-256 precisely because the IPv4 space is small enough to
 * enumerate against an unkeyed hash in seconds.
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyPluginCallback } from 'fastify';
import type { AppConfig } from '../config.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Pseudonymous, stable-per-secret identifier for the caller's network address.
     * Safe to log and to use as a rate-limit bucket. Never contains an IP address.
     */
    clientKey: string;
  }
}

/** The response header carrying the request id back to the caller. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Length of the hex digest kept. 16 hex characters is 64 bits: collisions are not a
 * practical concern for rate-limit buckets, and a short value keeps log lines readable.
 */
const CLIENT_KEY_LENGTH = 16;

/**
 * Keyed hash of an arbitrary identifier.
 *
 * `domain` is a label mixed into the input so that one secret used for two purposes
 * cannot produce the same digest for the same value — a hashed IP and a hashed session
 * token must never collide into a single rate-limit bucket.
 */
export function hashWithKey(secret: string, domain: string, value: string): string {
  return createHmac('sha256', secret).update(`${domain}:${value}`).digest('hex').slice(0, CLIENT_KEY_LENGTH);
}

/**
 * The IPv4-mapped IPv6 prefix. `::ffff:203.0.113.4` and `203.0.113.4` are the same host.
 *
 * Node reports the mapped spelling whenever the listening socket is dual-stack (`HOST=::`,
 * which is what a container uses) and the plain spelling when it is bound to an IPv4
 * address. So the *same client* produces two different strings depending only on how this
 * process was started — and, worse, one client can produce both within a single deployment
 * if anything in front of it resolves differently. Two spellings mean two rate-limit
 * buckets and two client keys in the logs for one caller, which is a limit that quietly
 * counts to half of what it says and an investigation that finds half the requests.
 *
 * Only this one transform is applied. `::1` and `127.0.0.1` are NOT folded together: they
 * are genuinely different addresses on different stacks, and treating them as one would be
 * inventing an equivalence rather than removing a spelling.
 */
const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * One canonical spelling per address.
 *
 * Lower-cased because IPv6 is hexadecimal and `::FFFF:` and `::ffff:` are the same address;
 * a case difference would fork the bucket exactly as the mapped prefix does.
 */
export function normaliseAddress(ip: string): string {
  const lowered = ip.toLowerCase();
  return lowered.startsWith(IPV4_MAPPED_PREFIX) ? lowered.slice(IPV4_MAPPED_PREFIX.length) : lowered;
}

/** The client key for a request. Falls back to a constant when there is no address. */
export function clientKeyFor(secret: string, ip: string | undefined): string {
  // A missing address happens with injected requests and with unix sockets. Bucketing
  // them together under one key is the right call: they are all "no address", and
  // inventing a unique key per request would silently disable rate limiting for them.
  const address = ip === undefined || ip === '' ? 'unknown' : normaliseAddress(ip);
  return hashWithKey(secret, 'client', address);
}

export interface RequestContextOptions {
  readonly config: AppConfig;
}

/**
 * Attaches the request context.
 *
 * Two things about the shape of this plugin:
 *
 * 1. It is a callback plugin, not an async one, because it has nothing to await and an
 *    `async` function with no `await` is flagged by the linter (rightly — it usually
 *    means a missing one).
 *
 * 2. `Symbol.for('skip-override')` is Fastify's own escape hatch for a plugin that must
 *    apply to the instance it is registered on rather than to a fresh child scope. It is
 *    exactly what `fastify-plugin` sets, and `fastify-plugin` is not a dependency of
 *    this repo. Without it the `onRequest` hook below would only run for routes
 *    registered *inside* this plugin — which is none of them — and the whole file would
 *    silently do nothing. That failure mode is invisible in tests that only check the
 *    plugin loads, so it is called out here.
 */
export const requestContextPlugin: FastifyPluginCallback<RequestContextOptions> = (app, options, done) => {
  const secret = options.config.sessionCookieSecret;

  // A primitive default, declared once, so the property lives on the shared Request
  // prototype instead of being added per request (which would change the object shape
  // on every request). Fastify 5 rejects reference-type defaults here for that reason.
  app.decorateRequest('clientKey', '');

  app.addHook('onRequest', (request, reply, next) => {
    request.clientKey = clientKeyFor(secret, request.ip);
    reply.header(REQUEST_ID_HEADER, request.id);
    next();
  });

  done();
};

Object.defineProperty(requestContextPlugin, Symbol.for('skip-override'), { value: true });

/**
 * The generator handed to Fastify's `genReqId`.
 *
 * `crypto.randomUUID` rather than a counter: a counter tells any caller how many
 * requests the process has served, and two processes behind a load balancer would emit
 * the same ids, which makes a log search ambiguous exactly when it matters.
 */
export function generateRequestId(): string {
  return randomUUID();
}

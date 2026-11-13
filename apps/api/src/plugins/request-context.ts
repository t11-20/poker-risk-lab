/**
 * Per-request identity. A request id we generate, and a client key that is not an IP.
 *
 * Inbound `request-id` headers are ignored (`requestIdHeader: false` in `app.ts`) because the id
 * appears in every log line and error body, and a caller-chosen one can forge or collide entries.
 * The id is echoed as `x-request-id` from `onRequest`, so 404s, 429s and CORS rejections carry it.
 * The client key is `HMAC-SHA256(secret, "client:" + ip)`, truncated. It is pseudonymous, not anonymous,
 * and keyed because the IPv4 space enumerates against an unkeyed hash in seconds.
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyPluginCallback } from 'fastify';
import type { AppConfig } from '../config.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Pseudonymous caller key. Safe to log and to use as a rate-limit bucket. Never contains an IP. */
    clientKey: string;
  }
}

export const REQUEST_ID_HEADER = 'x-request-id';

/** 16 hex characters is 64 bits, enough to avoid bucket collisions while keeping log lines short. */
const CLIENT_KEY_LENGTH = 16;

/** `domain` separates uses of one secret, so a hashed IP and a hashed session token never share a bucket. */
export function hashWithKey(secret: string, domain: string, value: string): string {
  return createHmac('sha256', secret).update(`${domain}:${value}`).digest('hex').slice(0, CLIENT_KEY_LENGTH);
}

/**
 * Node reports `::ffff:203.0.113.4` on a dual-stack socket and `203.0.113.4` on an IPv4 one.
 * Folding the two keeps one client in one rate-limit bucket. `::1` and `127.0.0.1` are distinct
 * addresses and are not folded.
 */
const IPV4_MAPPED_PREFIX = '::ffff:';

/** Lower-cased because `::FFFF:` and `::ffff:` are the same address and would fork the bucket. */
export function normaliseAddress(ip: string): string {
  const lowered = ip.toLowerCase();
  return lowered.startsWith(IPV4_MAPPED_PREFIX) ? lowered.slice(IPV4_MAPPED_PREFIX.length) : lowered;
}

/** Requests with no address (injected, unix socket) share one key, so rate limiting still applies to them. */
export function clientKeyFor(secret: string, ip: string | undefined): string {
  const address = ip === undefined || ip === '' ? 'unknown' : normaliseAddress(ip);
  return hashWithKey(secret, 'client', address);
}

export interface RequestContextOptions {
  readonly config: AppConfig;
}

/**
 * A callback plugin because it has nothing to await.
 * `Symbol.for('skip-override')` (what `fastify-plugin` sets) makes the hook apply to the parent
 * instance. Without it the hook would run only for routes inside this plugin, which is none.
 */
export const requestContextPlugin: FastifyPluginCallback<RequestContextOptions> = (app, options, done) => {
  const secret = options.config.sessionCookieSecret;

  // A primitive default keeps the property on the shared prototype. Fastify 5 rejects reference defaults.
  app.decorateRequest('clientKey', '');

  app.addHook('onRequest', (request, reply, next) => {
    request.clientKey = clientKeyFor(secret, request.ip);
    reply.header(REQUEST_ID_HEADER, request.id);
    next();
  });

  done();
};

Object.defineProperty(requestContextPlugin, Symbol.for('skip-override'), { value: true });

/** `randomUUID` rather than a counter, which would leak request volume and repeat across processes. */
export function generateRequestId(): string {
  return randomUUID();
}

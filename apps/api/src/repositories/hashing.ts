/**
 * Every secret-bearing column uses `prl.sha256_hash` (32 bytes), and this file computes all of them.
 * Unkeyed SHA-256 for CSPRNG-sized values (session tokens, invite codes, OIDC state/nonce/verifier).
 * The dev seed computes the invite digest in SQL, so it must stay unkeyed.
 * HMAC with `sessionCookieSecret` for IP and user agent, because 2^32 addresses enumerate in seconds.
 * The secret is a parameter because repositories do not read configuration.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normaliseInviteCode } from './ids.ts';

export const DIGEST_BYTES = 32;

/** Per-column labels, so a digest from one column cannot be tested against another. */
const HMAC_DOMAINS = {
  ip: 'prl.ip.v1',
  userAgent: 'prl.user-agent.v1',
} as const;

/**
 * Bounds the hashing work an unauthenticated caller chooses. Truncation is safe here, unlike for an
 * invite code, because these digests are only compared for equality and never authorise.
 */
const MAX_KEYED_INPUT_LENGTH = 512;

export function sha256(value: string | Uint8Array): Buffer {
  const hash = createHash('sha256');
  if (typeof value === 'string') hash.update(value, 'utf8');
  else hash.update(value);
  return hash.digest();
}

/** `prl.sessions.token_hash`. Unkeyed, because the token is 256 random bits. */
export function hashToken(token: string): Buffer {
  return sha256(token);
}

/** Normalised first. Null means no room will match, answered as `invite_code_invalid`. */
export function hashInviteCode(code: string): Buffer | null {
  const normalised = normaliseInviteCode(code);
  return normalised === null ? null : sha256(normalised);
}

/** `state`, `nonce` or PKCE verifier. Unkeyed, because each is 256 random bits. */
export function hashOidcSecret(value: string): Buffer {
  return sha256(value);
}

function keyedDigest(secret: string, domain: string, value: string): Buffer {
  return createHmac('sha256', secret)
    .update(`${domain}:${value.slice(0, MAX_KEYED_INPUT_LENGTH)}`, 'utf8')
    .digest();
}

/**
 * `prl.sessions.ip_hash`. Null for a request with no address, because a digest of a placeholder would
 * group unrelated sessions.
 */
export function hashIp(secret: string, ip: string | undefined): Buffer | null {
  if (ip === undefined || ip === '') return null;
  return keyedDigest(secret, HMAC_DOMAINS.ip, ip);
}

export function hashUserAgent(secret: string, userAgent: string | undefined): Buffer | null {
  if (userAgent === undefined || userAgent === '') return null;
  return keyedDigest(secret, HMAC_DOMAINS.userAgent, userAgent);
}

/**
 * Constant-time equality that returns false on a length mismatch. `crypto.timingSafeEqual` throws
 * there, which would leak length through an error path and turn a truncated cookie into a 500. The
 * comparison always runs before the length is consulted. Only the length of `a`, the caller's own
 * input, is visible to timing.
 */
export function timingSafeEquals(a: Uint8Array, b: Uint8Array): boolean {
  const sameLength = a.length === b.length;
  const right = sameLength ? b : a;
  return timingSafeEqual(a, right) && sameLength;
}

/**
 * Digests. The only shape a secret is allowed to have when it reaches a table.
 *
 * `db/migrations/0001_initial.sql` has a domain, `prl.sha256_hash`, that is 32 bytes and
 * nothing else, and every secret-bearing column in the schema uses it: session tokens, room
 * invite codes, OIDC state, nonce and PKCE verifier, plus optional digests of the client IP
 * and user agent. This file is the only place those digests are computed, so "what exactly is
 * stored" has one answer that can be read in one screen.
 *
 * ## Two kinds of digest, and the line between them
 *
 * **Unkeyed SHA-256** for values that are already 256 bits of CSPRNG output, or close enough:
 * a session token, an OIDC state or nonce or PKCE verifier, a room invite code. There is
 * nothing to rainbow-table — an attacker with the digest would have to search a space of 2^79
 * (invite code) or 2^256 (everything else), and a key would add no security while adding a
 * way for a rotated secret to lock every existing session out. It also has to be unkeyed for
 * the invite code specifically: `db/seeds/0001_dev_seed.sql` computes
 * `sha256(convert_to('PRL-DEV-ROOM-1','utf8'))` in SQL, and a keyed digest would make the
 * development room unjoinable by its own documented code.
 *
 * **Keyed HMAC-SHA-256** for the client IP and the user agent, because those are the opposite
 * situation. The whole IPv4 space is 2^32 values and the top few hundred user-agent strings
 * cover most traffic, so an unkeyed digest of either is reversible by enumeration in seconds
 * — a database leak would hand the reader a list of addresses, which is precisely what
 * storing a digest was supposed to prevent. Keyed with `sessionCookieSecret`, the digest is
 * useless to anyone who does not also hold that secret.
 *
 * Be honest about what the keyed version achieves: pseudonymisation, not anonymisation.
 * Anyone holding the secret can still confirm a guessed address. What it buys is that a
 * stolen dump, a screenshot or a support query does not enumerate anybody's network history.
 * `plugins/request-context.ts` makes the same trade for the log pipeline and says so at more
 * length; this is the database's version of it, differing in one respect — the full 32 bytes
 * are kept here, because `prl.sha256_hash` requires exactly 32, whereas the log key is
 * truncated to 16 hex characters to stay readable.
 *
 * ## Why the secret is a parameter
 *
 * A repository must not read configuration. `db.ts` spells out why: a module that reaches for
 * `process.env` from four layers down is how a test suite ends up connecting to, or in this
 * case keying against, whatever the developer had exported. So the caller — which already
 * holds `app.appConfig` — passes the secret in.
 *
 * The consequence is a division of labour worth stating outright. The repositories in this
 * directory hash **credentials** themselves (`sessions.create` hashes the token it just
 * minted; `sessions.findValidByToken` hashes the cookie it was handed), so a plaintext
 * credential can never reach a query parameter by accident. They accept **already-digested**
 * IP and user agent, because those need configuration the repository is not allowed to read.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normaliseInviteCode } from './ids.ts';

/** What every function here returns and what `prl.sha256_hash` accepts. */
export const DIGEST_BYTES = 32;

/**
 * Domain labels mixed into each keyed digest.
 *
 * One secret used for two purposes must not produce the same digest for the same input.
 * Without the label, a learner whose user-agent string happened to equal their IP address
 * would store the same 32 bytes in two columns, and — much more usefully to an attacker — a
 * digest lifted from one column could be tested against the other. The label is cheap and
 * removes the whole question.
 */
const HMAC_DOMAINS = {
  ip: 'prl.ip.v1',
  userAgent: 'prl.user-agent.v1',
} as const;

/**
 * Longest input either keyed hash will read.
 *
 * A `User-Agent` header can be as long as the server's header limit allows, and hashing all
 * of it is work an unauthenticated caller gets to choose the size of. 512 bytes is far past
 * any real user agent. Truncation is safe here in a way it is not for an invite code (see
 * `ids.ts`): two user agents colliding after truncation costs nothing, because this digest
 * is only ever compared for equality against the same truncation, never used to authorise.
 */
const MAX_KEYED_INPUT_LENGTH = 512;

/**
 * Plain SHA-256.
 *
 * Accepts a string (encoded UTF-8, stated explicitly rather than relying on the default) or
 * raw bytes, so a caller never has to decide which overload it wanted.
 */
export function sha256(value: string | Uint8Array): Buffer {
  const hash = createHash('sha256');
  if (typeof value === 'string') hash.update(value, 'utf8');
  else hash.update(value);
  return hash.digest();
}

/**
 * The digest stored in `prl.sessions.token_hash`.
 *
 * A separate name rather than a call to `sha256` at each site, because "the session token is
 * stored as a bare SHA-256 of 32 random bytes" is a security decision, and a decision wants a
 * function to hang its reasoning on. See the unkeyed/keyed note at the top of the file.
 */
export function hashToken(token: string): Buffer {
  return sha256(token);
}

/**
 * The digest stored in `prl.rooms.invite_code_hash`, and the one looked up on a join.
 *
 * Normalises first — upper case, whitespace removed — so a learner who typed the code in
 * lower case still gets into the room, and returns null when the input cannot be a code at
 * all. Null means "no room will match this", which the caller answers as
 * `invite_code_invalid`; it never means "try again unnormalised".
 */
export function hashInviteCode(code: string): Buffer | null {
  const normalised = normaliseInviteCode(code);
  return normalised === null ? null : sha256(normalised);
}

/**
 * The digest of an OIDC single-use value: `state`, `nonce`, or the PKCE code verifier.
 *
 * Same unkeyed reasoning as `hashToken`: all three are 256 bits of CSPRNG output from
 * `generateOidcSecret`. Storing the verifier itself would mean a database read could complete
 * somebody else's sign-in, which is the sentence the login-attempt table exists to make
 * false.
 */
export function hashOidcSecret(value: string): Buffer {
  return sha256(value);
}

function keyedDigest(secret: string, domain: string, value: string): Buffer {
  return createHmac('sha256', secret)
    .update(`${domain}:${value.slice(0, MAX_KEYED_INPUT_LENGTH)}`, 'utf8')
    .digest();
}

/**
 * The digest stored in `prl.sessions.ip_hash`. Keyed; the raw address is never stored.
 *
 * Takes `string | undefined` because an injected request and a unix-socket connection have no
 * address, and returns null for those. Null is a column that stays NULL, which is honest —
 * inventing a digest of the word "unknown" would create a bucket that looks like a real
 * address and groups unrelated sessions together.
 */
export function hashIp(secret: string, ip: string | undefined): Buffer | null {
  if (ip === undefined || ip === '') return null;
  return keyedDigest(secret, HMAC_DOMAINS.ip, ip);
}

/** The digest stored in `prl.sessions.user_agent_hash`. Keyed; the raw string is never stored. */
export function hashUserAgent(secret: string, userAgent: string | undefined): Buffer | null {
  if (userAgent === undefined || userAgent === '') return null;
  return keyedDigest(secret, HMAC_DOMAINS.userAgent, userAgent);
}

/**
 * Constant-time equality that tolerates a length mismatch instead of throwing.
 *
 * `crypto.timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_DATA_SIZE` when its two
 * arguments differ in length, and letting that throw is a real bug rather than a tidiness
 * problem. Two of them, in fact:
 *
 * 1. It leaks length through an error path. The caller sees an exception for "wrong length"
 *    and `false` for "right length, wrong bytes" — which is a distinguishable answer about
 *    the shape of the stored secret, delivered by the very function whose job was not to
 *    distinguish anything.
 * 2. In this codebase that exception would reach the single error handler and become
 *    `internal_error`, so a truncated cookie would answer 500 where an invalid one answers
 *    401. That is a free oracle and a confusing one.
 *
 * The fix is to make the comparison itself always run over equal lengths: when the lengths
 * differ, `a` is compared against itself so the loop still executes over the same number of
 * bytes, and the mismatch is folded in afterwards. `&&` evaluates left to right, so the
 * constant-time comparison always happens before the length is consulted, and the function
 * cannot return early.
 *
 * What is deliberately not claimed: this does not hide the length of `a` from timing, because
 * the work is proportional to it. That is fine — `a` is the value the caller computed from
 * its own input, so its length was never a secret. What stays hidden is any information about
 * the *stored* digest beyond the single bit "equal or not".
 */
export function timingSafeEquals(a: Uint8Array, b: Uint8Array): boolean {
  const sameLength = a.length === b.length;
  const right = sameLength ? b : a;
  return timingSafeEqual(a, right) && sameLength;
}

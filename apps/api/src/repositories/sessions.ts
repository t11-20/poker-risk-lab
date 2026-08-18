/**
 * `prl.sessions` and `prl.oidc_login_attempts` — one signed-in browser, and one outbound
 * sign-in attempt.
 *
 * ## The token is never stored
 *
 * `create` mints a 256-bit token, writes `sha256(token)`, and returns the plaintext exactly
 * once — to the caller, which puts it in a signed cookie and forgets it. There is no column it
 * could be recovered from. A database dump, a backup tape, or a `SELECT` by a compromised
 * read-only role therefore yields no credential that can log anyone in, which is the single
 * sentence `prl.sessions` exists to make true.
 *
 * That is also why every function here takes the token **in the clear** and hashes it itself.
 * The alternative — callers hashing before they call — puts the digest computation in six route
 * handlers and makes "did that one remember?" a code-review question forever. Hashing at this
 * boundary means a plaintext token can never reach a query parameter, and there is one line to
 * read to confirm it.
 *
 * ## The login-attempt table is a replay defence, not a cache
 *
 * `state`, `nonce` and the PKCE code verifier are single-use by construction: `consume` is one
 * `UPDATE ... WHERE consumed_at IS NULL ... RETURNING`, and no row coming back means the state
 * was unknown, expired, or already used. See the long comment on `consumeLoginAttempt` — the
 * atomicity there is the whole point of the table.
 */

import type { UserKind } from '@prl/contracts';
import { AppError } from '../errors.ts';
import { hashOidcSecret, hashToken, timingSafeEquals } from './hashing.ts';
import { generateSessionToken, newOidcLoginAttemptId, newSessionId } from './ids.ts';
import { type Db, violationError } from './sql.ts';

/**
 * How long a session lasts if the caller does not say.
 *
 * Fourteen days. Long enough that a learner working through the lessons over a fortnight is not
 * signed out mid-thought, short enough that an abandoned browser on a shared machine stops
 * being a way in. There is no configuration knob for it because there is no deployment in which
 * a *longer* one would be right, and a shorter one is one argument away at the call site.
 */
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * How long an outbound OIDC authorization request stays consumable.
 *
 * Ten minutes. A sign-in that takes longer than that has been abandoned, and the window a
 * stolen `state` is useful in should be as close to the length of the redirect round trip as
 * the slowest honest identity provider allows.
 */
export const OIDC_ATTEMPT_TTL_SECONDS = 10 * 60;

/**
 * Rows deleted per sweep call.
 *
 * The sweeps are bounded because an unbounded `DELETE` on a table nobody has vacuumed for a
 * month is a long exclusive lock on the hot path of every authenticated request. A caller that
 * wants the table empty calls again until it returns 0.
 */
const DEFAULT_SWEEP_LIMIT = 1_000;

/**
 * How long a revoked session's row is kept before the sweep takes it.
 *
 * A day. Long enough that "your other sessions were signed out" can still be shown, short
 * enough that the table does not accumulate rows nobody will ever read.
 */
const REVOKED_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * The local-path rule from `oidc_login_attempts_redirect_is_local`, copied exactly.
 *
 * Copied rather than approximated, because the two halves are load-bearing in different ways:
 * the character class excludes backslash and colon so a full URL cannot be smuggled in, and the
 * `//` refusal is what stops a stored redirect becoming an open redirect (a browser reads
 * `//evil.test/x` as a scheme-relative URL to another origin). Validating here means a bad
 * value is `invalid_request` rather than a check violation dressed up as `internal_error`.
 */
const LOCAL_REDIRECT_PATTERN = /^\/[A-Za-z0-9/_.~%?&=+,;@!$*()-]*$/;
const MAX_REDIRECT_LENGTH = 512;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  readonly userId: string;
  /**
   * Keyed digests, or null. Computed by the caller with `hashIp` / `hashUserAgent`, because
   * they need `sessionCookieSecret` and a repository must not read configuration — see the
   * note at the top of `hashing.ts`.
   */
  readonly ipHash: Buffer | null;
  readonly userAgentHash: Buffer | null;
  readonly ttlSeconds?: number;
}

export interface CreatedSession {
  readonly sessionId: string;
  /**
   * The plaintext token. This is the only moment it exists anywhere; it is not stored, not
   * logged (`logging.ts` censors `sessionToken` and anything matching `/token/i`), and cannot
   * be read back. Put it in the cookie and drop the reference.
   */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Opens a session and returns the raw token once.
 *
 * `expires_at` is computed by the database (`now() + n * interval '1 second'`) rather than by
 * the process, for two reasons. `sessions_expires_after_creation` compares it against a
 * `created_at` the database also defaults, so a client clock that is a minute behind would fail
 * the check on a short TTL; and a fleet whose clocks disagree would otherwise issue sessions
 * with quietly different lifetimes.
 */
export async function create(sql: Db, input: CreateSessionInput): Promise<CreatedSession> {
  const ttlSeconds = input.ttlSeconds ?? SESSION_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60) {
    throw new AppError('internal_error', { logDetail: `refusing a session TTL of ${String(ttlSeconds)}s` });
  }
  const token = generateSessionToken();
  const sessionId = newSessionId();
  try {
    const rows = await sql<{ id: string; expires_at: Date }[]>`
      insert into prl.sessions (id, user_id, token_hash, expires_at, user_agent_hash, ip_hash)
      values (
        ${sessionId},
        ${input.userId},
        ${hashToken(token)},
        now() + (${ttlSeconds}::int * interval '1 second'),
        ${input.userAgentHash},
        ${input.ipHash}
      )
      returning id, expires_at
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new AppError('internal_error', { logDetail: 'session insert returned no row' });
    }
    return { sessionId: row.id, token, expiresAt: row.expires_at };
  } catch (error) {
    const mapped = violationError(error, 'opening a session');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

/** A valid session and the learner it belongs to. */
export interface ResolvedSession {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly user: {
    readonly id: string;
    readonly kind: UserKind;
    readonly displayName: string;
    readonly createdAt: Date;
  };
}

interface ResolvedSessionRow {
  readonly session_id: string;
  readonly token_hash: Buffer;
  readonly expires_at: Date;
  readonly user_id: string;
  readonly kind: UserKind;
  readonly display_name: string;
  readonly user_created_at: Date;
}

/**
 * Resolves a cookie token to a live session and its learner, in one query.
 *
 * One query is a requirement rather than an optimisation. "Fetch the session, then fetch the
 * user" is two round trips on the hot path of every authenticated request, and — worse — it has
 * a window in which the account is deleted between the two, which a caller would have to
 * handle as "valid session, missing user". `join prl.users` removes the case: either both exist
 * or the answer is null.
 *
 * The three conditions are all in the WHERE clause for the same reason. A version that
 * fetched by digest and then checked expiry in JavaScript would work, and would also mean that
 * every future caller had to remember to check — and one that forgot would accept a revoked
 * session. `sessions_token_hash_key` makes the lookup a unique index scan regardless.
 *
 * ## The `timingSafeEquals` re-check
 *
 * The index scan has already established equality, so this is belt and braces, and it is worth
 * saying exactly what it does and does not buy. It does not defend the lookup: a B-tree
 * comparison is not constant time and cannot be made so from here. What it does is guarantee
 * that no future edit to this query — a `like`, a prefix match, a well-meant "case-insensitive
 * for debugging" — can widen it without the comparison failing. The house rule is that digests
 * are compared with `timingSafeEqual`; this is that rule applied at the one place where the
 * digest actually crosses back into JavaScript.
 */
export async function findValidByToken(sql: Db, token: string): Promise<ResolvedSession | null> {
  if (token === '') return null;
  const digest = hashToken(token);
  const rows = await sql<ResolvedSessionRow[]>`
    select
      s.id           as session_id,
      s.token_hash   as token_hash,
      s.expires_at   as expires_at,
      u.id           as user_id,
      u.kind         as kind,
      u.display_name as display_name,
      u.created_at   as user_created_at
      from prl.sessions s
      join prl.users u on u.id = s.user_id
     where s.token_hash = ${digest}
       and s.revoked_at is null
       and s.expires_at > now()
  `;
  const row = rows[0];
  if (row === undefined) return null;
  if (!timingSafeEquals(row.token_hash, digest)) return null;
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      kind: row.kind,
      displayName: row.display_name,
      createdAt: row.user_created_at,
    },
  };
}

/**
 * Slides a session's expiry forward, never past an absolute ceiling.
 *
 * Written to the signature `src/routes/auth.ts` asked for. `ceilingSeconds` is a parameter rather
 * than a constant here because the absolute lifetime is an authentication policy and lives with
 * the session middleware that owns it (`SESSION_ABSOLUTE_TTL_SECONDS` in `src/auth/session.ts`);
 * what belongs in this module is the statement.
 *
 * Three things about that statement are deliberate:
 *
 * - `least(now() + ttl, created_at + ceiling)` computes the new expiry in SQL, so the ceiling is
 *   measured against the database's own `created_at`. A process whose clock is ten minutes fast
 *   cannot extend a session past its absolute lifetime.
 * - The same expression appears in the WHERE clause, so a session already at its ceiling matches
 *   nothing and no row is written. An UPDATE that would be a no-op becomes an index probe, which
 *   matters when this runs on every authenticated request.
 * - `revoked_at is null`, so a session revoked between the lookup and this write is not quietly
 *   brought back to life by its own refresh.
 *
 * Returns the new expiry, or null when nothing moved — unknown session, revoked session, or
 * already at the ceiling. The caller does not need to tell those apart: in all three cases the
 * cookie's expiry simply is not extended.
 */
export async function extendExpiry(
  sql: Db,
  sessionId: string,
  ttlSeconds: number,
  ceilingSeconds: number,
): Promise<Date | null> {
  const rows = await sql<{ expires_at: Date }[]>`
    update prl.sessions
       set expires_at = least(
             now() + (${ttlSeconds}::int * interval '1 second'),
             created_at + (${ceilingSeconds}::int * interval '1 second')
           )
     where id = ${sessionId}
       and revoked_at is null
       and least(
             now() + (${ttlSeconds}::int * interval '1 second'),
             created_at + (${ceilingSeconds}::int * interval '1 second')
           ) > expires_at
    returning expires_at
  `;
  return rows[0]?.expires_at ?? null;
}

/**
 * Revokes one session by id. Idempotent: revoking an already-revoked session returns false and
 * does not move `revoked_at`, so the first revocation's timestamp stays the true one.
 */
export async function revoke(sql: Db, sessionId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update prl.sessions
       set revoked_at = now()
     where id = ${sessionId} and revoked_at is null
    returning id
  `;
  return rows.length > 0;
}

/**
 * Revokes the session a cookie names.
 *
 * Sign-out's natural shape: the caller holds a token, not an id. Deliberately does not require
 * the session to be unexpired — an expired session is already unusable, but leaving its row
 * unrevoked means the "your sessions" list keeps showing it as merely lapsed when the learner
 * explicitly ended it.
 */
export async function revokeByToken(sql: Db, token: string): Promise<boolean> {
  if (token === '') return false;
  const rows = await sql<{ id: string }[]>`
    update prl.sessions
       set revoked_at = now()
     where token_hash = ${hashToken(token)} and revoked_at is null
    returning id
  `;
  return rows.length > 0;
}

export interface RevokeAllOptions {
  /** Keeps one session alive — "sign out my other devices" without signing out this one. */
  readonly exceptSessionId?: string;
}

/**
 * Revokes every live session for a learner, optionally sparing one.
 *
 * The exception is expressed as `(${id}::text is null or id <> ${id})` rather than by building
 * the SQL two ways. One statement means one query plan, one thing to read, and no chance of the
 * two branches drifting apart — and the `::text` cast is there because Postgres cannot infer
 * the type of a parameter that is only ever compared against NULL.
 */
export async function revokeAllForUser(
  sql: Db,
  userId: string,
  options: RevokeAllOptions = {},
): Promise<number> {
  const except = options.exceptSessionId ?? null;
  const rows = await sql<{ id: string }[]>`
    update prl.sessions
       set revoked_at = now()
     where user_id = ${userId}
       and revoked_at is null
       and (${except}::text is null or id <> ${except})
    returning id
  `;
  return rows.length;
}

export interface SweepOptions {
  readonly limit?: number;
}

/**
 * Deletes sessions that are past their expiry, and revoked sessions past their retention.
 *
 * Bounded by `limit`, and the inner `select ... order by expires_at limit n` is what bounds it:
 * `DELETE ... LIMIT` is not valid Postgres, so the rows are chosen by a subquery that the
 * partial index `sessions_expiry_sweep_idx` can walk in order and stop early.
 *
 * Returns how many rows went. A caller that gets `limit` back should call again.
 */
export async function deleteExpired(sql: Db, options: SweepOptions = {}): Promise<number> {
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  const rows = await sql<{ id: string }[]>`
    delete from prl.sessions
     where id in (
       select id
         from prl.sessions
        where expires_at <= now()
           or (
             revoked_at is not null
             and revoked_at <= now() - (${REVOKED_RETENTION_SECONDS}::int * interval '1 second')
           )
        order by expires_at
        limit ${limit}
     )
    returning id
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// OIDC login attempts
// ---------------------------------------------------------------------------

export interface CreateLoginAttemptInput {
  /** Plaintext. Hashed here; only the digest reaches a query parameter. */
  readonly state: string;
  readonly nonce: string;
  readonly pkceVerifier: string;
  /** Site-relative path to return to, or null. Validated against the column's own CHECK. */
  readonly redirectAfter?: string | null;
  readonly ttlSeconds?: number;
}

export interface CreatedLoginAttempt {
  readonly id: string;
  readonly expiresAt: Date;
}

/**
 * Records an outbound authorization request.
 *
 * All three secrets arrive in plaintext and leave as digests. Storing the PKCE verifier itself
 * would mean a database read could complete somebody else's sign-in, so the callback re-derives
 * the digest from the value it holds in its own cookie and compares — which only works if what
 * is stored here is the digest and nothing else.
 *
 * `state_hash` is globally unique (`oidc_login_attempts_state_hash_key`, unique across consumed
 * rows too), so a replayed state cannot create a second attempt to consume. That unique
 * violation is deliberately left unmapped: two attempts with the same state means either the
 * generator repeated itself — which would be a broken CSPRNG and must fail loudly — or somebody
 * is replaying, and a 500 with a full log line is the right answer to both.
 */
export async function createLoginAttempt(
  sql: Db,
  input: CreateLoginAttemptInput,
): Promise<CreatedLoginAttempt> {
  const ttlSeconds = input.ttlSeconds ?? OIDC_ATTEMPT_TTL_SECONDS;
  const redirectAfter = validateRedirectAfter(input.redirectAfter ?? null);
  const id = newOidcLoginAttemptId();
  const rows = await sql<{ id: string; expires_at: Date }[]>`
    insert into prl.oidc_login_attempts (
      id, state_hash, nonce_hash, pkce_verifier_hash, redirect_after, expires_at
    )
    values (
      ${id},
      ${hashOidcSecret(input.state)},
      ${hashOidcSecret(input.nonce)},
      ${hashOidcSecret(input.pkceVerifier)},
      ${redirectAfter},
      now() + (${ttlSeconds}::int * interval '1 second')
    )
    returning id, expires_at
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('internal_error', { logDetail: 'login attempt insert returned no row' });
  }
  return { id: row.id, expiresAt: row.expires_at };
}

/** What a successful consume hands back: the digests the callback still has to check. */
export interface ConsumedLoginAttempt {
  readonly id: string;
  readonly nonceHash: Buffer;
  readonly pkceVerifierHash: Buffer;
  readonly redirectAfter: string | null;
}

/**
 * Consumes an attempt by its state, exactly once, or returns null.
 *
 * ############################################################################
 * ## SINGLE USE IS THE `UPDATE`, NOT A CHECK BEFORE IT                      ##
 * ############################################################################
 *
 * The version that looks correct and is not:
 *
 * ```ts
 * const attempt = await sql`select ... where state_hash = $1 and consumed_at is null`;
 * if (attempt === undefined) return null;
 * await sql`update ... set consumed_at = now() where id = $2`;
 * ```
 *
 * Two callbacks carrying the same `state` — a double-submitted redirect, a retried request, an
 * attacker replaying a captured URL — both run the SELECT before either runs the UPDATE. Both
 * see `consumed_at IS NULL`. Both proceed. The single-use property is gone, and with it the
 * replay defence the whole table exists for. The window is small and entirely reachable: it is
 * exactly one network round trip wide.
 *
 * One statement closes it. `UPDATE ... WHERE consumed_at IS NULL ... RETURNING` performs the
 * test and the write under the same row lock, so the second caller's UPDATE waits, re-evaluates
 * its WHERE against the committed result, matches nothing, and returns no rows. There is no
 * interval between the check and the write because there is no separate check.
 *
 * `expires_at > now()` rides along in the same predicate, so an expired attempt is also a
 * no-match and is never consumed. And note what the return value cannot distinguish: unknown
 * state, expired state, and already-used state all produce null. The callback answers
 * `oidc_state_mismatch` for all three, because telling a caller which of the three it was tells
 * them whether they guessed a real state.
 */
export async function consumeLoginAttempt(sql: Db, state: string): Promise<ConsumedLoginAttempt | null> {
  if (state === '') return null;
  const rows = await sql<
    { id: string; nonce_hash: Buffer; pkce_verifier_hash: Buffer; redirect_after: string | null }[]
  >`
    update prl.oidc_login_attempts
       set consumed_at = now()
     where state_hash = ${hashOidcSecret(state)}
       and consumed_at is null
       and expires_at > now()
    returning id, nonce_hash, pkce_verifier_hash, redirect_after
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    nonceHash: row.nonce_hash,
    pkceVerifierHash: row.pkce_verifier_hash,
    redirectAfter: row.redirect_after,
  };
}

/**
 * Deletes attempts that were never completed and are past their expiry.
 *
 * Consumed rows are swept too, once expired. Keeping them forever would not add a replay
 * defence — `expires_at > now()` in `consumeLoginAttempt` already refuses an old state whether
 * the row is there or not — and an ever-growing table of digests is a liability with no
 * corresponding benefit.
 */
export async function deleteExpiredLoginAttempts(sql: Db, options: SweepOptions = {}): Promise<number> {
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  const rows = await sql<{ id: string }[]>`
    delete from prl.oidc_login_attempts
     where id in (
       select id from prl.oidc_login_attempts where expires_at <= now() order by expires_at limit ${limit}
     )
    returning id
  `;
  return rows.length;
}

function validateRedirectAfter(value: string | null): string | null {
  if (value === null) return null;
  const problem =
    value.length > MAX_REDIRECT_LENGTH
      ? `must be at most ${MAX_REDIRECT_LENGTH} characters`
      : value.startsWith('//')
        ? 'must not start with "//", which browsers read as another origin'
        : LOCAL_REDIRECT_PATTERN.test(value)
          ? null
          : 'must be a site-relative path';
  if (problem === null) return value;
  throw new AppError('invalid_request', {
    fields: { redirectAfter: problem },
    // The value itself is not logged: it is caller-supplied text on the sign-in path, and
    // `logging.ts` exists because caller-supplied text in a log line is its own problem.
    logDetail: `rejected a post-login redirect target: ${problem}`,
  });
}

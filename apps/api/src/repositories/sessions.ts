/**
 * `prl.sessions` and `prl.oidc_login_attempts`.
 *
 * The session token is never stored. `create` writes `sha256(token)` and returns the plaintext once,
 * so a dump or a read-only role yields no usable credential. Every function takes the token in the
 * clear and hashes it here, so a plaintext token never reaches a query parameter.
 *
 * Login attempts are a replay defence. `consumeLoginAttempt` is single-use by construction.
 */

import type { UserKind } from '@prl/contracts';
import { AppError } from '../errors.ts';
import { hashOidcSecret, hashToken, timingSafeEquals } from './hashing.ts';
import { generateSessionToken, newOidcLoginAttemptId, newSessionId } from './ids.ts';
import { type Db, violationError } from './sql.ts';

/** Fourteen days. No configuration knob, because no deployment needs a longer one. */
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Ten minutes. Keeps the window a stolen `state` is useful in close to one redirect round trip. */
export const OIDC_ATTEMPT_TTL_SECONDS = 10 * 60;

/**
 * Rows deleted per sweep call. An unbounded `DELETE` on an unvacuumed table holds a long lock on the
 * hot path of every authenticated request. A caller that wants the table empty calls until it gets 0.
 */
const DEFAULT_SWEEP_LIMIT = 1_000;

/** A day, so "your other sessions were signed out" can still be shown. */
const REVOKED_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * Copied exactly from `oidc_login_attempts_redirect_is_local`. The character class excludes
 * backslash and colon so a full URL cannot be smuggled in, and the `//` refusal stops an open
 * redirect. Validating here makes a bad value `invalid_request` instead of `internal_error`.
 */
const LOCAL_REDIRECT_PATTERN = /^\/[A-Za-z0-9/_.~%?&=+,;@!$*()-]*$/;
const MAX_REDIRECT_LENGTH = 512;

export interface CreateSessionInput {
  readonly userId: string;
  /** Keyed digests from `hashIp` / `hashUserAgent`, computed by the caller (see `hashing.ts`). */
  readonly ipHash: Buffer | null;
  readonly userAgentHash: Buffer | null;
  readonly ttlSeconds?: number;
}

export interface CreatedSession {
  readonly sessionId: string;
  /** The only moment the plaintext exists. It is not stored and cannot be read back. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Opens a session and returns the raw token once.
 *
 * The database computes `expires_at`, because `sessions_expires_after_creation` compares it with a
 * database-defaulted `created_at` and a lagging process clock would fail the check on a short TTL.
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
 * The join removes the "valid session, deleted user" case, and expiry and revocation sit in the
 * WHERE clause so no caller can forget to check them. The `timingSafeEquals` re-check does not make
 * the B-tree lookup constant time. It makes any future widening of the query (a `like`, a prefix
 * match) fail the comparison.
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
 * Slides a session's expiry forward, never past `created_at + ceilingSeconds`.
 *
 * The ceiling is a parameter because the absolute lifetime is auth policy
 * (`SESSION_ABSOLUTE_TTL_SECONDS` in `src/auth/session.ts`). The new expiry is computed in SQL, so a
 * fast process clock cannot extend past the ceiling. The same expression in the WHERE clause turns a
 * no-op update into an index probe. `revoked_at is null` stops a refresh reviving a session revoked
 * since the lookup. Returns null when nothing moved.
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

/** Idempotent. A second revoke returns false and keeps the first `revoked_at`. */
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
 * Revokes the session a cookie names. Expired sessions are revoked too, so the sessions list shows
 * an explicit sign-out as ended rather than lapsed.
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
  readonly exceptSessionId?: string;
}

/**
 * Revokes every live session for a learner, optionally sparing one. The `::text` cast is needed
 * because Postgres cannot infer the type of a parameter only compared against NULL.
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
 * Deletes expired sessions and revoked sessions past retention, at most `limit` rows. Postgres has
 * no `DELETE ... LIMIT`, so a subquery walks `sessions_expiry_sweep_idx` in order.
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

export interface CreateLoginAttemptInput {
  /** Plaintext. Hashed here. */
  readonly state: string;
  readonly nonce: string;
  readonly pkceVerifier: string;
  readonly redirectAfter?: string | null;
  readonly ttlSeconds?: number;
}

export interface CreatedLoginAttempt {
  readonly id: string;
  readonly expiresAt: Date;
}

/**
 * Records an outbound authorization request. All three secrets are stored only as digests, so a
 * database read cannot complete somebody else's sign-in.
 *
 * A duplicate `state_hash` is deliberately left unmapped. It means a broken CSPRNG or a replay, and
 * a 500 with a full log line is right for both.
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

/** The digests the callback still has to check. */
export interface ConsumedLoginAttempt {
  readonly id: string;
  readonly nonceHash: Buffer;
  readonly pkceVerifierHash: Buffer;
  readonly redirectAfter: string | null;
}

/**
 * Consumes an attempt by its state, exactly once, or returns null.
 *
 * Single use is the `UPDATE ... WHERE consumed_at IS NULL ... RETURNING` itself. A SELECT followed by
 * an UPDATE lets two callbacks with the same `state` both pass the check. One statement does the test
 * and the write under the same row lock, so the second caller matches nothing.
 *
 * Unknown, expired and already-used states all return null, and the callback answers
 * `oidc_state_mismatch` for all three so a caller cannot learn whether a guessed state was real.
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
 * Deletes expired attempts, consumed or not. Keeping consumed rows adds no replay defence, because
 * `consumeLoginAttempt` already refuses an expired state.
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
    // The caller-supplied value is not logged.
    logDetail: `rejected a post-login redirect target: ${problem}`,
  });
}

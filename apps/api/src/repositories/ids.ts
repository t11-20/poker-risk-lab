/**
 * Every random value this server mints, all from `randomBytes`, because a guessable id enumerates rooms.
 * Ids are minted before the write, because the engine bakes `handId` into the commitment context.
 * The format must satisfy `prl.prefixed_id`, each table's prefix CHECK, and the contracts' `ID_PATTERN`,
 * which requires lowercase. So ids are 26 base32 characters, not base64url. That is 130 bits, because a
 * hand id in a URL is also a capability behind the review endpoint's authorisation check.
 */

import { randomBytes } from 'node:crypto';

/** RFC 4648 base32, lower case. 32 symbols, so `byte % 32` is exactly uniform. */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * 31 symbols that survive transcription. `0`, `O`, `1`, `I` and `L` are all excluded, because keeping
 * either member of a confusable pair leaves the ambiguity. Codes are upper case only.
 */
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const ID_RANDOM_LENGTH = 26;

/** Excluding the group separators. 16 x log2(31) = 79.3 bits. */
const INVITE_CODE_LENGTH = 16;
const INVITE_GROUP_SIZE = 4;

/**
 * Refused unread above this. The route caps the field at 32, but this is also reachable from the
 * WebSocket path, so it does not trust a route to have validated it.
 */
const MAX_INVITE_CODE_INPUT = 64;

/**
 * `count` uniformly random characters from `alphabet`.
 *
 * Bytes at or above the largest multiple of `size` are discarded, because `byte % 31` would favour the
 * first eight symbols by about 3%. For a 32-symbol alphabet nothing is discarded. `%` rather than bit
 * masks, because `biome.json` enables bitwise operators only in the engine and math packages.
 */
function randomCharacters(alphabet: string, count: number): string {
  const size = alphabet.length;
  const limit = 256 - (256 % size);
  let out = '';
  while (out.length < count) {
    // Over-draw by an eighth so one `randomBytes` call almost always suffices.
    const wanted = count - out.length;
    for (const byte of randomBytes(wanted + Math.ceil(wanted / 8) + 1)) {
      if (out.length >= count) break;
      if (byte >= limit) continue;
      const symbol = alphabet[byte % size];
      // Always defined. The guard satisfies `noUncheckedIndexedAccess` without a non-null assertion.
      if (symbol !== undefined) out += symbol;
    }
  }
  return out;
}

/**
 * Every id prefix, copied from the CHECK constraints in migration 0001. A mismatch fails the insert,
 * which is intended. The login-attempt prefix is `oidc`, not `att`.
 */
export const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  oidcLoginAttempt: 'oidc',
  room: 'room',
  roomMember: 'mem',
  hand: 'hand',
  handSeat: 'hseat',
  handAction: 'act',
  lessonProgress: 'lprog',
  quizAttempt: 'qatt',
  scenarioAttempt: 'satt',
  auditEvent: 'aud',
  cohort: 'coh',
  enrolment: 'enr',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Prefer the named helpers below; this exists for tests and loops. */
export function generateId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomCharacters(ID_ALPHABET, ID_RANDOM_LENGTH)}`;
}

export function newUserId(): string {
  return generateId('user');
}
export function newSessionId(): string {
  return generateId('session');
}
export function newOidcLoginAttemptId(): string {
  return generateId('oidcLoginAttempt');
}
export function newRoomId(): string {
  return generateId('room');
}
export function newRoomMemberId(): string {
  return generateId('roomMember');
}
export function newHandId(): string {
  return generateId('hand');
}
export function newHandSeatId(): string {
  return generateId('handSeat');
}
export function newHandActionId(): string {
  return generateId('handAction');
}
export function newLessonProgressId(): string {
  return generateId('lessonProgress');
}
export function newQuizAttemptId(): string {
  return generateId('quizAttempt');
}
export function newScenarioAttemptId(): string {
  return generateId('scenarioAttempt');
}
export function newAuditEventId(): string {
  return generateId('auditEvent');
}
export function newCohortId(): string {
  return generateId('cohort');
}
export function newEnrolmentId(): string {
  return generateId('enrolment');
}

/** Exported so tests assert it against the migration's domain and the contracts' `ID_PATTERN`. */
export const GENERATED_ID_PATTERN = /^[a-z]{3,6}_[a-z2-7]{26}$/;

export function isIdOfKind(value: string, kind: IdKind): boolean {
  return GENERATED_ID_PATTERN.test(value) && value.startsWith(`${ID_PREFIXES[kind]}_`);
}

/**
 * A room invite code, shown to the owner once. Only `sha256(code)` is stored, so it cannot be
 * recovered from the database. 79.3 bits, because it is the only guard on a private table and is
 * never rotated.
 *
 * The hyphens are hashed as part of the code. The dev seed stores the digest of `PRL-DEV-ROOM-1`, so
 * stripping hyphens would make the development room unjoinable. The result is 19 characters, within
 * `joinRoomBodySchema`'s `^[A-Za-z0-9-]{8,32}$`.
 */
export function generateInviteCode(): string {
  const raw = randomCharacters(INVITE_ALPHABET, INVITE_CODE_LENGTH);
  const groups: string[] = [];
  for (let start = 0; start < raw.length; start += INVITE_GROUP_SIZE) {
    groups.push(raw.slice(start, start + INVITE_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Upper-cases and drops all whitespace, or returns null. Over-long input is refused, not truncated,
 * because truncation would map two different strings to one code. Hyphens survive (see
 * `generateInviteCode`). The alphabet is not validated, because an invalid code hashes to no room.
 */
export function normaliseInviteCode(raw: string): string | null {
  if (raw.length > MAX_INVITE_CODE_INPUT) return null;
  const collapsed = raw.replace(/\s+/gu, '').toUpperCase();
  return collapsed === '' ? null : collapsed;
}

/** Exported for the tests, which assert that no ambiguous character can appear in a code. */
export const INVITE_CODE_ALPHABET = INVITE_ALPHABET;

const SECRET_BYTES = 32;

/**
 * A 256-bit secret, base64url encoded. A secret never appears in a path, so case is free, and
 * base64url is safe in `Set-Cookie` and OAuth query parameters. 32 bytes encode to 43 characters, the
 * RFC 7636 minimum for a PKCE verifier. 256 bits is why `hashToken` needs no key.
 */
export function generateOpaqueSecret(byteLength: number = SECRET_BYTES): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Returned to the caller once; only its digest is ever stored. */
export function generateSessionToken(): string {
  return generateOpaqueSecret();
}

/**
 * One OIDC `state`, `nonce` or PKCE verifier. Call it once per value. A `state` reused as a `nonce`
 * would make the CSRF check and the ID-token replay check the same check.
 */
export function generateOidcSecret(): string {
  return generateOpaqueSecret();
}

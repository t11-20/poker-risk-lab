/**
 * Identifier and secret generation. Every random value this server mints starts here.
 *
 * ## Why prefixed, application-generated ids
 *
 * `db/migrations/0001_initial.sql` explains the schema side of this decision; the code side
 * is that the server has to be able to mint an id *before* it writes. The engine builds a
 * whole `HandState` — with `handId` already baked into the commitment context — before any
 * row exists, so a serial or a database default could not work at all.
 *
 * Three constraints bound the format, and all three come from files that are not this one:
 *
 * 1. `prl.prefixed_id` (migration 0001): `^[a-z]{3,6}_[A-Za-z0-9_-]{8,64}$`.
 * 2. Each table's own prefix CHECK: `users_id_prefix` wants `^usr_`, `hand_seats_id_prefix`
 *    wants `^hseat_`, and so on. The prefixes below are copied from those constraints, not
 *    chosen here.
 * 3. `ID_PATTERN` in `packages/contracts/src/schemas.ts`: `^[a-z0-9][a-z0-9_-]{0,63}$`. This
 *    is the one that is easy to miss and it is the strictest of the three — an id that
 *    reaches a route as a path parameter must be **lowercase** and at most 64 characters.
 *    A mixed-case id (base64url, a UUID with capitals, anything) would be minted happily,
 *    stored happily, and then rejected by the router the first time somebody tried to fetch
 *    the thing it names.
 *
 * ## The entropy, stated exactly
 *
 * The random part of every id is 26 characters drawn from a 32-symbol lowercase alphabet
 * (`a`-`z` plus `2`-`7`, RFC 4648 base32 in lower case). Each character is one uniformly
 * random symbol, so each carries exactly log2(32) = 5 bits:
 *
 *     26 characters x 5 bits = 130 bits of entropy per id.
 *
 * Uniform, not merely "random": 256 is an exact multiple of 32, so `byte % 32` maps the 256
 * byte values onto the 32 symbols eight apiece with no remainder and therefore no bias. That
 * arithmetic is why the alphabet size is a power of two — see `generateInviteCode` below for
 * what happens when it cannot be.
 *
 * 130 bits is more than a collision bound needs (a birthday collision among a billion ids
 * would still sit around 2^-70) and it is deliberately generous, because some of these ids
 * are also capabilities: a hand id appears in a URL, and the review endpoint's authorisation
 * check is the only thing between it and someone else's hand history. An id nobody can guess
 * is defence in depth behind that check, and 130 bits is unguessable in any universe.
 *
 * ## Why base32 and not base64url
 *
 * Case. Base64url would fit the database domain and be four characters shorter, but it is
 * mixed case, and `ID_PATTERN` above forbids capitals. Lowercase base32 also survives every
 * case-folding step a URL, a log pipeline or a copy-paste can put an id through, and it can
 * never be broken by a comparison that someone wrote case-insensitively.
 *
 * ## `Math.random` appears nowhere in this file
 *
 * Every value here comes from `randomBytes`, which is the CSPRNG. That is a release-blocking
 * rule, and it applies to ids and not only to secrets: a guessable id is a way to enumerate
 * rooms and hands.
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Alphabets
// ---------------------------------------------------------------------------

/**
 * RFC 4648 base32, lower case. 32 symbols, so `byte % 32` is exactly uniform.
 *
 * Note what is absent: `0`, `1`, `8` and `9` are not in base32 at all, which happens to make
 * an id free of the digits most often confused with letters. That is a side effect, not the
 * point — ids are copied, never dictated.
 */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * The invite-code alphabet: 31 symbols, chosen so a person can read a code off a screen and
 * type it somewhere else without a support ticket.
 *
 * Excluded, and why:
 *   - `0` and `O`, `1` and `I` and `L` — the four classic transcription failures. All five
 *     characters are gone rather than just one of each pair, because "which one did they
 *     mean" is the problem, and keeping either member of a confusable pair leaves it.
 *   - lower case entirely. A code is displayed and compared in upper case, so there is no
 *     `l`/`1` ambiguity left to have.
 *
 * What remains is `2`-`9` (8 symbols) and `A`-`Z` minus `I`, `L`, `O` (23 symbols): 31.
 */
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Random characters in the id portion of every prefixed id. See the entropy note above. */
const ID_RANDOM_LENGTH = 26;

/** Invite-code characters, excluding the group separators. 16 x log2(31) = 79.3 bits. */
const INVITE_CODE_LENGTH = 16;
/** Characters per readable group: `XXXX-XXXX-XXXX-XXXX`. */
const INVITE_GROUP_SIZE = 4;

/**
 * Longest a candidate invite code may be before it is refused unread.
 *
 * `joinRoomBodySchema` already caps the field at 32 characters, but a repository must not
 * depend on a route having validated its input: this function is also reachable from the
 * WebSocket path and from a future admin tool. 64 is comfortably above any real code and
 * well below "somebody is posting a megabyte to make us hash it".
 */
const MAX_INVITE_CODE_INPUT = 64;

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * `count` uniformly random characters from `alphabet`.
 *
 * The rejection step is the part that matters. For an alphabet whose size does not divide
 * 256, `byte % size` is biased: with 31 symbols, bytes 0..7 map to the first eight symbols
 * one extra time each, so those symbols come up about 3% more often than the rest. Over a
 * 16-character code that is a measurable dent in the entropy, and "measurable dent" is not a
 * thing to accept in a value whose only job is to be unguessable. Discarding every byte at
 * or above the largest multiple of `size` removes the bias exactly, at the cost of throwing
 * away 8 bytes in 256.
 *
 * For a 32-symbol alphabet `limit` is 256, nothing is ever discarded, and this is a plain
 * modulo — which is why the id path pays nothing for the invite path's correctness.
 *
 * Written with `%` and `>=` rather than bit masks on purpose: bitwise operators are enabled
 * only for `packages/poker-engine` and `packages/poker-math` in `biome.json`, and there is
 * no performance argument for them here.
 */
function randomCharacters(alphabet: string, count: number): string {
  const size = alphabet.length;
  const limit = 256 - (256 % size);
  let out = '';
  while (out.length < count) {
    // Over-draw by an eighth so the loop almost always runs once. `randomBytes` is a syscall
    // per call; asking for one byte at a time would be the slow way to do this.
    const wanted = count - out.length;
    for (const byte of randomBytes(wanted + Math.ceil(wanted / 8) + 1)) {
      if (out.length >= count) break;
      if (byte >= limit) continue;
      const symbol = alphabet[byte % size];
      // `noUncheckedIndexedAccess` makes this `string | undefined`. It cannot actually be
      // undefined — `byte % size` is in range by construction — and the guard is how that is
      // expressed without a non-null assertion, which the linter rejects for good reasons.
      if (symbol !== undefined) out += symbol;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prefixes
// ---------------------------------------------------------------------------

/**
 * Every id prefix in the schema, keyed by what it names.
 *
 * Each value is checked by a CHECK constraint in migration 0001. Changing one here without
 * changing the migration produces an insert that fails at the database, which is the
 * intended failure: an id whose prefix does not match its table is how a room id ends up
 * being passed to a user lookup.
 *
 * `oidc` is worth a note because it is the one that surprises people: the login-attempt
 * table's constraint is `id ~ '^oidc_'`, not `att_`. The prefix is four letters, which the
 * `[a-z]{3,6}` part of the domain allows.
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

/** Mints one id. Prefer the named helpers below; this exists for tests and loops. */
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

/**
 * The shape every generated id has, as one pattern.
 *
 * Exported so the tests can assert it against the migration's domain and against
 * `ID_PATTERN` from the contracts, rather than against a copy of the rule written twice.
 */
export const GENERATED_ID_PATTERN = /^[a-z]{3,6}_[a-z2-7]{26}$/;

/** True when `value` looks like an id this server minted for `kind`. */
export function isIdOfKind(value: string, kind: IdKind): boolean {
  return GENERATED_ID_PATTERN.test(value) && value.startsWith(`${ID_PREFIXES[kind]}_`);
}

// ---------------------------------------------------------------------------
// Invite codes
// ---------------------------------------------------------------------------

/**
 * A room invite code, shown to the owner exactly once.
 *
 * ## Only the hash is stored
 *
 * `prl.rooms.invite_code_hash` holds `sha256(code)` and there is no column for the code
 * itself, so this string cannot be recovered from the database by anyone — us included.
 * `CreateRoomResponse.inviteCode` is the single moment it exists outside this function's
 * return value; if the owner loses it they create another room. That is the deal, and it is
 * the reason a database read cannot join a stranger's private table.
 *
 * ## The entropy, stated exactly
 *
 * 16 characters from a 31-symbol alphabet, each uniformly distributed (see
 * `randomCharacters` for why "uniformly" needed work):
 *
 *     16 x log2(31) = 16 x 4.954 = 79.3 bits.
 *
 * Comfortably past the 60-bit floor, and the margin is spent on purpose. An invite code is
 * the *only* thing protecting a private table, it is guessable by anyone who can send
 * requests, and unlike a password it is never rotated. The rate limiter makes online
 * guessing expensive; 79 bits makes it pointless.
 *
 * ## Why the hyphens are part of the code
 *
 * `PRLX-8H4K-...` is transcribed correctly far more often than the same 16 characters in a
 * row, and grouping is most of the reason. The separators are significant — they are hashed
 * along with everything else — because `normaliseInviteCode` deliberately does not strip
 * them: `db/seeds/0001_dev_seed.sql` stores `sha256(convert_to('PRL-DEV-ROOM-1','utf8'))`,
 * and a normaliser that removed hyphens would make the development room unjoinable by its
 * own documented code. Case is folded, because that costs nothing and no seeded code
 * contains a lower-case letter.
 *
 * The result is 19 characters, which satisfies `joinRoomBodySchema`'s
 * `^[A-Za-z0-9-]{8,32}$`.
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
 * Canonical form of a code a person typed, or null when it cannot be one.
 *
 * Upper-cases and drops surrounding and internal whitespace — a code pasted out of a chat
 * message picks up both — and refuses anything longer than `MAX_INVITE_CODE_INPUT`. Refusing
 * rather than truncating is the point: truncation would make two different long strings
 * normalise to the same code, which is a way to turn a typo into somebody else's table.
 *
 * Nothing else is changed. In particular hyphens survive, for the seed-compatibility reason
 * given on `generateInviteCode`, and no attempt is made to validate the alphabet: an invalid
 * code simply hashes to something no room has, and the caller answers
 * `invite_code_invalid`. Fail closed, with one code path.
 */
export function normaliseInviteCode(raw: string): string | null {
  if (raw.length > MAX_INVITE_CODE_INPUT) return null;
  const collapsed = raw.replace(/\s+/gu, '').toUpperCase();
  return collapsed === '' ? null : collapsed;
}

/** Exported for the tests, which assert that no ambiguous character can appear in a code. */
export const INVITE_CODE_ALPHABET = INVITE_ALPHABET;

// ---------------------------------------------------------------------------
// Opaque secrets
// ---------------------------------------------------------------------------

/** Bytes behind a session token and behind each OIDC single-use value. */
const SECRET_BYTES = 32;

/**
 * A 256-bit opaque secret, base64url encoded.
 *
 * Base64url rather than the lowercase base32 used for ids, and the reason is that the two
 * values have opposite constraints. An id is a path parameter and must be lowercase; a
 * secret never appears in a path. What a secret does need is to survive a `Set-Cookie` and
 * an OAuth query parameter, and base64url's alphabet (`A-Za-z0-9-_`) is safe in both without
 * escaping. It is also exactly the alphabet RFC 7636 requires of a PKCE code verifier, and
 * 32 bytes encodes to 43 characters, which is that spec's minimum length.
 *
 * 256 bits is the reason `hashToken` in `hashing.ts` needs no key: there is no dictionary to
 * build against an input drawn uniformly from 2^256 values.
 */
export function generateOpaqueSecret(byteLength: number = SECRET_BYTES): string {
  return randomBytes(byteLength).toString('base64url');
}

/** The raw session token. Returned to the caller once; only its digest is ever stored. */
export function generateSessionToken(): string {
  return generateOpaqueSecret();
}

/**
 * One OIDC single-use value: `state`, `nonce`, or the PKCE code verifier.
 *
 * All three are the same shape and the same size, and all three are stored only as digests
 * (`prl.oidc_login_attempts`), so one generator is right for all of them. Three independent
 * calls, never one value reused for two purposes — a `state` that doubled as a `nonce` would
 * make the CSRF check and the ID-token replay check the same check.
 */
export function generateOidcSecret(): string {
  return generateOpaqueSecret();
}

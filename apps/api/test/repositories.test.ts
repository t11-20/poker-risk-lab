/**
 * Repository-layer tests.
 *
 * Two halves, and the split is deliberate.
 *
 * The first half needs no database at all. Id shapes, entropy, the invite-code alphabet, keyed
 * hashing, constant-time comparison, audit redaction, cursor parsing and every input rule that a
 * repository enforces before it issues a query are all pure functions, and testing them as pure
 * functions is the only way the assertions stay about the property rather than about Postgres. A
 * uniformity check over 640,000 generated characters is a sensible unit test; it would be an
 * absurd integration test.
 *
 * The second half needs Postgres, and skips with a printed reason when `DATABASE_URL` is absent or
 * the schema has not been migrated. `pnpm test` has to pass on a laptop with no database — that is
 * a house rule, and a suite that quietly passes because it silently ran nothing would break it in
 * the other direction, hence the printed reason.
 *
 * Every database case runs inside a transaction that is rolled back afterwards (see `inRollback`),
 * so the suite leaves no rows behind, can be run against a seeded development database, and cannot
 * make one case depend on another's leftovers.
 */

import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { ErrorCode } from '@prl/contracts';
import { COMMITMENT_VERSION, type HandResult, parseCard } from '@prl/poker-engine';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql, type TransactionSql } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { isSensitiveKey } from '../src/logging.ts';
import * as audit from '../src/repositories/audit.ts';
import * as hands from '../src/repositories/hands.ts';
import {
  DIGEST_BYTES,
  hashInviteCode,
  hashIp,
  hashOidcSecret,
  hashToken,
  hashUserAgent,
  sha256,
  timingSafeEquals,
} from '../src/repositories/hashing.ts';
import {
  GENERATED_ID_PATTERN,
  generateId,
  generateInviteCode,
  generateOpaqueSecret,
  generateSessionToken,
  ID_PREFIXES,
  type IdKind,
  INVITE_CODE_ALPHABET,
  isIdOfKind,
  normaliseInviteCode,
} from '../src/repositories/ids.ts';
import * as progress from '../src/repositories/progress.ts';
import * as rooms from '../src/repositories/rooms.ts';
import * as sessions from '../src/repositories/sessions.ts';
import * as users from '../src/repositories/users.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

// ---------------------------------------------------------------------------
// Rules copied from files that are not this one
// ---------------------------------------------------------------------------

/**
 * `prl.prefixed_id`'s domain constraint, from `db/migrations/0001_initial.sql`.
 *
 * Copied rather than imported, because that is the point of the test: if the generator and the
 * domain ever disagree, one of these two literals is wrong and the test says which.
 */
const PREFIXED_ID_DOMAIN = /^[a-z]{3,6}_[A-Za-z0-9_-]{8,64}$/;

/** `ID_PATTERN` from `packages/contracts/src/schemas.ts` — the router's rule. Lowercase only. */
const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `joinRoomBodySchema.inviteCode`'s pattern, likewise copied on purpose. */
const ROUTE_INVITE_PATTERN = /^[A-Za-z0-9-]{8,32}$/;

/** `handListQuerySchema.cursor`'s pattern. */
const ROUTE_CURSOR_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;

/**
 * Every table's id prefix, copied straight out of the migration's CHECK constraints.
 *
 * `oidc_` is the one worth staring at: `oidc_login_attempts_id_prefix` wants `^oidc_`, not `att_`.
 */
const MIGRATION_PREFIXES: Readonly<Record<IdKind, string>> = {
  user: 'usr_',
  session: 'ses_',
  oidcLoginAttempt: 'oidc_',
  room: 'room_',
  roomMember: 'mem_',
  hand: 'hand_',
  handSeat: 'hseat_',
  handAction: 'act_',
  lessonProgress: 'lprog_',
  quizAttempt: 'qatt_',
  scenarioAttempt: 'satt_',
  auditEvent: 'aud_',
};

const ID_KINDS = Object.keys(ID_PREFIXES) as readonly IdKind[];

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';
const OTHER_SECRET = 'Qw9zX2mB7vN4kL6pR1tY8hJ3gF5dS0aC';

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

describe('ids — shape', () => {
  it('every kind produces an id all three rulebooks accept', () => {
    for (const kind of ID_KINDS) {
      const id = generateId(kind);
      const expectedPrefix = MIGRATION_PREFIXES[kind];
      assert.ok(id.startsWith(expectedPrefix), `${kind} produced "${id}", expected ${expectedPrefix}...`);
      assert.match(id, GENERATED_ID_PATTERN, `${kind}: ${id}`);
      assert.match(id, PREFIXED_ID_DOMAIN, `${kind} must satisfy prl.prefixed_id: ${id}`);
      // The strictest of the three, and the one that is easy to forget: an id reaching a route as
      // a path parameter must be lowercase and at most 64 characters.
      assert.match(id, ROUTE_ID_PATTERN, `${kind} must satisfy the router's ID_PATTERN: ${id}`);
      assert.ok(id.length <= 64, `${kind} produced a ${id.length}-character id`);
      assert.equal(id, id.toLowerCase(), `${kind} produced a mixed-case id: ${id}`);
      assert.ok(isIdOfKind(id, kind));
    }
  });

  it('the prefix table matches the migration exactly', () => {
    for (const kind of ID_KINDS) {
      assert.equal(`${ID_PREFIXES[kind]}_`, MIGRATION_PREFIXES[kind], `prefix drift for ${kind}`);
    }
  });

  it('an id of one kind is not an id of another', () => {
    assert.equal(isIdOfKind(generateId('room'), 'user'), false);
    assert.equal(isIdOfKind('usr_notbase32!!', 'user'), false);
    assert.equal(isIdOfKind('usr_tooshort', 'user'), false);
    // The seeded ids are legal for the domain but were not minted by this generator, and
    // `isIdOfKind` is about the generator's output rather than about validity.
    assert.equal(isIdOfKind('usr_devseed_alice', 'user'), false);
  });

  it('the random part carries 130 bits: 26 characters over a 32-symbol alphabet', () => {
    const id = generateId('hand');
    const random = id.slice('hand_'.length);
    assert.equal(random.length, 26);
    const alphabet = new Set('abcdefghijklmnopqrstuvwxyz234567');
    for (const char of random) assert.ok(alphabet.has(char), `unexpected id character "${char}"`);
  });

  it('generates 100,000 ids with no collision', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 100_000; index += 1) seen.add(generateId('user'));
    assert.equal(seen.size, 100_000, 'a collision at 100k means the generator is not what it claims');
  });
});

// ---------------------------------------------------------------------------
// invite codes
// ---------------------------------------------------------------------------

describe('ids — invite codes', () => {
  it('excludes every ambiguous character', () => {
    for (const ambiguous of ['0', 'O', '1', 'I', 'L', 'l']) {
      assert.equal(
        INVITE_CODE_ALPHABET.includes(ambiguous),
        false,
        `"${ambiguous}" must not be in the invite alphabet: it is unreadable next to its twin`,
      );
    }
    assert.equal(INVITE_CODE_ALPHABET.length, 31);
    assert.equal(INVITE_CODE_ALPHABET, INVITE_CODE_ALPHABET.toUpperCase());
  });

  it('is grouped, upper case, and inside the route schema', () => {
    const code = generateInviteCode();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, code);
    assert.equal(code.length, 19);
    assert.match(code, ROUTE_INVITE_PATTERN, `must satisfy joinRoomBodySchema: ${code}`);
  });

  it('never emits an ambiguous character across 40,000 codes, and never repeats one', () => {
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const symbol of INVITE_CODE_ALPHABET) counts.set(symbol, 0);

    for (let index = 0; index < 40_000; index += 1) {
      const code = generateInviteCode();
      seen.add(code);
      for (const char of code.replaceAll('-', '')) {
        const current = counts.get(char);
        assert.notEqual(current, undefined, `"${char}" is not in the invite alphabet`);
        counts.set(char, (current ?? 0) + 1);
      }
    }
    assert.equal(seen.size, 40_000, 'invite codes must not repeat');

    /**
     * The rejection-sampling check.
     *
     * 256 is not a multiple of 31, so a naive `byte % 31` gives the first eight symbols nine of the
     * 256 byte values each and the rest eight: 9/256 against 8/256, which is 9% above uniform for
     * a third of the alphabet. Over 640,000 characters the standard deviation of a symbol's count
     * is about 142, so a 4% tolerance is nearly six sigma of headroom against a false failure
     * while a 9% bias misses it by a mile. In other words: this test passes with the rejection
     * step and fails without it.
     */
    const total = 40_000 * 16;
    const expected = total / INVITE_CODE_ALPHABET.length;
    for (const [symbol, count] of counts) {
      const drift = Math.abs(count - expected) / expected;
      assert.ok(
        drift < 0.04,
        `"${symbol}" appeared ${count} times, expected about ${Math.round(expected)} ` +
          `(${(drift * 100).toFixed(1)}% off) — the modulo bias is back`,
      );
    }
  });

  it('normalises what a person typed, and refuses what cannot be a code', () => {
    assert.equal(normaliseInviteCode('  abcd-efgh  '), 'ABCD-EFGH');
    assert.equal(normaliseInviteCode('ABCD EFGH'), 'ABCDEFGH');
    // Hyphens survive. They are part of the code, not decoration — see the seed-compatibility
    // test below, which is the reason.
    assert.equal(normaliseInviteCode('prl-dev-room-1'), 'PRL-DEV-ROOM-1');
    assert.equal(normaliseInviteCode(''), null);
    assert.equal(normaliseInviteCode('   '), null);
    assert.equal(normaliseInviteCode('A'.repeat(65)), null, 'over-long input is refused, not cut');
  });
});

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

describe('hashing', () => {
  it('sha256 matches the published vector and is 32 bytes', () => {
    assert.equal(
      sha256('abc').toString('hex'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(sha256('abc').length, DIGEST_BYTES);
    assert.equal(DIGEST_BYTES, 32, 'prl.sha256_hash accepts exactly 32 bytes');
  });

  it('hashes strings and bytes to the same digest', () => {
    assert.deepEqual(sha256('abc'), sha256(Buffer.from('abc', 'utf8')));
  });

  it('token digests are unkeyed, deterministic sha256', () => {
    const token = generateSessionToken();
    assert.deepEqual(hashToken(token), sha256(token));
    assert.deepEqual(hashToken(token), hashToken(token));
    assert.notDeepEqual(hashToken(token), hashToken(generateSessionToken()));
  });

  it('an invite code hashes the way db/seeds/0001_dev_seed.sql expects', () => {
    // The seed writes sha256(convert_to('PRL-DEV-ROOM-1','utf8')) and documents that code as the
    // development room's. If normalisation ever starts stripping hyphens, that room becomes
    // unjoinable by its own documented code — so the two are pinned together here.
    const expected = sha256('PRL-DEV-ROOM-1');
    assert.deepEqual(hashInviteCode('PRL-DEV-ROOM-1'), expected);
    assert.deepEqual(hashInviteCode('  prl-dev-room-1 '), expected, 'case and padding are forgiven');
    assert.equal(hashInviteCode(''), null);
    assert.equal(hashInviteCode('X'.repeat(200)), null);
  });

  it('ip and user-agent digests are keyed, 32 bytes, and domain separated', () => {
    const ip = '198.51.100.7';
    const keyed = hashIp(TEST_SECRET, ip);
    assert.notEqual(keyed, null);
    assert.equal(keyed?.length, DIGEST_BYTES);

    // Deterministic under one secret: "which sessions are mine" has to keep working.
    assert.deepEqual(hashIp(TEST_SECRET, ip), keyed);
    // Keyed, so a database leak is not a list of addresses. This is the assertion that fails if
    // somebody "simplifies" these to a plain sha256.
    assert.notDeepEqual(hashIp(OTHER_SECRET, ip), keyed);
    assert.notDeepEqual(sha256(ip), keyed);
    // Domain separated, so the same string in the two columns is not the same 32 bytes.
    assert.notDeepEqual(hashUserAgent(TEST_SECRET, ip), keyed);

    assert.equal(hashIp(TEST_SECRET, undefined), null, 'no address means the column stays NULL');
    assert.equal(hashIp(TEST_SECRET, ''), null);
    assert.equal(hashUserAgent(TEST_SECRET, undefined), null);
  });

  it('oidc secrets hash unkeyed, so the callback can re-derive from its own cookie', () => {
    const state = generateOpaqueSecret();
    assert.deepEqual(hashOidcSecret(state), sha256(state));
  });
});

describe('hashing — timingSafeEquals', () => {
  it('is true only for identical bytes', () => {
    const left = randomBytes(32);
    assert.equal(timingSafeEquals(left, Buffer.from(left)), true);
    const flipped = Buffer.from(left);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    assert.equal(timingSafeEquals(left, flipped), false);
  });

  it('handles a length mismatch without throwing, in both directions', () => {
    const short = Buffer.from([1, 2, 3]);
    const long = Buffer.from([1, 2, 3, 4]);
    assert.equal(timingSafeEquals(short, long), false);
    assert.equal(timingSafeEquals(long, short), false);
    assert.equal(timingSafeEquals(Buffer.alloc(0), long), false);
    assert.equal(timingSafeEquals(long, Buffer.alloc(0)), false);
    assert.equal(timingSafeEquals(Buffer.alloc(0), Buffer.alloc(0)), true);
    // A prefix must not compare equal: the wrapper compares, it does not `startsWith`.
    assert.equal(timingSafeEquals(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3, 0])), false);
  });

  it('exists because crypto.timingSafeEqual throws on a length mismatch', () => {
    // Documents the reason for the wrapper. Letting this throw would leak length through an error
    // path, and in this codebase it would answer 500 where an invalid credential answers 401.
    assert.throws(() => timingSafeEqual(Buffer.from([1]), Buffer.from([1, 2])));
  });

  it('works across Uint8Array and Buffer', () => {
    const bytes = randomBytes(16);
    assert.equal(timingSafeEquals(bytes, new Uint8Array(bytes)), true);
  });
});

// ---------------------------------------------------------------------------
// users — input rules that need no database
// ---------------------------------------------------------------------------

describe('users — normaliseDisplayName', () => {
  it('trims, because the column requires a trimmed value', () => {
    assert.equal(users.normaliseDisplayName('  Sam  '), 'Sam');
  });

  it('refuses anything the column would refuse, as invalid_request', () => {
    for (const bad of ['', ' ', 'a', 'x'.repeat(25)]) {
      assert.throws(
        () => users.normaliseDisplayName(bad),
        (error: unknown) => error instanceof AppError && error.code === 'invalid_request',
        `"${bad.slice(0, 8)}" should have been refused`,
      );
    }
  });

  it('refuses control characters rather than rewriting them', () => {
    assert.throws(
      () => users.normaliseDisplayName(`Sam${String.fromCodePoint(0x07)}Bell`),
      (error: unknown) => error instanceof AppError && error.code === 'invalid_request',
    );
  });

  it('counts characters the way Postgres char_length does', () => {
    // 24 astral characters are 24 to the database and 48 to String.length. Counting the wrong one
    // would reject a name the column accepts.
    const astral = '\u{1F0A1}'.repeat(24);
    assert.equal(astral.length, 48);
    assert.equal(users.normaliseDisplayName(astral), astral);
    assert.throws(() => users.normaliseDisplayName('\u{1F0A1}'.repeat(25)));
  });

  it('generates a guest name the schema and the column both accept', () => {
    const name = users.defaultGuestDisplayName();
    assert.match(name, /^Guest [0-9A-F]{6}$/);
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9 '._-]{0,22}[A-Za-z0-9]$/, 'DISPLAY_NAME_SCHEMA');
    assert.equal(users.normaliseDisplayName(name), name);
  });
});

// ---------------------------------------------------------------------------
// rooms — configuration rules that need no database
// ---------------------------------------------------------------------------

describe('rooms — validateRoomConfig', () => {
  const base = {
    name: 'Kitchen table',
    ownerUserId: 'usr_abcdefgh',
    maxSeats: 6,
    smallBlind: 1,
    bigBlind: 2,
    startingStack: 200,
  } as const;

  it('accepts a sane table and fills the two optional fields', () => {
    const config = rooms.validateRoomConfig(base);
    assert.equal(config.name, 'Kitchen table');
    assert.equal(config.ante, 0);
    assert.equal(config.actionTimeoutSeconds, 30);
  });

  it('refuses every combination the route schema accepts and the CHECKs do not', () => {
    const cases: readonly { readonly input: rooms.CreateRoomInput; readonly field: string }[] = [
      // createRoomBodySchema allows a one-character name; rooms_name_shape wants two.
      { input: { ...base, name: 'x' }, field: 'name' },
      // The schema bounds each blind on its own; the CHECK relates them.
      { input: { ...base, smallBlind: 5, bigBlind: 5 }, field: 'bigBlind' },
      { input: { ...base, ante: 500 }, field: 'ante' },
      // rooms_stack_covers_blinds: a stack that cannot cover two big blinds is all-in on arrival.
      { input: { ...base, bigBlind: 200, startingStack: 200 }, field: 'startingStack' },
      { input: { ...base, maxSeats: 7 }, field: 'maxSeats' },
      { input: { ...base, actionTimeoutSeconds: 1 }, field: 'actionTimeoutSeconds' },
    ];
    for (const { input, field } of cases) {
      assert.throws(
        () => rooms.validateRoomConfig(input),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'invalid_request' &&
          error.fields?.[field] !== undefined,
        `expected ${field} to be rejected`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// hands — the guards and the cursor, without a database
// ---------------------------------------------------------------------------

describe('hands — assertRevealIsSafe', () => {
  function reveal(cardCount: number, complete: boolean) {
    return {
      commitment: {
        algorithm: 'sha256',
        version: COMMITMENT_VERSION,
        root: 'a'.repeat(64),
        context: 'hand_test',
      },
      cards: Array.from({ length: cardCount }, (_unused, index) => ({
        index,
        card: index,
        saltHex: 'b'.repeat(64),
        proof: [],
      })),
      complete,
    } as const;
  }

  it('accepts a reveal of the cards that can legitimately be public', () => {
    assert.doesNotThrow(() => hands.assertRevealIsSafe(reveal(hands.MAX_PUBLIC_REVEALED_CARDS, false)));
    assert.doesNotThrow(() => hands.assertRevealIsSafe(reveal(0, false)));
  });

  it('refuses a complete reveal — that is the whole-deck dump the scheme exists to prevent', () => {
    assert.throws(
      () => hands.assertRevealIsSafe(reveal(5, true)),
      (error: unknown) => error instanceof AppError && error.code === 'internal_error',
    );
  });

  it('refuses more than 5 board cards plus 2 for each of 6 seats', () => {
    assert.equal(hands.MAX_PUBLIC_REVEALED_CARDS, 17);
    assert.throws(
      () => hands.assertRevealIsSafe(reveal(18, false)),
      (error: unknown) => error instanceof AppError && error.code === 'internal_error',
    );
    assert.throws(() => hands.assertRevealIsSafe(reveal(52, false)));
  });
});

describe('hands — cursors', () => {
  it('round trips and stays inside handListQuerySchema', () => {
    const at = new Date('2026-04-01T10:20:30.400Z');
    const id = generateId('hand');
    const cursor = hands.encodeHandCursor(at, id);
    assert.match(cursor, ROUTE_CURSOR_PATTERN, cursor);
    const decoded = hands.decodeHandCursor(cursor);
    assert.equal(decoded.startedAt.getTime(), at.getTime());
    assert.equal(decoded.id, id);
  });

  it('refuses a cursor that did not come from a previous page', () => {
    for (const bad of ['', 'nope', ':', '123:', ':hand_x', 'abc:hand_x', '-1:hand_x', '1:HAND_X']) {
      assert.throws(
        () => hands.decodeHandCursor(bad),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'invalid_request' &&
          error.fields?.['cursor'] !== undefined,
        `"${bad}" should have been refused`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// audit — redaction, which is the half the database CHECK cannot do
// ---------------------------------------------------------------------------

describe('audit — redactDetail', () => {
  it('drops a nested secret, which is exactly what the CHECK cannot see', () => {
    const redacted = audit.redactDetail({
      route: '/api/v1/auth/session',
      context: { sessionToken: 'ses-plaintext-would-be-a-disaster', attempt: 2 },
    });
    const context = redacted['context'];
    assert.ok(context !== null && typeof context === 'object' && !Array.isArray(context));
    assert.equal(Reflect.get(context, 'sessionToken'), undefined, 'the key must be gone, not blanked');
    assert.deepEqual(Reflect.get(context, '_redacted'), ['sessionToken']);
    assert.equal(Reflect.get(context, 'attempt'), 2);
    assert.equal(redacted['route'], '/api/v1/auth/session');
  });

  it('drops every key the audit_log CHECK forbids at the top level', () => {
    const forbidden = [
      'token',
      'sessionToken',
      'password',
      'authorization',
      'cookie',
      'userAgent',
      'inviteCode',
      'deck',
      'salt',
      'salts',
      'holeCards',
    ];
    const detail: Record<string, unknown> = {};
    for (const key of forbidden) detail[key] = 'secret';
    const redacted = audit.redactDetail(detail);
    for (const key of forbidden) {
      // Removed, not blanked. `audit_log_detail_has_no_forbidden_keys` uses `?|`, which tests for
      // the key's existence and never looks at the value, so keeping the key with a marker value
      // would fail the write just as surely as keeping the secret.
      assert.equal(Object.hasOwn(redacted, key), false, `${key} must not survive as a key`);
    }
    assert.deepEqual(redacted['_redacted'], forbidden, 'the names are recorded as values');
    assert.equal(JSON.stringify(redacted).includes('secret'), false);
  });

  it('covers the keys logging.ts does not, which is why there are two lists', () => {
    // The gap that made `AUDIT_FORBIDDEN_KEYS` necessary. `logging.ts` keeps `ip` and `userAgent`
    // out of the log through its request serializer rather than by key name, so the shared
    // predicate says nothing about them and this table needs its own list.
    assert.equal(isSensitiveKey('userAgent'), false, 'if this becomes true, say so in audit.ts');
    assert.equal(isSensitiveKey('ip'), false);
    assert.equal(audit.isForbiddenAuditKey('userAgent'), true);
    assert.equal(audit.isForbiddenAuditKey('ip'), true);
    // Case-insensitive here, unlike the CHECK's exact `?|` match.
    assert.equal(audit.isForbiddenAuditKey('UserAgent'), true);
    assert.equal(audit.isForbiddenAuditKey('IP'), true);
    // And the families the shared pattern does catch still count.
    assert.equal(audit.isForbiddenAuditKey('refreshToken'), true);
    assert.equal(audit.isForbiddenAuditKey('roomId'), false, 'ordinary context must survive');
  });

  it('bounds depth, width, arrays and strings', () => {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };
    const redactedDeep = audit.redactDetail(deep);
    assert.ok(JSON.stringify(redactedDeep).includes('[truncated]'));

    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) wide[`k${index}`] = index;
    const redactedWide = audit.redactDetail(wide);
    assert.ok(Object.keys(redactedWide).length <= 25, 'a detail object is bounded');
    assert.equal(redactedWide['_truncated'], true);

    const long = audit.redactDetail({ note: 'x'.repeat(5_000) });
    assert.ok(String(long['note']).length < 300);

    const many = audit.redactDetail({ list: Array.from({ length: 100 }, (_u, index) => index) });
    const list = many['list'];
    assert.ok(Array.isArray(list) && list.length <= 17);
  });

  it('strips control characters, which is how a log line gets forged', () => {
    const redacted = audit.redactDetail({ note: `first${String.fromCodePoint(0x0a)}second` });
    assert.equal(redacted['note'], 'first second');
  });

  it('turns values that are not JSON into a marker rather than dropping them silently', () => {
    const redacted = audit.redactDetail({
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      missing: undefined,
      big: 10n,
    });
    assert.equal(redacted['nan'], '[truncated]');
    assert.equal(redacted['infinite'], '[truncated]');
    assert.equal(redacted['missing'], null);
    assert.equal(redacted['big'], '[truncated]');
  });
});

// ---------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------

/**
 * Decides whether the second half can run, and says so out loud when it cannot.
 *
 * Two separate reasons to skip, reported separately because they need different fixes: no
 * `DATABASE_URL` (set one, or accept that these do not run locally) and no schema (`pnpm
 * db:migrate`). Top-level `await` is what lets the probe happen before `describe` needs to know.
 */
const databaseUrl = TEST_DATABASE_URL;
let client: Sql | null = null;
let skipReason: string | false = databaseSkip('the repository queries');

if (databaseUrl !== undefined) {
  try {
    const probe = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: TEST_SECRET,
        DATABASE_POOL_MAX: '2',
      }),
    );
    await probe`select 1 from prl.users limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `prl schema is not reachable (${error instanceof Error ? error.name : 'error'}): run pnpm db:migrate`;
  }
}

if (skipReason !== false) {
  console.info(`[repositories.test.ts] skipping database-backed tests: ${skipReason}`);
}

after(async () => {
  if (client !== null) await client.end({ timeout: 5 });
});

/** Thrown to force a rollback. A module-private instance, so it can be identified by identity. */
const ROLLBACK = new Error('rollback: this transaction was only ever a test');

/**
 * Runs `fn` in a transaction and rolls it back, whatever happened.
 *
 * The assertions live inside the callback rather than being returned out of it, which keeps the
 * helper's type trivial and — more usefully — means a failed assertion rolls back too. Nothing this
 * suite writes is ever committed, so it is safe to point at a seeded development database.
 */
async function inRollback(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const handle = client;
  if (handle === null) throw new Error('inRollback called without a database');
  try {
    await handle.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

/**
 * Asserts that `run` rejects with `code`, inside a savepoint so the transaction survives it.
 *
 * The savepoint is the point of this helper, not a detail of it. Postgres aborts a transaction on
 * any failed statement, so a translated `seat_taken` recovers the error but not the transaction:
 * without `tx.savepoint(...)` every assertion after an expected rejection would fail with
 * "current transaction is aborted" and the test would be asserting the wrong thing. This is the
 * same reason `rooms.create` wraps its retry loop in `insideSavepoint`.
 */
async function rejectsWith(
  tx: TransactionSql,
  code: ErrorCode,
  run: (handle: TransactionSql) => Promise<unknown>,
): Promise<void> {
  await assert.rejects(
    tx.savepoint(async (savepoint) => {
      await run(savepoint);
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === code
        ? true
        : (() => {
            throw error;
          })(),
    `expected ${code}`,
  );
}

const dbOptions = { skip: skipReason };

async function makeGuest(tx: TransactionSql, name: string): Promise<string> {
  const user = await users.createGuest(tx, { displayName: name });
  return user.id;
}

function makeRoom(tx: TransactionSql, ownerId: string) {
  return rooms.create(tx, {
    name: 'Kitchen table',
    ownerUserId: ownerId,
    maxSeats: 6,
    smallBlind: 1,
    bigBlind: 2,
    startingStack: 200,
  });
}

describe('users — against Postgres', dbOptions, () => {
  it('creates a guest and reads it back', async () => {
    await inRollback(async (tx) => {
      const guest = await users.createGuest(tx, { displayName: 'Alice' });
      assert.equal(guest.kind, 'guest');
      assert.equal(guest.display_name, 'Alice');
      assert.equal(guest.oidc_issuer, null);
      assert.equal(guest.oidc_subject, null);
      assert.match(guest.id, GENERATED_ID_PATTERN);

      const found = await users.byId(tx, guest.id);
      assert.equal(found?.id, guest.id);
      assert.equal(await users.byId(tx, generateId('user')), null);
      assert.equal(await users.touchLastSeen(tx, guest.id), true);
      assert.equal(await users.touchLastSeen(tx, generateId('user')), false);
    });
  });

  it('creates a guest with no chosen name', async () => {
    await inRollback(async (tx) => {
      const guest = await users.createGuest(tx);
      assert.match(guest.display_name, /^Guest [0-9A-F]{6}$/);
    });
  });

  it('finds or creates a federated account in one statement, and reports which it did', async () => {
    await inRollback(async (tx) => {
      const issuer = 'https://issuer.test.invalid';
      const subject = `subject-${generateOpaqueSecret(8)}`;

      const first = await users.findOrCreateOidcUser(tx, { issuer, subject, displayName: 'Borys' });
      assert.equal(first.created, true);
      assert.equal(first.user.kind, 'oidc');

      const second = await users.findOrCreateOidcUser(tx, { issuer, subject, displayName: 'Renamed' });
      assert.equal(second.created, false, 'the second call must match, not insert');
      assert.equal(second.user.id, first.user.id);
      // The identity provider does not get to undo a learner's own rename.
      assert.equal(second.user.display_name, 'Borys');
    });
  });

  it('derives units from live seats and falls back to the standing allowance', async () => {
    await inRollback(async (tx) => {
      const ownerId = await makeGuest(tx, 'Owner');
      const before = await users.readUnits(tx, ownerId);
      assert.equal(before.units, users.DEFAULT_UNIT_ALLOWANCE, 'no table means the allowance');
      assert.equal(before.netLifetime, 0);

      const { room } = await makeRoom(tx, ownerId);
      await rooms.addMember(tx, { roomId: room.id, userId: ownerId });
      const seated = await users.readUnits(tx, ownerId);
      assert.equal(seated.units, 200, 'units are the chips in front of them');

      assert.equal(await users.adjustUnits(tx, { userId: ownerId, roomId: room.id, delta: -50 }), 150);
      assert.equal(
        await users.adjustUnits(tx, { userId: ownerId, roomId: room.id, delta: -1_000 }),
        null,
        'the guard is in the WHERE clause: a stack cannot go negative',
      );
      assert.equal((await users.readUnits(tx, ownerId)).units, 150);

      const reset = await users.resetUnits(tx, ownerId);
      assert.equal(reset.units, 200, 'reset is always available and never penalised');
    });
  });
});

describe('sessions — against Postgres', dbOptions, () => {
  it('stores only the digest and resolves the token in one query', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Alice');
      const created = await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });
      assert.ok(created.token.length >= 40);

      const stored = await tx<{ token_hash: Buffer }[]>`
        select token_hash from prl.sessions where id = ${created.sessionId}
      `;
      assert.deepEqual(stored[0]?.token_hash, hashToken(created.token), 'the digest, not the token');

      const resolved = await sessions.findValidByToken(tx, created.token);
      assert.equal(resolved?.sessionId, created.sessionId);
      assert.equal(resolved?.user.id, userId);
      assert.equal(resolved?.user.displayName, 'Alice');

      assert.equal(await sessions.findValidByToken(tx, generateSessionToken()), null);
      assert.equal(await sessions.findValidByToken(tx, ''), null);
    });
  });

  it('stores the keyed fingerprints as 32-byte digests', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Alice');
      const created = await sessions.create(tx, {
        userId,
        ipHash: hashIp(TEST_SECRET, '198.51.100.7'),
        userAgentHash: hashUserAgent(TEST_SECRET, 'Mozilla/5.0'),
      });
      const row = await tx<{ ip_hash: Buffer | null; user_agent_hash: Buffer | null }[]>`
        select ip_hash, user_agent_hash from prl.sessions where id = ${created.sessionId}
      `;
      assert.equal(row[0]?.ip_hash?.length, 32);
      assert.equal(row[0]?.user_agent_hash?.length, 32);
      assert.deepEqual(row[0]?.ip_hash, hashIp(TEST_SECRET, '198.51.100.7'));
    });
  });

  it('refuses a revoked or expired session', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Alice');

      const revoked = await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });
      assert.equal(await sessions.revoke(tx, revoked.sessionId), true);
      assert.equal(await sessions.revoke(tx, revoked.sessionId), false, 'revocation is idempotent');
      assert.equal(await sessions.findValidByToken(tx, revoked.token), null);

      const expired = await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });
      // Both timestamps move back, and that is not arbitrary: `now()` is the transaction's start
      // time and does not advance, so a row whose created_at is `now()` can never have an
      // expires_at that is both in the past and after created_at (which
      // `sessions_expires_after_creation` requires). Backdating the pair is the only way to build
      // an expired session inside one transaction.
      await tx`
        update prl.sessions
           set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
         where id = ${expired.sessionId}
      `;
      assert.equal(await sessions.findValidByToken(tx, expired.token), null, 'expiry is in the WHERE');
    });
  });

  it('revokes by token, and revokes the rest while sparing one', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Alice');
      const a = await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });
      const b = await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });
      const c = await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });

      assert.equal(await sessions.revokeByToken(tx, a.token), true);
      assert.equal(await sessions.revokeByToken(tx, a.token), false);

      assert.equal(await sessions.revokeAllForUser(tx, userId, { exceptSessionId: b.sessionId }), 1);
      assert.notEqual(await sessions.findValidByToken(tx, b.token), null, 'this device stays signed in');
      assert.equal(await sessions.findValidByToken(tx, c.token), null);
    });
  });

  it('slides expiry forward but never past the ceiling', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Alice');
      const created = await sessions.create(tx, {
        userId,
        ipHash: null,
        userAgentHash: null,
        ttlSeconds: 3_600,
      });
      const extended = await sessions.extendExpiry(tx, created.sessionId, 7_200, 86_400);
      assert.notEqual(extended, null);
      assert.ok((extended?.getTime() ?? 0) > created.expiresAt.getTime());

      // A ceiling below the current expiry cannot move it, and must not shorten it either.
      assert.equal(await sessions.extendExpiry(tx, created.sessionId, 7_200, 60), null);
      assert.equal(await sessions.extendExpiry(tx, generateId('session'), 7_200, 86_400), null);
    });
  });

  it('sweeps expired sessions', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Alice');
      const doomed = await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });
      const kept = await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });
      await tx`
        update prl.sessions
           set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
         where id = ${doomed.sessionId}
      `;
      assert.ok((await sessions.deleteExpired(tx)) >= 1);
      assert.notEqual(await sessions.findValidByToken(tx, kept.token), null);
    });
  });

  it('consumes an OIDC attempt exactly once', async () => {
    await inRollback(async (tx) => {
      const state = generateOpaqueSecret();
      const nonce = generateOpaqueSecret();
      const verifier = generateOpaqueSecret();
      await sessions.createLoginAttempt(tx, {
        state,
        nonce,
        pkceVerifier: verifier,
        redirectAfter: '/lessons/pot-odds',
      });

      const first = await sessions.consumeLoginAttempt(tx, state);
      assert.notEqual(first, null);
      assert.deepEqual(first?.nonceHash, hashOidcSecret(nonce));
      assert.deepEqual(first?.pkceVerifierHash, hashOidcSecret(verifier));
      assert.equal(first?.redirectAfter, '/lessons/pot-odds');

      // The replay. One UPDATE ... WHERE consumed_at IS NULL is what makes this null rather than a
      // second successful sign-in.
      assert.equal(await sessions.consumeLoginAttempt(tx, state), null);
      assert.equal(await sessions.consumeLoginAttempt(tx, generateOpaqueSecret()), null);
      assert.equal(await sessions.consumeLoginAttempt(tx, ''), null);
    });
  });

  it('never consumes an expired attempt, and never stores a plaintext secret', async () => {
    await inRollback(async (tx) => {
      const state = generateOpaqueSecret();
      const attempt = await sessions.createLoginAttempt(tx, {
        state,
        nonce: generateOpaqueSecret(),
        pkceVerifier: generateOpaqueSecret(),
      });
      const row = await tx<{ state_hash: Buffer }[]>`
        select state_hash from prl.oidc_login_attempts where id = ${attempt.id}
      `;
      assert.deepEqual(row[0]?.state_hash, hashOidcSecret(state));

      await tx`
        update prl.oidc_login_attempts
           set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
         where id = ${attempt.id}
      `;
      assert.equal(await sessions.consumeLoginAttempt(tx, state), null);
      assert.ok((await sessions.deleteExpiredLoginAttempts(tx)) >= 1);
    });
  });

  it('refuses a redirect target that is not a local path', async () => {
    await inRollback(async (tx) => {
      for (const bad of ['//evil.test/x', 'https://evil.test', 'not-a-path', '/x\\y']) {
        await rejectsWith(tx, 'invalid_request', (handle) =>
          sessions.createLoginAttempt(handle, {
            state: generateOpaqueSecret(),
            nonce: generateOpaqueSecret(),
            pkceVerifier: generateOpaqueSecret(),
            redirectAfter: bad,
          }),
        );
      }
    });
  });
});

describe('rooms — against Postgres', dbOptions, () => {
  it('stores only the invite-code digest and finds the room by the code', async () => {
    await inRollback(async (tx) => {
      const ownerId = await makeGuest(tx, 'Owner');
      const { room, inviteCode } = await makeRoom(tx, ownerId);
      assert.match(inviteCode, ROUTE_INVITE_PATTERN);
      assert.equal(room.status, 'open');
      assert.equal(room.visibility, 'invite_only');

      const stored = await tx<{ invite_code_hash: Buffer }[]>`
        select invite_code_hash from prl.rooms where id = ${room.id}
      `;
      assert.deepEqual(stored[0]?.invite_code_hash, sha256(inviteCode));

      const found = await rooms.byInviteCode(tx, inviteCode.toLowerCase());
      assert.equal(found?.id, room.id, 'a code typed in lower case still works');
      assert.equal(await rooms.byInviteCode(tx, generateInviteCode()), null);
      assert.equal(await rooms.byInviteCode(tx, ''), null);
      // The row that comes back never carries the digest onwards.
      assert.equal(Object.hasOwn(found ?? {}, 'invite_code_hash'), false);
    });
  });

  it('seats members, refuses a taken seat, and refuses a second membership', async () => {
    await inRollback(async (tx) => {
      const ownerId = await makeGuest(tx, 'Owner');
      const otherId = await makeGuest(tx, 'Other');
      const { room } = await makeRoom(tx, ownerId);

      const owner = await rooms.addMember(tx, { roomId: room.id, userId: ownerId });
      assert.equal(owner.seat, null, 'a new member is waiting, not seated');
      assert.equal(owner.stack, 200, 'the stack defaults to the room starting stack');

      // The partial unique index is what stops one learner acting out of two seats.
      await rejectsWith(tx, 'already_seated', (handle) =>
        rooms.addMember(handle, { roomId: room.id, userId: ownerId }),
      );

      const seated = await rooms.seatMember(tx, room.id, ownerId, 3);
      assert.equal(seated.seat, 3);

      await rooms.addMember(tx, { roomId: room.id, userId: otherId });
      await rejectsWith(tx, 'seat_taken', (handle) => rooms.seatMember(handle, room.id, otherId, 3));
      assert.notEqual(await rooms.seatMember(tx, room.id, otherId, 4), null);

      assert.equal(await rooms.unseatMember(tx, room.id, ownerId), true);
      assert.notEqual(await rooms.seatMember(tx, room.id, otherId, 3), null, 'the seat is free again');
    });
  });

  it('refuses a seat outside this table max_seats', async () => {
    await inRollback(async (tx) => {
      const ownerId = await makeGuest(tx, 'Owner');
      const { room } = await rooms.create(tx, {
        name: 'Heads up',
        ownerUserId: ownerId,
        maxSeats: 2,
        smallBlind: 1,
        bigBlind: 2,
        startingStack: 200,
      });
      await rooms.addMember(tx, { roomId: room.id, userId: ownerId });
      // A CHECK cannot see across tables, so `seat < max_seats` is in the statement's WHERE clause.
      await rejectsWith(tx, 'invalid_request', (handle) => rooms.seatMember(handle, room.id, ownerId, 4));
      await rejectsWith(tx, 'invalid_request', (handle) => rooms.seatMember(handle, room.id, ownerId, 9));
    });
  });

  it('refuses a join once the table is full', async () => {
    await inRollback(async (tx) => {
      const ownerId = await makeGuest(tx, 'Owner');
      const { room } = await rooms.create(tx, {
        name: 'Heads up',
        ownerUserId: ownerId,
        maxSeats: 2,
        smallBlind: 1,
        bigBlind: 2,
        startingStack: 200,
      });
      await rooms.addMember(tx, { roomId: room.id, userId: ownerId });
      await rooms.addMember(tx, { roomId: room.id, userId: await makeGuest(tx, 'Second') });
      const thirdId = await makeGuest(tx, 'Third');
      await rejectsWith(tx, 'room_full', (handle) =>
        rooms.addMember(handle, { roomId: room.id, userId: thirdId }),
      );
    });
  });

  it('says the same thing about a missing room and one that is not yours', async () => {
    await inRollback(async (tx) => {
      const strangerId = await makeGuest(tx, 'Stranger');
      await rejectsWith(tx, 'room_not_found_or_not_permitted', (handle) =>
        rooms.addMember(handle, { roomId: generateId('room'), userId: strangerId }),
      );
    });
  });

  it('closes a room, only for its owner, and refuses to reopen it', async () => {
    await inRollback(async (tx) => {
      const ownerId = await makeGuest(tx, 'Owner');
      const strangerId = await makeGuest(tx, 'Stranger');
      const { room } = await makeRoom(tx, ownerId);

      assert.equal(await rooms.close(tx, room.id, { ownerUserId: strangerId }), false);
      assert.equal(await rooms.setStatus(tx, room.id, 'playing'), true);
      assert.equal(await rooms.close(tx, room.id, { ownerUserId: ownerId }), true);
      assert.equal(await rooms.close(tx, room.id), false, 'closing twice does not move closed_at');

      const closed = await rooms.byId(tx, room.id);
      assert.equal(closed?.status, 'closed');
      assert.notEqual(closed?.closed_at, null, 'status and closed_at move together');
      assert.equal(await rooms.setStatus(tx, room.id, 'open'), false, 'a closed room stays closed');

      await rejectsWith(tx, 'room_closed', (handle) =>
        rooms.addMember(handle, { roomId: room.id, userId: strangerId }),
      );
    });
  });

  it('lists rooms for a member and for the owner, and leaves history behind', async () => {
    await inRollback(async (tx) => {
      const ownerId = await makeGuest(tx, 'Owner');
      const playerId = await makeGuest(tx, 'Player');
      const { room } = await makeRoom(tx, ownerId);
      await rooms.addMember(tx, { roomId: room.id, userId: playerId });
      await rooms.seatMember(tx, room.id, playerId, 1);

      const forPlayer = await rooms.listForUser(tx, playerId);
      assert.ok(forPlayer.some((entry) => entry.id === room.id));
      const forOwner = await rooms.listForUser(tx, ownerId);
      assert.ok(
        forOwner.some((entry) => entry.id === room.id),
        'an owner who stood up can still close it',
      );

      const roster = await rooms.membersOf(tx, room.id);
      assert.equal(roster.length, 1);
      assert.equal(roster[0]?.display_name, 'Player');

      assert.equal(await rooms.updateMemberStack(tx, room.id, playerId, 175), true);
      assert.equal((await rooms.memberOf(tx, room.id, playerId))?.stack, 175);

      assert.equal(await rooms.removeMember(tx, room.id, playerId), true);
      assert.equal(await rooms.memberOf(tx, room.id, playerId), null);
      assert.equal((await rooms.membersOf(tx, room.id)).length, 0);
      const withHistory = await rooms.membersOf(tx, room.id, { includeDeparted: true });
      assert.equal(withHistory.length, 1, 'left_at, not DELETE: who sat where is history');
      assert.equal(withHistory[0]?.seat, 1, 'the seat number stays on the departed row');
    });
  });

  it('seats a bot with a profile, and refuses the two mismatched combinations', async () => {
    await inRollback(async (tx) => {
      const ownerId = await makeGuest(tx, 'Owner');
      const { room } = await makeRoom(tx, ownerId);
      const botId = await makeGuest(tx, 'Rock bot');

      const bot = await rooms.addMember(tx, {
        roomId: room.id,
        userId: botId,
        isBot: true,
        bot: { profileId: 'disciplined-specialist', difficulty: 'realistic', seed: 4_294_967_295 },
      });
      assert.equal(bot.is_bot, true);
      // The profile's own id, not a legacy range label — migration 0003. And the seed survives the
      // full uint32 range: it is a `bigint` column precisely because a signed `int` would lose half
      // of it, and postgres.js hands int8 back as a string, so this also pins the conversion.
      assert.equal(bot.bot_profile, 'disciplined-specialist');
      assert.equal(bot.bot_difficulty, 'realistic');
      assert.equal(bot.bot_seed, 4_294_967_295);

      await rejectsWith(tx, 'invalid_request', (handle) =>
        rooms.addMember(handle, { roomId: room.id, userId: ownerId, isBot: true }),
      );
      await rejectsWith(tx, 'invalid_request', (handle) =>
        rooms.addMember(handle, {
          roomId: room.id,
          userId: ownerId,
          bot: { profileId: 'volume-grinder', difficulty: 'realistic', seed: 1 },
        }),
      );
    });
  });

  it('membersOfRooms tolerates an empty list', async () => {
    await inRollback(async (tx) => {
      assert.deepEqual(await rooms.membersOfRooms(tx, []), []);
    });
  });
});

describe('hands — against Postgres', dbOptions, () => {
  const ROOT = 'a'.repeat(64);

  async function dealtHand(tx: TransactionSql) {
    const heroId = await makeGuest(tx, 'Hero');
    const villainId = await makeGuest(tx, 'Villain');
    const { room } = await makeRoom(tx, heroId);
    await rooms.addMember(tx, { roomId: room.id, userId: heroId });
    await rooms.seatMember(tx, room.id, heroId, 0);
    await rooms.addMember(tx, { roomId: room.id, userId: villainId });
    await rooms.seatMember(tx, room.id, villainId, 1);

    const handId = generateId('hand');
    const handNumber = await hands.nextHandNumber(tx, room.id);
    await hands.start(tx, {
      handId,
      roomId: room.id,
      handNumber,
      buttonSeat: 0,
      config: { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
      commitmentRoot: ROOT,
      commitmentContext: `prl-deck-v2|${handId}`,
      randomSourceKind: 'csprng',
      seats: [
        {
          seat: 0,
          userId: heroId,
          isBot: false,
          startingStack: 200,
          holeCards: [parseCard('Ah'), parseCard('Kh')],
          status: 'active',
        },
        {
          seat: 1,
          userId: villainId,
          isBot: false,
          startingStack: 200,
          holeCards: [parseCard('7c'), parseCard('2d')],
          status: 'active',
        },
      ],
    });
    return { heroId, villainId, roomId: room.id, handId, handNumber };
  }

  it('writes a hand and its seats, and numbers hands from one', async () => {
    await inRollback(async (tx) => {
      const { roomId, handId, handNumber } = await dealtHand(tx);
      assert.equal(handNumber, 1);
      assert.equal(await hands.nextHandNumber(tx, roomId), 2);
      assert.equal(await hands.activeHandIdForRoom(tx, roomId), handId);
    });
  });

  it('has no column for the deck or the salts, and this proves it', async () => {
    await inRollback(async (tx) => {
      const columns = await tx<{ column_name: string }[]>`
        select column_name
          from information_schema.columns
         where table_schema = 'prl' and table_name in ('hands', 'hand_seats')
      `;
      const names = columns.map((row) => row.column_name.toLowerCase());
      for (const forbidden of ['deck', 'deck_order', 'deck_cursor', 'salt', 'salts', 'deck_salts']) {
        assert.equal(names.includes(forbidden), false, `prl must never grow a "${forbidden}" column`);
      }
      assert.ok(names.includes('commitment_root'), 'the root is the only thing stored in advance');
    });
  });

  // #########################################################################
  // # THE HOLE-CARD TEST                                                    #
  // #########################################################################
  it('returns hole cards only for the viewer own seat', async () => {
    await inRollback(async (tx) => {
      const { heroId, villainId, handId } = await dealtHand(tx);

      const asHero = await hands.seatsOf(tx, handId, heroId);
      assert.equal(asHero.length, 2);
      assert.deepEqual(asHero[0]?.holeCards, ['Ah', 'Kh'], 'hero sees their own cards');
      assert.equal(asHero[1]?.holeCards, null, "hero must never see the villain's cards");

      const asVillain = await hands.seatsOf(tx, handId, villainId);
      assert.equal(asVillain[0]?.holeCards, null);
      assert.deepEqual(asVillain[1]?.holeCards, ['7c', '2d']);

      // A spectator, and an unauthenticated viewer, see nothing at all.
      const asStranger = await hands.seatsOf(tx, handId, await makeGuest(tx, 'Stranger'));
      assert.deepEqual(
        asStranger.map((seat) => seat.holeCards),
        [null, null],
      );
      const asNobody = await hands.seatsOf(tx, handId, null);
      assert.deepEqual(
        asNobody.map((seat) => seat.holeCards),
        [null, null],
        'a null viewer must match no seat, including seats whose user_id is null',
      );

      // Everything else about the seat is public: it has to be, for the table to render.
      assert.equal(asStranger[0]?.startingStack, 200);
      assert.equal(asStranger[0]?.displayName, 'Hero');
    });
  });

  it('opens a seat cards to everyone once it has shown down, and not before', async () => {
    await inRollback(async (tx) => {
      const { heroId, villainId, handId } = await dealtHand(tx);
      const result: HandResult = {
        showdowns: [],
        pots: [{ amount: 40, eligibleSeats: [0, 1], capPerSeat: 20, index: 0 }],
        awards: [],
        netBySeat: { 0: 20, 1: -20 },
        endedByFold: false,
        reveal: {
          commitment: {
            algorithm: 'sha256',
            version: COMMITMENT_VERSION,
            root: ROOT,
            context: `prl-deck-v2|${handId}`,
          },
          cards: [],
          complete: false,
        },
      };
      await hands.complete(tx, {
        handId,
        board: [parseCard('Qh'), parseCard('7h'), parseCard('2c'), parseCard('5s'), parseCard('9d')],
        result,
        seats: [
          { seat: 0, netResult: 20, status: 'active', showedDown: true },
          { seat: 1, netResult: -20, status: 'folded', showedDown: false },
        ],
      });

      const asVillain = await hands.seatsOf(tx, handId, villainId);
      assert.deepEqual(asVillain[0]?.holeCards, ['Ah', 'Kh'], 'a seat that showed is public');
      assert.deepEqual(asVillain[1]?.holeCards, ['7c', '2d'], 'and villain still sees their own');

      const asStranger = await hands.seatsOf(tx, handId, await makeGuest(tx, 'Stranger'));
      assert.deepEqual(asStranger[0]?.holeCards, ['Ah', 'Kh']);
      assert.equal(asStranger[1]?.holeCards, null, 'a fold stays sealed forever, including from us');

      assert.equal(await hands.activeHandIdForRoom(tx, heroId), null);
      const summary = await hands.listForUser(tx, { userId: heroId });
      assert.equal(summary.hands[0]?.potTotal, 40);
      assert.equal(summary.hands[0]?.heroNet, 20);
      assert.equal(summary.hands[0]?.endedByFold, false);
      assert.deepEqual(summary.hands[0]?.board, ['Qh', '7h', '2c', '5s', '9d']);
    });
  });

  it('refuses to settle a hand twice', async () => {
    await inRollback(async (tx) => {
      const { handId } = await dealtHand(tx);
      const result: HandResult = {
        showdowns: [],
        pots: [],
        awards: [],
        netBySeat: { 0: 0, 1: 0 },
        endedByFold: true,
        reveal: {
          commitment: {
            algorithm: 'sha256',
            version: COMMITMENT_VERSION,
            root: ROOT,
            context: `prl-deck-v2|${handId}`,
          },
          cards: [],
          complete: false,
        },
      };
      const seats = [
        { seat: 0, netResult: 0, status: 'folded' as const, showedDown: false },
        { seat: 1, netResult: 0, status: 'active' as const, showedDown: false },
      ];
      await hands.complete(tx, { handId, board: [], result, seats });
      await rejectsWith(tx, 'hand_not_active', (handle) =>
        hands.complete(handle, { handId, board: [], result, seats }),
      );
    });
  });

  it('applies an action once per client actionId', async () => {
    await inRollback(async (tx) => {
      const { handId } = await dealtHand(tx);
      const actionId = generateOpaqueSecret(12);
      const action = {
        handId,
        sequence: 1,
        street: 'preflop' as const,
        seat: 0,
        actionType: 'raise' as const,
        actionTo: 6,
        amountPaid: 6,
        betLevelAfter: 6,
        potAfter: 9,
        wasAutomatic: false,
        actionId,
      };

      const first = await hands.appendAction(tx, action);
      assert.equal(first.applied, true);

      // The retry. One statement decides, and it decides "already done".
      const retry = await hands.appendAction(tx, action);
      assert.equal(retry.applied, false, 'chips must not leave a stack twice');
      assert.equal(retry.id, null);

      // A different decision that reused the sequence is a stale action, not a duplicate — and the
      // named conflict target is what keeps those two apart.
      await rejectsWith(tx, 'stale_action_sequence', (handle) =>
        hands.appendAction(handle, { ...action, actionId: generateOpaqueSecret(12) }),
      );

      // Server-generated actions carry no id, so several of them coexist.
      await hands.appendAction(tx, {
        ...action,
        sequence: 2,
        actionType: 'check',
        actionTo: null,
        amountPaid: 0,
        actionId: null,
      });
      await hands.appendAction(tx, {
        ...action,
        sequence: 3,
        actionType: 'check',
        actionTo: null,
        amountPaid: 0,
        actionId: null,
      });

      const logged = await hands.actionsOf(tx, handId);
      assert.deepEqual(
        logged.map((entry) => entry.sequence),
        [1, 2, 3],
      );
      assert.equal(logged[0]?.action_to, 6);
      assert.equal(logged[1]?.action_to, null);
    });
  });

  it('refuses an action whose sizing contradicts its type', async () => {
    await inRollback(async (tx) => {
      const { handId } = await dealtHand(tx);
      await rejectsWith(tx, 'internal_error', (handle) =>
        hands.appendAction(handle, {
          handId,
          sequence: 1,
          street: 'preflop',
          seat: 0,
          actionType: 'check',
          actionTo: 6,
          amountPaid: 0,
          betLevelAfter: 6,
          potAfter: 9,
          wasAutomatic: false,
          actionId: null,
        }),
      );
    });
  });

  it('advances the street and the board', async () => {
    await inRollback(async (tx) => {
      const { handId, heroId } = await dealtHand(tx);
      assert.equal(
        await hands.advanceStreet(tx, handId, 'flop', [parseCard('Qh'), parseCard('7h'), parseCard('2c')]),
        true,
      );
      const hand = await hands.byId(tx, handId, heroId);
      assert.equal(hand?.street, 'flop');
      assert.deepEqual(hand?.board, ['Qh', '7h', '2c']);
    });
  });

  it('hides a hand from someone who was never at the table', async () => {
    await inRollback(async (tx) => {
      const { handId, heroId, villainId } = await dealtHand(tx);
      assert.notEqual(await hands.byId(tx, handId, heroId), null);
      assert.notEqual(await hands.byId(tx, handId, villainId), null);
      assert.equal(
        await hands.byId(tx, handId, await makeGuest(tx, 'Stranger')),
        null,
        'not-yours and not-found must be the same answer',
      );
      assert.equal(await hands.byId(tx, generateId('hand'), heroId), null);
    });
  });

  it('pages hand history by keyset, newest first', async () => {
    await inRollback(async (tx) => {
      const { heroId, roomId, handId } = await dealtHand(tx);
      // Two more hands in the same room, so there is something to page through.
      for (const offset of [1, 2]) {
        const nextId = generateId('hand');
        await hands.start(tx, {
          handId: nextId,
          roomId,
          handNumber: 1 + offset,
          buttonSeat: 0,
          config: { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
          commitmentRoot: ROOT,
          commitmentContext: `prl-deck-v2|${nextId}`,
          randomSourceKind: 'csprng',
          seats: [
            {
              seat: 0,
              userId: heroId,
              isBot: false,
              startingStack: 200,
              holeCards: [parseCard('Ah'), parseCard('Kh')],
              status: 'active',
            },
          ],
        });
        await tx`
          update prl.hands set started_at = now() + ${offset}::int * interval '1 minute' where id = ${nextId}
        `;
      }

      const first = await hands.listForUser(tx, { userId: heroId, roomId, limit: 2 });
      assert.equal(first.hands.length, 2);
      assert.notEqual(first.nextCursor, null);
      assert.equal(first.hands[0]?.handNumber, 3, 'newest first');

      const cursor = first.nextCursor;
      assert.ok(cursor !== null);
      const second = await hands.listForUser(tx, { userId: heroId, roomId, limit: 2, cursor });
      assert.equal(second.hands.length, 1);
      assert.equal(second.hands[0]?.id, handId);
      assert.equal(second.nextCursor, null, 'the last page says so');

      // A hand the learner had no seat in is not in their history.
      const stranger = await hands.listForUser(tx, { userId: await makeGuest(tx, 'Stranger') });
      assert.equal(stranger.hands.length, 0);
    });
  });

  // #########################################################################
  // # RESTORING THE ROTATION, AND CLOSING WHAT CANNOT FINISH                #
  // #########################################################################

  it('reports the last deal, so a re-opened room does not restart the blind rotation', async () => {
    await inRollback(async (tx) => {
      const { roomId, handId, heroId, villainId } = await dealtHand(tx);
      const last = await hands.lastDealtHand(tx, roomId);
      assert.deepEqual(
        last === null
          ? null
          : {
              handId: last.handId,
              handNumber: last.handNumber,
              buttonSeat: last.buttonSeat,
              dealtSeats: [...last.dealtSeats],
            },
        { handId, handNumber: 1, buttonSeat: 0, dealtSeats: [0, 1] },
      );

      // The newest hand wins even when it is still in progress: it was dealt, so it is where the
      // rotation had got to, and a restart must carry on from there rather than from the last one
      // that happened to finish.
      const second = generateId('hand');
      await hands.start(tx, {
        handId: second,
        roomId,
        handNumber: 2,
        buttonSeat: 1,
        config: { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
        commitmentRoot: ROOT,
        commitmentContext: `prl-deck-v2|${second}`,
        randomSourceKind: 'csprng',
        seats: [
          {
            seat: 0,
            userId: heroId,
            isBot: false,
            startingStack: 200,
            holeCards: [parseCard('Ah'), parseCard('Kh')],
            status: 'active',
          },
          {
            seat: 1,
            userId: villainId,
            isBot: false,
            startingStack: 200,
            holeCards: [parseCard('7c'), parseCard('2d')],
            status: 'active',
          },
        ],
      });
      assert.equal((await hands.lastDealtHand(tx, roomId))?.buttonSeat, 1);
      assert.equal(await hands.lastDealtHand(tx, generateId('room')), null);
    });
  });

  it('closes an interrupted hand instead of leaving it open forever', async () => {
    await inRollback(async (tx) => {
      const { roomId, handId, heroId } = await dealtHand(tx);
      assert.equal(await hands.activeHandIdForRoom(tx, roomId), handId, 'the orphan is there to begin with');

      const abandoned = await hands.abandonInterruptedHands(tx, roomId);
      assert.deepEqual(
        abandoned.map((hand) => ({ handId: hand.handId, roomId: hand.roomId, handNumber: hand.handNumber })),
        [{ handId, roomId, handNumber: 1 }],
      );

      // Nothing is left for the history to render as a null: the hand is complete, it has a
      // completion time, and both blank-result constraints on `prl.hands` are satisfied.
      const rows = await tx<
        {
          street: string;
          completed_at: Date | null;
          result: Record<string, unknown>;
          reveal: Record<string, unknown>;
        }[]
      >`select street, completed_at, result, reveal from prl.hands where id = ${handId}`;
      const row = rows[0];
      assert.ok(row !== undefined);
      assert.equal(row.street, 'complete');
      assert.notEqual(row.completed_at, null);
      assert.equal(row.result.abandoned, true, 'and it says so, rather than posing as an ordinary fold');
      assert.equal(row.result.endedByFold, true, 'no cards were shown, which is what the flag means');
      assert.deepEqual(row.result.showdowns, []);
      assert.deepEqual(row.result.awards, []);
      // The deck is gone with the process, so the only honest reveal proves nothing at all — and
      // it must still be a reveal the verifier and both CHECK constraints accept.
      assert.deepEqual(row.reveal.cards, []);
      assert.equal(row.reveal.complete, false);
      assert.deepEqual(row.reveal.commitment, {
        algorithm: 'sha256',
        version: COMMITMENT_VERSION,
        root: ROOT,
        context: `prl-deck-v2|${handId}`,
      });

      // Chips: an interrupted hand never wrote a stack back, so nobody won or lost anything, and
      // zero is the true figure rather than a placeholder.
      const seats = await hands.seatsOf(tx, handId, heroId);
      assert.deepEqual(
        seats.map((seat) => ({ seat: seat.seat, net: seat.netResult, starting: seat.startingStack })),
        [
          { seat: 0, net: 0, starting: 200 },
          { seat: 1, net: 0, starting: 200 },
        ],
      );

      // And the learner's own history has something to render rather than a row of nulls, which
      // is the whole complaint: three of these accumulated in one audit session.
      const history = await hands.listForUser(tx, { userId: heroId, roomId });
      const listed = history.hands[0];
      assert.ok(listed !== undefined);
      assert.notEqual(listed.completedAt, null, 'the history no longer shows an unfinished hand');
      assert.equal(listed.heroNet, 0);
      assert.equal(listed.potTotal, 0);

      assert.equal(await hands.activeHandIdForRoom(tx, roomId), null, 'and the room has no live hand');
      assert.deepEqual(await hands.abandonInterruptedHands(tx, roomId), [], 'running it again does nothing');
    });
  });

  it('leaves a settled hand and another room untouched', async () => {
    await inRollback(async (tx) => {
      const { roomId, handId, heroId, villainId } = await dealtHand(tx);
      const result: HandResult = {
        showdowns: [],
        pots: [{ amount: 4, eligibleSeats: [0, 1], capPerSeat: 2, index: 0 }],
        awards: [],
        netBySeat: { 0: 2, 1: -2 },
        endedByFold: true,
        reveal: {
          commitment: {
            algorithm: 'sha256',
            version: COMMITMENT_VERSION,
            root: ROOT,
            context: `prl-deck-v2|${handId}`,
          },
          cards: [],
          complete: false,
        },
      };
      const settled = await hands.complete(tx, {
        handId,
        board: [parseCard('2s'), parseCard('9d'), parseCard('Jc')],
        result,
        seats: [
          { seat: 0, netResult: 2, status: 'active', showedDown: true },
          { seat: 1, netResult: -2, status: 'folded', showedDown: false },
        ],
      });
      assert.notEqual(settled.completed_at, null);

      // A different room's orphan is not this room's business: the reconciliation is scoped to the
      // room being taken over, because that is the only room this process can be sure nobody else
      // is mid-hand in.
      const otherRoom = await makeRoom(tx, villainId);
      const otherHand = generateId('hand');
      await rooms.addMember(tx, { roomId: otherRoom.room.id, userId: villainId });
      await hands.start(tx, {
        handId: otherHand,
        roomId: otherRoom.room.id,
        handNumber: 1,
        buttonSeat: 0,
        config: { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
        commitmentRoot: ROOT,
        commitmentContext: `prl-deck-v2|${otherHand}`,
        randomSourceKind: 'csprng',
        seats: [
          {
            seat: 0,
            userId: villainId,
            isBot: false,
            startingStack: 200,
            holeCards: [parseCard('Ah'), parseCard('Kh')],
            status: 'active',
          },
        ],
      });

      assert.deepEqual(await hands.abandonInterruptedHands(tx, roomId), [], 'nothing to close here');
      const after = await hands.seatsOf(tx, handId, heroId);
      assert.deepEqual(
        after.map((seat) => seat.netResult),
        [2, -2],
        'the settled hand keeps the nets it settled with',
      );
      assert.equal(
        await hands.activeHandIdForRoom(tx, otherRoom.room.id),
        otherHand,
        'and the other room is untouched',
      );
    });
  });
});

describe('progress — against Postgres', dbOptions, () => {
  it('upserts lesson progress and keeps completion sticky', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Learner');

      const opened = await progress.upsertLessonProgress(tx, { userId, lessonId: 'pot-odds' });
      assert.equal(opened.completed_at, null);

      const finished = await progress.upsertLessonProgress(tx, {
        userId,
        lessonId: 'pot-odds',
        completed: true,
      });
      assert.notEqual(finished.completed_at, null);

      const reread = await progress.upsertLessonProgress(tx, { userId, lessonId: 'pot-odds' });
      assert.notEqual(reread.completed_at, null, 'reading a lesson again must not un-finish it');
      assert.equal(
        reread.completed_at?.getTime(),
        finished.completed_at?.getTime(),
        'and must not move the completion time either',
      );
    });
  });

  it('records attempts and answers the whole progress page in one read', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Learner');
      await progress.upsertLessonProgress(tx, { userId, lessonId: 'pot-odds', completed: true });
      await progress.upsertLessonProgress(tx, { userId, lessonId: 'outs-and-equity' });

      await progress.recordQuizAttempt(tx, {
        userId,
        quizId: 'foundations',
        questionId: 'q-break-even',
        answer: { kind: 'number', value: 0.25 },
        wasCorrect: true,
      });
      // The same question again: a learner reconsidering has not answered two questions.
      await progress.recordQuizAttempt(tx, {
        userId,
        quizId: 'foundations',
        questionId: 'q-break-even',
        answer: { kind: 'number', value: 0.26 },
        wasCorrect: false,
      });
      await progress.recordQuizAttempt(tx, {
        userId,
        quizId: 'foundations',
        questionId: 'q-outs',
        answer: { kind: 'choice', index: 2 },
        wasCorrect: true,
      });

      await progress.recordScenarioAttempt(tx, {
        userId,
        scenarioId: 'river-bluff-catch',
        action: 'call',
        matchedExpected: null,
      });
      await progress.recordScenarioAttempt(tx, {
        userId,
        scenarioId: 'turn-semi-bluff',
        action: 'raise',
        to: 120,
        matchedExpected: true,
      });

      const snapshot = await progress.readProgress(tx, userId);
      assert.deepEqual(snapshot.lessonsCompleted, ['pot-odds']);
      assert.deepEqual([...snapshot.lessonsViewed].sort(), ['outs-and-equity', 'pot-odds']);
      assert.deepEqual([...snapshot.scenariosAttempted].sort(), ['river-bluff-catch', 'turn-semi-bluff']);
      assert.equal(snapshot.quizQuestionsAnswered, 2, 'distinct questions, not attempts');
      assert.equal(snapshot.handsPlayed, 0);
      assert.equal(snapshot.unitsNetLifetime, 0);
      assert.equal(typeof snapshot.unitsNetLifetime, 'number', 'bigint must not arrive as a string');
    });
  });

  it('refuses a content id the domain would refuse, and a non-object answer', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Learner');
      for (const bad of ['Pot-Odds', 'pot odds', 'trailing-', 'x'.repeat(64), '']) {
        await rejectsWith(tx, 'invalid_request', (handle) =>
          progress.upsertLessonProgress(handle, { userId, lessonId: bad }),
        );
      }
      await rejectsWith(tx, 'invalid_request', (handle) =>
        progress.recordQuizAttempt(handle, {
          userId,
          quizId: 'foundations',
          questionId: 'q-outs',
          answer: [1, 2, 3],
          wasCorrect: true,
        }),
      );
      await rejectsWith(tx, 'invalid_request', (handle) =>
        progress.recordScenarioAttempt(handle, {
          userId,
          scenarioId: 'turn-semi-bluff',
          action: 'bet',
          matchedExpected: null,
        }),
      );
    });
  });

  it('lets a learner clear their lessons and nothing else', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Learner');
      await progress.upsertLessonProgress(tx, { userId, lessonId: 'pot-odds', completed: true });
      await progress.recordQuizAttempt(tx, {
        userId,
        quizId: 'foundations',
        questionId: 'q-outs',
        answer: { kind: 'choice', index: 1 },
        wasCorrect: true,
      });

      assert.equal(await progress.clearLessonProgress(tx, userId), 1);
      const snapshot = await progress.readProgress(tx, userId);
      assert.deepEqual(snapshot.lessonsCompleted, []);
      assert.equal(snapshot.quizQuestionsAnswered, 1, 'attempts are append-only and stay');
    });
  });

  it('counts hands played and the lifetime net from settled hands', async () => {
    await inRollback(async (tx) => {
      const heroId = await makeGuest(tx, 'Hero');
      const { room } = await makeRoom(tx, heroId);
      const handId = generateId('hand');
      await hands.start(tx, {
        handId,
        roomId: room.id,
        handNumber: 1,
        buttonSeat: 0,
        config: { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
        commitmentRoot: 'c'.repeat(64),
        commitmentContext: `prl-deck-v2|${handId}`,
        randomSourceKind: 'csprng',
        seats: [
          {
            seat: 0,
            userId: heroId,
            isBot: false,
            startingStack: 200,
            holeCards: [parseCard('Ah'), parseCard('Kh')],
            status: 'active',
          },
        ],
      });

      // A hand in progress has not been played yet.
      assert.equal((await progress.readProgress(tx, heroId)).handsPlayed, 0);

      await hands.complete(tx, {
        handId,
        board: [],
        result: {
          showdowns: [],
          pots: [],
          awards: [],
          netBySeat: { 0: -12 },
          endedByFold: true,
          reveal: {
            commitment: {
              algorithm: 'sha256',
              version: COMMITMENT_VERSION,
              root: 'c'.repeat(64),
              context: `prl-deck-v2|${handId}`,
            },
            cards: [],
            complete: false,
          },
        },
        seats: [{ seat: 0, netResult: -12, status: 'folded', showedDown: false }],
      });

      const snapshot = await progress.readProgress(tx, heroId);
      assert.equal(snapshot.handsPlayed, 1);
      assert.equal(snapshot.unitsNetLifetime, -12);
      assert.equal((await users.readUnits(tx, heroId)).netLifetime, -12);
    });
  });
});

describe('audit — against Postgres', dbOptions, () => {
  it('writes a redacted entry and reads it back', async () => {
    await inRollback(async (tx) => {
      const userId = await makeGuest(tx, 'Learner');
      await audit.record(tx, {
        event: 'auth.guest.created',
        userId,
        detail: { route: '/api/v1/auth/guest', context: { sessionToken: 'must not survive' } },
      });

      const entries = await audit.readRecent(tx, { userId, event: 'auth.guest.created' });
      assert.equal(entries.length, 1);
      const detail = JSON.stringify(entries[0]?.detail);
      assert.ok(detail.includes('_redacted'), 'the row records that something was dropped');
      assert.equal(detail.includes('must not survive'), false, 'the nested secret must be gone');
      assert.equal(detail.includes('sessionToken":'), false, 'and so must its key');
    });
  });

  it('accepts an entry with no account and no detail', async () => {
    await inRollback(async (tx) => {
      await audit.record(tx, { event: 'room.invite.rejected' });
      const entries = await audit.readRecent(tx, { event: 'room.invite.rejected', limit: 1 });
      assert.equal(entries[0]?.user_id, null);
      assert.equal(entries[0]?.detail, null);
    });
  });

  it('refuses an event name the column would refuse', async () => {
    await inRollback(async (tx) => {
      for (const bad of ['', 'Ab', 'auth..guest', 'Auth.Guest', 'x'.repeat(65)]) {
        await rejectsWith(tx, 'internal_error', (handle) => audit.record(handle, { event: bad }));
      }
    });
  });

  it('writes a forbidden top-level key as a marker rather than tripping the CHECK', async () => {
    await inRollback(async (tx) => {
      // Without the redaction pass this insert would be a check violation, and a check violation on
      // an audit write takes the request it was auditing down with it.
      await audit.record(tx, {
        event: 'test.forbidden.keys',
        detail: { holeCards: ['Ah', 'Kh'], roomId: 'room_kept' },
      });
      const entries = await audit.readRecent(tx, { event: 'test.forbidden.keys', limit: 1 });
      assert.deepEqual(entries[0]?.detail, { roomId: 'room_kept', _redacted: ['holeCards'] });
    });
  });
});

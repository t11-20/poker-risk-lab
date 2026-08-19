/**
 * The harness the hand-route tests share: an app with the real security layer, and the inserts
 * that put a fixture hand into a real table.
 *
 * Not a `.test.ts` file, so the runner's glob does not pick it up.
 *
 * ## The session layer here is a stand-in, on purpose
 *
 * `src/routes/hands.ts` depends on exactly one thing from `src/auth/session.ts`:
 * `requireSession(request)`, which reads `request.session`. So that is all this harness provides.
 * Registering the real `sessionPlugin` with a fake store would additionally couple every hand test
 * to the store interface, the token digest and the sliding-expiry policy, and would break them
 * whenever any of those is refactored — for reasons with nothing to do with hand history. Real
 * session resolution belongs to `test/auth.test.ts`.
 *
 * What is NOT stubbed is the part that could hide a bug in these routes: the cookie is the real
 * cookie, with the real name, signed with the real secret by `@fastify/cookie`, and every request
 * goes through helmet, CORS, the rate limiter and Ajv exactly as a browser's would.
 */

import assert from 'node:assert/strict';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { buildApp, registerRoutes } from '../../src/app.ts';
import type { SessionAccount } from '../../src/auth/session.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../../src/config.ts';
import type { DatabaseHandle } from '../../src/db.ts';
import { sessionCookieName } from '../../src/plugins/security.ts';
import { sha256 } from '../../src/repositories/hashing.ts';
import { newHandActionId, newHandSeatId } from '../../src/repositories/ids.ts';
import type { Db } from '../../src/repositories/sql.ts';
import handsRoutes from '../../src/routes/hands.ts';
import { databaseSkip, TEST_DATABASE_URL, withAdminSql } from './database.ts';
import type { PersistedHand } from './hand-rows.ts';

/**
 * Set when a database is available.
 *
 * Re-exported from `./database.ts` rather than read from the environment here: one file decides
 * whether the database suites run, and `test/database-availability.test.ts` asserts that no other
 * file in this tree reads `DATABASE_URL` at all. Five hand-rolled copies of that condition are how
 * 57 tests came to skip on every documented command while the run exited 0.
 */
export { TEST_DATABASE_URL };

export const DB_SKIP_REASON = databaseSkip('the hand routes');

/** Prints the reason once per file, so a skipped suite never looks like a passing one. */
export function announceSkipUnlessDatabase(what: string): void {
  if (DB_SKIP_REASON !== false) console.info(`skipping ${what}: ${DB_SKIP_REASON}`);
}

export function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // A syntactically valid URL when there is no database: `loadConfig` insists on one, and
    // nothing connects unless `configureDatabase` is called.
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    // Generous, so the limiter is never the reason an assertion fails. The limits themselves are
    // covered by `test/security-headers.test.ts`.
    RATE_LIMIT_MAX: '5000',
    RATE_LIMIT_EXPENSIVE_MAX: '5000',
    ...overrides,
  });
}

/** `buildApp` needs a `DatabaseHandle` for `/ready`; the routes use `getSql()` instead. */
export const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(undefined),
};

export function accountFor(userId: string, displayName: string): SessionAccount {
  return { id: userId, kind: 'guest', displayName, createdAt: new Date().toISOString() };
}

/** Resolves the real signed session cookie to one of the given accounts, keyed by token. */
function stubSessionPlugin(
  config: AppConfig,
  accounts: ReadonlyMap<string, SessionAccount>,
): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = (app) => {
    if (!app.hasRequestDecorator('session')) {
      app.decorateRequest('session', null);
      app.decorateRequest('sessionRejection', null);
    }
    app.addHook('preHandler', (request, _reply, done) => {
      // `request.cookies` is null until @fastify/cookie's own hook has run; same guard, same
      // reason, as `plugins/security.ts`.
      const jar: { [name: string]: string | undefined } | null = request.cookies;
      const raw = jar === null ? undefined : jar[sessionCookieName(config)];
      if (raw !== undefined) {
        const unsigned = request.unsignCookie(raw);
        const account = unsigned.valid ? accounts.get(unsigned.value) : undefined;
        if (account === undefined) request.sessionRejection = 'malformed';
        else request.session = { sessionId: `ses_${account.id.slice(4)}`, user: account };
      }
      done();
    });
    return Promise.resolve();
  };
  // Same reason as the real plugin: without this the hook lands on a child scope no route belongs
  // to, and every test would silently see an anonymous caller.
  Object.defineProperty(plugin, Symbol.for('skip-override'), { value: true });
  return plugin;
}

export interface HandsAppHarness {
  readonly app: FastifyInstance;
  /** A `cookie` header value for the given token. */
  readonly cookieFor: (token: string) => string;
}

/** An app carrying the security layer, a stand-in session, and the hand routes. */
export async function buildHandsApp(options: {
  readonly config: AppConfig;
  readonly accounts: ReadonlyMap<string, SessionAccount>;
}): Promise<HandsAppHarness> {
  const app = await buildApp({ config: options.config, database: stubDatabase });
  await app.register(stubSessionPlugin(options.config, options.accounts));
  await registerRoutes(app, [handsRoutes]);
  await app.ready();
  return {
    app,
    cookieFor: (token) => `${sessionCookieName(options.config)}=${app.signCookie(token)}`,
  };
}

// ---------------------------------------------------------------------------
// Inserts
// ---------------------------------------------------------------------------

/**
 * A `jsonb` value as a text parameter, or SQL NULL.
 *
 * The `::text::jsonb` double cast at every call site below is not decoration. Given
 * `${value}::jsonb`, Postgres infers the parameter's type as `jsonb` and the driver then
 * serialises the JS string with `JSON.stringify` — so `'["Ah","Ks"]'` arrives as the JSON *string*
 * `"[\"Ah\",\"Ks\"]"`, `jsonb_typeof` reports `string`, and `hands_board_is_cards` refuses the row.
 * Casting the parameter to `text` first pins the inference and lets Postgres parse the JSON.
 *
 * `JSON.stringify(null)` is the string `'null'`, which becomes a JSON null rather than SQL NULL,
 * and `hands_result_iff_completed` can tell the difference. Hence the branch.
 */
export function jsonText(value: unknown): string | null {
  return value === null || value === undefined ? null : (JSON.stringify(value) ?? null);
}

export async function insertGuest(sql: Db, userId: string, displayName: string): Promise<void> {
  await sql`insert into prl.users (id, kind, display_name) values (${userId}, 'guest', ${displayName})`;
}

/** A private table. Only the digest of the invite code is ever stored. */
export async function insertRoom(sql: Db, roomId: string, ownerUserId: string): Promise<void> {
  await sql`
    insert into prl.rooms (
      id, name, owner_user_id, invite_code_hash, max_seats, small_blind, big_blind, ante,
      starting_stack, action_timeout_seconds
    ) values (
      ${roomId}, 'Review table', ${ownerUserId}, ${sha256(`invite-${roomId}`)}, 6, 1, 2, 0, 200, 30
    )
  `;
}

/**
 * Writes a fixture hand: the hand, its seats, its actions.
 *
 * Note what is absent, and note that it is absent because there is nowhere to put it: no deck and
 * no salts. The columns do not exist.
 */
export async function insertHand(sql: Db, fixture: PersistedHand): Promise<void> {
  const hand = fixture.hand;
  await sql`
    insert into prl.hands (
      id, room_id, hand_number, button_seat, config, commitment_root, commitment_context,
      random_source_kind, board, street, result, reveal, started_at, completed_at
    ) values (
      ${hand.id}, ${hand.room_id}, ${hand.hand_number}, ${hand.button_seat},
      ${jsonText(hand.config)}::text::jsonb, ${hand.commitment_root}, ${hand.commitment_context},
      'fixed-deck-scenario', ${jsonText(hand.board)}::text::jsonb, ${hand.street},
      ${jsonText(hand.result)}::text::jsonb, ${jsonText(hand.reveal)}::text::jsonb,
      ${hand.started_at}, ${hand.completed_at}
    )
  `;
  for (const seat of fixture.seats) {
    await sql`
      insert into prl.hand_seats (
        id, hand_id, seat, user_id, is_bot, starting_stack, hole_cards, net_result, status, showed_down
      ) values (
        ${newHandSeatId()}, ${hand.id}, ${seat.seat}, ${seat.user_id}, ${seat.is_bot},
        ${seat.starting_stack}, ${jsonText(seat.hole_cards)}::text::jsonb, ${seat.net_result},
        ${seat.status}, ${seat.showed_down}
      )
    `;
  }
  for (const action of fixture.actions) {
    await sql`
      insert into prl.hand_actions (
        id, hand_id, sequence, street, seat, action_type, action_to, amount_paid,
        bet_level_after, pot_after, was_automatic, action_id
      ) values (
        ${newHandActionId()}, ${hand.id}, ${action.sequence}, ${action.street}, ${action.seat},
        ${action.action_type}, ${action.action_to}, ${action.amount_paid}, ${action.bet_level_after},
        ${action.pot_after}, ${action.was_automatic}, ${`fixture-${hand.id.slice(-6)}-${action.sequence}`}
      )
    `;
  }
}

/**
 * Removes everything a test inserted.
 *
 * The room cascades to its hands, and each hand to its seats and actions, so the order is: rooms
 * first (which takes the history with it), then the accounts, which `rooms.owner_user_id` would
 * otherwise RESTRICT.
 *
 * ## Why the two deletes run on two different connections
 *
 * `prl.rooms` is one of the tables the runtime role may not delete from: the grant matrix at the
 * bottom of `db/migrations/0001_initial.sql` gives `prl_app` SELECT/INSERT/UPDATE there and no
 * DELETE, because a room carries other learners' hand history and removing it must be a deliberate
 * ordered operation rather than something the API can do by accident.
 *
 * This one statement is why CI's `test` job could not connect as a member of `prl_app` and had to
 * keep using the superuser — so the job that runs every SQL-backed test was the one job that never
 * exercised the privilege model (audit finding OPS-008). Widening the grant to fix that would have
 * deleted the finding rather than the defect. Instead the teardown says which identity it needs:
 * the room delete goes to the schema-owning identity (`DATABASE_URL_ADMIN`, falling back to
 * `DATABASE_URL`), and everything the application itself can legitimately do — `prl.users` carries
 * a real DELETE grant, because a learner deleting their account is an application path — stays on
 * the suite's own connection, where a missing GRANT still fails the suite.
 *
 * `prl.users` is deleted second and on the app connection ON PURPOSE: it is the assertion that the
 * runtime role can still do its own work. Moving it to the admin handle for tidiness would make
 * this helper prove nothing about the grant it depends on.
 */
export async function deleteFixtures(
  sql: Db,
  roomIds: readonly string[],
  userIds: readonly string[],
): Promise<void> {
  if (roomIds.length > 0) {
    await withAdminSql(async (admin) => {
      for (const roomId of roomIds) await admin`delete from prl.rooms where id = ${roomId}`;
    });
  }
  for (const userId of userIds) await sql`delete from prl.users where id = ${userId}`;
}

/** Narrows an `inject` body to the contract's error shape and returns the code. */
export function errorCodeOf(payload: string): string {
  const parsed: unknown = JSON.parse(payload);
  const outer = parsed === null || typeof parsed !== 'object' ? null : parsed;
  assert.ok(outer !== null, `expected an error body, got ${payload.slice(0, 120)}`);
  const error: unknown = Reflect.get(outer, 'error');
  assert.ok(
    error !== null && typeof error === 'object',
    `expected an error member in ${payload.slice(0, 120)}`,
  );
  const code: unknown = Reflect.get(error, 'code');
  assert.equal(typeof code, 'string');
  return String(code);
}

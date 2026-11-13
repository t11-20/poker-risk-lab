/**
 * Shared harness for the hand-route tests. An app with the real security layer, and fixture inserts.
 * The session layer is a stand-in, because `src/routes/hands.ts` only needs `request.session`. The
 * cookie is still real, signed with the real secret, and every request passes helmet, CORS, the
 * rate limiter and Ajv. Real session resolution is `test/auth.test.ts`.
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

/** Re-exported, because `test/database-availability.test.ts` allows one file to read the variable. */
export { TEST_DATABASE_URL };

export const DB_SKIP_REASON = databaseSkip('the hand routes');

export function announceSkipUnlessDatabase(what: string): void {
  if (DB_SKIP_REASON !== false) console.info(`skipping ${what}: ${DB_SKIP_REASON}`);
}

export function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // `loadConfig` requires a URL. Nothing connects unless `configureDatabase` is called.
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    // Generous, so the limiter never fails an assertion. Limits are `test/security-headers.test.ts`.
    RATE_LIMIT_MAX: '5000',
    RATE_LIMIT_EXPENSIVE_MAX: '5000',
    ...overrides,
  });
}

export const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(undefined),
};

export function accountFor(userId: string, displayName: string): SessionAccount {
  return { id: userId, kind: 'guest', displayName, createdAt: new Date().toISOString() };
}

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
      // `request.cookies` is null until @fastify/cookie's hook has run.
      const jar: { [name: string]: string | undefined } | null = request.cookies;
      const raw = jar === null ? undefined : jar[sessionCookieName(config)];
      if (raw !== undefined) {
        const unsigned = request.unsignCookie(raw);
        const account = unsigned.valid ? accounts.get(unsigned.value) : undefined;
        if (account === undefined) request.sessionRejection = 'malformed';
        else {
          request.session = {
            sessionId: `ses_${account.id.slice(4)}`,
            user: account,
            expiresAt: new Date(Date.now() + 3_600_000),
          };
        }
      }
      done();
    });
    return Promise.resolve();
  };
  // Without this the hook lands on a child scope and every caller looks anonymous.
  Object.defineProperty(plugin, Symbol.for('skip-override'), { value: true });
  return plugin;
}

export interface HandsAppHarness {
  readonly app: FastifyInstance;
  readonly cookieFor: (token: string) => string;
}

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

/**
 * Every call site casts `::text::jsonb`. With `::jsonb` alone the driver serialises the string again
 * and Postgres stores a JSON string. `null` becomes SQL NULL, which `hands_result_iff_completed`
 * tells apart from JSON null.
 */
export function jsonText(value: unknown): string | null {
  return value === null || value === undefined ? null : (JSON.stringify(value) ?? null);
}

export async function insertGuest(sql: Db, userId: string, displayName: string): Promise<void> {
  await sql`insert into prl.users (id, kind, display_name) values (${userId}, 'guest', ${displayName})`;
}

/** Only the digest of the invite code is stored. */
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

/** No deck and no salts, because the columns do not exist. */
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
 * Rooms go on the owner connection (`DATABASE_URL_ADMIN`, else `DATABASE_URL`), because `prl_app`
 * has no DELETE on `prl.rooms` (OPS-008). The users delete stays on the app connection on purpose,
 * so a missing grant on the runtime role still fails the suite.
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

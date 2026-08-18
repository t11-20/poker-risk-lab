/**
 * Rooms: the live table's rules, and the REST surface over it.
 *
 * ## No database, and no clock
 *
 * `RoomStore` and `SessionStore` are ports, so the whole of rooms, seating, bots and the Legends
 * endpoints runs against `Map`-backed fakes in this file. The tables run on a manual clock, so a
 * thirty-second turn timer is exercised in a microsecond and nothing here depends on wall time.
 *
 * ## What is asserted, and why these things
 *
 * The interesting assertions are the ones about *refusals*: a duplicate `actionId` that must not
 * apply twice, a stale `expectedSequence` that must leave the state byte-identical, a seat that is
 * not to act, a timeout that must never call, and an invite code that must appear exactly once and
 * never again. Each of those is a place where being wrong is expensive and being wrong is quiet.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_MESSAGES } from '@prl/contracts';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { SessionAccount, SessionStore, StoredSession } from '../src/auth/session.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppError, isAppError } from '../src/errors.ts';
import type { RoomMemberRow, RoomRow } from '../src/repositories/rooms.ts';
import { botDisplayName, persistableProfile, resolveProfile } from '../src/rooms/bots.ts';
import { RoomRegistry, type RoomStore } from '../src/rooms/registry.ts';
import { LiveTable } from '../src/rooms/table.ts';
import { createManualClock, type ManualClock, TurnTimer } from '../src/rooms/timers.ts';
import { createRoomRoutes } from '../src/routes/rooms.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

/** Readable, sequential hand ids, so a failure names the hand it happened in. */
function incrementingHandIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_test${count}`;
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A session store backed by a Map, keyed by the plaintext token.
 *
 * The real store hashes inside the repository, which is what keeps a plaintext token out of every
 * query in the codebase; a fake has no query to keep it out of, so it holds the token directly and
 * the digest never comes into it.
 */
function fakeSessionStore(): {
  readonly store: SessionStore;
  readonly signIn: (account: SessionAccount) => string;
} {
  const byToken = new Map<string, StoredSession>();
  let counter = 0;
  return {
    store: {
      findValidByToken: (token) => Promise.resolve(byToken.get(token) ?? null),
      create: () => {
        counter += 1;
        return Promise.resolve({
          sessionId: `ses_${counter}`,
          token: `token-${counter}`,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
      },
      extendExpiry: () => Promise.resolve(null),
      revoke: () => Promise.resolve(true),
      touchLastSeen: () => Promise.resolve(true),
    },
    signIn: (account) => {
      counter += 1;
      const token = `token-for-${account.id}-${counter}`;
      byToken.set(token, {
        sessionId: `ses_${counter}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        user: account,
      });
      return token;
    },
  };
}

interface FakeRoomStore extends RoomStore {
  /** The plaintext codes handed out, so a test can join with one. */
  readonly codes: Map<string, string>;
  readonly units: Map<string, number>;
  readonly rows: Map<string, RoomRow>;
}

/**
 * A `Map`-backed room store.
 *
 * It enforces the two rules the real one leaves to a partial unique index — one live member per
 * seat, one membership per user — because those are the two a test needs to be able to trip.
 */
function fakeRoomStore(): FakeRoomStore {
  const rows = new Map<string, RoomRow>();
  const members = new Map<string, RoomMemberRow>();
  const codes = new Map<string, string>();
  const units = new Map<string, number>();
  let counter = 0;
  const key = (roomId: string, userId: string): string => `${roomId}:${userId}`;

  return {
    codes,
    units,
    rows,
    create: (spec) => {
      counter += 1;
      const id = `room_test${counter}`;
      const row: RoomRow = {
        id,
        name: spec.name,
        owner_user_id: spec.ownerUserId,
        max_seats: spec.maxSeats,
        small_blind: spec.smallBlind,
        big_blind: spec.bigBlind,
        ante: spec.ante ?? 0,
        starting_stack: spec.startingStack,
        action_timeout_seconds: spec.actionTimeoutSeconds ?? 30,
        visibility: 'invite_only',
        status: 'open',
        closed_at: null,
        created_at: new Date('2026-08-17T12:00:00.000Z'),
      };
      rows.set(id, row);
      const inviteCode = `INVITE${counter}CODE`;
      codes.set(inviteCode, id);
      return Promise.resolve({ room: row, inviteCode });
    },
    byId: (roomId) => Promise.resolve(rows.get(roomId) ?? null),
    byInviteCode: (code) => {
      const roomId = codes.get(code);
      return Promise.resolve(roomId === undefined ? null : (rows.get(roomId) ?? null));
    },
    listForUser: (userId) =>
      Promise.resolve(
        [...rows.values()].filter((row) => row.owner_user_id === userId || members.has(key(row.id, userId))),
      ),
    membersOfRooms: (roomIds) =>
      Promise.resolve([...members.values()].filter((member) => roomIds.includes(member.room_id))),
    memberOf: (roomId, userId) => Promise.resolve(members.get(key(roomId, userId)) ?? null),
    addMember: (input) => {
      const existing = members.get(key(input.roomId, input.userId));
      if (existing !== undefined) return Promise.resolve(existing);
      const row = rows.get(input.roomId);
      if (row === undefined) throw new AppError('room_not_found_or_not_permitted', {});
      counter += 1;
      const member: RoomMemberRow = {
        id: `mem_${counter}`,
        room_id: input.roomId,
        user_id: input.userId,
        display_name: `Player ${input.userId}`,
        seat: null,
        stack: input.stack ?? row.starting_stack,
        is_bot: input.isBot ?? false,
        bot_profile: input.isBot === true ? (input.botProfile ?? 'unknown') : null,
        joined_at: new Date(),
        left_at: null,
      };
      members.set(key(input.roomId, input.userId), member);
      return Promise.resolve(member);
    },
    seatMember: (roomId, userId, seat) => {
      const member = members.get(key(roomId, userId));
      if (member === undefined) throw new AppError('not_room_member', {});
      const taken = [...members.values()].some(
        (other) => other.room_id === roomId && other.seat === seat && other.user_id !== userId,
      );
      if (taken) throw new AppError('seat_taken', {});
      members.set(key(roomId, userId), { ...member, seat });
      return Promise.resolve();
    },
    unseatMember: (roomId, userId) => {
      const member = members.get(key(roomId, userId));
      if (member !== undefined) members.set(key(roomId, userId), { ...member, seat: null });
      return Promise.resolve();
    },
    removeMember: (roomId, userId) => {
      members.delete(key(roomId, userId));
      return Promise.resolve();
    },
    close: (roomId) => {
      const row = rows.get(roomId);
      if (row === undefined) return Promise.resolve(false);
      rows.set(roomId, { ...row, status: 'closed', closed_at: new Date() });
      return Promise.resolve(true);
    },
    createBotUser: (displayName) => {
      counter += 1;
      return Promise.resolve({ id: `usr_bot${counter}`, displayName });
    },
    readUnits: (userId) => Promise.resolve(units.get(userId) ?? 10_000),
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly store: FakeRoomStore;
  readonly registry: RoomRegistry;
  readonly sessions: ReturnType<typeof fakeSessionStore>;
  readonly clock: ManualClock;
}

/** The one route this file adds: a CSRF token to send with the mutating requests. */
const CSRF_ROUTE = '/api/v1/test-csrf-rooms';

async function harness(overrides: { readonly config?: AppConfig } = {}): Promise<Harness> {
  const app = await buildApp({ config: overrides.config ?? testConfig(), database: stubDatabase });
  app.get(CSRF_ROUTE, async (_request, reply) => ({ token: reply.generateCsrf() }));
  const clock = createManualClock();
  const store = fakeRoomStore();
  const registry = new RoomRegistry({
    store,
    clock,
    random: createSecureRandom(),
    nextHandId: incrementingHandIds(),
    botThinkingDelayMs: 5,
  });
  const sessions = fakeSessionStore();
  await app.register(createRoomRoutes({ registry, sessionStore: sessions.store }), {
    prefix: '/api/v1',
  });
  await app.ready();
  return { app, store, registry, sessions, clock };
}

/** A signed-in caller: the signed cookie a browser would send. */
function caller(
  harnessed: Harness,
  account: Partial<SessionAccount> & { readonly id: string },
): { readonly cookies: Record<string, string> } {
  const full: SessionAccount = {
    id: account.id,
    kind: account.kind ?? 'guest',
    displayName: account.displayName ?? `Player ${account.id}`,
    createdAt: account.createdAt ?? new Date().toISOString(),
  };
  const token = harnessed.sessions.signIn(full);
  return { cookies: { prl_session: harnessed.app.signCookie(token) } };
}

/**
 * A CSRF token and its cookie, minted through the real plugin.
 *
 * Every mutating request in this file carries them, so these tests take exactly the path a
 * browser's would — including the check that would reject them if the security layer's hook order
 * ever changed.
 */
async function csrfPair(app: FastifyInstance): Promise<{ token: string; cookie: string }> {
  const response = await app.inject({ method: 'GET', url: CSRF_ROUTE });
  const body: unknown = response.json();
  assert.ok(typeof body === 'object' && body !== null && 'token' in body);
  const payload: { readonly token?: unknown } = body;
  const cookie = response.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(cookie !== undefined);
  return { token: String(payload.token), cookie: cookie.value };
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

describe('turn timers', () => {
  it('fires at an absolute deadline and not before', () => {
    const clock = createManualClock();
    const fired: number[] = [];
    const timer = new TurnTimer({ clock, onExpiry: (expiry) => fired.push(expiry.seat) });
    timer.arm({ handId: 'hand_1', seat: 2, deadlineMs: clock.now() + 30_000 });

    clock.advance(29_999);
    assert.deepEqual(fired, [], 'a timer must not fire before its deadline');
    clock.advance(1);
    assert.deepEqual(fired, [2]);
    assert.equal(timer.deadlineMs, null, 'a fired timer holds no deadline');
  });

  it('is cancelled by an action, and a disposed timer never fires', () => {
    const clock = createManualClock();
    let fired = 0;
    const timer = new TurnTimer({
      clock,
      onExpiry: () => {
        fired += 1;
      },
    });

    timer.arm({ handId: 'hand_1', seat: 0, deadlineMs: clock.now() + 1_000 });
    timer.cancel();
    clock.advance(5_000);
    assert.equal(fired, 0, 'cancel must stop the deadline');
    assert.equal(clock.pending, 0, 'a cancelled timer must not stay queued');

    timer.arm({ handId: 'hand_1', seat: 0, deadlineMs: clock.now() + 1_000 });
    timer.dispose();
    clock.advance(5_000);
    assert.equal(fired, 0, 'a closed room must not be able to fire a timer');
  });

  it('re-arms rather than firing early when the clock is short', () => {
    const clock = createManualClock();
    let fired = 0;
    const timer = new TurnTimer({
      clock,
      onExpiry: () => {
        fired += 1;
      },
    });
    // A deadline in the past fires on the next turn of the loop rather than synchronously.
    timer.arm({ handId: 'hand_1', seat: 1, deadlineMs: clock.now() - 5 });
    assert.equal(fired, 0, 'arming must not fire inline');
    clock.advance(0);
    assert.equal(fired, 1);
  });
});

// ---------------------------------------------------------------------------
// The live table
// ---------------------------------------------------------------------------

interface TableHarness {
  readonly table: LiveTable;
  readonly clock: ManualClock;
}

async function headsUp(): Promise<TableHarness> {
  const clock = createManualClock();
  const table = new LiveTable({
    roomId: 'room_unit',
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
    clock,
    random: createSecureRandom(),
    nextHandId: incrementingHandIds(),
  });
  await table.sit({ userId: 'usr_a', displayName: 'Ada', seat: 0, stack: 1_000 });
  await table.sit({ userId: 'usr_b', displayName: 'Bo', seat: 1, stack: 1_000 });
  return { table, clock };
}

/** Whoever the engine says is to act, as a user id. */
function actorOf(table: LiveTable): string {
  const view = table.viewFor('usr_a');
  assert.ok(view !== null);
  const seat = view.toAct;
  assert.ok(seat !== null, 'somebody must be to act');
  return seat === 0 ? 'usr_a' : 'usr_b';
}

describe('the live table', () => {
  it('deduplicates a repeated actionId and does not apply it twice', async () => {
    const { table } = await headsUp();
    await table.startHand();
    const actor = actorOf(table);
    const before = table.viewFor(actor);
    assert.ok(before !== null);

    const first = await table.submitAction(actor, {
      action: { type: 'call' },
      actionId: 'action-0001',
      expectedSequence: before.actionSequence,
    });
    assert.equal(first.deduplicated, false);

    const afterFirst = table.viewFor(actor);
    assert.ok(afterFirst !== null);
    const sequenceAfterFirst = afterFirst.actionSequence;
    const potAfterFirst = afterFirst.potTotal;

    // The retry a dropped response would produce: same actionId, same (now stale) sequence.
    const retry = await table.submitAction(actor, {
      action: { type: 'call' },
      actionId: 'action-0001',
      expectedSequence: before.actionSequence,
    });
    assert.equal(retry.deduplicated, true, 'a repeated actionId must be reported as deduplicated');
    assert.equal(retry.appliedSequence, first.appliedSequence, 'the original outcome must stand');

    const afterRetry = table.viewFor(actor);
    assert.ok(afterRetry !== null);
    assert.equal(afterRetry.actionSequence, sequenceAfterFirst, 'the retry must not advance the hand');
    assert.equal(afterRetry.potTotal, potAfterFirst, 'the retry must not move any chips');
  });

  it('rejects a stale expectedSequence and leaves the state untouched', async () => {
    const { table } = await headsUp();
    await table.startHand();
    const actor = actorOf(table);
    const before = table.viewFor(actor);
    assert.ok(before !== null);
    const snapshot = JSON.stringify(before);

    await assert.rejects(
      table.submitAction(actor, {
        action: { type: 'call' },
        actionId: 'action-stale',
        expectedSequence: before.actionSequence + 5,
      }),
      (error: unknown) => isAppError(error) && error.code === 'stale_action_sequence',
    );

    assert.equal(JSON.stringify(table.viewFor(actor)), snapshot, 'a rejection must change nothing');
  });

  it('refuses an action from the seat that is not to act', async () => {
    const { table } = await headsUp();
    await table.startHand();
    const actor = actorOf(table);
    const waiting = actor === 'usr_a' ? 'usr_b' : 'usr_a';
    const view = table.viewFor(waiting);
    assert.ok(view !== null);

    await assert.rejects(
      table.submitAction(waiting, {
        action: { type: 'call' },
        actionId: 'action-outofturn',
        expectedSequence: view.actionSequence,
      }),
      (error: unknown) => isAppError(error) && error.code === 'not_your_turn',
    );
  });

  it('checks for free on a timeout and folds when facing a bet, never calls', async () => {
    const { table, clock } = await headsUp();
    await table.startHand();

    // Preflop heads-up the small blind is facing the big blind, so the timeout must fold.
    const actor = actorOf(table);
    const seat = table.seatOf(actor);
    clock.advance(30_001);
    await Promise.resolve();
    const afterFold = table.viewFor(actor);
    assert.ok(afterFold !== null);
    const timedOut = afterFold.actions.find((action) => action.seat === seat);
    assert.ok(timedOut !== undefined, 'the timeout must have produced an action');
    assert.equal(timedOut.action.type, 'fold', 'facing a bet, a timeout folds');
    assert.equal(timedOut.wasAutomatic, true, 'a timeout is recorded as automatic');
    assert.equal(timedOut.amountPaid, 0, 'a timeout must never spend a chip');
  });

  it('shows each seat only its own cards', async () => {
    const { table } = await headsUp();
    await table.startHand();

    const alpha = table.viewFor('usr_a');
    const beta = table.viewFor('usr_b');
    assert.ok(alpha !== null && beta !== null);

    assert.notEqual(JSON.stringify(alpha), JSON.stringify(beta), 'two seats must not share a view');
    for (const [view, ownSeat] of [
      [alpha, 0],
      [beta, 1],
    ] as const) {
      for (const seat of view.seats) {
        if (seat.seat === ownSeat) {
          assert.ok(seat.holeCards !== null, 'a seat must see its own cards');
          continue;
        }
        assert.equal(seat.holeCards, null, 'a seat must not see anybody else’s cards');
      }
    }
    const raw = JSON.stringify(alpha);
    assert.ok(!raw.includes('"deck"'), 'a view must not carry a deck');
    assert.ok(!raw.includes('deckSalt'), 'a view must not carry a salt');
  });

  it('folds a seat that stood up, and does not let it escape its bet', async () => {
    const { table } = await headsUp();
    await table.startHand();
    const actor = actorOf(table);

    await table.stand(actor);
    const view = table.viewFor('usr_a');
    assert.ok(view !== null);
    const folded = view.actions.at(-1);
    assert.ok(folded !== undefined, 'standing up mid-hand must produce a fold');
    assert.equal(folded.action.type, 'fold');
    assert.equal(folded.wasAutomatic, true);
  });

  it('releases its timer when the room closes', async () => {
    const { table, clock } = await headsUp();
    await table.startHand();
    assert.ok(clock.pending > 0, 'a hand in progress arms a turn timer');
    table.close();
    assert.equal(clock.pending, 0, 'a closed table must not leave a timer armed');
  });
});

// ---------------------------------------------------------------------------
// Bot naming and profile mapping
// ---------------------------------------------------------------------------

describe('bot profiles', () => {
  it('maps the contract’s five legacy names onto strategy profiles', () => {
    for (const legacy of ['nit', 'tight-aggressive', 'loose-aggressive', 'calling-station', 'maniac']) {
      const profile = resolveProfile(legacy);
      assert.ok(profile.naming.id.length > 0, `${legacy} must resolve to a profile`);
    }
    assert.throws(
      () => resolveProfile('not-a-profile'),
      (error: unknown) => isAppError(error),
    );
  });

  it('persists a Legends profile the seat CHECK does not know as "unknown"', () => {
    assert.equal(persistableProfile('calling-station'), 'calling-station');
    assert.equal(persistableProfile('adaptive-exploiter'), 'unknown');
  });

  it('keeps a bot’s seat plate inside the database’s display-name rule', () => {
    for (const profile of ['reading-pressure-specialist', 'adaptive-exploiter', 'calling-station']) {
      const name = botDisplayName(profile);
      assert.ok(name.length >= 2 && name.length <= 24, `${profile} produced "${name}"`);
      assert.equal(name, name.trim(), 'the database requires a trimmed name');
    }
  });
});

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

describe('POST /rooms', () => {
  it('creates a room and returns the invite code exactly once', async () => {
    const test = await harness();
    const owner = caller(test, { id: 'usr_owner' });
    const { token, cookie } = await csrfPair(test.app);

    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      payload: {
        name: 'Study table',
        maxSeats: 3,
        smallBlind: 5,
        bigBlind: 10,
        startingStack: 1_000,
      },
      cookies: { ...owner.cookies, prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });

    assert.equal(created.statusCode, 201, created.payload);
    const body: unknown = created.json();
    assert.ok(typeof body === 'object' && body !== null && 'inviteCode' in body && 'room' in body);
    const payload: { readonly inviteCode?: unknown; readonly room?: unknown } = body;
    const inviteCode = String(payload.inviteCode);
    assert.match(inviteCode, /^[A-Za-z0-9-]{8,32}$/);
    const room = payload.room;
    assert.ok(typeof room === 'object' && room !== null && 'id' in room);
    const roomId = String((room as { readonly id: unknown }).id);

    // The one place the code appears. Every later read of the same room must not carry it.
    const read = await test.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      cookies: owner.cookies,
    });
    assert.equal(read.statusCode, 200, read.payload);
    assert.ok(!read.payload.includes(inviteCode), 'a room read must never repeat the invite code');
    assert.ok(!read.payload.includes('inviteCode'), 'a room summary has no invite field at all');

    const listed = await test.app.inject({ method: 'GET', url: '/api/v1/rooms', cookies: owner.cookies });
    assert.equal(listed.statusCode, 200);
    assert.ok(!listed.payload.includes(inviteCode), 'the room list must never carry an invite code');

    await test.app.close();
  });

  it('refuses an anonymous caller', async () => {
    const test = await harness();
    const { token, cookie } = await csrfPair(test.app);
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      payload: { name: 'Study table', maxSeats: 2, smallBlind: 5, bigBlind: 10, startingStack: 1_000 },
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });
    assert.equal(response.statusCode, 401);
    await test.app.close();
  });

  it('seats the bots the body asks for, leaving seat 0 for the owner', async () => {
    const test = await harness();
    const owner = caller(test, { id: 'usr_owner' });
    const { token, cookie } = await csrfPair(test.app);

    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      payload: {
        name: 'Bot table',
        maxSeats: 3,
        smallBlind: 5,
        bigBlind: 10,
        startingStack: 1_000,
        bots: [{ profile: 'calling-station', count: 2 }],
      },
      cookies: { ...owner.cookies, prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const room: unknown = created.json();
    assert.ok(typeof room === 'object' && room !== null && 'room' in room);
    const summary = (
      room as {
        readonly room: {
          readonly members: readonly {
            readonly seat: number | null;
            readonly isBot: boolean;
            readonly botProfile: string | null;
          }[];
        };
      }
    ).room;
    const bots = summary.members.filter((member) => member.isBot);
    assert.equal(bots.length, 2);
    assert.deepEqual(bots.map((bot) => bot.seat).sort(), [1, 2], 'bots take seats above the owner’s');
    for (const bot of bots) {
      assert.equal(bot.botProfile, 'calling-station', 'the live record carries the real profile id');
    }
    await test.app.close();
  });
});

describe('joining and sitting', () => {
  it('answers invite_code_invalid for a code no room matches', async () => {
    const test = await harness();
    const guest = caller(test, { id: 'usr_guest' });
    const { token, cookie } = await csrfPair(test.app);

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rooms/join',
      payload: { inviteCode: 'NOSUCHCODE12' },
      cookies: { ...guest.cookies, prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });
    assert.equal(response.statusCode, 404);
    const body: unknown = response.json();
    assert.ok(typeof body === 'object' && body !== null && 'error' in body);
    assert.equal((body as { error: { code: string } }).error.code, 'invite_code_invalid');
    await test.app.close();
  });

  it('gives a non-member the same answer as somebody asking for a room that does not exist', async () => {
    const test = await harness();
    const owner = caller(test, { id: 'usr_owner' });
    const { token, cookie } = await csrfPair(test.app);
    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      payload: { name: 'Private', maxSeats: 2, smallBlind: 5, bigBlind: 10, startingStack: 1_000 },
      cookies: { ...owner.cookies, prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });
    const roomId = String((created.json() as { room: { id: string } }).room.id);

    const stranger = caller(test, { id: 'usr_stranger' });
    const forbidden = await test.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      cookies: stranger.cookies,
    });
    const missing = await test.app.inject({
      method: 'GET',
      url: '/api/v1/rooms/room_doesnotexist',
      cookies: stranger.cookies,
    });

    assert.equal(forbidden.statusCode, 404);
    assert.equal(missing.statusCode, 404);
    const forbiddenCode = (forbidden.json() as { error: { code: string; message: string } }).error;
    const missingCode = (missing.json() as { error: { code: string; message: string } }).error;
    assert.equal(forbiddenCode.code, 'room_not_found_or_not_permitted');
    assert.equal(missingCode.code, forbiddenCode.code, 'the two must be indistinguishable');
    assert.equal(forbiddenCode.message, ERROR_MESSAGES.room_not_found_or_not_permitted);
    await test.app.close();
  });

  it('lets a member sit, refuses a taken seat, and refuses a buy-in beyond the units', async () => {
    const test = await harness();
    const owner = caller(test, { id: 'usr_owner' });
    const { token, cookie } = await csrfPair(test.app);
    const mutate = { 'x-csrf-token': token, origin: ALLOWED_ORIGIN };

    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      payload: { name: 'Seats', maxSeats: 3, smallBlind: 5, bigBlind: 10, startingStack: 1_000 },
      cookies: { ...owner.cookies, prl_csrf: cookie },
      headers: mutate,
    });
    const roomId = String((created.json() as { room: { id: string } }).room.id);
    const code = [...test.store.codes.keys()].at(-1);
    assert.ok(code !== undefined);

    const sat = await test.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/sit`,
      payload: { seat: 0 },
      cookies: { ...owner.cookies, prl_csrf: cookie },
      headers: mutate,
    });
    assert.equal(sat.statusCode, 200, sat.payload);

    // A second learner joins by code, then tries the same seat.
    const guest = caller(test, { id: 'usr_guest' });
    const joined = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rooms/join',
      payload: { inviteCode: code },
      cookies: { ...guest.cookies, prl_csrf: cookie },
      headers: mutate,
    });
    assert.equal(joined.statusCode, 200, joined.payload);

    const clash = await test.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/sit`,
      payload: { seat: 0 },
      cookies: { ...guest.cookies, prl_csrf: cookie },
      headers: mutate,
    });
    assert.equal(clash.statusCode, 409);
    assert.equal((clash.json() as { error: { code: string } }).error.code, 'seat_taken');

    // The same learner, now short of units for the buy-in.
    test.store.units.set('usr_guest', 10);
    const broke = await test.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/sit`,
      payload: { seat: 1 },
      cookies: { ...guest.cookies, prl_csrf: cookie },
      headers: mutate,
    });
    assert.equal(broke.statusCode, 409);
    assert.equal((broke.json() as { error: { code: string } }).error.code, 'insufficient_units');

    await test.app.close();
  });
});

describe('the Legends endpoints', () => {
  it('returns every profile with a non-empty disclosure, and the archetype naming by default', async () => {
    const test = await harness();
    const response = await test.app.inject({ method: 'GET', url: '/api/v1/legends/profiles' });
    assert.equal(response.statusCode, 200);

    const body = response.json() as {
      namingMode: string;
      universalDisclaimer: string;
      difficulties: readonly { id: string; coachAvailable: boolean }[];
      profiles: readonly {
        id: string;
        disclosure: { displayName: string; disclaimers: readonly string[]; attributed: boolean };
        axes: readonly { key: string; label: string; description: string }[];
      }[];
    };

    assert.equal(body.namingMode, 'archetype', 'the safe naming mode is the default');
    assert.ok(body.universalDisclaimer.length > 40);
    assert.ok(body.profiles.length >= 10);
    for (const profile of body.profiles) {
      assert.ok(
        profile.disclosure.disclaimers.length >= 1,
        `${profile.id} must carry at least one disclaimer`,
      );
      assert.equal(profile.disclosure.attributed, false, 'archetype mode shows no attributed name');
      assert.equal(profile.axes.length, 16, 'every trait axis is rendered');
    }
    assert.deepEqual(
      body.difficulties.map((entry) => entry.id),
      ['educational', 'realistic', 'expert'],
    );
    await test.app.close();
  });

  it('describes one profile, and answers content_not_found for an unknown id', async () => {
    const test = await harness();
    const found = await test.app.inject({
      method: 'GET',
      url: '/api/v1/legends/profiles/calling-station',
    });
    assert.equal(found.statusCode, 200);
    const body = found.json() as {
      profileId: string;
      disclosure: { disclaimers: readonly string[] };
      learnFrom: readonly string[];
      counterStrategy: readonly string[];
      observed: unknown;
      contrasts: readonly { otherProfileId: string; differences: readonly unknown[] }[];
    };
    assert.equal(body.profileId, 'calling-station');
    assert.ok(body.disclosure.disclaimers.length >= 1);
    assert.ok(body.learnFrom.length >= 2);
    assert.ok(body.counterStrategy.length >= 2);
    assert.equal(body.observed, null, 'no hands played means no observed frequencies to report');
    assert.ok(body.contrasts.length >= 1);

    const missing = await test.app.inject({ method: 'GET', url: '/api/v1/legends/profiles/nobody' });
    assert.equal(missing.statusCode, 404);
    await test.app.close();
  });

  it('creates a Legends match with the profiles seated and their disclosures returned', async () => {
    const test = await harness();
    const learner = caller(test, { id: 'usr_learner' });
    const { token, cookie } = await csrfPair(test.app);

    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/legends/matches',
      payload: {
        profileIds: ['calling-station', 'patient-technician'],
        difficulty: 'educational',
        startingStack: 1_000,
        smallBlind: 5,
        bigBlind: 10,
        deterministicSeed: 7,
      },
      cookies: { ...learner.cookies, prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const body = created.json() as {
      roomId: string;
      difficulty: { id: string; coachAvailable: boolean };
      seats: readonly {
        seat: number;
        profileId: string;
        disclosure: { displayName: string; disclaimers: readonly string[] };
      }[];
    };
    assert.match(body.roomId, /^room_/);
    assert.equal(body.difficulty.id, 'educational');
    assert.equal(body.difficulty.coachAvailable, true);
    assert.deepEqual(
      body.seats.map((seat) => seat.seat),
      [1, 2],
      'the learner keeps seat 0',
    );
    for (const seat of body.seats) {
      assert.ok(seat.disclosure.disclaimers.length >= 1, 'every seat carries its disclaimers');
      assert.ok(seat.disclosure.displayName.length > 0);
    }

    // The room is real: the learner can read it and the bots are members of it.
    const read = await test.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${body.roomId}`,
      cookies: learner.cookies,
    });
    assert.equal(read.statusCode, 200, read.payload);
    const summary = read.json() as { room: { members: readonly { isBot: boolean }[] } };
    assert.equal(summary.room.members.filter((member) => member.isBot).length, 2);
    await test.app.close();
  });

  it('compares two profiles on the same river spot', async () => {
    const test = await harness();
    const { token, cookie } = await csrfPair(test.app);

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/legends/compare',
      payload: {
        situation: {
          heroCards: 'AhKh',
          board: 'Qh7h2c9s3d',
          pot: 200,
          toCall: 100,
          heroStack: 900,
          opponentStack: 900,
          bigBlind: 10,
          street: 'river',
        },
        profileIds: ['calling-station', 'disciplined-specialist'],
        difficulty: 'educational',
        trials: 4,
      },
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });

    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json() as {
      trials: number;
      takeaway: string;
      analysis: { assumptions: readonly string[]; uncertainty: { method: string } };
      entries: readonly {
        profileId: string;
        disclosure: { disclaimers: readonly string[] };
        actionDistribution: readonly { action: string; probability: number }[];
        modalAction: string;
        reasoning: { modelPreference: string; actionProbabilities: readonly unknown[] };
      }[];
    };
    assert.equal(body.trials, 4);
    assert.equal(body.entries.length, 2);
    assert.ok(body.analysis.assumptions.length >= 1, 'a number without its assumptions is a guess');
    for (const entry of body.entries) {
      assert.ok(entry.disclosure.disclaimers.length >= 1);
      const total = entry.actionDistribution.reduce((sum, item) => sum + item.probability, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `the distribution must sum to 1, got ${total}`);
      assert.ok(entry.reasoning.modelPreference.includes('model'), 'the reasoning describes the model');
      assert.ok(
        !/\b(he|she|they)\s+(thinks|feels|knows)\b/i.test(entry.reasoning.modelPreference),
        'no commentary may attribute a mental state to a person',
      );
    }
    await test.app.close();
  });
});

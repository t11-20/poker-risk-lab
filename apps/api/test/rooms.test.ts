/**
 * The live table's rules and the REST surface over it. `RoomStore` and `SessionStore` are
 * ports backed by `Map` fakes, and tables run on a manual clock, so nothing needs a database or wall
 * time. The weight is on refusals, where being wrong is expensive and quiet.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_MESSAGES } from '@prl/contracts';
import { PROFILES, traitDistance } from '@prl/poker-ai';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { SessionAccount, SessionStore, StoredSession } from '../src/auth/session.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppError, isAppError } from '../src/errors.ts';
import type { RoomMemberRow, RoomRow } from '../src/repositories/rooms.ts';
import { durableProfile, rehydrateBotSeat } from '../src/rooms/bot-profile.ts';
import { botDisplayName, resolveProfile } from '../src/rooms/bots.ts';
import {
  blindsFromLastHand,
  type HandArchive,
  noopArchive,
  type RoomRecord,
  RoomRegistry,
  type RoomStore,
} from '../src/rooms/registry.ts';
import { type ArchivedAction, LiveTable } from '../src/rooms/table.ts';
import { createManualClock, type ManualClock, TurnTimer } from '../src/rooms/timers.ts';
import { CONTRAST_PROFILES, createRoomRoutes } from '../src/routes/rooms.ts';

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

function incrementingHandIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_test${count}`;
  };
}

/** Keyed by plaintext token. The real store hashes inside the repository. */
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
  readonly codes: Map<string, string>;
  readonly units: Map<string, number>;
  readonly rows: Map<string, RoomRow>;
  readonly members: Map<string, RoomMemberRow>;
}

/** Enforces one live member per seat and one membership per user, the two indexes a test trips. */
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
    members,
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
        bot_profile: input.bot?.profileId ?? null,
        bot_difficulty: input.bot?.difficulty ?? null,
        bot_seed: input.bot?.seed ?? null,
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
      return Promise.resolve(member.id);
    },
    unseatMember: (roomId, userId) => {
      const member = members.get(key(roomId, userId));
      if (member !== undefined) members.set(key(roomId, userId), { ...member, seat: null });
      return Promise.resolve();
    },
    recordFirstSit: (memberId) => Promise.resolve([...members.values()].some((m) => m.id === memberId)),
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
    closePracticeTable: (roomId, ownerUserId) => {
      const row = rows.get(roomId);
      if (row === undefined || row.status === 'closed' || row.owner_user_id !== ownerUserId) {
        return Promise.resolve(false);
      }
      const others = [...members.values()].some(
        (member) => member.room_id === roomId && !member.is_bot && member.user_id !== ownerUserId,
      );
      if (others) return Promise.resolve(false);
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

/** Minted through the real plugin, so a change in hook order would fail these tests. */
async function csrfPair(app: FastifyInstance): Promise<{ token: string; cookie: string }> {
  const response = await app.inject({ method: 'GET', url: CSRF_ROUTE });
  const body: unknown = response.json();
  assert.ok(typeof body === 'object' && body !== null && 'token' in body);
  const payload: { readonly token?: unknown } = body;
  const cookie = response.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(cookie !== undefined);
  return { token: String(payload.token), cookie: cookie.value };
}

async function postAs(
  test: Harness,
  who: { readonly cookies: Record<string, string> },
  url: string,
  payload: Record<string, unknown>,
): Promise<{ readonly status: number; readonly code: string | undefined; readonly body: unknown }> {
  const { token, cookie } = await csrfPair(test.app);
  const response = await test.app.inject({
    method: 'POST',
    url,
    payload,
    cookies: { ...who.cookies, prl_csrf: cookie },
    headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
  });
  const body: unknown = response.json();
  return { status: response.statusCode, code: (body as { error?: { code?: string } }).error?.code, body };
}

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
    timer.arm({ handId: 'hand_1', seat: 1, deadlineMs: clock.now() - 5 });
    assert.equal(fired, 0, 'arming must not fire inline');
    clock.advance(0);
    assert.equal(fired, 1);
  });
});

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

    // Preflop heads-up the small blind faces the big blind, so the timeout must fold.
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

  /**
   * The reason is what the archive writes to `hand_actions.automatic_reason` (migration 0009), so it
   * is asserted on the notice the archive reads.
   */
  it('tells the archive WHY it acted: the clock, or a player who had already stood up', async () => {
    const archived = async (
      drive: (table: LiveTable, clock: ManualClock) => Promise<void>,
    ): Promise<readonly ArchivedAction[]> => {
      const { table, clock } = await headsUp();
      const seen: ArchivedAction[] = [];
      table.subscribe((notice) => {
        seen.push(...notice.loggedActions);
      });
      await table.startHand();
      await drive(table, clock);
      assert.ok(seen.length > 0, 'a sweep of nothing is not a pass');
      return seen;
    };
    const reasons = (actions: readonly ArchivedAction[]): readonly unknown[] =>
      actions.map((action) => [action.action.type, action.wasAutomatic, action.automaticReason]);

    const timedOut = await archived(async (_table, clock) => {
      clock.advance(30_001);
      await Promise.resolve();
    });
    assert.deepEqual(reasons(timedOut), [['fold', true, 'timeout']]);

    const stoodUp = await archived(async (table) => {
      await table.stand(actorOf(table));
    });
    assert.deepEqual(reasons(stoodUp), [['fold', true, 'departed']]);

    // The waiting seat stands. Its fold happens inside the call's mutation and must not borrow the
    // call's reason (null) or the timer's.
    const stoodUpWaiting = await archived(async (table) => {
      const actor = actorOf(table);
      await table.stand(actor === 'usr_a' ? 'usr_b' : 'usr_a');
      const view = table.viewFor(actor);
      assert.ok(view !== null);
      await table.submitAction(actor, {
        action: { type: 'call' },
        actionId: 'action-before-departed-fold',
        expectedSequence: view.actionSequence,
      });
    });
    assert.deepEqual(reasons(stoodUpWaiting), [
      ['call', false, null],
      ['fold', true, 'departed'],
    ]);
  });

  it('releases its timer when the room closes', async () => {
    const { table, clock } = await headsUp();
    await table.startHand();
    assert.ok(clock.pending > 0, 'a hand in progress arms a turn timer');
    table.close();
    assert.equal(clock.pending, 0, 'a closed table must not leave a timer armed');
  });
});

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

  /** `persistableProfile` refuses an id it cannot name rather than writing a Legends seat as `unknown`. */
  it('persists every strategy profile under its own id, and refuses one it does not know', () => {
    for (const profile of PROFILES) {
      assert.equal(durableProfile(profile.naming.id), profile.naming.id);
    }
    assert.throws(
      () => durableProfile('some-retired-legend'),
      (error: unknown) => isAppError(error),
      'an id no build carries must fail loudly rather than persist as something else',
    );
  });

  it('refuses to rehydrate a seat it cannot reproduce, rather than substituting a style', () => {
    const good = rehydrateBotSeat({
      botProfile: 'adaptive-exploiter',
      botDifficulty: 'expert',
      botSeed: 12345,
    });
    assert.equal(good.ok, true);
    assert.equal(good.ok && good.seat.profileId, 'adaptive-exploiter');

    for (const row of [
      { botProfile: 'unknown', botDifficulty: 'expert', botSeed: 1 },
      { botProfile: 'a-retired-legend', botDifficulty: 'expert', botSeed: 1 },
      { botProfile: 'adaptive-exploiter', botDifficulty: null, botSeed: 1 },
      { botProfile: 'adaptive-exploiter', botDifficulty: 'expert', botSeed: null },
    ]) {
      assert.equal(rehydrateBotSeat(row).ok, false, `${JSON.stringify(row)} must be refused`);
    }
  });

  it('keeps a bot’s seat plate inside the database’s display-name rule', () => {
    for (const profile of ['reading-pressure-specialist', 'adaptive-exploiter', 'calling-station']) {
      const name = botDisplayName(profile);
      assert.ok(name.length >= 2 && name.length <= 24, `${profile} produced "${name}"`);
      assert.equal(name, name.trim(), 'the database requires a trimmed name');
    }
  });
});

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

    // The only response that carries the code.
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

  it('refuses more bots than chairs before it makes the room or any bot', async () => {
    const test = await harness();
    const owner = caller(test, { id: 'usr_owner' });
    const crowded = { name: 'Bots', maxSeats: 3, smallBlind: 5, bigBlind: 10, startingStack: 1_000 };
    const refused = await postAs(test, owner, '/api/v1/rooms', {
      ...crowded,
      bots: [{ profile: 'nit', count: 5 }],
    });
    assert.deepEqual([refused.status, refused.code], [409, 'room_full']);
    const listed = await test.app.inject({ method: 'GET', url: '/api/v1/rooms', cookies: owner.cookies });
    assert.deepEqual((listed.json() as { rooms: unknown[] }).rooms, [], 'the refused room is not listed');
    assert.equal(test.store.rows.size, 0, 'no room row');
    assert.equal(test.store.members.size, 0, 'no member, bot or owner');
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

    // The membership must hold 0, because one with chips is sat down with its own.
    const membership = test.store.members.get(`${roomId}:usr_guest`);
    assert.ok(membership !== undefined);
    test.store.members.set(`${roomId}:usr_guest`, { ...membership, stack: 0 });
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

  /** A durable seat the live table does not match is dropped, or invented, by the next restart. */
  async function emptyRoom(test: Harness): Promise<string> {
    const owner = caller(test, { id: 'usr_owner' });
    const room = { name: 'Twice', maxSeats: 3, smallBlind: 5, bigBlind: 10, startingStack: 1_000 };
    const created = await postAs(test, owner, '/api/v1/rooms', room);
    return (created.body as { room: { id: string } }).room.id;
  }

  function seatsOf(test: Harness, roomId: string): { live: number | null; durable: number | null } {
    const live = test.registry.get(roomId)?.table.seatOf('usr_owner') ?? null;
    return { live, durable: test.store.members.get(`${roomId}:usr_owner`)?.seat ?? null };
  }

  it('refuses a sit from somebody already seated, and leaves their seat where it was', async () => {
    const test = await harness();
    const roomId = await emptyRoom(test);
    const owner = caller(test, { id: 'usr_owner' });
    assert.equal((await postAs(test, owner, `/api/v1/rooms/${roomId}/sit`, { seat: 0 })).status, 200);
    const writes: number[] = [];
    const seatMember = test.store.seatMember;
    (test.store as { seatMember: typeof seatMember }).seatMember = (room, userId, seat) => {
      writes.push(seat);
      return seatMember(room, userId, seat);
    };
    for (const seat of [0, 1]) {
      const again = await postAs(test, owner, `/api/v1/rooms/${roomId}/sit`, { seat });
      assert.deepEqual([again.status, again.code], [409, 'already_seated'], `sit again at ${seat}`);
      assert.deepEqual(seatsOf(test, roomId), { live: 0, durable: 0 }, `after sitting again at ${seat}`);
    }
    assert.deepEqual(writes, [], 'refused before the row was touched');
    await test.app.close();
  });

  for (const seats of [
    [0, 0],
    [1, 2],
  ] as const) {
    it(`keeps the durable seat on the live one when two sits race, at seats ${seats.join(' and ')}`, async () => {
      const test = await harness();
      const roomId = await emptyRoom(test);
      // Called directly, so both pass the already-seated check before either reaches the live table.
      const principal = { userId: 'usr_owner', displayName: 'Player usr_owner' };
      const answers = await Promise.allSettled(
        seats.map((seat) => test.registry.sitAtTable(roomId, principal, seat)),
      );
      const outcomes = answers.map((answer) =>
        answer.status === 'fulfilled' ? 'sat' : isAppError(answer.reason) ? answer.reason.code : 'threw',
      );
      assert.deepEqual(outcomes.sort(), ['already_seated', 'sat']);
      const { live, durable } = seatsOf(test, roomId);
      assert.ok(live !== null, 'one of the two sits took a seat');
      assert.equal(durable, live, 'the row names the seat the live table holds');
      await test.app.close();
    });
  }
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
    // The page says "the three most different profiles", so the route sends exactly those, furthest first.
    const subject = PROFILES.find((profile) => profile.naming.id === 'calling-station');
    assert.ok(subject !== undefined);
    const furthest = PROFILES.filter((other) => other !== subject)
      .map((other) => ({ id: other.naming.id, distance: traitDistance(subject.traits, other.traits) }))
      .sort((left, right) => right.distance - left.distance || left.id.localeCompare(right.id))
      .slice(0, 3)
      .map((other) => other.id);
    assert.equal(CONTRAST_PROFILES, 3);
    assert.deepEqual(
      body.contrasts.map((contrast) => contrast.otherProfileId),
      furthest,
    );
    for (const contrast of body.contrasts) assert.equal(contrast.differences.length, 3);

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

    const read = await test.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${body.roomId}`,
      cookies: learner.cookies,
    });
    assert.equal(read.statusCode, 200, read.payload);
    const summary = read.json() as { room: { members: readonly { isBot: boolean }[] } };
    assert.equal(summary.room.members.filter((member) => member.isBot).length, 2);

    // A learner holds one practice table at a time. The hub closes the old match's sockets off this
    // notification.
    const notified: string[] = [];
    test.registry.onRetirement((roomId) => notified.push(roomId));
    const expert = await test.app.inject({
      method: 'POST',
      url: '/api/v1/legends/matches',
      payload: {
        profileIds: ['adaptive-exploiter'],
        difficulty: 'expert',
        startingStack: 1_000,
        smallBlind: 5,
        bigBlind: 10,
      },
      cookies: { ...learner.cookies, prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });
    assert.equal(expert.statusCode, 201, expert.payload);
    const expertBody = expert.json() as { difficulty: { id: string; coachAvailable: boolean } };
    assert.equal(expertBody.difficulty.id, 'expert');
    assert.equal(expertBody.difficulty.coachAvailable, false);
    const retired = await test.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${body.roomId}`,
      cookies: learner.cookies,
    });
    assert.equal(retired.statusCode, 404, 'the first match closed when the second began');
    assert.deepEqual(notified, [body.roomId]);
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

  it('compares against the seat that made the bet, not the first seat still in', async () => {
    const test = await harness();
    const { token, cookie } = await csrfPair(test.app);
    // The small blind has 995 behind and 5 in, the big blind 990 and the 10 the button faces.
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/legends/compare',
      payload: {
        scenarioId: 'fl-same-cards-on-the-button',
        profileIds: ['calling-station'],
        difficulty: 'educational',
        trials: 1,
      },
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });
    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json() as { analysis: { stackContext: { explanation: string } } };
    assert.match(body.analysis.stackContext.explanation, /has 990 behind and 10 more than you/);
    await test.app.close();
  });

  it('compares against the opponent still in a scenario, not a seat that folded', async () => {
    const test = await harness();
    const { token, cookie } = await csrfPair(test.app);
    // The cutoff folds with 5,000 behind and the small blind is all in, so nobody can call another chip.
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/legends/compare',
      payload: {
        scenarioId: 'rk-when-survival-outweighs-chip-ev',
        profileIds: ['calling-station'],
        difficulty: 'educational',
        trials: 1,
      },
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: ALLOWED_ORIGIN },
    });
    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json() as {
      analysis: { stackContext: { effectiveStack: number; explanation: string } };
    };
    assert.equal(body.analysis.stackContext.effectiveStack, 0);
    assert.match(body.analysis.stackContext.explanation, /^Every opponent is already all in/);
    await test.app.close();
  });
});

/** The cross-column checks of `prl.rooms` in 0001_initial.sql, which `sql.ts` maps to invalid_request. */
function enforceRoomChecks(test: Harness): void {
  const create = test.store.create;
  (test.store as { create: typeof create }).create = (spec) => {
    const playable =
      spec.bigBlind > spec.smallBlind &&
      (spec.ante ?? 0) <= spec.bigBlind &&
      spec.startingStack >= spec.bigBlind * 2;
    return playable ? create(spec) : Promise.reject(new AppError('invalid_request', {}));
  };
}

const UNPLAYABLE_STAKES: readonly Record<string, number>[] = [
  { smallBlind: 10, bigBlind: 10, startingStack: 1_000 },
  { smallBlind: 5, bigBlind: 10, ante: 11, startingStack: 1_000 },
  { smallBlind: 5, bigBlind: 10, startingStack: 19 },
];

describe('a practice table request the database would refuse', () => {
  const stakes = { smallBlind: 5, bigBlind: 10, startingStack: 1_000 };
  const legends = { profileIds: [PROFILES[0]?.naming.id], difficulty: 'realistic' };
  const botTable = { name: 'Bots', maxSeats: 3, bots: [{ profile: 'nit', count: 2 }] };

  for (const [route, body] of [
    ['/api/v1/legends/matches', legends],
    ['/api/v1/rooms', botTable],
  ] as const) {
    it(`leaves the open practice table alone when ${route} is refused`, async () => {
      const test = await harness();
      enforceRoomChecks(test);
      const owner = caller(test, { id: 'usr_owner' });
      const first = await postAs(test, owner, route, { ...body, ...stakes });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const firstId = [...test.store.rows.keys()].at(-1) ?? '';
      for (const unplayable of UNPLAYABLE_STAKES) {
        const refused = await postAs(test, owner, route, { ...body, ...unplayable });
        assert.deepEqual(
          [refused.status, refused.code],
          [400, 'invalid_request'],
          JSON.stringify(unplayable),
        );
        assert.equal(
          test.store.rows.get(firstId)?.status,
          'open',
          `durable, after ${JSON.stringify(unplayable)}`,
        );
        assert.equal(test.registry.get(firstId)?.record.closed, false, 'and live');
      }
      assert.equal(test.store.rows.size, 1, 'no second room was made');
      await test.app.close();
    });
  }
});

describe('a room name the database would refuse', () => {
  it('is refused by the schema, before the open practice table is retired', async () => {
    const test = await harness();
    const owner = caller(test, { id: 'usr_owner' });
    const table = {
      maxSeats: 3,
      bots: [{ profile: 'nit', count: 2 }],
      smallBlind: 5,
      bigBlind: 10,
      startingStack: 1_000,
    };
    const first = await postAs(test, owner, '/api/v1/rooms', { ...table, name: 'Bots' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstId = [...test.store.rows.keys()].at(-1) ?? '';
    // `rooms_name_shape` needs 2 to 48 characters.
    const refused = await postAs(test, owner, '/api/v1/rooms', { ...table, name: 'B' });
    assert.deepEqual([refused.status, refused.code], [400, 'invalid_request']);
    assert.equal(test.store.rows.get(firstId)?.status, 'open');
    await test.app.close();
  });
});

/**
 * A live hand cannot survive a restart, but the button and the interrupted hand row can be
 * recovered. Without that, somebody pays a second consecutive big blind and the history shows
 * null rows.
 */
describe('a room re-opened after a restart', () => {
  const RESTART_CONFIG = { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 };

  function restartedRecord(): RoomRecord {
    return {
      id: 'room_restart',
      name: 'Restarted',
      ownerUserId: 'usr_a',
      config: RESTART_CONFIG,
      startingStack: 1_000,
      createdAt: new Date().toISOString(),
      closed: false,
    };
  }

  function replayingArchive(): { readonly archive: HandArchive; readonly abandonedFor: string[] } {
    const abandonedFor: string[] = [];
    return {
      abandonedFor,
      archive: {
        ...noopArchive,
        nextHandNumber: async () => 5,
        // Hand 4 was dealt BTN 1 / SB 3 / BB 0 to seats 0, 1 and 3.
        lastDealtHand: async () => ({
          handId: 'hand_before_restart',
          handNumber: 4,
          buttonSeat: 1,
          dealtSeats: [0, 1, 3],
        }),
        abandonInterruptedHands: (roomId) => {
          abandonedFor.push(roomId);
          return Promise.resolve([{ handId: 'hand_before_restart', roomId, handNumber: 4 }]);
        },
      },
    };
  }

  function restartedRegistry(archive: HandArchive): RoomRegistry {
    return new RoomRegistry({
      store: fakeRoomStore(),
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
      archive,
    });
  }

  it('reconstructs the blind positions from the persisted button and who was dealt in', () => {
    assert.deepEqual(
      blindsFromLastHand({ handId: 'h', handNumber: 4, buttonSeat: 1, dealtSeats: [0, 1, 3] }, 6),
      { buttonSeat: 1, smallBlindSeat: 3, bigBlindSeat: 0 },
    );
    // Heads-up the button posted the small blind, so both positions are its seat.
    assert.deepEqual(
      blindsFromLastHand({ handId: 'h', handNumber: 4, buttonSeat: 2, dealtSeats: [0, 2] }, 6),
      { buttonSeat: 2, smallBlindSeat: 2, bigBlindSeat: 0 },
    );
    assert.deepEqual(
      blindsFromLastHand({ handId: 'h', handNumber: 4, buttonSeat: 2, dealtSeats: [0, 1, 3] }, 6),
      { buttonSeat: 2, smallBlindSeat: 3, bigBlindSeat: 0 },
    );
    assert.equal(blindsFromLastHand({ handId: 'h', handNumber: 4, buttonSeat: 0, dealtSeats: [0] }, 6), null);
  });

  it('carries the rotation on rather than charging the last big blind a second one', async () => {
    const { archive } = replayingArchive();
    const registry = restartedRegistry(archive);
    const room = await registry.open({ record: restartedRecord() });

    assert.equal(room.table.snapshot().buttonSeat, 1, 'the button is restored, not reset');
    assert.equal(room.table.snapshot().handNumber, 4, 'and the numbering continues');

    for (const [userId, seat] of [
      ['usr_a', 0],
      ['usr_b', 1],
      ['usr_c', 3],
    ] as const) {
      await room.table.sit({
        userId,
        displayName: userId,
        seat,
        stack: 1_000,
        resumingSeat: true,
      });
      assert.equal(room.table.owesBlind(userId), false, 'a restart is not an arrival');
    }

    await room.table.startHand();
    const view = room.table.viewFor('usr_a');
    assert.ok(view !== null);
    assert.equal(view.handNumber, 5);
    const posted = new Map(view.forcedBets.map((bet) => [bet.kind, bet.seat]));
    assert.notEqual(posted.get('bigBlind'), 0, 'seat 0 must not pay the big blind twice');
    assert.equal(posted.get('bigBlind'), 1, 'the big blind advances one live player from seat 0');
    assert.equal(posted.get('smallBlind'), 0, 'the small blind falls where the big blind was');
    assert.equal(view.buttonSeat, 3, 'and the button where the small blind was');
  });

  it('closes the interrupted hand as it takes the room over, and only then', async () => {
    const { archive, abandonedFor } = replayingArchive();
    const registry = restartedRegistry(archive);

    const room = await registry.open({ record: restartedRecord() });
    assert.deepEqual(abandonedFor, ['room_restart'], 'reconciled exactly once, as the room opened');

    // Must not reconcile, because this process is now mid-hand in the room.
    await registry.open({ record: restartedRecord() });
    assert.deepEqual(abandonedFor, ['room_restart']);
    assert.equal(await registry.reconcileInterruptedHands('room_restart'), 0, 'refused while live');
    assert.deepEqual(abandonedFor, ['room_restart']);

    registry.close(room.record.id);
    assert.equal(await registry.reconcileInterruptedHands('room_restart'), 1, 'and available again');
    assert.deepEqual(abandonedFor, ['room_restart', 'room_restart']);
  });

  it('opens the room anyway when the reconciliation fails', async () => {
    const problems: string[] = [];
    const registry = new RoomRegistry({
      store: fakeRoomStore(),
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
      archive: {
        ...noopArchive,
        abandonInterruptedHands: () => Promise.reject(new Error('database is down')),
      },
      onProblem: (message) => problems.push(message),
    });

    // A history row that could not be tidied must not stop the room opening.
    const room = await registry.open({ record: restartedRecord() });
    assert.ok(room.table.snapshot().seats.length === 0);
    assert.ok(
      problems.some((message) => message.includes('could not reconcile interrupted hands')),
      `the failure must be logged, got ${JSON.stringify(problems)}`,
    );
  });
});

describe('RoomRegistry.open is deduplicated across concurrent first-touches', () => {
  /**
   * `open()` spans several awaits, so two cold callers (a `GET /rooms/:id` racing the WebSocket
   * `hello`, or two tabs) must share one `LiveTable` rather than the second replacing the first. The
   * slow archive read below opens the window.
   */
  it('builds one LiveRoom for two simultaneous ensureOpen calls', async () => {
    const { store } = await harness();
    const { room } = await store.create({
      name: 'Race',
      ownerUserId: 'usr_owner',
      maxSeats: 3,
      smallBlind: 5,
      bigBlind: 10,
      startingStack: 1000,
    });

    let handNumberReads = 0;
    const slowArchive: HandArchive = {
      ...noopArchive,
      nextHandNumber: async () => {
        handNumberReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 1;
      },
    };
    const racing = new RoomRegistry({
      store,
      archive: slowArchive,
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
    });

    const [first, second] = await Promise.all([racing.ensureOpen(room.id), racing.ensureOpen(room.id)]);

    assert.equal(first, second, 'two concurrent opens built two independent LiveRooms for one room id');
    assert.equal(racing.get(room.id), first, 'the room in the map is not the one the callers were handed');
    assert.equal(racing.size, 1);
    // The positive control, so the assertions above cannot pass on opening nothing.
    assert.equal(handNumberReads, 1, 'the room was built more than once');
    racing.closeAll();
  });

  it('does not leave a failed open cached, so the next attempt can still succeed', async () => {
    // Without removal on rejection, one database blip would make the room permanently unopenable.
    const { store } = await harness();
    const { room } = await store.create({
      name: 'Blip',
      ownerUserId: 'usr_owner',
      maxSeats: 3,
      smallBlind: 5,
      bigBlind: 10,
      startingStack: 1000,
    });

    let attempt = 0;
    const flaky: HandArchive = {
      ...noopArchive,
      nextHandNumber: (roomId: string) => {
        attempt += 1;
        if (attempt === 1)
          return Promise.reject(new Error(`connection terminated unexpectedly for ${roomId}`));
        return Promise.resolve(1);
      },
    };
    const registry = new RoomRegistry({
      store,
      archive: flaky,
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
    });

    // `open` reads the hand count fail-soft, so the first open succeeds with a fresh rotation.
    const first = await registry.ensureOpen(room.id);
    const second = await registry.ensureOpen(room.id);
    assert.equal(first, second);
    assert.equal(registry.size, 1);
    registry.closeAll();
  });
});

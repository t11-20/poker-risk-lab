/**
 * `GET /legends/hands/:handId/comparison` returns the reader's own hand and nobody else's. The page
 * once served one bundled sample for every id (CHAL-P1-6). Two real hands go through the route with
 * the real security layer, and the assertions are about correspondence to each hand. The refusals
 * never fall back to a sample.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { HandComparison } from '@prl/contracts';
import type { SessionAccount } from '../src/auth/session.ts';
import { closeDatabase, configureDatabase, getSql } from '../src/db.ts';
import { newHandId, newRoomId, newUserId } from '../src/repositories/ids.ts';
import type { Db } from '../src/repositories/sql.ts';
import { persistHand } from './helpers/hand-rows.ts';
import {
  accountFor,
  announceSkipUnlessDatabase,
  buildHandsApp,
  DB_SKIP_REASON,
  deleteFixtures,
  errorCodeOf,
  insertGuest,
  insertHand,
  insertRoom,
  TEST_DATABASE_URL,
  testConfig,
} from './helpers/hands-app.ts';

announceSkipUnlessDatabase('the Legends hand comparison route');

/** One the old schema could not name. */
const LEGEND_PROFILE = 'adaptive-exploiter';

interface Fixtures {
  readonly app: Awaited<ReturnType<typeof buildHandsApp>>['app'];
  readonly cookieFor: (token: string) => string;
  readonly learnerToken: string;
  readonly strangerToken: string;
  readonly handA: string;
  readonly handB: string;
  readonly liveHand: string;
  readonly humanOnlyHand: string;
}

let fixtures: Fixtures | null = null;
const created: { readonly roomIds: string[]; readonly userIds: string[] } = { roomIds: [], userIds: [] };

/** Numbered, because the learner is a member of two rooms and a user-keyed id would collide. */
let memberCounter = 0;
function nextMemberId(): string {
  memberCounter += 1;
  return `mem_z4comparison${memberCounter.toString().padStart(4, '0')}`;
}

async function seatBotMember(sql: Db, roomId: string, userId: string, profileId: string): Promise<void> {
  await sql`
    insert into prl.room_members
           (id, room_id, user_id, seat, stack, is_bot, bot_profile, bot_difficulty, bot_seed)
    values (${nextMemberId()}, ${roomId}, ${userId}, 1, 200, true, ${profileId}, 'realistic', 4242)
  `;
}

async function seatHumanMember(sql: Db, roomId: string, userId: string): Promise<void> {
  await sql`
    insert into prl.room_members (id, room_id, user_id, seat, stack, is_bot)
    values (${nextMemberId()}, ${roomId}, ${userId}, 0, 200, false)
  `;
}

before(async () => {
  if (TEST_DATABASE_URL === undefined) return;
  const config = testConfig();
  const sql = configureDatabase(config);

  const learnerId = newUserId();
  const strangerId = newUserId();
  const botId = newUserId();
  const otherHumanId = newUserId();
  const roomId = newRoomId();
  const humanRoomId = newRoomId();
  created.userIds.push(learnerId, strangerId, botId, otherHumanId);
  created.roomIds.push(roomId, humanRoomId);

  await insertGuest(sql, learnerId, 'Learner');
  await insertGuest(sql, strangerId, 'Stranger');
  await insertGuest(sql, botId, 'The Exploiter');
  await insertGuest(sql, otherHumanId, 'Friend');
  await insertRoom(sql, roomId, learnerId);
  await insertRoom(sql, humanRoomId, learnerId);
  await seatHumanMember(sql, roomId, learnerId);
  await seatBotMember(sql, roomId, botId, LEGEND_PROFILE);
  await seatHumanMember(sql, humanRoomId, learnerId);

  const handA = newHandId();
  const handB = newHandId();
  const liveHand = newHandId();
  const humanOnlyHand = newHandId();

  await insertHand(
    sql,
    persistHand({
      handId: handA,
      roomId,
      handNumber: 1,
      seats: [
        { seat: 0, userId: learnerId, displayName: 'Learner', stack: 200 },
        { seat: 1, userId: botId, displayName: 'The Exploiter', stack: 200, isBot: true },
      ],
      holeCards: { 0: 'AhKs', 1: '7c2d' },
      steps: [
        { seat: 0, action: { type: 'raise', to: 6 } },
        { seat: 1, action: { type: 'fold' } },
      ],
      startedAt: new Date('2026-08-18T10:00:00.111111Z'),
    }),
  );

  await insertHand(
    sql,
    persistHand({
      handId: handB,
      roomId,
      handNumber: 2,
      seats: [
        { seat: 0, userId: learnerId, displayName: 'Learner', stack: 200 },
        { seat: 1, userId: botId, displayName: 'The Exploiter', stack: 200, isBot: true },
      ],
      holeCards: { 0: 'QdQc', 1: 'JhTs' },
      board: 'Qh 7h 2c 4d 9s',
      steps: [
        { seat: 0, action: { type: 'call' } },
        { seat: 1, action: { type: 'check' } },
        { seat: 1, action: { type: 'check' } },
        { seat: 0, action: { type: 'bet', to: 4 } },
        { seat: 1, action: { type: 'call' } },
        { seat: 1, action: { type: 'check' } },
        { seat: 0, action: { type: 'check' } },
        { seat: 1, action: { type: 'check' } },
        { seat: 0, action: { type: 'check' } },
      ],
      startedAt: new Date('2026-08-18T11:00:00.222222Z'),
    }),
  );

  // Written by hand because `persistHand` settles what it deals.
  const unfinished = persistHand({
    handId: liveHand,
    roomId,
    handNumber: 3,
    seats: [
      { seat: 0, userId: learnerId, displayName: 'Learner', stack: 200 },
      { seat: 1, userId: botId, displayName: 'The Exploiter', stack: 200, isBot: true },
    ],
    holeCards: { 0: 'AsKd', 1: '5c4h' },
    steps: [{ seat: 0, action: { type: 'raise', to: 6 } }],
    startedAt: new Date('2026-08-18T12:00:00.333333Z'),
  });
  await insertHand(sql, unfinished);
  await sql`
    update prl.hands set street = 'preflop', completed_at = null, result = null where id = ${liveHand}
  `;

  await insertHand(
    sql,
    persistHand({
      handId: humanOnlyHand,
      roomId: humanRoomId,
      handNumber: 1,
      seats: [
        { seat: 0, userId: learnerId, displayName: 'Learner', stack: 200 },
        { seat: 1, userId: otherHumanId, displayName: 'Friend', stack: 200 },
      ],
      holeCards: { 0: 'AhKs', 1: '7c2d' },
      steps: [{ seat: 0, action: { type: 'fold' } }],
      startedAt: new Date('2026-08-18T13:00:00.444444Z'),
    }),
  );

  const learnerToken = 'learner-token-for-the-legend-comparison-tests';
  const strangerToken = 'stranger-token-for-the-legend-comparison-tests';
  const harness = await buildHandsApp({
    config,
    accounts: new Map<string, SessionAccount>([
      [learnerToken, accountFor(learnerId, 'Learner')],
      [strangerToken, accountFor(strangerId, 'Stranger')],
    ]),
  });

  fixtures = {
    app: harness.app,
    cookieFor: harness.cookieFor,
    learnerToken,
    strangerToken,
    handA,
    handB,
    liveHand,
    humanOnlyHand,
  };
});

after(async () => {
  if (TEST_DATABASE_URL === undefined) return;
  await deleteFixtures(getSql(), created.roomIds, created.userIds);
  await fixtures?.app.close();
  await closeDatabase(1_000);
});

function live(): Fixtures {
  assert.ok(fixtures !== null, 'the database fixtures were not created');
  return fixtures;
}

async function fetchComparison(
  handId: string,
  token: string | null,
): Promise<{ readonly status: number; readonly payload: string }> {
  const harness = live();
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/v1/legends/hands/${handId}/comparison`,
    ...(token === null ? {} : { headers: { cookie: harness.cookieFor(token) } }),
  });
  return { status: response.statusCode, payload: response.payload };
}

async function comparisonOf(handId: string): Promise<HandComparison> {
  const { status, payload } = await fetchComparison(handId, live().learnerToken);
  assert.equal(status, 200, payload);
  return JSON.parse(payload) as HandComparison;
}

describe('the comparison is of the hand that was asked for', { skip: DB_SKIP_REASON }, () => {
  it('names that hand, that board and that result', async () => {
    const { handA, handB } = live();
    const a = await comparisonOf(handA);
    const b = await comparisonOf(handB);

    assert.equal(a.handId, handA);
    assert.equal(b.handId, handB);
    assert.equal(a.handNumber, 1);
    assert.equal(b.handNumber, 2);

    assert.deepEqual(a.board, []);
    assert.deepEqual(b.board, ['Qh', '7h', '2c', '4d', '9s']);
  });

  it('reports the actions that were actually taken, by the seats that took them', async () => {
    const a = await comparisonOf(live().handA);

    assert.equal(a.decisions.length, 2);
    const [first, second] = a.decisions;
    assert.ok(first !== undefined && second !== undefined);

    assert.deepEqual(first.userAction, { action: 'raise', to: 6 });
    assert.equal(first.modelAction, null);
    assert.equal(first.street, 'preflop');

    assert.equal(second.userAction, null);
    assert.deepEqual(second.modelAction, { action: 'fold', to: null });

    assert.ok(second.sequence > first.sequence);
  });

  it('follows hand B through its streets, which hand A never reached', async () => {
    const b = await comparisonOf(live().handB);
    const streets = [...new Set(b.decisions.map((decision) => decision.street))];
    assert.deepEqual(streets, ['preflop', 'flop', 'turn', 'river']);

    // Read off the replay's views, so a drifting reconstruction shows here.
    const pots = b.decisions.map((decision) => decision.potBefore);
    assert.ok(pots[pots.length - 1] !== undefined && pots[0] !== undefined);
    assert.ok(
      (pots[pots.length - 1] as number) > (pots[0] as number),
      `pots did not grow: ${pots.join(', ')}`,
    );
  });

  it('gives the two hands different results', async () => {
    const { handA, handB } = live();
    const a = await comparisonOf(handA);
    const b = await comparisonOf(handB);
    assert.notDeepEqual(
      { board: a.board, chipResult: a.chipResult, decisions: a.decisions.length },
      { board: b.board, chipResult: b.chipResult, decisions: b.decisions.length },
      'two different hands produced the same comparison — this is the defect, exactly',
    );
    assert.ok(a.chipResult > 0, `hand A took the pot, so the net is positive: ${a.chipResult}`);
  });

  it('names the modelled opponent from the roster', async () => {
    const a = await comparisonOf(live().handA);
    assert.equal(a.profileId, LEGEND_PROFILE, 'one of the seven ids the old schema could not store');
    assert.ok(a.disclosure.displayName.length > 0);
    assert.ok(a.disclosure.disclaimers.length > 0);
  });

  it('claims nothing about why the model acted', async () => {
    // `prl.hand_actions` records what was done, not the distribution a policy sampled from.
    const a = await comparisonOf(live().handA);
    for (const decision of a.decisions) {
      if (decision.modelAction !== null) assert.equal(decision.modelReasoning, null);
      // Analysing the model's decisions would leak its hole cards.
      if (decision.modelAction !== null) assert.equal(decision.analysis, null);
    }
  });
});

describe('a comparison is refused rather than substituted', { skip: DB_SKIP_REASON }, () => {
  it('needs a session', async () => {
    const { status } = await fetchComparison(live().handA, null);
    assert.equal(status, 401);
  });

  it('answers a stranger and a nonexistent hand identically', async () => {
    const mine = await fetchComparison(live().handA, live().strangerToken);
    const nothing = await fetchComparison('hand_zzzzzzzzzzzzzzzzzzzzzz', live().learnerToken);

    assert.equal(mine.status, 404);
    assert.equal(nothing.status, 404);
    assert.equal(errorCodeOf(mine.payload), 'hand_not_found');
    assert.equal(errorCodeOf(nothing.payload), 'hand_not_found');
    assert.equal(
      errorCodeOf(mine.payload),
      errorCodeOf(nothing.payload),
      'a distinguishable answer confirms a hand id to anybody who guesses one',
    );
  });

  it('refuses a hand that is still being played, with that reason', async () => {
    const { status, payload } = await fetchComparison(live().liveHand, live().learnerToken);
    assert.equal(status, 409, payload);
    assert.equal(errorCodeOf(payload), 'hand_not_comparable');
    assert.equal(
      (JSON.parse(payload) as { error: { fields?: Record<string, string> } }).error.fields?.hand,
      'hand-in-progress',
    );
  });

  it('refuses a hand with no modelled seat in it, with that reason', async () => {
    const { status, payload } = await fetchComparison(live().humanOnlyHand, live().learnerToken);
    assert.equal(status, 409, payload);
    assert.equal(errorCodeOf(payload), 'hand_not_comparable');
    assert.equal(
      (JSON.parse(payload) as { error: { fields?: Record<string, string> } }).error.fields?.hand,
      'no-legend-in-hand',
    );
  });

  it('never answers with a body that could be mistaken for a hand', async () => {
    for (const [handId, token] of [
      [live().handA, live().strangerToken],
      [live().liveHand, live().learnerToken],
      [live().humanOnlyHand, live().learnerToken],
    ] as const) {
      const { payload } = await fetchComparison(handId, token);
      const body = JSON.parse(payload) as Record<string, unknown>;
      assert.equal(body['decisions'], undefined);
      assert.equal(body['board'], undefined);
      assert.ok('error' in body);
    }
  });
});

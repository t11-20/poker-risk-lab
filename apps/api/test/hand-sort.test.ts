/**
 * `GET /hands?sort=` orders the whole history, and the cursor resumes its own ordering. Pages are
 * smaller than the fixture, so only a database-side sort passes. Each ordering is paged through and
 * compared with the unpaged answer, because `HAND_ORDERINGS` writes the keyset predicate and
 * `order by` separately. `net_result` and the final `pot_after` are set directly, not played.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { HandListResponse } from '@prl/contracts';
import { HAND_SORTS } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import type { SessionAccount } from '../src/auth/session.ts';
import { closeDatabase, configureDatabase, getSql } from '../src/db.ts';
import { newHandId, newRoomId, newUserId } from '../src/repositories/ids.ts';
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

announceSkipUnlessDatabase('the hand ordering tests');

interface Planned {
  readonly handNumber: number;
  readonly startedAt: string;
  /** Null is unsettled, and sorts last in both net orderings rather than as zero. */
  readonly net: number | null;
  /** Null means no recorded action, and sorts last in the pot ordering. */
  readonly pot: number | null;
}

/** No two of the five orderings agree, so a silent fallback to `recent` fails. */
const PLAN: readonly Planned[] = [
  { handNumber: 1, startedAt: '2026-08-10T10:00:00.100001Z', net: 250, pot: 400 },
  { handNumber: 2, startedAt: '2026-08-11T10:00:00.200002Z', net: -100, pot: 220 },
  { handNumber: 3, startedAt: '2026-08-12T10:00:00.300003Z', net: 0, pot: 100 },
  { handNumber: 4, startedAt: '2026-08-13T10:00:00.400004Z', net: 900, pot: 1800 },
  { handNumber: 5, startedAt: '2026-08-14T10:00:00.500005Z', net: -400, pot: 900 },
  { handNumber: 6, startedAt: '2026-08-15T10:00:00.600006Z', net: 60, pot: null },
  { handNumber: 7, startedAt: '2026-08-16T10:00:00.700007Z', net: null, pot: 300 },
  { handNumber: 8, startedAt: '2026-08-17T10:00:00.800008Z', net: -50, pot: 200 },
];

const EXPECTED: Readonly<Record<(typeof HAND_SORTS)[number], readonly number[]>> = {
  recent: [8, 7, 6, 5, 4, 3, 2, 1],
  oldest: [1, 2, 3, 4, 5, 6, 7, 8],
  'net-high': [4, 1, 6, 3, 8, 2, 5, 7],
  'net-low': [5, 2, 8, 3, 6, 1, 4, 7],
  'pot-high': [4, 5, 1, 7, 2, 8, 3, 6],
};

interface Fixtures {
  readonly app: FastifyInstance;
  readonly cookie: string;
}

let fixtures: Fixtures | null = null;
const created: { readonly roomIds: string[]; readonly userIds: string[] } = { roomIds: [], userIds: [] };

before(async () => {
  if (TEST_DATABASE_URL === undefined) return;
  const config = testConfig();
  const sql = configureDatabase(config);

  const readerId = newUserId();
  const botId = newUserId();
  const roomId = newRoomId();
  created.userIds.push(readerId, botId);
  created.roomIds.push(roomId);

  await insertGuest(sql, readerId, 'Sorter');
  await insertGuest(sql, botId, 'Rock');
  await insertRoom(sql, roomId, readerId);

  for (const planned of PLAN) {
    const handId = newHandId();
    const played = persistHand({
      handId,
      roomId,
      handNumber: planned.handNumber,
      seats: [
        { seat: 0, userId: readerId, displayName: 'Sorter', stack: 200 },
        { seat: 1, userId: botId, displayName: 'Rock', stack: 200, isBot: true },
      ],
      holeCards: { 0: 'AhKs', 1: '7c2d' },
      steps: [{ seat: 0, action: { type: 'fold' } }],
      startedAt: new Date(planned.startedAt),
    });
    const finalPot = planned.pot;
    const actions =
      finalPot === null
        ? []
        : played.actions.map((action, index) =>
            index === played.actions.length - 1 ? { ...action, pot_after: finalPot } : action,
          );
    await insertHand(sql, {
      ...played,
      seats: played.seats.map((seat) => (seat.seat === 0 ? { ...seat, net_result: planned.net } : seat)),
      actions,
    });
  }

  const token = 'sorter-token-for-the-hand-ordering-tests';
  const accounts = new Map<string, SessionAccount>([[token, accountFor(readerId, 'Sorter')]]);
  const harness = await buildHandsApp({ config, accounts });
  fixtures = { app: harness.app, cookie: harness.cookieFor(token) };
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

async function list(query: string): Promise<HandListResponse> {
  const context = live();
  const response = await context.app.inject({
    method: 'GET',
    url: `/api/v1/hands?${query}`,
    headers: { cookie: context.cookie },
  });
  assert.equal(response.statusCode, 200, response.payload.slice(0, 200));
  return response.json<HandListResponse>();
}

function numbersOf(body: HandListResponse): readonly number[] {
  return body.hands.map((hand) => hand.handNumber);
}

describe('GET /hands?sort=', { skip: DB_SKIP_REASON }, () => {
  for (const sort of HAND_SORTS) {
    it(`orders the whole history by ${sort}`, async () => {
      const body = await list(`sort=${sort}&limit=50`);
      assert.deepEqual(numbersOf(body), EXPECTED[sort]);
    });

    it(`applies ${sort} before the page is cut, not after`, async () => {
      const body = await list(`sort=${sort}&limit=3`);
      assert.deepEqual(numbersOf(body), EXPECTED[sort].slice(0, 3));
      assert.notEqual(body.nextCursor, null, 'five hands remain, so there is a next page');
    });

    it(`pages ${sort} without dropping or repeating a hand at the seam`, async () => {
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query = `sort=${sort}&limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
        const body: HandListResponse = await list(query);
        seen.push(...numbersOf(body));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }
      assert.equal(cursor, null, 'paging did not terminate');
      assert.deepEqual(seen, EXPECTED[sort], 'the pages, concatenated, are the unpaged ordering');
    });
  }

  it('defaults to recency when no ordering is asked for', async () => {
    assert.deepEqual(numbersOf(await list('limit=50')), EXPECTED.recent);
  });

  it('refuses an ordering it does not serve', async () => {
    const context = live();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/hands?sort=whatever',
      headers: { cookie: context.cookie },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCodeOf(response.payload), 'invalid_request');
  });

  it('refuses a cursor issued for a different ordering', async () => {
    const context = live();
    const first = await list('sort=net-high&limit=3');
    assert.ok(first.nextCursor !== null);
    const response = await context.app.inject({
      method: 'GET',
      // A cursor from another ordering would return a plausible page from a sequence that does not exist.
      url: `/api/v1/hands?sort=net-low&limit=3&cursor=${encodeURIComponent(first.nextCursor)}`,
      headers: { cookie: context.cookie },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCodeOf(response.payload), 'invalid_request');
  });

  it('refuses a recency cursor replayed into a value ordering', async () => {
    const context = live();
    const first = await list('sort=recent&limit=3');
    assert.ok(first.nextCursor !== null);
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/hands?sort=pot-high&limit=3&cursor=${encodeURIComponent(first.nextCursor)}`,
      headers: { cookie: context.cookie },
    });
    assert.equal(response.statusCode, 400);
  });

  it('sorts an unsettled hand last rather than as zero', async () => {
    const byNet = await list('sort=net-low&limit=50');
    const last = byNet.hands[byNet.hands.length - 1];
    assert.equal(last?.handNumber, 7);
    assert.equal(last?.heroNet, null, 'a hand with no net is not the smallest net');
    assert.notEqual(byNet.hands[0]?.handNumber, 7, 'and it is not the biggest loss either');
  });
});

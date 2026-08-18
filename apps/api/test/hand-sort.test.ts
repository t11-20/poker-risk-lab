/**
 * `GET /hands?sort=` orders the whole history, and the cursor resumes the ordering it was issued for.
 *
 * ## Why this file exists
 *
 * The hand-history screen offered five orderings and the endpoint performed one. `sort` was not in
 * `prl:handListQuery`, the schema is closed, so the parameter came back `invalid_request`; the
 * screen stopped sending it and kept the control, which left four labels naming an ordering that
 * nothing anywhere produced. That is the worse of the two failures, because a control that silently
 * does nothing looks exactly like a control that works.
 *
 * So the assertions here are about the two properties a client cannot check for itself:
 *
 *  1. **The ordering is over the whole history, not over a page.** Every case below asks for a page
 *     SMALLER than the fixture and checks the rows are the right rows — which is only true if the
 *     database sorted before it cut. A client-side sort of one page would pass a naive "is it in
 *     order" assertion and fail every one of these.
 *  2. **A page boundary lands in the same place on the way back.** The keyset predicate and the
 *     `order by` are written out separately per ordering (`HAND_ORDERINGS`), so a mismatch between
 *     them would silently drop or repeat rows at the seam. Each ordering is therefore paged all the
 *     way through and the concatenation is compared against the unpaged answer.
 *
 * ## The fixture, and why the sort keys are set rather than played
 *
 * The rows come from `persistHand`, so they are engine-shaped, and then `net_result` and the final
 * `pot_after` are overridden. Playing eight hands that happen to produce a spread of nets and pots
 * — including an unsettled one — would make the fixture a puzzle and would tie these assertions to
 * the engine's payouts, which are not what is under test. What IS under test is what the database
 * does with those two columns, and a null in either of them.
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

/** One row of the fixture: what it should look like once it is in the table. */
interface Planned {
  readonly handNumber: number;
  readonly startedAt: string;
  /** Null is an unsettled hand, which sorts last in both net orderings rather than as zero. */
  readonly net: number | null;
  /** Null is a hand with no recorded action, which sorts last in the pot ordering. */
  readonly pot: number | null;
}

/**
 * Eight hands with a deliberately awkward spread.
 *
 * The nets are not in time order and are not in pot order, so no two of the five orderings agree —
 * an ordering that quietly fell back to `recent` would match `recent` and nothing else. Two rows
 * carry a null: one unsettled net, one hand with no action rows at all.
 */
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

/** The order each `sort` must produce over the whole fixture, by hand number. */
const EXPECTED: Readonly<Record<(typeof HAND_SORTS)[number], readonly number[]>> = {
  recent: [8, 7, 6, 5, 4, 3, 2, 1],
  oldest: [1, 2, 3, 4, 5, 6, 7, 8],
  // Nulls last; the unsettled hand is not the smallest gain, it has no gain.
  'net-high': [4, 1, 6, 3, 8, 2, 5, 7],
  'net-low': [5, 2, 8, 3, 6, 1, 4, 7],
  // Hand 6 has no actions, so it has no pot and sorts after every hand that does.
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
    // The reader is seat 0. `net_result` and the last `pot_after` are the two columns the orderings
    // key on, so they are set here rather than left to whatever a folded hand happens to pay.
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

/** Hand numbers, so a failure reads as an ordering rather than as a wall of ids. */
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
      // Three rows out of eight. Every one of them has to be a row from the front of the WHOLE
      // ordering — which is the property a client sorting its own page cannot have.
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
      // The same cursor, replayed into the opposite ordering. Accepting it would return a page from
      // the middle of a sequence that does not exist, which reads as data rather than as an error.
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

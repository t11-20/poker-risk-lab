/**
 * `GET /legends/hands/:handId/comparison` — the reader's OWN hand, and nobody else's.
 *
 * ## The defect (CHAL-P1-6)
 *
 * `/legends/hand-review` served `HAND_COMPARISON_FIXTURE` — one bundled sample — for every hand id
 * anybody asked for. The client's loader ignored its argument (`loadHandComparison(_handId)`) and
 * said why in its own comment: the API had never registered a per-hand comparison route.
 * `buildHandComparison` sat complete and tested in `@prl/poker-ai` with nothing in front of it.
 *
 * Reproduced before the fix by fetching `/legends/hand-review?hand=hand_aaaaaaaaaaaa` and
 * `?hand=hand_zzzzzzzzzzzz` from a running server: the two pages differed only in the id echoed in
 * a link. Same board, same decisions, same result.
 *
 * ## What this file proves
 *
 * Two REAL hands, dealt through the engine by `persistHand` and written to a real database, then
 * read back through the route with the real security layer in front of it. The assertions are the
 * ones the audit asked for and they are about correspondence, not shape:
 *
 *   - the comparison names the hand that was asked for;
 *   - its board is that hand's board, and the other hand's board is different;
 *   - its decisions are the actions that were actually taken, in order, by the seats that took
 *     them — so a comparison of hand A can never be a rendering of hand B;
 *   - `chipResult` is the learner's own net, and the two hands disagree about it;
 *   - the opponent is named as the strategy profile the roster records.
 *
 * And the refusals, because a fallback is what the defect was: a stranger and a nonexistent id get
 * the same 404, a hand still in progress and a hand with no modelled seat each get their own
 * `hand_not_comparable` reason, and none of them is ever a sample hand.
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

/** The profile the bot seat plays. One the OLD schema could not name — deliberately. */
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

/**
 * Membership ids, numbered rather than derived from the user id: the learner is a member of two
 * rooms here, so anything keyed on the user alone collides on the primary key.
 */
let memberCounter = 0;
function nextMemberId(): string {
  memberCounter += 1;
  return `mem_z4comparison${memberCounter.toString().padStart(4, '0')}`;
}

/** A bot seat on the roster, carrying everything migration 0003 made the column able to hold. */
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

  // Hand A: the learner raises preflop and the model folds. Short, and every figure in it is
  // decided by the two actions below rather than by anything this test asserts.
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

  // Hand B: a different deal, a different board, a different line, a different result. Everything
  // this test compares between the two is a consequence of these inputs.
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

  // A hand that has not finished. Written by hand because `persistHand` settles what it deals.
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

  // A hand at a table with no bot in it at all.
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

    // Hand A never saw a flop; hand B ran out five cards. This is the assertion the old page could
    // not have passed: it rendered one bundled board for every id.
    assert.deepEqual(a.board, []);
    assert.deepEqual(b.board, ['Qh', '7h', '2c', '4d', '9s']);
  });

  it('reports the actions that were actually taken, by the seats that took them', async () => {
    const a = await comparisonOf(live().handA);

    // Two actions were played: the learner raised to 6, the model folded. `userAction` is set for
    // the learner's own decisions and `modelAction` for the opponent's, never both.
    assert.equal(a.decisions.length, 2);
    const [first, second] = a.decisions;
    assert.ok(first !== undefined && second !== undefined);

    assert.deepEqual(first.userAction, { action: 'raise', to: 6 });
    assert.equal(first.modelAction, null);
    assert.equal(first.street, 'preflop');

    assert.equal(second.userAction, null);
    assert.deepEqual(second.modelAction, { action: 'fold', to: null });

    // Sequences strictly increase — `buildHandComparison` refuses otherwise, and a replay out of
    // order would describe a hand that never happened.
    assert.ok(second.sequence > first.sequence);
  });

  it('follows hand B through its streets, which hand A never reached', async () => {
    const b = await comparisonOf(live().handB);
    const streets = [...new Set(b.decisions.map((decision) => decision.street))];
    assert.deepEqual(streets, ['preflop', 'flop', 'turn', 'river']);

    // The pot grows. Read off the views the replay reconstructed, so a drifting reconstruction
    // shows up here rather than as a plausible wrong number on the page.
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
    // The learner won hand A uncontested and lost nothing; they cannot both be zero by accident,
    // so the values are asserted rather than merely compared.
    assert.ok(a.chipResult > 0, `hand A took the pot, so the net is positive: ${a.chipResult}`);
  });

  it('names the modelled opponent from the roster', async () => {
    const a = await comparisonOf(live().handA);
    assert.equal(a.profileId, LEGEND_PROFILE, 'one of the seven ids the old schema could not store');
    assert.ok(a.disclosure.displayName.length > 0);
    // Every Legends surface carries the disclosure, never a bare name.
    assert.ok(a.disclosure.disclaimers.length > 0);
  });

  it('claims nothing about why the model acted', async () => {
    // `prl.hand_actions` records what was done, not the distribution a policy sampled from. A
    // reconstructed reasoning would be a different hand's thinking attached to this one's action.
    const a = await comparisonOf(live().handA);
    for (const decision of a.decisions) {
      if (decision.modelAction !== null) assert.equal(decision.modelReasoning, null);
      // And the model's own decisions are never analysed — that would leak its hole cards.
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
    // The point of every refusal above. A 200 carrying a bundled sample is what this route
    // replaced, so nothing that is not the caller's own hand may come back with a comparison in it.
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

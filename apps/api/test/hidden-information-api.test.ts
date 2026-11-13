/**
 * Hidden information at the API surface. A `HandReviewResponse` is built from database rows by
 * different code than `redactFor`, so the engine's redaction tests say nothing about it.
 * A stranger gets `hand_not_found`, never `forbidden`, so a hand id in a URL is not an oracle.
 * The route half needs a database and skips loudly. The payload half runs everywhere.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { HandReviewResponse } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import type { SessionAccount } from '../src/auth/session.ts';
import { closeDatabase, configureDatabase, getSql } from '../src/db.ts';
import { newHandId, newRoomId, newUserId } from '../src/repositories/ids.ts';
import { buildHandReview } from '../src/review/build-review.ts';
import { holeCardsOf, type PersistedHand, persistHand } from './helpers/hand-rows.ts';
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

const ALICE = 'usr_hiddenaliceaaaaaaaaaaaa';
const BORYS = 'usr_hiddenborysbbbbbbbbbbb';

/** `^salt` is anchored so `assaults` does not match. `cursor` is unanchored so `deckCursor` does. */
const FORBIDDEN_KEY = /^deck|^salt|cursor/i;

/** A salt is allowed only in a proof for a card that is already public. */
const ALLOWED_SALT_PATH = /^reveal\.cards\.\d+\.saltHex$/;

const REVIEW_ALLOWED_PATHS: readonly RegExp[] = [ALLOWED_SALT_PATH];

/** `nextCursor` is a paging token, allowed by exact path so `deckCursor` stays caught everywhere. */
const LIST_ALLOWED_PATHS: readonly RegExp[] = [...REVIEW_ALLOWED_PATHS, /^nextCursor$/];

interface Leak {
  readonly path: string;
  readonly reason: string;
}

/** Walks the whole graph rather than known fields, to catch a key nobody predicted. */
function findLeaks(value: unknown, allowed: readonly RegExp[] = REVIEW_ALLOWED_PATHS, path = ''): Leak[] {
  const leaks: Leak[] = [];

  if (Array.isArray(value)) {
    // A 52-element array of distinct small integers is a deck, whatever it is called.
    if (
      value.length === 52 &&
      value.every((entry) => typeof entry === 'number') &&
      new Set(value).size === 52
    ) {
      leaks.push({ path, reason: 'a full 52-card deck' });
    }
    for (const [index, entry] of value.entries()) {
      leaks.push(...findLeaks(entry, allowed, `${path}.${index}`));
    }
    return leaks;
  }

  if (value === null || typeof value !== 'object') return leaks;

  for (const key of Object.keys(value)) {
    const child = `${path === '' ? '' : `${path}.`}${key}`;
    if (FORBIDDEN_KEY.test(key) && !allowed.some((pattern) => pattern.test(child))) {
      leaks.push({ path: child, reason: `forbidden key "${key}"` });
    }
    const entry: unknown = Reflect.get(value, key);
    leaks.push(...findLeaks(entry, allowed, child));
  }
  return leaks;
}

function assertNoLeaks(
  payload: unknown,
  what: string,
  allowed: readonly RegExp[] = REVIEW_ALLOWED_PATHS,
): void {
  const leaks = findLeaks(payload, allowed);
  assert.deepEqual(
    leaks,
    [],
    `${what} carried ${leaks.length} thing(s) it must not:\n${leaks
      .map((leak) => `  ${leak.path === '' ? '<root>' : leak.path}: ${leak.reason}`)
      .join('\n')}`,
  );
}

function twoSeatFoldOut(handId: string, roomId: string, aliceId: string, borysId: string): PersistedHand {
  return persistHand({
    handId,
    roomId,
    seats: [
      { seat: 0, userId: aliceId, displayName: 'Alice', stack: 200 },
      { seat: 1, userId: borysId, displayName: 'Borys', stack: 200 },
    ],
    holeCards: { 0: 'AhKs', 1: '7c2d' },
    steps: [{ seat: 0, action: { type: 'fold' } }],
  });
}

function twoSeatShowdown(handId: string, roomId: string, aliceId: string, borysId: string): PersistedHand {
  return persistHand({
    handId,
    roomId,
    handNumber: 2,
    seats: [
      { seat: 0, userId: aliceId, displayName: 'Alice', stack: 200 },
      { seat: 1, userId: borysId, displayName: 'Borys', stack: 200 },
    ],
    holeCards: { 0: 'AhKs', 1: '7c2d' },
    board: 'Qh Jh 2s 4d 9c',
    steps: [
      { seat: 0, action: { type: 'call' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 0, action: { type: 'check' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 0, action: { type: 'check' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 0, action: { type: 'check' } },
    ],
  });
}

/**
 * One folds preflop and two show down. Heads-up fixtures cannot tell a per-seat `showed_down` from a
 * per-hand one, and this one can.
 */
function threeSeatFoldAndShowdown(
  handId: string,
  roomId: string,
  aliceId: string,
  borysId: string,
  chidiId: string,
): PersistedHand {
  return persistHand({
    handId,
    roomId,
    handNumber: 3,
    buttonSeat: 0,
    seats: [
      { seat: 0, userId: aliceId, displayName: 'Alice', stack: 200 },
      { seat: 1, userId: borysId, displayName: 'Borys', stack: 200 },
      { seat: 2, userId: chidiId, displayName: 'Chidi', stack: 200 },
    ],
    holeCards: { 0: 'AhKs', 1: '7c2d', 2: 'Ts9s' },
    board: 'Qh Jh 2s 4d 3c',
    steps: [
      { seat: 0, action: { type: 'call' } },
      { seat: 1, action: { type: 'fold' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 0, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 0, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 0, action: { type: 'check' } },
    ],
  });
}

function reviewFor(fixture: PersistedHand, viewerUserId: string): HandReviewResponse {
  return buildHandReview(
    {
      hand: fixture.hand,
      seats: fixture.seats,
      actions: fixture.actions,
      viewerUserId,
      maxPotAfter: fixture.hand.max_pot_after,
    },
    // Coach report confidentiality is covered in `test/hands.test.ts`.
    { maxAnalysedDecisions: 0 },
  );
}

describe('a hand review never carries what the viewer may not see', () => {
  const foldOut = twoSeatFoldOut('hand_hiddenfoldoutaaaaaaaa', 'room_hiddentableaaaaaaaaaa', ALICE, BORYS);
  const showdown = twoSeatShowdown('hand_hiddenshowdownaaaaaaa', 'room_hiddentableaaaaaaaaaa', ALICE, BORYS);

  it('gives each player their own cards and not the other’s, in a fold-out hand', () => {
    assert.equal(foldOut.hand.street, 'complete');
    assert.equal(foldOut.actions.length, 1, 'one fold and the hand is over');

    for (const [viewer, ownSeat, otherSeat] of [
      [ALICE, 0, 1],
      [BORYS, 1, 0],
    ] as const) {
      const review = reviewFor(foldOut, viewer);
      const own = review.seats.find((seat) => seat.seat === ownSeat);
      const other = review.seats.find((seat) => seat.seat === otherSeat);
      assert.deepEqual(own?.holeCards, holeCardsOf(foldOut, ownSeat), 'own cards are always visible');
      assert.equal(other?.holeCards, null, `seat ${otherSeat} never showed, so its cards stay sealed`);

      // A whole-payload scan is fair only because a preflop fold-out produces no `outs` list.
      const serialised = JSON.stringify(review);
      for (const card of holeCardsOf(foldOut, otherSeat)) {
        assert.ok(!serialised.includes(`"${card}"`), `${card} reached the wrong player`);
      }
    }
  });

  it('reveals nothing at all when the hand ended by folding', () => {
    const review = reviewFor(foldOut, ALICE);
    assert.equal(review.hand.endedByFold, true);
    assert.deepEqual(review.hand.board, [], 'no board was dealt');
    assert.equal(review.verification.ok, true, 'nothing to prove is a pass, not a failure');
    assert.equal(review.verification.verifiedPositions, 0);
    assert.ok(!JSON.stringify(review).includes('saltHex'));
  });

  it('has no deck, no cursor and no salt under any key', () => {
    for (const viewer of [ALICE, BORYS]) {
      assertNoLeaks(
        JSON.parse(JSON.stringify(reviewFor(foldOut, viewer))),
        `the fold-out review for ${viewer}`,
      );
    }
  });

  it('allows a salt only inside a proof for a card that is already public', () => {
    const review = reviewFor(showdown, ALICE);
    const serialised: unknown = JSON.parse(JSON.stringify(review));
    assert.equal(review.verification.verifiedPositions, 9, 'five board cards and two shown hands');
    assertNoLeaks(serialised, 'the showdown review');
    assert.ok(JSON.stringify(review.reveal).includes('saltHex'), 'the proofs are there to be checked');
  });

  it('would notice a leak, so a clean result means something', () => {
    // Negative controls for the walk.
    assert.equal(findLeaks({ deck: [1, 2, 3] }).length, 1);
    assert.equal(findLeaks({ deckCursor: 12 }).length, 1);
    assert.equal(findLeaks({ deckSalts: 'aa' }).length, 1);
    assert.equal(findLeaks({ nested: { salts: ['aa'] } }).length, 1);
    assert.equal(findLeaks({ page: { cursor: 'abc' } }).length, 1);
    assert.equal(findLeaks({ cards: Array.from({ length: 52 }, (_unused, index) => index) }).length, 1);
    assert.deepEqual(findLeaks({ reveal: { cards: [{ saltHex: 'aa', index: 3 }] } }), []);
    assert.deepEqual(findLeaks({ seats: [{ holeCards: ['Ah', 'Ks'] }], commitmentRoot: 'ff' }), []);
    assert.deepEqual(findLeaks({ board: [1, 2, 3, 4, 5] }), []);
    assert.deepEqual(findLeaks({ nextCursor: 'abc' }, LIST_ALLOWED_PATHS), []);
    assert.equal(findLeaks({ nextCursor: 'abc' }).length, 1, 'a review has no cursor at all');
    assert.equal(findLeaks({ hands: [{ deckCursor: 4 }] }, LIST_ALLOWED_PATHS).length, 1);
  });

  it('opens the seats that showed and keeps the seat that folded sealed, in one hand', () => {
    const CHIDI = 'usr_hiddenchidiccccccccccc';
    const multiway = threeSeatFoldAndShowdown(
      'hand_hiddenmultiwayaaaaaaa',
      'room_hiddentableaaaaaaaaaa',
      ALICE,
      BORYS,
      CHIDI,
    );
    const shown = multiway.state.result?.showdowns.map((showdown) => showdown.seat) ?? [];
    assert.deepEqual(shown, [0, 2], 'seats 0 and 2 must show; seat 1 folded before the flop');
    assert.equal(multiway.state.result?.endedByFold, false);
    assert.equal(multiway.state.board.length, 5);

    const folderCards = holeCardsOf(multiway, 1);
    for (const [viewer, ownSeat] of [
      [ALICE, 0],
      [BORYS, 1],
      [CHIDI, 2],
    ] as const) {
      const review = reviewFor(multiway, viewer);
      const bySeat = new Map(review.seats.map((seat) => [seat.seat, seat]));

      assert.deepEqual(bySeat.get(0)?.holeCards, holeCardsOf(multiway, 0), `seat 0 showed, for ${viewer}`);
      assert.deepEqual(bySeat.get(2)?.holeCards, holeCardsOf(multiway, 2), `seat 2 showed, for ${viewer}`);

      if (ownSeat === 1) {
        assert.deepEqual(bySeat.get(1)?.holeCards, folderCards, 'the folder sees their own hand');
      } else {
        assert.equal(bySeat.get(1)?.holeCards, null, `seat 1 never showed, so ${viewer} may not see it`);
        const serialised = JSON.stringify(review);
        for (const card of folderCards) {
          assert.ok(!serialised.includes(`"${card}"`), `the folder's ${card} reached ${viewer}`);
        }
      }
      assert.equal(bySeat.get(1)?.showedDown, false, 'and the flag that would open it stays false');
      assertNoLeaks(JSON.parse(JSON.stringify(review)), `the multiway review for ${viewer}`);
    }

    const review = reviewFor(multiway, ALICE);
    assert.equal(review.verification.ok, true);
    assert.equal(review.verification.verifiedPositions, 9, 'five board cards and two shown hands');
  });

  it('never carries an unshown seat’s cards even in the field that proves the deal', () => {
    const review = reviewFor(foldOut, ALICE);
    assert.deepEqual(review.reveal, {
      commitment: {
        algorithm: 'sha256',
        version: 'prl-deck-v2',
        root: foldOut.hand.commitment_root,
        context: foldOut.hand.commitment_context,
      },
      cards: [],
      complete: false,
    });
  });
});

announceSkipUnlessDatabase('the API-level hidden-information route tests');

interface Fixtures {
  readonly app: FastifyInstance;
  readonly cookieFor: (token: string) => string;
  readonly aliceToken: string;
  readonly borysToken: string;
  readonly strangerToken: string;
  readonly aliceId: string;
  readonly borysId: string;
  readonly strangerId: string;
  readonly roomId: string;
  readonly handId: string;
  readonly aliceCards: readonly string[];
  readonly borysCards: readonly string[];
}

let fixtures: Fixtures | null = null;

/** Recorded before any write, so a `before` that throws halfway still gets cleaned up. */
const created: { readonly roomIds: string[]; readonly userIds: string[] } = { roomIds: [], userIds: [] };

before(async () => {
  if (TEST_DATABASE_URL === undefined) return;
  const config = testConfig();
  const sql = configureDatabase(config);

  const aliceId = newUserId();
  const borysId = newUserId();
  const strangerId = newUserId();
  const roomId = newRoomId();
  const handId = newHandId();
  created.userIds.push(aliceId, borysId, strangerId);
  created.roomIds.push(roomId);

  await insertGuest(sql, aliceId, 'Alice');
  await insertGuest(sql, borysId, 'Borys');
  await insertGuest(sql, strangerId, 'Nosey');
  await insertRoom(sql, roomId, aliceId);

  const fixture = twoSeatFoldOut(handId, roomId, aliceId, borysId);
  await insertHand(sql, fixture);

  const aliceToken = 'alice-token-for-the-confidentiality-tests';
  const borysToken = 'borys-token-for-the-confidentiality-tests';
  const strangerToken = 'stranger-token-for-the-confidentiality-tests';
  const accounts = new Map<string, SessionAccount>([
    [aliceToken, accountFor(aliceId, 'Alice')],
    [borysToken, accountFor(borysId, 'Borys')],
    [strangerToken, accountFor(strangerId, 'Nosey')],
  ]);
  const harness = await buildHandsApp({ config, accounts });

  fixtures = {
    app: harness.app,
    cookieFor: harness.cookieFor,
    aliceToken,
    borysToken,
    strangerToken,
    aliceId,
    borysId,
    strangerId,
    roomId,
    handId,
    aliceCards: holeCardsOf(fixture, 0),
    borysCards: holeCardsOf(fixture, 1),
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

describe('GET /hands/:handId over HTTP', { skip: DB_SKIP_REASON }, () => {
  it('serves each player their own cards and never the other’s', async () => {
    const context = live();
    for (const [token, ownCards, otherCards] of [
      [context.aliceToken, context.aliceCards, context.borysCards],
      [context.borysToken, context.borysCards, context.aliceCards],
    ] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/hands/${context.handId}`,
        headers: { cookie: context.cookieFor(token) },
      });
      assert.equal(response.statusCode, 200);
      for (const card of ownCards) {
        assert.ok(response.payload.includes(`"${card}"`), `the caller must see their own ${card}`);
      }
      for (const card of otherCards) {
        assert.ok(!response.payload.includes(`"${card}"`), `${card} belongs to the other player`);
      }
    }
  });

  it('sends no deck, no cursor and no salt over the wire', async () => {
    const context = live();
    for (const token of [context.aliceToken, context.borysToken]) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/hands/${context.handId}`,
        headers: { cookie: context.cookieFor(token) },
      });
      assertNoLeaks(JSON.parse(response.payload), 'the served review');
    }
  });

  it('answers a stranger with hand_not_found, not forbidden', async () => {
    const context = live();
    const stranger = await context.app.inject({
      method: 'GET',
      url: `/api/v1/hands/${context.handId}`,
      headers: { cookie: context.cookieFor(context.strangerToken) },
    });
    assert.equal(stranger.statusCode, 404);
    assert.equal(
      errorCodeOf(stranger.payload),
      'hand_not_found',
      'a distinguishable "not permitted" would confirm the hand exists',
    );
    assert.ok(!stranger.payload.includes('forbidden'));
    const body: unknown = JSON.parse(stranger.payload);
    const error: unknown = body === null || typeof body !== 'object' ? null : Reflect.get(body, 'error');
    assert.ok(error !== null && typeof error === 'object');
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'requestId']);
    for (const card of [...context.aliceCards, ...context.borysCards]) {
      // Quoted, because a bare "7c" or "2d" turns up inside a UUID request id often enough to flake.
      assert.ok(!stranger.payload.includes(`"${card}"`), `${card} must not appear in a refusal`);
    }
  });

  it('is indistinguishable from asking about a hand that never existed', async () => {
    const context = live();
    const [real, imaginary] = await Promise.all([
      context.app.inject({
        method: 'GET',
        url: `/api/v1/hands/${context.handId}`,
        headers: { cookie: context.cookieFor(context.strangerToken) },
      }),
      context.app.inject({
        method: 'GET',
        url: '/api/v1/hands/hand_thishandneverexistedx',
        headers: { cookie: context.cookieFor(context.strangerToken) },
      }),
    ]);
    assert.equal(real.statusCode, imaginary.statusCode);
    // Two 404s with different messages would still be an oracle, so compare bodies.
    const strip = (payload: string): string => payload.replace(/"requestId":"[^"]*"/, '"requestId":"<id>"');
    assert.equal(strip(real.payload), strip(imaginary.payload));
  });

  it('does not leak through a list either', async () => {
    const context = live();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/hands',
      headers: { cookie: context.cookieFor(context.strangerToken) },
    });
    assert.equal(response.statusCode, 200);
    const body: unknown = JSON.parse(response.payload);
    const hands: unknown = body === null || typeof body !== 'object' ? null : Reflect.get(body, 'hands');
    assert.ok(Array.isArray(hands), 'a list response always has a hands array');
    assert.equal(hands.length, 0, 'a stranger has no hand history here');
    assertNoLeaks(body, 'the served list', LIST_ALLOWED_PATHS);
  });
});

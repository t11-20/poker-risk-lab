/**
 * Hidden information, at the API surface.
 *
 * `packages/poker-engine/test/hidden-information.test.ts` already proves that `redactFor` never
 * builds a view containing a card the recipient may not see. This file covers the other end of the
 * same rule: the place a leak would actually reach a person. A `HandReviewResponse` is assembled
 * from database rows rather than from a `HandState`, by different code, and it is served over HTTP
 * to a named user — so the engine's guarantee says nothing about it.
 *
 * ## What is asserted, and why it is asserted this way
 *
 * 1. **Neither player in a fold-out hand can see the other's cards.** A hand that ends with
 *    everyone folding is the case that matters most: nobody paid to see anything, so whether the
 *    winner held a bluff or a monster must stay unknown for ever. The check is a scan of the whole
 *    serialised payload for the other seat's exact card strings, which is only a fair check here
 *    because a preflop fold-out produces no outs list — the one part of a Coach report that
 *    legitimately names other cards. The showdown case is checked field by field instead, for that
 *    reason, and the reason is stated at the assertion.
 *
 * 2. **No deck, no cursor and no salt under any key.** Walked over the object graph rather than
 *    checked against a list of known fields, because the failure being guarded against is a leak
 *    through a field nobody thought to check. The one legitimate exception is `saltHex` inside
 *    `reveal.cards[]` — the per-position salt for a card that is *already public*, without which
 *    the proof could not be checked. The walk allows it at exactly that path and nowhere else.
 *
 * 3. **A stranger cannot fetch the hand at all**, and gets `hand_not_found` rather than
 *    `forbidden`. A distinguishable "you may not see this" confirms the hand exists, which turns a
 *    hand id in a shared URL into an oracle. The two answers are compared field by field, not just
 *    by status code.
 *
 * The route half needs a database and SKIPS, with a printed reason, when `DATABASE_URL` is absent.
 * The payload half does not: it builds the same response object from a real engine hand and runs
 * every scan above on it, so the confidentiality assertions run in every environment.
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

// ---------------------------------------------------------------------------
// The object-graph walk
// ---------------------------------------------------------------------------

/**
 * Key names that must not appear anywhere in a response.
 *
 * `^salt` catches `salt`, `salts` and `saltHex`; the walk then allows `saltHex` back in at the one
 * path where it belongs. Anchoring it means `desalted` or `assaults` in a prose field name would
 * not match, while `cursor` is unanchored on purpose so `deckCursor` is caught wherever it hides.
 */
const FORBIDDEN_KEY = /^deck|^salt|cursor/i;

/** The only path a salt may legitimately occupy: a proof for a card that is already public. */
const ALLOWED_SALT_PATH = /^reveal\.cards\.\d+\.saltHex$/;

/** What a hand review is allowed to carry. It has no cursor of any kind. */
const REVIEW_ALLOWED_PATHS: readonly RegExp[] = [ALLOWED_SALT_PATH];

/**
 * What a hand *list* is allowed to carry.
 *
 * `nextCursor` is a paging token by contract and has nothing to do with `HandState.deckCursor`,
 * which is the read position into the shuffled deck and the thing the rule is about. Allowing it
 * by exact path rather than loosening the pattern keeps `deckCursor` caught anywhere it appears,
 * including nested inside a list row.
 */
const LIST_ALLOWED_PATHS: readonly RegExp[] = [...REVIEW_ALLOWED_PATHS, /^nextCursor$/];

interface Leak {
  readonly path: string;
  readonly reason: string;
}

/**
 * Walks every value in a serialised response and reports anything that should not be there.
 *
 * Deliberately not a check of known fields. `HandReviewResponse` types `reveal` as `unknown`, a
 * `CoachReport` is a deep tree of computed detail, and the whole point is to catch the key nobody
 * predicted — a row spread into a response, a debugging field left behind, a driver's own metadata
 * riding along on a query result.
 */
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Heads-up, two named users, and the button folds. Nobody shows; no board is dealt. */
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

/** The same two seats, but they show down, so `reveal.cards` is non-empty. */
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
 * Three seats: one folds preflop, the other two check it down and show.
 *
 * The case the two fixtures above cannot produce, and the one the rule is most easily got wrong
 * in. A heads-up hand is either "nobody showed" or "everybody showed", so a review that opened
 * every seat's cards the moment the hand reached a showdown would pass both of them. Here a
 * showdown happens AND a seat that folded into it is sitting in the same `hand_seats` rows, so
 * `showed_down` has to be read per seat rather than off the hand — which is exactly the shape of
 * the defect `unentitledHoleCardSeats` in `scripts/smoke-test.mjs` was written for on the wire.
 *
 * The folder is also the one recipient who legitimately learns something: seats 0 and 2 opened
 * their hands in front of them. So this fixture asserts both directions at once — the folder sees
 * both showdowns and neither showdown participant sees the folder.
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
    // Button on seat 0, so the small blind is seat 1 and the big blind seat 2.
    buttonSeat: 0,
    seats: [
      { seat: 0, userId: aliceId, displayName: 'Alice', stack: 200 },
      { seat: 1, userId: borysId, displayName: 'Borys', stack: 200 },
      { seat: 2, userId: chidiId, displayName: 'Chidi', stack: 200 },
    ],
    holeCards: { 0: 'AhKs', 1: '7c2d', 2: 'Ts9s' },
    board: 'Qh Jh 2s 4d 3c',
    steps: [
      // Preflop: the button calls, the small blind folds, the big blind checks its option.
      { seat: 0, action: { type: 'call' } },
      { seat: 1, action: { type: 'fold' } },
      { seat: 2, action: { type: 'check' } },
      // Three streets checked through, so the hand reaches a showdown between seats 0 and 2.
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
    // No analysis: this file is about what leaves the process, and a Coach report is the expensive
    // part. Its own confidentiality is covered where it is built, in `test/hands.test.ts`.
    { maxAnalysedDecisions: 0 },
  );
}

// ---------------------------------------------------------------------------
// The payload, with no database involved
// ---------------------------------------------------------------------------

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

      // A scan of the whole payload, not just the card fields. Fair here because a preflop
      // fold-out produces no `outs` list — the one part of a Coach report that legitimately names
      // cards other than hero's — so any occurrence of the other seat's card really is a leak.
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
    // With no positions proved there is no salt anywhere, so the walk below is unconditional.
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
    // Both seats showed, so this hand does carry proofs — and the walk still finds no leak,
    // because the only salt-bearing key sits at `reveal.cards.<n>.saltHex`.
    assert.equal(review.verification.verifiedPositions, 9, 'five board cards and two shown hands');
    assertNoLeaks(serialised, 'the showdown review');
    assert.ok(JSON.stringify(review.reveal).includes('saltHex'), 'the proofs are there to be checked');
  });

  it('would notice a leak, so a clean result means something', () => {
    // A guard that cannot fail is decoration. Each of these is a shape the walk must reject.
    assert.equal(findLeaks({ deck: [1, 2, 3] }).length, 1);
    assert.equal(findLeaks({ deckCursor: 12 }).length, 1);
    assert.equal(findLeaks({ deckSalts: 'aa' }).length, 1);
    assert.equal(findLeaks({ nested: { salts: ['aa'] } }).length, 1);
    assert.equal(findLeaks({ page: { cursor: 'abc' } }).length, 1);
    assert.equal(findLeaks({ cards: Array.from({ length: 52 }, (_unused, index) => index) }).length, 1);
    // And each of these must be left alone.
    assert.deepEqual(findLeaks({ reveal: { cards: [{ saltHex: 'aa', index: 3 }] } }), []);
    assert.deepEqual(findLeaks({ seats: [{ holeCards: ['Ah', 'Ks'] }], commitmentRoot: 'ff' }), []);
    assert.deepEqual(findLeaks({ board: [1, 2, 3, 4, 5] }), []);
    // A paging cursor is allowed on a list and nowhere else, and never a deck cursor.
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
    // The fixture must actually be the shape the assertions below are about, or they prove nothing
    // about a mixed hand: one folder, two showdowns, and a board.
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

      // The two seats that showed are open to everybody at the table, including the folder.
      assert.deepEqual(bySeat.get(0)?.holeCards, holeCardsOf(multiway, 0), `seat 0 showed, for ${viewer}`);
      assert.deepEqual(bySeat.get(2)?.holeCards, holeCardsOf(multiway, 2), `seat 2 showed, for ${viewer}`);

      // The folder's cards are their own and nobody else's — permanently, because whether they
      // folded a bluff or a monster is what the commitment scheme exists to keep sealed.
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

    // The reveal proves exactly the five board cards and the two hands that opened — never the
    // folder's two, which would make the proof itself the leak.
    const review = reviewFor(multiway, ALICE);
    assert.equal(review.verification.ok, true);
    assert.equal(review.verification.verifiedPositions, 9, 'five board cards and two shown hands');
  });

  it('never carries an unshown seat’s cards even in the field that proves the deal', () => {
    // The reveal is the one place a card and its salt appear together. A seat that did not show
    // must have no position in it, or the proof itself would be the leak.
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

// ---------------------------------------------------------------------------
// The route, against a real database
// ---------------------------------------------------------------------------

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

/**
 * What to delete afterwards, recorded before anything is written.
 *
 * Separate from `fixtures` on purpose: a `before` that throws halfway would never assign it, and a
 * cleanup keyed on that would leave rows behind in a shared development database.
 */
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
    // The refusal carries no hand detail at all, which is stronger than "no cards": the whole body
    // is a code, a fixed message and a request id.
    const body: unknown = JSON.parse(stranger.payload);
    const error: unknown = body === null || typeof body !== 'object' ? null : Reflect.get(body, 'error');
    assert.ok(error !== null && typeof error === 'object');
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'requestId']);
    for (const card of [...context.aliceCards, ...context.borysCards]) {
      // The quoted form, not the bare one. A request id is a UUID, so a bare "7c" or "2d" turns up
      // in one often enough to make the loose check flaky rather than strict — and a card can only
      // reach a client as a JSON string in the first place.
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
    // Identical but for the request id, which is per-request by design and says nothing about
    // the hand. Compared field by field rather than by status alone: two 404s with different
    // messages would still be an oracle.
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

/**
 * Hand history and hand review.
 *
 * Two halves, split by what each needs.
 *
 * The first half tests `src/review/build-review.ts` directly, with rows produced from a real
 * engine hand (`test/helpers/hand-rows.ts`). No Postgres, no Fastify, no network — the review is a
 * pure function of the persisted rows plus the id of the user asking, which is what makes the
 * interesting rules (whose cards, whose analysis, what an empty reveal means) provable at all.
 *
 * The second half drives the routes through `app.inject()` against a real database, because
 * "scoped to the caller's own hands" is a SQL predicate and a predicate can only be tested against
 * a query planner. Those tests SKIP, with a printed reason, when `DATABASE_URL` is absent — the
 * suite has to pass without a database, and a test that silently passes because it never ran is
 * worse than one that says it was skipped.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { CoachReport, HandListResponse, HandReviewResponse } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import type { SessionAccount } from '../src/auth/session.ts';
import { closeDatabase, configureDatabase, getSql } from '../src/db.ts';
import { newHandId, newRoomId, newUserId } from '../src/repositories/ids.ts';
import type { HandRow, SkippedAnalysis } from '../src/review/build-review.ts';
import { buildHandReview, REVIEW_OPPONENT_RANGE, toHandSummary } from '../src/review/build-review.ts';
import { decodeCursor, encodeCursor } from '../src/routes/hands.ts';
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

const ALICE = 'usr_reviewaliceaaaaaaaaaaaa';
const BORYS = 'usr_reviewborysbbbbbbbbbbb';
const CARLA = 'usr_reviewcarlaccccccccccc';

/** Small sample count: these tests assert structure, not the third digit of an equity. */
const TEST_SAMPLES = 2_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Heads-up, and the button folds preflop.
 *
 * The shape that matters most: no board is dealt and nobody shows, so the reveal is empty and the
 * winner's two cards stay sealed for ever. Everything about how this hand is reported has to say
 * "correct", never "unverified".
 */
function foldOutHand(handId = 'hand_reviewfoldoutaaaaaaaaa'): PersistedHand {
  return persistHand({
    handId,
    roomId: 'room_reviewtableaaaaaaaaaaa',
    seats: [
      { seat: 0, userId: ALICE, displayName: 'Alice', stack: 200 },
      { seat: 1, userId: BORYS, displayName: 'Borys', stack: 200 },
    ],
    holeCards: { 0: 'AhKs', 1: '7c2d' },
    steps: [{ seat: 0, action: { type: 'fold' } }],
  });
}

/**
 * Three-handed, one seat folds preflop and the other two check it down to a showdown.
 *
 * Gives every visibility case in one hand: a folder whose cards nobody may see, two seats whose
 * cards became public because they showed, and four decisions belonging to the same player.
 */
function showdownHand(handId = 'hand_reviewshowdownaaaaaaa'): PersistedHand {
  return persistHand({
    handId,
    roomId: 'room_reviewtableaaaaqaaaaaa',
    seats: [
      { seat: 0, userId: CARLA, displayName: 'Carla', stack: 200 },
      { seat: 1, userId: ALICE, displayName: 'Alice', stack: 200 },
      { seat: 2, userId: BORYS, displayName: 'Borys', stack: 200, isBot: true },
    ],
    holeCards: { 0: '7c2d', 1: 'AhKs', 2: 'QdQc' },
    board: 'Qh 7h 2c 4d 9s',
    steps: [
      { seat: 0, action: { type: 'fold' } },
      { seat: 1, action: { type: 'call' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
    ],
  });
}

/**
 * Heads-up, both all-in preflop, and the board runs itself out.
 *
 * The only shape where the stored board is longer than the street the decisions were made on, and
 * therefore the case that proves the per-street board prefix is taken rather than the whole array.
 */
function allInPreflopHand(handId = 'hand_reviewallinaaaaaaaaaaa'): PersistedHand {
  return persistHand({
    handId,
    roomId: 'room_reviewtableaaaaaaaaaaa',
    seats: [
      { seat: 0, userId: ALICE, displayName: 'Alice', stack: 200 },
      { seat: 1, userId: BORYS, displayName: 'Borys', stack: 200 },
    ],
    holeCards: { 0: 'AhKs', 1: 'QdQc' },
    board: 'Jh 7h 2c 4d 9s',
    steps: [
      { seat: 0, action: { type: 'raise', to: 200 } },
      { seat: 1, action: { type: 'call' } },
    ],
  });
}

interface ReviewOptions {
  readonly skipped?: SkippedAnalysis[];
  readonly maxAnalysedDecisions?: number;
  readonly budgetMs?: number;
  readonly now?: () => number;
}

function reviewAs(
  fixture: PersistedHand,
  viewerUserId: string,
  options: ReviewOptions = {},
): HandReviewResponse {
  const skipped = options.skipped;
  return buildHandReview(
    {
      hand: fixture.hand,
      seats: fixture.seats,
      actions: fixture.actions,
      viewerUserId,
      maxPotAfter: fixture.hand.max_pot_after,
    },
    {
      equitySamples: TEST_SAMPLES,
      ...(options.maxAnalysedDecisions === undefined
        ? {}
        : { maxAnalysedDecisions: options.maxAnalysedDecisions }),
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(skipped === undefined ? {} : { onAnalysisSkipped: (detail) => skipped.push(detail) }),
    },
  );
}

function seatOf(review: HandReviewResponse, seat: number): HandReviewResponse['seats'][number] {
  const found = review.seats.find((entry) => entry.seat === seat);
  assert.ok(found !== undefined, `expected the review to describe seat ${seat}`);
  return found;
}

function analysisAt(review: HandReviewResponse, sequence: number): CoachReport {
  const decision = review.decisions.find((entry) => entry.sequence === sequence);
  assert.ok(decision !== undefined, `expected a decision at sequence ${sequence}`);
  assert.ok(decision.analysis !== null, `expected an analysis at sequence ${sequence}`);
  return decision.analysis;
}

// ---------------------------------------------------------------------------
// Reconstructing the hand without the deck
// ---------------------------------------------------------------------------

describe('the review replays a hand from its rows, with no deck anywhere', () => {
  it('reconstructs the pot and the price from the action log and the recovered blinds', () => {
    const fixture = foldOutHand();
    const review = reviewAs(fixture, ALICE);

    const fold = review.decisions[0];
    assert.ok(fold !== undefined);
    assert.equal(review.decisions.length, 1);
    // Small blind 1 plus big blind 2. Neither is an action row, so both were recovered from what
    // the hand recorded — who opened the action, and the engine's own pot before they did. NOT
    // from `button_seat`: the dead-button rule means the button no longer determines the blinds,
    // and `test/x3-dead-blind-review.test.ts` covers the hands where the difference shows.
    assert.equal(fold.potBefore, 3);

    const analysis = analysisAt(review, 1);
    assert.equal(analysis.street, 'preflop');
    assert.equal(analysis.potTotal, 3, 'the pot the decision faced');
    assert.equal(analysis.toCall, 1, 'the button had posted the small blind, so it owed one more');
    // The button has 199 behind and the big blind 198, so the effective stack is the smaller of
    // the two. Getting the blinds the wrong way round would show up here as 199.
    assert.equal(analysis.stackContext.effectiveStack, 198);
  });

  it('agrees with the engine about the pot at every decision', () => {
    const fixture = showdownHand();
    const review = reviewAs(fixture, ALICE, { maxAnalysedDecisions: 0 });

    // `pot_after` is the engine's own running total. Every `potBefore` must be the previous one.
    let expected =
      fixture.actions[0] === undefined ? 0 : fixture.actions[0].pot_after - fixture.actions[0].amount_paid;
    for (const [index, decision] of review.decisions.entries()) {
      assert.equal(decision.potBefore, expected, `decision ${index} faced the wrong pot`);
      const action = fixture.actions[index];
      assert.ok(action !== undefined);
      expected = action.pot_after;
    }
  });

  it('carries the persisted action detail through unchanged', () => {
    const fixture = showdownHand();
    const review = reviewAs(fixture, ALICE, { maxAnalysedDecisions: 0 });
    assert.equal(review.decisions.length, fixture.actions.length);
    for (const [index, decision] of review.decisions.entries()) {
      const action = fixture.actions[index];
      assert.ok(action !== undefined);
      assert.equal(decision.sequence, action.sequence);
      assert.equal(decision.street, action.street);
      assert.equal(decision.seat, action.seat);
      assert.equal(decision.action, action.action_type);
      assert.equal(decision.to, action.action_to);
      assert.equal(decision.amountPaid, action.amount_paid);
      assert.equal(decision.wasAutomatic, action.was_automatic);
    }
  });

  it('reconstructs the board for each street from the stored board alone', () => {
    const fixture = showdownHand();
    const review = reviewAs(fixture, ALICE);
    // Alice acts on all four streets. Each report's own street must line up with a board of the
    // right length, which only works if the prefix of `hands.board` was taken per street.
    const streets = review.decisions
      .filter((decision) => decision.analysis !== null)
      .map((decision) => decision.analysis?.street);
    assert.deepEqual(streets, ['preflop', 'flop', 'turn', 'river']);
    // On the river every card is out, so equity is exact rather than sampled: proof the board
    // really was five cards by then and not a truncated prefix.
    const river = review.decisions.at(-2);
    assert.equal(river?.analysis?.equity.method, 'exact-enumeration');
  });

  it('analyses a preflop all-in against an empty board, not the board that ran out after it', () => {
    // The one case where the stored board is longer than the acting street implies: both players
    // are all-in preflop, so `advanceStreets` deals five cards with no further action. A review
    // that handed the whole stored board to a preflop decision would be analysing a spot that
    // never existed — and `buildCoachReport` would refuse it, so this would surface as a null.
    const fixture = allInPreflopHand();
    assert.equal(fixture.actions.length, 2, 'a raise and a call, then the board runs itself out');
    const board = fixture.hand.board;
    assert.ok(Array.isArray(board) && board.length === 5, 'five community cards were dealt');

    const review = reviewAs(fixture, ALICE);
    const analysis = analysisAt(review, 1);
    assert.equal(analysis.street, 'preflop');
    assert.equal(analysis.potTotal, 3, 'the blinds, and nothing the run-out added afterwards');
    assert.equal(analysis.toCall, 1);
    assert.equal(analysis.outs, null, 'outs are a postflop idea; preflop there are none to count');
    assert.equal(review.verification.verifiedPositions, 9, 'five board cards and two shown hands');
  });

  it('refuses to analyse when the replay disagrees with the persisted pot', () => {
    const fixture = foldOutHand();
    const skipped: SkippedAnalysis[] = [];
    // A tampered row: the pot no longer follows from the blinds and the action.
    const tampered = {
      ...fixture,
      actions: fixture.actions.map((action) => ({ ...action, pot_after: 999 })),
    };
    const review = reviewAs(tampered, ALICE, { skipped });
    assert.equal(review.decisions[0]?.analysis, null);
    assert.deepEqual(
      skipped.map((entry) => entry.reason),
      ['the replayed pot disagrees with the persisted pot'],
    );
  });
});

// ---------------------------------------------------------------------------
// Hole-card visibility
// ---------------------------------------------------------------------------

describe('hole cards follow the rule on prl.hand_seats.hole_cards', () => {
  it('shows the viewer their own cards and nobody else in a fold-out hand', () => {
    const fixture = foldOutHand();

    const forAlice = reviewAs(fixture, ALICE, { maxAnalysedDecisions: 0 });
    assert.deepEqual(seatOf(forAlice, 0).holeCards, ['Ah', 'Ks']);
    assert.equal(seatOf(forAlice, 1).holeCards, null, 'the winner never showed, so nobody sees the cards');

    const forBorys = reviewAs(fixture, BORYS, { maxAnalysedDecisions: 0 });
    assert.deepEqual(seatOf(forBorys, 1).holeCards, ['7c', '2d']);
    assert.equal(seatOf(forBorys, 0).holeCards, null, 'a folded hand stays sealed even from the winner');
  });

  it('shows every seat that actually showed down, to everyone', () => {
    const fixture = showdownHand();
    for (const viewer of [ALICE, BORYS, CARLA]) {
      const review = reviewAs(fixture, viewer, { maxAnalysedDecisions: 0 });
      assert.deepEqual(seatOf(review, 1).holeCards, ['Ah', 'Ks'], 'seat 1 showed');
      assert.deepEqual(seatOf(review, 2).holeCards, ['Qd', 'Qc'], 'seat 2 showed');
      assert.equal(seatOf(review, 1).showedDown, true);
      assert.equal(seatOf(review, 2).showedDown, true);
    }
  });

  it('keeps the folder’s cards sealed from everyone but the folder', () => {
    const fixture = showdownHand();
    for (const viewer of [ALICE, BORYS]) {
      const review = reviewAs(fixture, viewer, { maxAnalysedDecisions: 0 });
      assert.equal(
        seatOf(review, 0).holeCards,
        null,
        'whether seat 0 folded a bluff or a monster is exactly what must not leak',
      );
      assert.equal(seatOf(review, 0).showedDown, false);
    }
    const forCarla = reviewAs(fixture, CARLA, { maxAnalysedDecisions: 0 });
    assert.deepEqual(seatOf(forCarla, 0).holeCards, ['7c', '2d'], 'their own cards, always');
  });

  it('shows nothing to a user with no seat in the hand', () => {
    const fixture = showdownHand();
    // Not reachable through the route — it answers `hand_not_found` first — but the builder must
    // fail closed on its own, because it is the layer that decides what a card is attached to.
    const review = buildHandReview(
      {
        hand: fixture.hand,
        seats: fixture.seats,
        actions: fixture.actions,
        viewerUserId: 'usr_strangerzzzzzzzzzzzzzzz',
        maxPotAfter: fixture.hand.max_pot_after,
      },
      { equitySamples: TEST_SAMPLES },
    );
    assert.equal(seatOf(review, 0).holeCards, null, 'the folder is invisible to a stranger too');
    assert.deepEqual(seatOf(review, 1).holeCards, ['Ah', 'Ks'], 'a shown hand is public');
    assert.equal(review.hand.heroNet, null, 'a stranger has no net result in this hand');
    for (const decision of review.decisions) {
      assert.equal(decision.analysis, null, 'a stranger owns none of these decisions');
    }
  });

  it('does not leak a hidden card anywhere in the serialised response', () => {
    const fixture = showdownHand();
    for (const viewer of [ALICE, BORYS]) {
      const serialised = JSON.stringify(reviewAs(fixture, viewer, { maxAnalysedDecisions: 0 }));
      for (const card of holeCardsOf(fixture, 0)) {
        assert.ok(
          !serialised.includes(`"${card}"`),
          `seat 0's ${card} reached a viewer who never paid to see it`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Per-decision analysis
// ---------------------------------------------------------------------------

describe('analysis is computed for the viewer’s own decisions and nobody else’s', () => {
  it('analyses only the requesting user’s decisions', () => {
    const fixture = showdownHand();
    const forAlice = reviewAs(fixture, ALICE);
    for (const decision of forAlice.decisions) {
      if (decision.seat === 1) assert.ok(decision.analysis !== null, `seat 1 decision ${decision.sequence}`);
      else assert.equal(decision.analysis, null, `seat ${decision.seat} is not Alice`);
    }
    assert.equal(forAlice.decisions.filter((decision) => decision.analysis !== null).length, 4);
  });

  it('still refuses to analyse an opponent’s decision after they showed down', () => {
    // Seat 2's cards are public in this hand, so an analysis would be *possible*. It is still not
    // produced: the review reports on the decisions of the person asking, and a report that
    // appeared only for hands that happened to reach a showdown would be a review that told you
    // more about other people the more they had shown.
    const fixture = showdownHand();
    const forAlice = reviewAs(fixture, ALICE);
    const seatTwo = forAlice.decisions.filter((decision) => decision.seat === 2);
    assert.ok(seatTwo.length > 0);
    for (const decision of seatTwo) assert.equal(decision.analysis, null);
    assert.deepEqual(
      seatOf(forAlice, 2).holeCards,
      ['Qd', 'Qc'],
      'their cards are public; the analysis is not',
    );
  });

  it('states the assumed opponent range as an assumption of its own', () => {
    const analysis = analysisAt(reviewAs(foldOutHand(), ALICE), 1);
    const last = analysis.assumptions.at(-1) ?? '';
    assert.match(last, /fixed range/);
    assert.ok(last.includes(REVIEW_OPPONENT_RANGE), 'the exact range must be legible to the learner');
    assert.match(last, /not a read of what they actually held/);
    assert.ok(analysis.assumptions.length > 1, 'the Coach’s own assumptions are kept, not replaced');
  });

  it('never claims a decision was correct', () => {
    const analysis = analysisAt(reviewAs(foldOutHand(), ALICE), 1);
    assert.ok(['low', 'moderate', 'reasonable'].includes(analysis.suggestion.confidence));
    assert.ok(analysis.suggestion.whatWouldChangeIt.length > 0);
    assert.ok(analysis.uncertainty.limitations.length > 0);
    assert.ok(!JSON.stringify(analysis).includes('"correct"'));
  });

  it('reproduces the same figures on a second read', () => {
    const fixture = foldOutHand();
    const first = analysisAt(reviewAs(fixture, ALICE), 1);
    const second = analysisAt(reviewAs(fixture, ALICE), 1);
    assert.equal(
      first.equity.heroEquity,
      second.equity.heroEquity,
      'a learner who reloads a review must not see the numbers move',
    );
  });

  it('stops at the decision cap and records why', () => {
    const fixture = showdownHand();
    const skipped: SkippedAnalysis[] = [];
    const review = reviewAs(fixture, ALICE, { maxAnalysedDecisions: 1, skipped });
    assert.equal(review.decisions.filter((decision) => decision.analysis !== null).length, 1);
    assert.deepEqual(
      skipped.map((entry) => entry.reason),
      Array.from({ length: 3 }, () => 'the per-review analysis cap was reached'),
    );
  });

  it('stops when the budget is exhausted and records why', () => {
    const fixture = showdownHand();
    const skipped: SkippedAnalysis[] = [];
    // A clock that has already run past the deadline by the first decision.
    let calls = 0;
    const now = (): number => {
      calls += 1;
      return calls === 1 ? 0 : 10_000;
    };
    const review = reviewAs(fixture, ALICE, { budgetMs: 1_000, now, skipped });
    for (const decision of review.decisions) assert.equal(decision.analysis, null);
    assert.deepEqual(
      new Set(skipped.map((entry) => entry.reason)),
      new Set(['the analysis budget was exhausted']),
    );
  });
});

// ---------------------------------------------------------------------------
// The commitment
// ---------------------------------------------------------------------------

describe('the reveal is verified, and an empty one is a pass', () => {
  it('reports a fold-out hand as verified with nothing to prove', () => {
    const review = reviewAs(foldOutHand(), ALICE, { maxAnalysedDecisions: 0 });
    assert.equal(review.verification.ok, true, 'an empty reveal is correct, never a failure');
    assert.equal(review.verification.verifiedPositions, 0);
    assert.match(review.verification.reason ?? '', /nothing to prove/);
    assert.match(review.commitmentRoot, /^[0-9a-f]{64}$/, 'the root is published either way');
  });

  it('verifies every position a showdown made public', () => {
    const review = reviewAs(showdownHand(), ALICE, { maxAnalysedDecisions: 0 });
    assert.equal(review.verification.ok, true, review.verification.reason);
    // Five board cards plus two hole cards for each of the two seats that showed.
    assert.equal(review.verification.verifiedPositions, 9);
    assert.equal(review.verification.reason, undefined);
  });

  it('proves only the cards that legitimately became public', () => {
    const fixture = showdownHand();
    const review = reviewAs(fixture, ALICE, { maxAnalysedDecisions: 0 });
    const serialised = JSON.stringify(review.reveal);
    assert.ok(serialised.includes('"saltHex"'), 'a proof carries the salt for a card already public');
    // The folder's cards are not among them, so their positions were never proved.
    for (const card of holeCardsOf(fixture, 0)) {
      assert.ok(!serialised.includes(`"${card}"`), `the reveal must not name ${card}`);
    }
  });

  it('refuses a reveal that does not belong to this hand', () => {
    const fixture = showdownHand();
    const other = showdownHand('hand_reviewotherhandaaaaaa');
    const review = reviewAs({ ...fixture, hand: { ...fixture.hand, reveal: other.hand.reveal } }, ALICE, {
      maxAnalysedDecisions: 0,
    });
    assert.equal(review.verification.ok, false);
    assert.equal(review.verification.reason, 'the stored reveal does not belong to this hand');
    assert.equal(review.reveal, null, 'a reveal that failed to parse is not passed on');
  });

  it('refuses a whole-deck reveal outright', () => {
    const fixture = showdownHand();
    const stored = JSON.parse(JSON.stringify(fixture.hand.reveal)) as { complete: boolean };
    stored.complete = true;
    const review = reviewAs({ ...fixture, hand: { ...fixture.hand, reveal: stored } }, ALICE, {
      maxAnalysedDecisions: 0,
    });
    assert.equal(review.verification.ok, false);
    assert.match(review.verification.reason ?? '', /whole-deck reveal is never valid/);
    assert.equal(review.reveal, null);
  });

  it('reports a malformed reveal as unverified rather than throwing', () => {
    const fixture = showdownHand();
    for (const stored of [{ nonsense: true }, 'not an object', 7, { commitment: {}, cards: [] }]) {
      const review = reviewAs(
        { ...fixture, hand: { ...fixture.hand, reveal: stored, result: null } },
        ALICE,
        { maxAnalysedDecisions: 0 },
      );
      assert.equal(review.verification.ok, false, `stored ${JSON.stringify(stored)}`);
      assert.equal(review.reveal, null);
    }
  });

  it('falls back to the reveal inside the result when the column is null', () => {
    // Both places hold it: `hands.reveal` and `hands.result.reveal`, each with its own CHECK
    // constraints. A row written by a path that filled only one of them still verifies.
    const fixture = showdownHand();
    const review = reviewAs({ ...fixture, hand: { ...fixture.hand, reveal: null } }, ALICE, {
      maxAnalysedDecisions: 0,
    });
    assert.equal(review.verification.ok, true, review.verification.reason);
    assert.equal(review.verification.verifiedPositions, 9);
  });

  it('says so plainly when a hand has published no reveal at all', () => {
    const fixture = showdownHand();
    const review = reviewAs({ ...fixture, hand: { ...fixture.hand, reveal: null, result: null } }, ALICE, {
      maxAnalysedDecisions: 0,
    });
    assert.equal(review.verification.ok, false);
    assert.match(review.verification.reason ?? '', /has not published a reveal yet/);
    assert.equal(review.reveal, null);
  });

  it('notices a tampered proof', () => {
    const fixture = showdownHand();
    const stored = JSON.parse(JSON.stringify(fixture.hand.reveal)) as {
      cards: { saltHex: string }[];
    };
    const first = stored.cards[0];
    assert.ok(first !== undefined);
    first.saltHex = first.saltHex.replace(/^./, first.saltHex.startsWith('a') ? 'b' : 'a');
    const review = reviewAs({ ...fixture, hand: { ...fixture.hand, reveal: stored } }, ALICE, {
      maxAnalysedDecisions: 0,
    });
    assert.equal(review.verification.ok, false);
    assert.match(review.verification.reason ?? '', /does not prove against the published root/);
  });
});

// ---------------------------------------------------------------------------
// The summary, and the cursor
// ---------------------------------------------------------------------------

describe('the hand summary', () => {
  const bareHand: HandRow = {
    id: 'hand_summarybareaaaaaaaaaa',
    room_id: 'room_summarybareaaaaaaaaaa',
    hand_number: 4,
    button_seat: 0,
    config: null,
    commitment_root: '',
    commitment_context: '',
    random_source_kind: 'csprng' as const,
    board: ['Qh', '7h', '2c'],
    street: 'complete',
    result: { endedByFold: true, pots: [{ amount: 12 }] },
    reveal: null,
    started_at: new Date('2026-08-17T14:26:23.974456Z'),
    completed_at: new Date('2026-08-17T14:27:23.000000Z'),
  };

  it('prefers the engine’s own running pot total', () => {
    const summary = toHandSummary({ hand: bareHand, heroNet: -12, maxPotAfter: 30 });
    assert.equal(summary.potTotal, 30);
    assert.equal(summary.heroNet, -12);
    assert.equal(summary.endedByFold, true);
    assert.deepEqual(summary.board, ['Qh', '7h', '2c']);
    assert.equal(summary.startedAt, '2026-08-17T14:26:23.974Z');
    assert.equal(summary.completedAt, '2026-08-17T14:27:23.000Z');
  });

  it('falls back to the settled pot layers for a hand with no actions', () => {
    // Everyone all-in from the blinds: there is no action row, so `max(pot_after)` is null and the
    // only other place the figure exists is the settled result.
    const summary = toHandSummary({ hand: bareHand, heroNet: null, maxPotAfter: null });
    assert.equal(summary.potTotal, 12);
    assert.equal(summary.heroNet, null);
  });

  it('tolerates an unreadable board rather than failing the whole read', () => {
    const summary = toHandSummary({
      hand: { ...bareHand, board: ['not a card'] },
      heroNet: 0,
      maxPotAfter: 1,
    });
    assert.deepEqual(summary.board, []);
  });

  it('says a hand is not a fold-out when it has no result yet', () => {
    const summary = toHandSummary({
      hand: { ...bareHand, result: null, completed_at: null },
      heroNet: null,
      maxPotAfter: 8,
    });
    assert.equal(summary.endedByFold, false);
    assert.equal(summary.completedAt, null);
  });
});

describe('the review route is rate limited as an expensive one', () => {
  /**
   * No database needed, and that is the point.
   *
   * `@fastify/rate-limit` attaches itself per route in `onRequest`, which runs before the session
   * `preHandler` and long before any query. So two refused requests are enough to prove which
   * bucket each route is in — and the claim being checked is a real one: without
   * `config: app.expensiveRateLimit` a single session could ask for three hundred Monte Carlo runs
   * a minute under the global limit.
   */
  it('limits the review long before the list', async () => {
    const harness = await buildHandsApp({
      config: testConfig({ RATE_LIMIT_MAX: '100', RATE_LIMIT_EXPENSIVE_MAX: '1' }),
      accounts: new Map(),
    });
    try {
      const url = '/api/v1/hands/hand_ratelimitprobeaaaaaaa';
      const first = await harness.app.inject({ method: 'GET', url });
      const second = await harness.app.inject({ method: 'GET', url });
      assert.equal(first.statusCode, 401, 'refused for want of a session, and counted anyway');
      assert.equal(second.statusCode, 429);
      assert.equal(errorCodeOf(second.payload), 'rate_limited');

      // The list is a cheap read and keeps the global limit, so it is still answering.
      const list = await harness.app.inject({ method: 'GET', url: '/api/v1/hands' });
      assert.equal(list.statusCode, 401);
      assert.equal(errorCodeOf(list.payload), 'not_authenticated');
    } finally {
      await harness.app.close();
    }
  });
});

describe('the list cursor', () => {
  const cursor = { handId: 'hand_cursoraaaaaaaaaaaaaaa', startedAtKey: '2026-08-17T14:26:23.974456Z' };

  it('round trips', () => {
    assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  });

  it('keeps the microseconds, which is the whole reason it exists', () => {
    assert.ok(encodeCursor(cursor).endsWith('.974456Z'));
  });

  it('rejects anything it did not issue', () => {
    const bad = [
      '',
      'nocolon',
      'hand_cursoraaaaaaaaaaaaaaa:2026-08-17T14:26:23.974Z',
      'hand_cursoraaaaaaaaaaaaaaa:2026-08-17 14:26:23.974456Z',
      ':2026-08-17T14:26:23.974456Z',
      'HAND_UPPERCASE:2026-08-17T14:26:23.974456Z',
      "hand_'; drop table prl.hands; --:2026-08-17T14:26:23.974456Z",
    ];
    for (const raw of bad) {
      assert.throws(
        () => decodeCursor(raw),
        (error: unknown) => error instanceof Error && error.name === 'AppError',
        `expected ${JSON.stringify(raw)} to be refused`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The routes, against a real database
// ---------------------------------------------------------------------------

announceSkipUnlessDatabase('the hand route tests');

interface Fixtures {
  readonly app: FastifyInstance;
  readonly cookieFor: (token: string) => string;
  readonly aliceToken: string;
  readonly borysToken: string;
  readonly aliceId: string;
  readonly borysId: string;
  readonly botId: string;
  readonly roomId: string;
  readonly soloHandId: string;
  readonly sharedHandId: string;
}

let fixtures: Fixtures | null = null;

/**
 * What to delete afterwards, recorded before anything is written.
 *
 * Separate from `fixtures` on purpose: a `before` hook that throws halfway — a constraint the
 * fixture violates, say — would never assign `fixtures`, and a cleanup keyed on that would leave
 * rows behind in a shared development database for every future run to trip over.
 */
const created: { readonly roomIds: string[]; readonly userIds: string[] } = { roomIds: [], userIds: [] };

before(async () => {
  if (TEST_DATABASE_URL === undefined) return;
  const config = testConfig();
  const sql = configureDatabase(config);

  const aliceId = newUserId();
  const borysId = newUserId();
  const botId = newUserId();
  const roomId = newRoomId();
  const soloHandId = newHandId();
  const sharedHandId = newHandId();
  created.userIds.push(aliceId, borysId, botId);
  created.roomIds.push(roomId);

  await insertGuest(sql, aliceId, 'Alice');
  await insertGuest(sql, borysId, 'Borys');
  await insertGuest(sql, botId, 'Rock');
  await insertRoom(sql, roomId, aliceId);

  // Alice alone with a bot: Borys must never see this one.
  await insertHand(
    sql,
    persistHand({
      handId: soloHandId,
      roomId,
      handNumber: 1,
      seats: [
        { seat: 0, userId: aliceId, displayName: 'Alice', stack: 200 },
        { seat: 1, userId: botId, displayName: 'Rock', stack: 200, isBot: true },
      ],
      holeCards: { 0: 'AhKs', 1: '7c2d' },
      steps: [{ seat: 0, action: { type: 'fold' } }],
      startedAt: new Date('2026-08-17T10:00:00.111111Z'),
    }),
  );
  // Alice and Borys together, later, so it sorts first.
  await insertHand(
    sql,
    persistHand({
      handId: sharedHandId,
      roomId,
      handNumber: 2,
      seats: [
        { seat: 0, userId: aliceId, displayName: 'Alice', stack: 200 },
        { seat: 1, userId: borysId, displayName: 'Borys', stack: 200 },
      ],
      holeCards: { 0: 'AhKs', 1: '7c2d' },
      steps: [{ seat: 0, action: { type: 'fold' } }],
      startedAt: new Date('2026-08-17T11:00:00.222222Z'),
    }),
  );

  const aliceToken = 'alice-token-for-the-hand-route-tests';
  const borysToken = 'borys-token-for-the-hand-route-tests';
  const accounts = new Map<string, SessionAccount>([
    [aliceToken, accountFor(aliceId, 'Alice')],
    [borysToken, accountFor(borysId, 'Borys')],
  ]);

  const harness = await buildHandsApp({ config, accounts });

  fixtures = {
    app: harness.app,
    cookieFor: harness.cookieFor,
    aliceToken,
    borysToken,
    aliceId,
    borysId,
    botId,
    roomId,
    soloHandId,
    sharedHandId,
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

describe('GET /hands', { skip: DB_SKIP_REASON }, () => {
  it('needs a session', async () => {
    const response = await live().app.inject({ method: 'GET', url: '/api/v1/hands' });
    assert.equal(response.statusCode, 401);
    assert.equal(errorCodeOf(response.payload), 'not_authenticated');
  });

  it('returns only the caller’s own hands, newest first', async () => {
    const context = live();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/hands',
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<HandListResponse>();
    assert.deepEqual(
      body.hands.map((hand) => hand.id),
      [context.sharedHandId, context.soloHandId],
    );
    assert.equal(body.nextCursor, null);
    assert.equal(body.hands[0]?.endedByFold, true);
    assert.equal(body.hands[0]?.potTotal, 3);
    assert.equal(body.hands[0]?.heroNet, -1, 'Alice folded the small blind');

    const forBorys = await context.app.inject({
      method: 'GET',
      url: '/api/v1/hands',
      headers: { cookie: context.cookieFor(context.borysToken) },
    });
    assert.deepEqual(
      forBorys.json<HandListResponse>().hands.map((hand) => hand.id),
      [context.sharedHandId],
      'Borys held no seat in the other hand, so it is not his history',
    );
  });

  it('never puts a hole card in a list row', async () => {
    const context = live();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/hands',
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    assert.ok(!response.payload.includes('holeCards'));
    assert.ok(!response.payload.includes('"Ah"'), 'even the caller’s own cards have no place in a list');
  });

  it('pages with a cursor, and the second page follows the first', async () => {
    const context = live();
    const first = await context.app.inject({
      method: 'GET',
      url: '/api/v1/hands?limit=1',
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    const firstPage = first.json<HandListResponse>();
    assert.deepEqual(
      firstPage.hands.map((hand) => hand.id),
      [context.sharedHandId],
    );
    assert.ok(firstPage.nextCursor !== null, 'a further page exists');

    const second = await context.app.inject({
      method: 'GET',
      url: `/api/v1/hands?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    const secondPage = second.json<HandListResponse>();
    assert.deepEqual(
      secondPage.hands.map((hand) => hand.id),
      [context.soloHandId],
      'no repeat and no gap',
    );
    assert.equal(secondPage.nextCursor, null);
  });

  it('filters by room, and an unknown room is simply empty', async () => {
    const context = live();
    const mine = await context.app.inject({
      method: 'GET',
      url: `/api/v1/hands?roomId=${context.roomId}`,
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    assert.equal(mine.json<HandListResponse>().hands.length, 2);

    const elsewhere = await context.app.inject({
      method: 'GET',
      url: '/api/v1/hands?roomId=room_someoneelsesroomaaaaa',
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    assert.equal(elsewhere.statusCode, 200);
    assert.deepEqual(elsewhere.json<HandListResponse>().hands, []);
  });

  it('refuses a tampered cursor and an out-of-range limit', async () => {
    const context = live();
    const cookie = context.cookieFor(context.aliceToken);
    for (const url of [
      '/api/v1/hands?cursor=not-a-cursor',
      '/api/v1/hands?limit=500',
      '/api/v1/hands?limit=0',
    ]) {
      const response = await context.app.inject({ method: 'GET', url, headers: { cookie } });
      assert.equal(response.statusCode, 400, url);
      assert.equal(errorCodeOf(response.payload), 'invalid_request', url);
    }
  });
});

describe('GET /hands/:handId', { skip: DB_SKIP_REASON }, () => {
  it('reviews the caller’s own hand', async () => {
    const context = live();
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/hands/${context.soloHandId}`,
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<HandReviewResponse>();
    assert.equal(body.hand.id, context.soloHandId);
    assert.equal(body.verification.ok, true, body.verification.reason);
    assert.equal(body.verification.verifiedPositions, 0, 'a fold-out hand proves nothing, correctly');
    assert.deepEqual(
      body.seats.map((seat) => seat.holeCards),
      [['Ah', 'Ks'], null],
      'own cards visible, the bot’s sealed',
    );
    assert.deepEqual(
      body.seats.map((seat) => seat.displayName),
      ['Alice', 'Rock'],
    );
    assert.equal(body.decisions.length, 1);
    assert.ok(body.decisions[0]?.analysis !== null, 'the fold was Alice’s own decision');
    assert.equal(body.decisions[0]?.analysis?.toCall, 1);
  });

  it('answers hand_not_found for somebody else’s hand', async () => {
    const context = live();
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/hands/${context.soloHandId}`,
      headers: { cookie: context.cookieFor(context.borysToken) },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(errorCodeOf(response.payload), 'hand_not_found');
  });

  it('answers hand_not_found for a hand that does not exist, with the same code', async () => {
    const context = live();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/hands/hand_thisoneneverexistedxx',
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(errorCodeOf(response.payload), 'hand_not_found');
  });

  it('rejects a hand id that is not an id at all', async () => {
    const context = live();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/hands/NOT-AN-ID',
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCodeOf(response.payload), 'invalid_request');
  });

  it('is not cached, because it is one learner’s history', async () => {
    const context = live();
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/hands/${context.sharedHandId}`,
      headers: { cookie: context.cookieFor(context.aliceToken) },
    });
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

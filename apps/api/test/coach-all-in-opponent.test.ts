/**
 * An all-in opponent's `winnable` survives both API paths: the calculation thread, and the review's
 * replay of a stored hand. Board Ks 9d 5c 2h 2s, hero KcQh: aces beat hero, queens lose to hero, so
 * every pot share is 0 or 1 and each figure is worked by hand.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildHandReview } from '../src/review/build-review.ts';
import type { CoachTask } from '../src/workers/equity-worker.ts';
import { WorkerPool } from '../src/workers/pool.ts';
import { persistHand } from './helpers/hand-rows.ts';

const pool = new WorkerPool({ size: 1, timeoutMs: 60_000 });
after(async () => {
  await pool.close();
});

test('the thread prices a side pot from the winnable the task carries', async () => {
  // A is all in for a 150 main pot. B and hero have since put 200 more in: a side pot A is not in.
  // Checking loses the main pot to aces and wins the side pot from queens: 200.
  const task: CoachTask = {
    kind: 'coach',
    spec: {
      heroLabel: 'you',
      heroCards: parseCards('Kc Qh'),
      board: parseCards('Ks 9d 5c 2h 2s'),
      opponents: [
        { kind: 'notation', label: 'A', notation: 'AA' },
        { kind: 'notation', label: 'B', notation: 'QQ' },
      ],
    },
    street: 'river',
    pot: 350,
    contestablePot: 350,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 850,
    opponentStacks: [
      { behind: 0, committedThisStreet: 0, winnable: 150 },
      { behind: 850, committedThisStreet: 0 },
    ],
    bigBlind: 10,
    legalActions: ['fold', 'check', 'bet'],
    samples: 1_000,
    seed: 1,
  };
  const report = await pool.runCoach(task);
  const check = report.candidates.find((row) => row.action === 'check');
  assert.equal(check?.ev, 200);
});

test('a review replays the pot an all-in seat can win, folded chips included', () => {
  // Seat 3 shoves 50 and three seats call: a 200 main pot. Flop: seat 0 bets 100 and both call. Turn:
  // seat 1 bets 200, hero calls, seat 0 folds with its 100 in the side pot. River: 900 in the
  // middle, 200 of it seat 3's. The street alone would have given seat 3 all 900.
  const fixture = persistHand({
    handId: 'coach-all-in-opponent',
    roomId: 'coach-all-in-opponent',
    buttonSeat: 0,
    smallBlind: 5,
    bigBlind: 10,
    seats: [
      { seat: 0, userId: 'user-c', displayName: 'C', stack: 1_000 },
      { seat: 1, userId: 'user-b', displayName: 'B', stack: 1_000 },
      { seat: 2, userId: 'user-hero', displayName: 'Hero', stack: 1_000 },
      { seat: 3, userId: 'user-a', displayName: 'A', stack: 50 },
    ],
    holeCards: { 0: 'JcTc', 1: 'QcQd', 2: 'KcQh', 3: 'AsAh' },
    board: 'Ks 9d 5c 2h 2s',
    steps: [
      { seat: 3, action: { type: 'raise', to: 50 } },
      { seat: 0, action: { type: 'call' } },
      { seat: 1, action: { type: 'call' } },
      { seat: 2, action: { type: 'call' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 0, action: { type: 'bet', to: 100 } },
      { seat: 1, action: { type: 'call' } },
      { seat: 2, action: { type: 'call' } },
      { seat: 1, action: { type: 'bet', to: 200 } },
      { seat: 2, action: { type: 'call' } },
      { seat: 0, action: { type: 'fold' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
    ],
  });
  const review = buildHandReview({
    hand: fixture.hand,
    seats: fixture.seats,
    actions: fixture.actions,
    viewerUserId: 'user-hero',
    maxPotAfter: fixture.hand.max_pot_after,
  });
  const river = review.decisions.find((decision) => decision.street === 'river' && decision.seat === 2);
  assert.equal(river?.potBefore, 900);
  const check = river?.analysis?.candidates.find((row) => row.action === 'check');
  assert.match(check?.derivation ?? '', /the 200 main pot at [\d.]+% and the 700 side pot at/);
});

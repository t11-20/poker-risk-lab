/**
 * A row that puts hero's whole stack in says so, by the rule the table's buttons use: its street total
 * is hero's maximum. Nothing else marks it, because a call that covers a shove also ends the betting.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, deriveContestablePot } from '../src/coach.ts';
import { exactRange } from '../src/ranges.ts';
import { atBetLevel, type BehindSpot } from './at-bet-level.ts';

function rows(overrides: Partial<BehindSpot>) {
  const spot: BehindSpot = {
    heroCards: parseCards('Qs Qd'),
    board: parseCards('Qh 7h 2c 3d'),
    street: 'turn',
    opponents: [{ label: 'the draw', range: exactRange(parseCards('Ah Kh')) }],
    pot: 56,
    contestablePot: 56,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 2589,
    opponentStacks: [370],
    bigBlind: 10,
    ...overrides,
  };
  const input = atBetLevel(spot);
  return buildCoachReport({ ...input, contestablePot: deriveContestablePot(input) }).candidates.map(
    (row) => `${row.action}@${row.to}${row.allIn ? ' all in' : ''}`,
  );
}

test('a call of exactly the stack behind is all in', () => {
  assert.ok(rows({ pot: 426, toCall: 370, heroStack: 370, opponentStacks: [0] }).includes('call@370 all in'));
});

test('a call for less than the bet is all in', () => {
  assert.ok(rows({ pot: 426, toCall: 370, heroStack: 200, opponentStacks: [0] }).includes('call@200 all in'));
});

test('a call that covers a shove is not all in, though no raise is left to make', () => {
  const offered = rows({ pot: 426, toCall: 370, opponentStacks: [0] });
  assert.ok(offered.includes('call@370'), offered.join(', '));
  assert.ok(!offered.some((row) => /^(bet|raise)@/u.test(row)), 'no raise is priced');
});

test('of the bets, only the whole stack is all in, even when the opponent can call less of it', () => {
  const bets = rows({}).filter((row) => row.startsWith('bet@'));
  assert.deepEqual(
    bets.filter((row) => row.endsWith(' all in')),
    ['bet@2589 all in'],
  );
  assert.ok(bets.length > 1, bets.join(', '));
});

/**
 * The part of a range that continues against a bet. On Kd Qc 7h 3s 2d no flush or straight is possible,
 * so the order is plain: 3 combos of KK (a set of kings), 3 of 77 (a set of sevens), 12 of AK (kings
 * with an ace kicker, all identical), then 12 of QJ (queens). 30 combos in all.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import {
  CallingRangeError,
  continuingRange,
  continuingShare,
  rankAgainstBoard,
} from '../src/calling-range.ts';
import { type Combo, classOfCombo, comboToString, exactRange, parseRange } from '../src/ranges.ts';

const BOARD = parseCards('Kd Qc 7h 3s 2d');
const HERO = parseCards('Ts 9s');
const ranked = (notation: string, hero = HERO, board = BOARD) =>
  rankAgainstBoard(parseRange(notation), board, hero);
const classes = (combos: readonly Combo[]) => [...new Set(combos.map((c) => classOfCombo(c).label))].sort();
const combos = (combos: readonly Combo[]) => combos.map(comboToString).sort();

test('the share is pot / (pot + risk / 2), closer to the bots than pot / (pot + risk)', () => {
  assert.equal(continuingShare(100, 0), 1);
  assert.equal(continuingShare(100, 100), 2 / 3);
  assert.equal(continuingShare(100, 200), 0.5);
  assert.equal(continuingShare(100, 800), 0.2);
});

test('the strongest hands on the board continue, whoever holds what', () => {
  const order = ranked('QJ, AK, 77, KK');
  assert.equal(order.combos.length, 30);
  // A share of 0.2 is 6 combos: the sets, and nothing else.
  const tight = continuingRange(order, 100, 800);
  assert.equal(tight.share, 0.2);
  assert.equal(tight.range.combos.length, 6);
  assert.deepEqual(classes(tight.range.combos), ['77', 'KK']);
});

test('every hand tied with the weakest one that must continue continues too', () => {
  // A share of 0.5 asks for 15 combos. The 15th is an AK, and all 12 AK tie, so 18 continue.
  const half = continuingRange(ranked('QJ, AK, 77, KK'), 100, 200);
  assert.equal(half.share, 0.5);
  assert.equal(half.range.combos.length, 18);
  assert.deepEqual(classes(half.range.combos), ['77', 'AKo', 'AKs', 'KK']);
  assert.equal(half.range.fractionOfAllHands, 18 / 1326);
});

test('a share that is a whole count in exact arithmetic is not rounded up into the next group', () => {
  // 70 / (70 + 55) x 25 is exactly 14, the sets, K7s and AA, but 0.56 x 25 is 14.000000000000002.
  const order = ranked('KK, 77, K7s, AA, QJs, JTs, 98s, 97s');
  assert.equal(order.combos.length, 25);
  const cut = continuingRange(order, 70, 110);
  assert.equal(cut.range.combos.length, 14);
  assert.deepEqual(classes(cut.range.combos), ['77', 'AA', 'K7s', 'KK']);
});

test('the continuing set does not depend on the order the range was written in', () => {
  const a = continuingRange(ranked('QJ, AK, 77, KK'), 100, 200);
  const b = continuingRange(ranked('KK, 77, AK, QJ'), 100, 200);
  assert.deepEqual(combos(a.range.combos), combos(b.range.combos));
});

test('at least the strongest hand continues against any size', () => {
  const shove = continuingRange(ranked('QJ, AK, 77, KK'), 1, 1e12);
  assert.equal(shove.range.combos.length, 3);
  assert.deepEqual(classes(shove.range.combos), ['KK']);
});

test('a combo that shares a card with hero or the board is never ranked', () => {
  const order = ranked('AK', parseCards('Ah As'));
  // Two aces left, three kings left once Kd is on the board.
  assert.equal(order.combos.length, 6);
});

test('before the flop the range is ranked by starting-hand strength', () => {
  // 24 combos, so a share of 0.5 is 12: the aces and the kings, not the seven-deuce.
  const order = rankAgainstBoard(parseRange('72o, KK, AA'), [], parseCards('Js Ts'));
  const half = continuingRange(order, 100, 200);
  assert.equal(half.range.combos.length, 12);
  assert.deepEqual(classes(half.range.combos), ['AA', 'KK']);
});

test('a range with no live combo is refused, not read as nobody continuing', () => {
  const blocked = exactRange(parseCards('Kh Kc'));
  assert.throws(() => rankAgainstBoard(blocked, BOARD, parseCards('Kh 2c')), CallingRangeError);
});

test('a board that repeats a card, or a dead card on the board, is refused rather than scored', () => {
  assert.throws(() => rankAgainstBoard(parseRange('AK'), parseCards('Kd Kd 7h'), HERO), CallingRangeError);
  assert.throws(() => rankAgainstBoard(parseRange('AK'), BOARD, parseCards('Kd 9s')), CallingRangeError);
});

test('a pot of nothing or a negative risk is refused', () => {
  assert.throws(() => continuingShare(0, 10), CallingRangeError);
  assert.throws(() => continuingShare(100, -1), CallingRangeError);
});

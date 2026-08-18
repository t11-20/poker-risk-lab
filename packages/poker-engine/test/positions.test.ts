/**
 * Position naming, checked against standard No-Limit Hold'em terminology.
 *
 * Every expectation in this file is written out from the standard naming as a
 * literal, and the clockwise seat walk is done here rather than with the engine's
 * own `orderFrom`, so nothing is checked against the code that produces it. That
 * matters: the only previous test of `positionLabels` asserted the two heads-up
 * labels, and heads-up returns before the code path that mislabelled every seat at
 * three or more handed.
 *
 * The reference naming, clockwise from the button:
 *
 *   2 handed  BTN/SB, BB          the button posts the small blind and is both
 *   3 handed  BTN, SB, BB         no seat is left over to name
 *   4 handed  BTN, SB, BB, CO     the one extra seat sits right of the button
 *   5 handed  BTN, SB, BB, UTG, CO
 *   6 handed  BTN, SB, BB, UTG, HJ, CO
 *
 * Two anchors define the whole scheme: UTG is the first seat after the big blind
 * (it is "under the gun" because it opens the preflop action), and CO is the seat
 * immediately right of the button (it acts just before the button, hence "cutoff").
 * The names in between are filled towards the blinds as the table grows.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignBlinds, type PositionLabel, positionLabels } from '../src/positions.ts';

/** Standard labels in clockwise order starting AT the button, by player count. */
const STANDARD_ORDER = new Map<number, readonly PositionLabel[]>([
  [2, ['BTN/SB', 'BB']],
  [3, ['BTN', 'SB', 'BB']],
  [4, ['BTN', 'SB', 'BB', 'CO']],
  [5, ['BTN', 'SB', 'BB', 'UTG', 'CO']],
  [6, ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']],
]);

/**
 * Occupied seats clockwise starting at the button, computed here so the referee
 * never borrows the engine's seat arithmetic.
 */
function clockwiseFromButton(buttonSeat: number, maxSeats: number, occupied: readonly number[]): number[] {
  const order: number[] = [buttonSeat];
  for (let step = 1; step < maxSeats; step++) {
    const candidate = (buttonSeat + step) % maxSeats;
    if (occupied.includes(candidate)) order.push(candidate);
  }
  return order;
}

/** The label map the standard naming requires, built independently of the engine. */
function refereeLabels(
  buttonSeat: number,
  maxSeats: number,
  occupied: readonly number[],
): Map<number, PositionLabel> {
  const order = clockwiseFromButton(buttonSeat, maxSeats, occupied);
  const names = STANDARD_ORDER.get(order.length);
  assert.ok(names !== undefined, `no reference naming for ${order.length} players`);
  assert.equal(order.length, names.length);
  const expected = new Map<number, PositionLabel>();
  for (const [index, seat] of order.entries()) {
    const name = names[index];
    assert.ok(name !== undefined);
    expected.set(seat, name);
  }
  return expected;
}

/** Which seats post the blinds, from the rules rather than from `assignBlinds`. */
function refereeBlinds(
  buttonSeat: number,
  maxSeats: number,
  occupied: readonly number[],
): { smallBlindSeat: number; bigBlindSeat: number; isHeadsUp: boolean } {
  const afterButton = clockwiseFromButton(buttonSeat, maxSeats, occupied).slice(1);
  const [first, second] = afterButton;
  assert.ok(first !== undefined, 'a table needs at least two players');
  // Heads-up is a different rule set: the button posts the small blind.
  if (occupied.length === 2) {
    return { smallBlindSeat: buttonSeat, bigBlindSeat: first, isHeadsUp: true };
  }
  assert.ok(second !== undefined);
  return { smallBlindSeat: first, bigBlindSeat: second, isHeadsUp: false };
}

function sortedEntries(labels: ReadonlyMap<number, PositionLabel>): [number, PositionLabel][] {
  return [...labels.entries()].sort((a, b) => a[0] - b[0]);
}

test('the complete label map, written out as literals, for 2 to 6 handed', () => {
  // Flat literals, button on seat 0, no gaps. Read straight off the reference
  // naming above; nothing here is derived from the engine.
  assert.deepEqual(sortedEntries(positionLabels(0, 2, [0, 1])), [
    [0, 'BTN/SB'],
    [1, 'BB'],
  ]);
  assert.deepEqual(sortedEntries(positionLabels(0, 3, [0, 1, 2])), [
    [0, 'BTN'],
    [1, 'SB'],
    [2, 'BB'],
  ]);
  assert.deepEqual(sortedEntries(positionLabels(0, 4, [0, 1, 2, 3])), [
    [0, 'BTN'],
    [1, 'SB'],
    [2, 'BB'],
    [3, 'CO'],
  ]);
  assert.deepEqual(sortedEntries(positionLabels(0, 5, [0, 1, 2, 3, 4])), [
    [0, 'BTN'],
    [1, 'SB'],
    [2, 'BB'],
    [3, 'UTG'],
    [4, 'CO'],
  ]);
  assert.deepEqual(sortedEntries(positionLabels(0, 6, [0, 1, 2, 3, 4, 5])), [
    [0, 'BTN'],
    [1, 'SB'],
    [2, 'BB'],
    [3, 'UTG'],
    [4, 'HJ'],
    [5, 'CO'],
  ]);

  // The button moved one seat: every label moves with it. Six-handed with the
  // button on seat 2 was the case the old code reported as
  // [HJ, CO, BTN, CO, MP, UTG]-flavoured nonsense, with no SB or BB anywhere.
  assert.deepEqual(sortedEntries(positionLabels(2, 6, [0, 1, 2, 3, 4, 5])), [
    [0, 'HJ'],
    [1, 'CO'],
    [2, 'BTN'],
    [3, 'SB'],
    [4, 'BB'],
    [5, 'UTG'],
  ]);
});

test('every table size 2..6 and every button position matches standard naming', () => {
  for (let players = 2; players <= 6; players++) {
    const occupied = Array.from({ length: players }, (_, seat) => seat);
    for (const buttonSeat of occupied) {
      const labels = positionLabels(buttonSeat, players, occupied);
      const expected = refereeLabels(buttonSeat, players, occupied);
      assert.deepEqual(
        sortedEntries(labels),
        sortedEntries(expected),
        `${players}-handed, button on seat ${buttonSeat}`,
      );
    }
  }
});

test('gapped seating is labelled by clockwise order, not by seat number', () => {
  // A six-max table with three players sitting in seats 0, 2 and 5.
  assert.deepEqual(sortedEntries(positionLabels(0, 6, [0, 2, 5])), [
    [0, 'BTN'],
    [2, 'SB'],
    [5, 'BB'],
  ]);
  assert.deepEqual(sortedEntries(positionLabels(2, 6, [0, 2, 5])), [
    [0, 'BB'],
    [2, 'BTN'],
    [5, 'SB'],
  ]);
  // Two players in seats 1 and 4 of a six-max table is still heads-up.
  assert.deepEqual(sortedEntries(positionLabels(4, 6, [1, 4])), [
    [1, 'BB'],
    [4, 'BTN/SB'],
  ]);

  for (const occupied of [
    [0, 2, 5],
    [1, 3],
    [0, 1, 4],
    [0, 2, 3, 5],
    [1, 2, 3, 4, 5],
  ]) {
    for (const buttonSeat of occupied) {
      assert.deepEqual(
        sortedEntries(positionLabels(buttonSeat, 6, occupied)),
        sortedEntries(refereeLabels(buttonSeat, 6, occupied)),
        `seats ${occupied.join(',')} with the button on ${buttonSeat}`,
      );
    }
  }
});

test('the seat that posts each blind is the seat labelled for it', () => {
  // The regression in one assertion: the small blind was reported as the cutoff at
  // six handed and as under the gun at three handed, so a learner reading the table
  // saw the wrong position for the seat that had just been charged a blind.
  for (let players = 2; players <= 6; players++) {
    const occupied = Array.from({ length: players }, (_, seat) => seat);
    for (const buttonSeat of occupied) {
      const referee = refereeBlinds(buttonSeat, players, occupied);
      const engine = assignBlinds(buttonSeat, players, occupied);
      assert.deepEqual(
        { ...engine },
        referee,
        `${players}-handed, button ${buttonSeat}: blind seats disagree with the rules`,
      );

      const labels = positionLabels(buttonSeat, players, occupied);
      const where = `${players}-handed, button ${buttonSeat}`;
      assert.equal(
        labels.get(referee.smallBlindSeat),
        referee.isHeadsUp ? 'BTN/SB' : 'SB',
        `${where}: seat ${referee.smallBlindSeat} posts the small blind`,
      );
      assert.equal(
        labels.get(referee.bigBlindSeat),
        'BB',
        `${where}: seat ${referee.bigBlindSeat} posts the big blind`,
      );
      assert.equal(labels.get(buttonSeat), referee.isHeadsUp ? 'BTN/SB' : 'BTN', `${where}: the button`);
    }
  }
});

test('every occupied seat gets exactly one label and no label is reused', () => {
  for (let players = 2; players <= 6; players++) {
    const occupied = Array.from({ length: players }, (_, seat) => seat);
    for (const buttonSeat of occupied) {
      const labels = positionLabels(buttonSeat, players, occupied);
      const where = `${players}-handed, button ${buttonSeat}`;
      assert.equal(labels.size, players, `${where}: every seat must be labelled exactly once`);
      for (const seat of occupied) {
        assert.ok(labels.get(seat) !== undefined, `${where}: seat ${seat} has no label`);
      }
      const used = [...labels.values()];
      assert.equal(new Set(used).size, used.length, `${where}: duplicate label in ${used.join(',')}`);
      // 'MP' is the fallback the old code fell through to once its name list ran
      // out. At six or fewer seats every position has a real name, so it must
      // never appear.
      assert.ok(!used.includes('MP'), `${where}: fell through to the MP fallback`);
    }
  }
});

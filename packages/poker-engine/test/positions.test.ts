/**
 * Position names against standard NLHE terminology. Expectations are literals and the seat walk is
 * done here, not with `orderFrom`, so nothing is checked against the code under test. The earlier
 * test only covered heads-up, which returns before the path that mislabelled 3+ handed tables.
 *
 *   2 handed  BTN/SB, BB
 *   3 handed  BTN, SB, BB
 *   4 handed  BTN, SB, BB, CO
 *   5 handed  BTN, SB, BB, UTG, CO
 *   6 handed  BTN, SB, BB, UTG, HJ, CO
 *
 * UTG is the first seat after the big blind and CO the seat right of the button.
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

/** Occupied seats clockwise from the button, computed here rather than with the engine's arithmetic. */
function clockwiseFromButton(buttonSeat: number, maxSeats: number, occupied: readonly number[]): number[] {
  const order: number[] = [buttonSeat];
  for (let step = 1; step < maxSeats; step++) {
    const candidate = (buttonSeat + step) % maxSeats;
    if (occupied.includes(candidate)) order.push(candidate);
  }
  return order;
}

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

  // Six-handed with the button on seat 2 was a case the old code reported with no SB or BB.
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
  // The regression. The small blind was labelled CO at six handed and UTG at three handed.
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
      // 'MP' is the old fallback. At six or fewer seats every position has a real name.
      assert.ok(!used.includes('MP'), `${where}: fell through to the MP fallback`);
    }
  }
});

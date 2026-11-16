import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionPotNote } from '../src/lib/decision-pot-note.ts';

// Hero called 30 all in into a 310 shove: 50 to win, 270 of the 320 out of reach.
const SHORT = { potTotal: 320, toCall: 30, potOdds: { pot: 50 } } as const;

test('heads-up, the chips past a short seat are the part of the bet it could not match', () => {
  const note = decisionPotNote({ ...SHORT, outOfReach: 'uncalled' });
  assert.equal(
    note,
    '30 units to call, with 270 units of the 320 units in the middle the part of the bet this seat could ' +
      'not match, which goes back to the bettor uncalled.',
  );
});

test('with a second opponent able to contest them, they are a side pot', () => {
  assert.match(
    decisionPotNote({ ...SHORT, outOfReach: 'side-pot' }),
    /270 units of the 320 units in the middle a side pot this seat was not in\./,
  );
});

test('a seat that covers the bet is told only the price', () => {
  assert.equal(decisionPotNote({ potTotal: 110, toCall: 90, potOdds: { pot: 110 } }), '90 units to call.');
  assert.equal(decisionPotNote({ potTotal: 110, toCall: 0, potOdds: { pot: 110 } }), 'Nothing to call.');
});

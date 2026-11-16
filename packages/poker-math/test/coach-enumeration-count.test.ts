/**
 * An exact figure's count is one showdown per opponent hand per board still to come. On a complete
 * river there is no board to come, so the count is opponent hands, never boards or run-outs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput } from '../src/coach.ts';
import { exactRange, parseRange } from '../src/ranges.ts';

const RIVER = parseCards('Ks 9d 5c 2h 2s');

function exact(spot: Pick<CoachInput, 'board' | 'street' | 'opponents' | 'opponentStacks'>) {
  return buildCoachReport({
    heroCards: parseCards('Kc Qh'),
    pot: 100,
    contestablePot: 100,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 900,
    bigBlind: 10,
    ...spot,
  });
}

test('a complete river counts the opponent hands it played out, not boards', () => {
  // JJ, 99 and 55 leave 6 + 3 + 3 = 12 combinations beside K♣ Q♥ and this board.
  const report = exact({
    board: RIVER,
    street: 'river',
    opponents: [{ label: 'B', range: parseRange('JJ,99,55', [...RIVER, ...parseCards('Kc Qh')]) }],
    opponentStacks: [{ behind: 900, committedThisStreet: 0 }],
  });
  assert.equal(report.equity.method, 'exact-enumeration');
  assert.equal(report.equity.trials, 12);
  assert.equal(
    report.uncertainty.summary,
    'Computed exactly over every hand the opponent range allows (12 showdowns). There is no sampling error.',
  );
});

test('a turn counts each opponent hand against each river card', () => {
  // One hand for the opponent and 44 river cards: 44 showdowns.
  const report = exact({
    board: RIVER.slice(0, 4),
    street: 'turn',
    opponents: [{ label: 'A', range: exactRange(parseCards('Jc Th')) }],
    opponentStacks: [{ behind: 900, committedThisStreet: 0 }],
  });
  assert.equal(report.equity.trials, 44);
  assert.equal(
    report.uncertainty.summary,
    'Computed exactly over every hand the opponent range allows and every board still to come (44 showdowns). There is no sampling error.',
  );
});

test('several opponents count each combination of their hands', () => {
  const report = exact({
    board: RIVER,
    street: 'river',
    opponents: [
      { label: 'A', range: exactRange(parseCards('Jc Th')) },
      { label: 'B', range: exactRange(parseCards('9c 9h')) },
    ],
    opponentStacks: [
      { behind: 900, committedThisStreet: 0 },
      { behind: 900, committedThisStreet: 0 },
    ],
  });
  assert.equal(report.equity.trials, 1);
  assert.match(
    report.uncertainty.summary,
    /^Computed exactly over every combination of hands the opponent ranges allow \(1 showdown\)\./,
  );
});

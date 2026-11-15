/**
 * A seat that has folded cannot call, so it is not one of the opponents the Coach prices against.
 * Expected figures are worked by hand in comments.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Scenario } from '@prl/contracts';
import { buildCoachReport, deriveContestablePot, deriveLegalActions } from '@prl/poker-math';
import { collectContentProblems, content, readRawContent, readSituation } from '../src/index.ts';

function shipped(id: string): Scenario {
  const found = content().scenarios.find((scenario) => scenario.id === id);
  assert.ok(found !== undefined, `no scenario "${id}"`);
  return found;
}

test('only the seats still in the hand are opponents, an all-in one at 0 behind', () => {
  // Under the gun, the hijack and the cutoff fold, so the blinds are the only opponents.
  assert.deepEqual(readSituation(shipped('fl-same-cards-on-the-button')).opponentStacks, [
    { behind: 995, committedThisStreet: 5 },
    { behind: 990, committedThisStreet: 10 },
  ]);
  // The cutoff and the button fold and the small blind is all in, so nobody can call another chip.
  assert.deepEqual(readSituation(shipped('rk-when-survival-outweighs-chip-ev')).opponentStacks, [
    { behind: 0, committedThisStreet: 24000 },
  ]);
  // The small blind folded before the flop. The big blind's 940 is all that can still be matched.
  assert.deepEqual(readSituation(shipped('fl-board-plays-itself-river')).opponentStacks, [
    { behind: 940, committedThisStreet: 20 },
  ]);
});

test('a deep folded seat does not lift what a shove can win', () => {
  // A set of queens against the nut flush draw, equity 37/44. The folded small blind has 1000 behind
  // and the big blind 300. Shoving 1000 into 56, only 300 can be called:
  //   EV = 0.35 x 56 + 0.65 x [ (37/44) x (56 + 600) - 300 ] = 19.6 + 0.65 x 251.6363636 = 183.1636364.
  // Counting the folded 1000 as callable it read 19.6 + 0.65 x [ (37/44) x 2056 - 1000 ] = 493.39.
  const scenario: Scenario = {
    ...shipped('fl-board-plays-itself-river'),
    street: 'turn',
    board: 'Qh 7h 2c 3d',
    potBeforeStreet: 56,
    committedThisStreet: {},
    toCall: 0,
    opponentRange: { kind: 'exact', cards: 'AhKh' },
    seats: [
      { seat: 0, label: 'BTN', stack: 1000, isHero: true, holeCards: 'QsQd' },
      { seat: 1, label: 'SB', stack: 1000, folded: true },
      { seat: 2, label: 'BB', stack: 300 },
    ],
  };
  const situation = readSituation(scenario);
  const spot = {
    pot: situation.pot,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
  };
  const report = buildCoachReport({
    heroCards: situation.heroCards,
    board: situation.board,
    street: 'turn',
    opponents: [{ label: 'the draw', range: situation.opponentRange }],
    ...spot,
    contestablePot: deriveContestablePot(spot),
    bigBlind: 10,
    legalActions: deriveLegalActions(spot),
    assumedFoldEquity: 0.35,
  });
  const shove = report.candidates.find((candidate) => candidate.to === 1000);
  assert.ok(shove !== undefined, 'the all-in is offered');
  assert.ok(Math.abs(shove.ev - 183.16363636) < 1e-6, `EV of the shove: got ${shove.ev}`);
  assert.equal(shove.cost, 300);
  assert.equal(report.stackContext.effectiveStack, 300);
});

function problemsWithSeats(id: string, edit: (seat: Record<string, unknown>) => void): readonly string[] {
  const raw = structuredClone(readRawContent());
  const scenario = raw.scenarios.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['id'] === id,
  );
  assert.ok(scenario !== undefined && Array.isArray(scenario['seats']));
  for (const seat of scenario['seats']) edit(seat as Record<string, unknown>);
  return collectContentProblems({ ...raw, scenarios: [scenario] }).filter((problem) =>
    problem.startsWith('scenarios[0]'),
  );
}

test('a folded hero, or a hand with every opponent folded, is refused', () => {
  const foldedHero = problemsWithSeats('fl-board-plays-itself-river', (seat) => {
    if (seat['isHero'] === true) seat['folded'] = true;
  });
  assert.ok(
    foldedHero.some((problem) => /hero seat cannot be folded/.test(problem)),
    foldedHero.join('\n'),
  );
  const nobodyLeft = problemsWithSeats('fl-board-plays-itself-river', (seat) => {
    if (seat['isHero'] !== true) seat['folded'] = true;
  });
  assert.ok(
    nobodyLeft.some((problem) => /no opponent is still in the hand/.test(problem)),
    nobodyLeft.join('\n'),
  );
  const unreadable = problemsWithSeats('fl-board-plays-itself-river', (seat) => {
    if (seat['label'] === 'SB') seat['folded'] = 'yes';
  });
  assert.ok(
    unreadable.some((problem) => /folded/.test(problem)),
    unreadable.join('\n'),
  );
});

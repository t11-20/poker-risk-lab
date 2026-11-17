/**
 * Facing an all-in from the last opponent with chips, no bet can follow this decision. The SPR band
 * and its "one more bet commits them" note describe betting still to come, so they are not shown.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type OpponentStack } from '../src/coach.ts';
import { exactRange } from '../src/ranges.ts';

function facing(opponentStacks: readonly OpponentStack[], toCall: number) {
  // Q♥J♣ on 6♠ 8♠ 7♦ 8♦ 5♥ against 9♣9♦, the river all-in of the audit: 1,300 in the middle.
  return buildCoachReport({
    heroCards: parseCards('Qh Jc'),
    board: parseCards('6s 8s 7d 8d 5h'),
    street: 'river',
    opponents: [{ label: 'the shover', range: exactRange(parseCards('9c 9d')) }],
    pot: 1300,
    contestablePot: 1300,
    toCall,
    heroCommittedThisStreet: 0,
    heroStack: 764,
    opponentStacks,
    bigBlind: 10,
  });
}

test('facing an all-in with no opponent behind, the stack notes say only that betting is over', () => {
  const report = facing([{ behind: 0, committedThisStreet: 764 }], 764);
  assert.equal(report.stackContext.effectiveStack, 0);
  assert.match(report.stackContext.explanation, /there is no more betting/);
  assert.doesNotMatch(report.stackContext.explanation, /SPR|single bet|pots behind/);
  assert.ok(
    !report.teachingNotes.some((note) => /SPR|commits them/.test(note)),
    report.teachingNotes.join('\n'),
  );
});

test('control: a shallow stack with an opponent behind keeps its SPR and its commitment note', () => {
  // 400 behind into 1,300 is an SPR of 0.3, and a bet can still follow.
  const report = facing([{ behind: 400, committedThisStreet: 0 }], 0);
  assert.equal(report.stackContext.effectiveStack, 400);
  assert.match(report.stackContext.explanation, /SPR = effective stack \/ pot = 400 \/ 1300/);
  assert.ok(report.teachingNotes.some((note) => /At an SPR of 0\.3 .* one more bet commits them/.test(note)));
});

test('a call that puts hero all in drops the SPR band and its note, though the opponent has chips behind', () => {
  // The panel shows "No more betting" for this spot, so the depth band beneath it would be untrue.
  for (const toCall of [764, 900]) {
    const report = facing([{ behind: 400, committedThisStreet: toCall }], toCall);
    const call = report.candidates.find((row) => row.action === 'call');
    assert.equal(call?.allIn, true, `calling ${toCall} is all in`);
    assert.equal(report.stackContext.effectiveStack, 764);
    assert.doesNotMatch(report.stackContext.explanation, /SPR|band/, report.stackContext.explanation);
    assert.ok(
      !report.teachingNotes.some((note) => /SPR|commits them/.test(note)),
      report.teachingNotes.join('\n'),
    );
  }
});

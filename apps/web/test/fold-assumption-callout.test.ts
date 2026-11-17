/**
 * The Lab's insight callout names the rows the fold assumption actually moves. It once said "the
 * raise row" unconditionally, though some fixtures assume folds on BET rows and an all-in spot has
 * no fold assumption at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CoachReport } from '@prl/contracts';
import { LAB_SCENARIO_ANALYSIS } from '../src/fixtures/scenarios.ts';
import { foldAssumingActions, foldAssumptionSentence } from '../src/lib/consistency.ts';

function report(id: string): CoachReport {
  const found = LAB_SCENARIO_ANALYSIS[id];
  assert.ok(found !== undefined, `the fixture no longer carries ${id}`);
  return found;
}

describe('the rows the fold assumption moves', () => {
  it('are bet rows where the table prices bets (REGRESSION)', () => {
    assert.deepEqual(foldAssumingActions(report('flop-spr-commitment')), ['bet']);
  });

  it('are raise rows where the table prices raises', () => {
    assert.deepEqual(foldAssumingActions(report('flop-flush-draw-price')), ['raise']);
  });

  it('are pointed at the next panel only where the table has one fold frequency to change', () => {
    assert.match(foldAssumptionSentence(report('flop-spr-commitment')), /change it in the next panel/u);
    const sized = foldAssumptionSentence(report('flop-flush-draw-price'));
    assert.match(sized, /how often the opponent folds to each size.* are the raise rows\./u);
    assert.doesNotMatch(sized, /next panel|somebody chose/u);
  });

  it('are none where no row assumes a fold (REGRESSION)', () => {
    const base = report('flop-flush-draw-price');
    const noAggression: CoachReport = {
      ...base,
      candidates: base.candidates.filter((candidate) => candidate.foldEquityAssumed === undefined),
    };
    assert.ok(noAggression.candidates.length > 0, 'the constructed table is empty');
    assert.deepEqual(foldAssumingActions(noAggression), []);
  });
});

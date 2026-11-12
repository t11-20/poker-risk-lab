/**
 * The Lab's insight callout names the rows the fold assumption actually moves.
 *
 * ## The failure this is written against
 *
 * The callout under every verdict read "If you think that fold assumption is too generous, the row it
 * moves is the raise row" — unconditionally. On `flop-spr-commitment` (the bundled fixture) the rows
 * carrying an assumed fold frequency are BET rows, and on a spot where every opponent is already all
 * in (`eq-rule-of-four-big-draw-flop`) there is no aggressive row and no fold assumption at all, so
 * the sentence pointed the reader at a row that is not on the table.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CoachReport } from '@prl/contracts';
import { LAB_SCENARIO_ANALYSIS } from '../src/fixtures/scenarios.ts';
import { foldAssumingActions } from '../src/lib/consistency.ts';

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

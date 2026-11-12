/**
 * Re-pricing a report at another fold frequency gives the report the Coach would have built there.
 *
 * The Lab's fold-frequency control recomputes the candidate table in the browser from the report
 * alone. That is only honest if the result is the Coach's own arithmetic, so the strongest test is
 * the direct one: build the report at 35%, re-price it at f, and compare with the report the Coach
 * builds when it is TOLD f — row by row, to a billionth of a unit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput } from '../src/coach.ts';
import { exactRange } from '../src/ranges.ts';
import { repriceAtFoldEquity } from '../src/reprice.ts';

function spot(overrides: Partial<CoachInput> = {}): CoachInput {
  return {
    heroCards: parseCards('Qh Jh'),
    board: parseCards('Th 9s 2c 3d'),
    street: 'turn',
    opponents: [{ label: 'the opponent', range: exactRange(parseCards('Ac Kd')) }],
    pot: 210,
    contestablePot: 210,
    toCall: 100,
    heroCommittedThisStreet: 0,
    heroStack: 1000,
    opponentStacks: [1000],
    bigBlind: 20,
    ...overrides,
  };
}

const SHAPES: readonly [string, CoachInput][] = [
  ['facing a bet (raise rows)', spot()],
  ['checked to (bet rows)', spot({ toCall: 0 })],
  ['facing a bet with chips already out', spot({ heroCommittedThisStreet: 40, toCall: 60, heroStack: 960 })],
];

describe('repriceAtFoldEquity', () => {
  for (const [name, input] of SHAPES) {
    it(`reproduces the Coach's own report at every frequency: ${name}`, () => {
      const analysed = buildCoachReport(input);
      for (const f of [0, 0.1, 0.2, 0.35, 0.5, 0.75, 1]) {
        const told = buildCoachReport({ ...input, assumedFoldEquity: f });
        const repriced = repriceAtFoldEquity(analysed, f);
        assert.equal(repriced.kind, 'available');
        assert.ok(repriced.kind === 'available');
        assert.equal(repriced.rows.length, told.candidates.length);
        for (const [index, row] of repriced.rows.entries()) {
          const expected = told.candidates[index];
          assert.equal(row.action, expected?.action);
          assert.equal(row.to, expected?.to ?? null);
          assert.ok(
            Math.abs(row.ev - (expected?.ev ?? Number.NaN)) < 1e-9,
            `${name} at ${f}: ${row.action} ${row.to} re-priced ${row.ev}, the Coach says ${expected?.ev}`,
          );
        }
      }
    });
  }

  it('moves only the rows that read a fold frequency, and leaves equity alone', () => {
    const report = buildCoachReport(spot());
    const repriced = repriceAtFoldEquity(report, 0);
    assert.ok(repriced.kind === 'available');
    assert.equal(repriced.analysedFoldEquity, 0.35);
    for (const row of repriced.rows) {
      if (row.readsFoldEquity)
        assert.notEqual(row.ev, row.analysedEv, `${row.action} ${row.to} did not move`);
      else assert.equal(row.ev, row.analysedEv, `${row.action} moved, and it reads no fold frequency`);
    }
    assert.deepEqual(
      repriced.rows.filter((row) => !row.readsFoldEquity).map((row) => row.action),
      ['fold', 'call'],
    );
  });

  it('names the best row at the new frequency and at the analysed one', () => {
    const report = buildCoachReport(spot());
    const repriced = repriceAtFoldEquity(report, 0);
    assert.ok(repriced.kind === 'available');
    // At 35% the floor raise is best (+41.44); with no folds at all every raise loses more than
    // folding's 0 and the call's -8.41, so the best row is the fold.
    assert.equal(repriced.analysedBest.action, 'raise');
    assert.equal(repriced.analysedBest.to, 200);
    assert.equal(repriced.best.action, 'fold');
  });

  it('refuses a report with no row that reads a fold frequency, and says why', () => {
    // Every opponent all in: the Coach prices fold and call only.
    const report = buildCoachReport(spot({ opponentStacks: [0] }));
    assert.deepEqual(
      report.candidates.map((candidate) => candidate.action),
      ['fold', 'call'],
    );
    const repriced = repriceAtFoldEquity(report, 0.1);
    assert.equal(repriced.kind, 'unavailable');
    assert.ok(repriced.kind === 'unavailable');
    assert.match(repriced.reason, /No row in this table assumes the opponent folds/u);
  });

  it('refuses a report whose rows it cannot reproduce rather than showing different figures', () => {
    const report = buildCoachReport(spot());
    const tampered = {
      ...report,
      candidates: report.candidates.map((candidate) =>
        candidate.action === 'raise' ? { ...candidate, ev: candidate.ev + 1 } : candidate,
      ),
    };
    const repriced = repriceAtFoldEquity(tampered, 0.1);
    assert.equal(repriced.kind, 'unavailable');
    assert.ok(repriced.kind === 'unavailable');
    assert.match(repriced.reason, /could not be reproduced/u);
  });

  it('clamps a frequency outside 0..1 and treats a non-finite one as the analysed frequency', () => {
    const report = buildCoachReport(spot());
    const high = repriceAtFoldEquity(report, 7);
    const none = repriceAtFoldEquity(report, Number.NaN);
    assert.ok(high.kind === 'available' && none.kind === 'available');
    assert.equal(high.foldEquity, 1);
    assert.equal(none.foldEquity, 0.35);
    for (const row of none.rows) assert.ok(Math.abs(row.ev - row.analysedEv) < 1e-9);
  });
});

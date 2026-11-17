/**
 * The fold-frequency summary sits under the Verdict panel, which names the Coach's reading. Naming only
 * the table's highest row puts a second answer beside it, as on `fl-combo-draw-already-ahead`: Raise to
 * 975 at +566.5 next to the reading's 175 at +155.2. Driven with the reports the API builds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content, SCENARIO_ANALYSIS_SAMPLES, SCENARIO_ANALYSIS_SEED } from '@prl/content';
import type { CoachReport } from '@prl/contracts';
import { buildCoachReport, repriceAtFoldEquity, suggestedCandidate } from '@prl/poker-math';
import { formatSignedUnits, formatUnits } from '@prl/ui/format';
import { rowName } from '../src/lib/consistency.ts';
import { type Formatters, repricingSummary } from '../src/lib/fold-equity-lab.ts';
import { coachInputFor } from './lab-coach-input.ts';

const FORMAT: Formatters = {
  units: (value) => formatUnits(value),
  signed: (value) => formatSignedUnits(value, { decimals: 1 }),
};

const reports = content().scenarios.map((scenario): [string, CoachReport] => [
  scenario.id,
  buildCoachReport(
    coachInputFor(scenario, { samples: SCENARIO_ANALYSIS_SAMPLES, seed: SCENARIO_ANALYSIS_SEED }),
  ),
]);

function summaryAt(report: CoachReport, foldEquity: number): string {
  const repriced = repriceAtFoldEquity(report, foldEquity);
  assert.ok(repriced.kind === 'available');
  return repricingSummary(repriced, suggestedCandidate(report), FORMAT);
}

describe('the fold-frequency summary names the Coach’s reading', () => {
  it('fl-combo-draw-already-ahead: the 975 raise is named as set aside, beside the reading (REGRESSION)', () => {
    const report = reports.find(([id]) => id === 'fl-combo-draw-already-ahead')?.[1];
    assert.ok(report !== undefined, 'fl-combo-draw-already-ahead is no longer in the bundle');
    assert.equal(
      summaryAt(report, Number.NaN),
      'At the analysed 35%, the Coach’s reading stands on Raise to 175 units, worth +155.2 units. The ' +
        'highest row, Raise to 975 units, all in, worth +566.5 units, is one the reading sets aside, ' +
        'and the Coach says why.',
    );
  });

  it('names the reading first wherever a higher row would read as the answer, at any frequency', () => {
    let differs = 0;
    let swept = 0;
    for (const [id, report] of reports) {
      const reading = suggestedCandidate(report);
      if (reading === null || repriceAtFoldEquity(report, 0).kind !== 'available') continue;
      swept += 1;
      const name = rowName({ ...reading, to: reading.to ?? null }, formatUnits);
      for (const f of [Number.NaN, 0, 0.6, 1]) {
        const repriced = repriceAtFoldEquity(report, f);
        assert.ok(repriced.kind === 'available');
        const sentence = summaryAt(report, f);
        assert.ok(sentence.includes(name), `${id} at ${f}: no "${name}" in "${sentence}"`);
        const top = repriced.best;
        if (top.action === reading.action && top.to === (reading.to ?? null)) continue;
        assert.ok(
          sentence.indexOf(name) < sentence.indexOf(rowName(top, formatUnits)),
          `${id} at ${f}: a higher row is named before the reading in "${sentence}"`,
        );
        if (Number.isNaN(f)) {
          differs += 1;
          assert.match(sentence, /is one the reading sets aside/u, `${id}: says why it is not the answer`);
        }
      }
    }
    // The control is offered where one fold rate prices every size: four preflop scenarios and the five
    // that say the opponent does not fold. All but the gutshot's fold set a higher row aside.
    assert.equal(swept, 9, `swept ${swept} scenario(s)`);
    assert.equal(differs, 8, `${differs} scenario(s) set a higher row aside`);
  });

  it('control: where the reading is the highest row, the summary says so once', () => {
    const report = reports.find(([id]) => id === 'fl-gutshot-facing-turn-bet')?.[1];
    assert.ok(report !== undefined);
    const sentence = summaryAt(report, Number.NaN);
    assert.match(
      sentence,
      /^At the analysed 35%, the highest row is Fold, worth .* reading stands on it\.$/u,
    );
    assert.doesNotMatch(sentence, /sets aside/u);
  });
});

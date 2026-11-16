/**
 * The fold-frequency summary sits under the Verdict panel, which names the Coach's reading. Naming only
 * the table's highest row put a second answer beside it on `rk-high-spr-same-top-pair`: Raise to 1,400
 * at +264.4 next to the reading's 680 at +230.4. Driven with the reports the API builds.
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
  it('rk-high-spr-same-top-pair: the 1,400 raise is named as set aside, beside the reading (REGRESSION)', () => {
    const report = reports.find(([id]) => id === 'rk-high-spr-same-top-pair')?.[1];
    assert.ok(report !== undefined, 'rk-high-spr-same-top-pair is no longer in the bundle');
    assert.equal(
      summaryAt(report, Number.NaN),
      'At the analysed 35%, the Coach’s reading stands on Raise to 680 units, worth +230.4 units. The ' +
        'highest row, Raise to 1,400 units, all in, worth +264.4 units, is one the reading sets aside, ' +
        'and the Coach says why.',
    );
  });

  it('names the reading first wherever a higher row would read as the answer, at any frequency', () => {
    let differs = 0;
    for (const [id, report] of reports) {
      const reading = suggestedCandidate(report);
      if (reading === null || repriceAtFoldEquity(report, 0).kind !== 'available') continue;
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
    assert.ok(differs >= 20, `only ${differs} scenario(s) set a higher row aside; a sweep of nothing`);
  });

  it('control: where the reading is the highest row, the summary says so once', () => {
    const report = reports.find(([id]) => id === 'rk-low-spr-commit-top-pair')?.[1];
    assert.ok(report !== undefined);
    const sentence = summaryAt(report, Number.NaN);
    assert.match(sentence, /^At the analysed 35%, the highest row is Raise to 440 units, all in, worth /u);
    assert.doesNotMatch(sentence, /sets aside/u);
  });
});

/**
 * The Lab's one promised input is the fold frequency, changed after deciding. `FoldEquityControl` is
 * offered wherever a row reads a fold frequency and explained elsewhere, reproduces the analysis at
 * the analysed frequency and moves only fold-reading rows, and is a labelled native range. The
 * arithmetic is pinned against the Coach in `packages/poker-math/test/reprice.test.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { content } from '@prl/content';
import type { CoachReport } from '@prl/contracts';
import { buildCoachReport, repriceAtFoldEquity } from '@prl/poker-math';
import { LAB_SCENARIO_ANALYSIS } from '../src/fixtures/scenarios.ts';
import { type Formatters, repricingSummary, rowChangeText } from '../src/lib/fold-equity-lab.ts';
import { coachInputFor } from './lab-coach-input.ts';

const FORMAT: Formatters = {
  units: (value) => `${value} units`,
  signed: (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} units`,
};

const reports: [string, CoachReport][] = [
  ...content().scenarios.map((scenario): [string, CoachReport] => [
    scenario.id,
    buildCoachReport(coachInputFor(scenario)),
  ]),
  ...Object.entries(LAB_SCENARIO_ANALYSIS).map(([id, report]): [string, CoachReport] => [
    `fixture ${id}`,
    report,
  ]),
];

describe('the fold-frequency control', () => {
  it('is offered wherever a row reads a fold frequency, and explained everywhere else', () => {
    assert.ok(reports.length >= 42, `only ${reports.length} report(s); a sweep of nothing is not a pass`);
    let offered = 0;
    let explained = 0;
    const wrong: string[] = [];
    for (const [id, report] of reports) {
      const readsFolds = report.candidates.some((candidate) => candidate.foldEquityAssumed !== undefined);
      const repriced = repriceAtFoldEquity(report, 0.1);
      if (readsFolds && repriced.kind !== 'available') wrong.push(`${id}: ${repriced.reason}`);
      if (!readsFolds) {
        if (repriced.kind !== 'unavailable' || !/No row in this table assumes/u.test(repriced.reason)) {
          wrong.push(`${id}: no row reads a fold frequency and the control did not say so`);
        }
        explained += 1;
      } else {
        offered += 1;
      }
    }
    assert.deepEqual(wrong, [], wrong.join('\n'));
    // The other five of the 36 bundled scenarios face an all-in.
    assert.ok(offered >= 30, `offered on only ${offered}`);
    assert.ok(explained >= 1, 'no scenario exercised the explanation');
  });

  it('reproduces the analysis at its own frequency and moves only fold-reading rows elsewhere', () => {
    for (const [id, report] of reports) {
      const atAnalysed = repriceAtFoldEquity(report, Number.NaN);
      if (atAnalysed.kind !== 'available') continue;
      for (const [index, row] of atAnalysed.rows.entries()) {
        assert.equal(
          row.ev,
          report.candidates[index]?.ev,
          `${id}: ${row.action} ${row.to} at the analysed frequency`,
        );
      }
      const atZero = repriceAtFoldEquity(report, 0);
      const atOne = repriceAtFoldEquity(report, 1);
      assert.ok(atZero.kind === 'available' && atOne.kind === 'available');
      const f = atAnalysed.analysedFoldEquity;
      for (const [index, row] of atZero.rows.entries()) {
        if (!row.readsFoldEquity) {
          assert.equal(row.ev, row.analysedEv, `${id}: ${row.action} moved`);
          continue;
        }
        // A bet's EV is linear in f, so the analysed figure sits on the line through 0% and 100%.
        // "Fewer folds cost chips" is false when the called branch is worth more than the pot.
        const one = atOne.rows[index]?.ev ?? Number.NaN;
        const onLine = row.ev + f * (one - row.ev);
        assert.ok(
          Math.abs(onLine - row.analysedEv) < 1e-6,
          `${id}: ${row.action} ${row.to} is not linear in f`,
        );
        assert.ok(Math.abs(one - report.potOdds.pot) < 1e-9, `${id}: ${row.action} ${row.to} at 100%`);
      }
    }
  });

  it('says what moved, and what did not', () => {
    const report = reports.find(([id]) => id === 'eq-flush-draw-turn-small-bet')?.[1];
    assert.ok(report !== undefined, 'eq-flush-draw-turn-small-bet is no longer in the bundle');
    const repriced = repriceAtFoldEquity(report, 0);
    assert.ok(repriced.kind === 'available');
    const call = repriced.rows.find((row) => row.action === 'call');
    const raise = repriced.rows.find((row) => row.action === 'raise');
    assert.ok(call !== undefined && raise !== undefined);
    assert.match(rowChangeText(call, FORMAT), /does not depend on the fold frequency, so it does not move/u);
    assert.match(rowChangeText(raise, FORMAT), /as analysed, .* now \(-/u);
    assert.match(repricingSummary(repriced, FORMAT), /^At 0%, the highest row is /u);
    const analysed = repriceAtFoldEquity(report, 0.35);
    assert.ok(analysed.kind === 'available');
    assert.match(repricingSummary(analysed, FORMAT), /^At the analysed 35%, the highest row is /u);
  });

  it('is in the reveal, as a labelled native range whose value is announced', () => {
    const stage = readFileSync(new URL('../src/components/ScenarioStage.tsx', import.meta.url), 'utf8');
    assert.match(stage, /<FoldEquityControl report=\{analysis\} \/>/u);
    const control = readFileSync(new URL('../src/components/FoldEquityControl.tsx', import.meta.url), 'utf8');
    assert.match(control, /<label className="prl-fold-input__label" htmlFor=\{sliderId\}>/u);
    assert.match(control, /type="range"/u);
    assert.match(control, /aria-valuetext=\{`\$\{percent\}% fold frequency`\}/u);
    assert.match(control, /role="status" aria-live="polite"/u);
    assert.match(control, /repriceAtFoldEquity\(report, percent \/ 100\)/u);
    // The reset disables itself on the render it causes, so focus moves off it first.
    assert.match(control, /sliderRef\.current\?\.focus\(\);\s*setPercent\(analysedPercent\);/u);
  });
});

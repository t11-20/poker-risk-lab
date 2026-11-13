/**
 * The Verdict panel's distance from the benchmark is the real distance. `shortfallUnits` is zeroed on
 * purpose inside the allowance, so a call 2.9 units behind folding once read "Shortfall 0.0". The
 * distance is now its own field, and the verdict semantics are untouched.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAB_SCENARIO_ANALYSIS, LAB_SCENARIOS } from '../src/fixtures/scenarios.ts';
import { judgeConsistency, type ScenarioAction } from '../src/lib/consistency.ts';

const ACTIONS: readonly ScenarioAction[] = ['fold', 'check', 'call', 'bet', 'raise'];

function* everyJudgement() {
  for (const scenario of LAB_SCENARIOS) {
    const report = LAB_SCENARIO_ANALYSIS[scenario.id];
    if (report === undefined) continue;
    for (const action of ACTIONS) {
      const sizes = report.candidates
        .filter((candidate) => candidate.action === action)
        .map((candidate) => candidate.to);
      for (const to of sizes.length === 0 ? [undefined] : sizes) {
        yield {
          label: `${scenario.id}/${action}${to === undefined ? '' : ` to ${to}`}`,
          verdict: judgeConsistency(report, action, to, scenario.bigBlind),
        };
      }
    }
  }
}

describe('the distance from the benchmark', () => {
  it('is nonzero for a consistent action that is behind the benchmark (REGRESSION)', () => {
    const behind: string[] = [];
    for (const { label, verdict } of everyJudgement()) {
      if (verdict.chosenEv === null || !verdict.consistent) continue;
      if (verdict.benchmarkEv - verdict.chosenEv <= 0) continue;
      assert.equal(verdict.shortfallUnits, 0, `${label}: the verdict's own zeroing changed`);
      assert.ok(
        Math.abs((verdict.behindBenchmarkUnits ?? Number.NaN) - (verdict.benchmarkEv - verdict.chosenEv)) <
          1e-9,
        `${label}: behind the benchmark by ${verdict.benchmarkEv - verdict.chosenEv}, reported ${verdict.behindBenchmarkUnits}`,
      );
      behind.push(label);
    }
    assert.ok(
      behind.length > 0,
      'no shipped analysis has a consistent action behind its benchmark; this guard would be decoration',
    );
  });

  it('is the signed gap for every priced action, ahead of the benchmark included', () => {
    let priced = 0;
    for (const { label, verdict } of everyJudgement()) {
      if (verdict.chosenEv === null) continue;
      priced += 1;
      assert.ok(
        Math.abs((verdict.behindBenchmarkUnits ?? Number.NaN) - (verdict.benchmarkEv - verdict.chosenEv)) <
          1e-9,
        `${label}: reported ${verdict.behindBenchmarkUnits}`,
      );
    }
    assert.ok(priced >= 15, `only ${priced} priced action(s); a sweep of nothing is not a pass`);
  });

  it('says "within the allowance" exactly when the verdict is consistent', () => {
    let priced = 0;
    for (const { label, verdict } of everyJudgement()) {
      if (verdict.chosenEv === null) continue;
      priced += 1;
      assert.equal(verdict.withinAllowance, verdict.consistent, `${label}: allowance and verdict disagree`);
      assert.equal(
        verdict.withinAllowance,
        (verdict.behindBenchmarkUnits ?? Number.NaN) <= verdict.toleranceUnits,
        `${label}: "within" does not follow from the two figures printed beside it`,
      );
    }
    assert.ok(priced >= 15, `only ${priced} priced action(s); a sweep of nothing is not a pass`);
  });

  it('has neither figure for an action the analysis did not price', () => {
    const report = LAB_SCENARIO_ANALYSIS[LAB_SCENARIOS[0]?.id ?? ''];
    assert.ok(report !== undefined, 'the first fixture scenario has no analysis');
    const unpriced = judgeConsistency(report, 'raise', 999_999, LAB_SCENARIOS[0]?.bigBlind);
    assert.notEqual(unpriced.pricing, 'priced');
    assert.equal(unpriced.behindBenchmarkUnits, null);
    assert.equal(unpriced.withinAllowance, null);
  });
});

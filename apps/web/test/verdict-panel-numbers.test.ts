/**
 * The Verdict panel must show the number its verdict was decided on. `judgeConsistency` asks whether
 * an action beats FOLDING, so the chosen EV, the best row and the tolerance alone can read as a
 * contradiction. The first test proves such a case exists in shipped analysis, so the guard is not
 * written against a case that cannot occur.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAB_SCENARIO_ANALYSIS, LAB_SCENARIOS } from '../src/fixtures/scenarios.ts';
import { judgeConsistency, type ScenarioAction } from '../src/lib/consistency.ts';

const ACTIONS: readonly ScenarioAction[] = ['fold', 'check', 'call', 'bet', 'raise'];

describe('the Verdict panel can explain its own verdict', () => {
  it('a consistent verdict whose best-row gap exceeds the tolerance is real, and explained (REGRESSION)', () => {
    const misleading: string[] = [];
    let judged = 0;

    for (const scenario of LAB_SCENARIOS) {
      const report = LAB_SCENARIO_ANALYSIS[scenario.id];
      if (report === undefined) continue;
      for (const action of ACTIONS) {
        const verdict = judgeConsistency(report, action, undefined, scenario.bigBlind);
        if (verdict.chosenEv === null) continue;
        judged += 1;
        const bestRowGap = verdict.bestEv - verdict.chosenEv;
        if (verdict.consistent && bestRowGap > verdict.toleranceUnits) {
          assert.equal(
            verdict.shortfallUnits,
            0,
            `${scenario.id}/${action}: consistent, yet a shortfall of ${verdict.shortfallUnits}`,
          );
          assert.equal(
            verdict.benchmarkEv,
            0,
            `${scenario.id}/${action}: a non-fold action judged against ${verdict.benchmarkEv}, not folding`,
          );
          misleading.push(
            `${scenario.id}/${action}: gap ${bestRowGap.toFixed(1)} > tolerance ${verdict.toleranceUnits}`,
          );
        }
      }
    }

    assert.ok(judged >= 15, `only ${judged} action(s) judged; a sweep of nothing is not a pass`);
    assert.ok(
      misleading.length > 0,
      'no shipped analysis produces a consistent verdict whose best-row gap exceeds the tolerance. ' +
        'Either the rule changed or this guard is now decoration — check before deleting it.',
    );
  });

  it('the verdict is decided by the shortfall, never by the best-row gap', () => {
    let checked = 0;
    for (const scenario of LAB_SCENARIOS) {
      const report = LAB_SCENARIO_ANALYSIS[scenario.id];
      if (report === undefined) continue;
      for (const action of ACTIONS) {
        const verdict = judgeConsistency(report, action, undefined, scenario.bigBlind);
        if (verdict.chosenEv === null) continue;
        checked += 1;
        assert.equal(
          verdict.consistent,
          verdict.shortfallUnits <= verdict.toleranceUnits,
          `${scenario.id}/${action}: consistent=${verdict.consistent} disagrees with the shortfall it reports`,
        );
      }
    }
    assert.ok(checked >= 15, `only ${checked} action(s) checked; a sweep of nothing is not a pass`);
  });
});

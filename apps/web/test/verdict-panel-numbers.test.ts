/**
 * The Verdict panel must show the number its verdict was decided on.
 *
 * ## The failure this is written against
 *
 * `ScenarioStage` rendered three figures — the chosen action's EV, the best row on the table, and
 * the tolerance — and the only natural reading of those three together is "consistent when the
 * best row minus mine fits inside the tolerance".
 *
 * That is not the rule. `judgeConsistency` asks whether the action beats FOLDING: a non-fold
 * candidate is defensible at `ev >= -marginUnits`, and a fold is judged against the best row that
 * does not rest on an assumed fold frequency. So a learner could be shown a chosen +20.6, a best
 * row of +51.4, a tolerance of 10 and the words "consistent with the analysis", with nothing on
 * screen that could reconcile them.
 *
 * `@prl/poker-math` already published both missing numbers — `shortfallUnits` and `measuredBestEv`,
 * the latter with a comment saying it exists "so a caller can show the reader the number the
 * verdict used rather than a different one". The web layer dropped both.
 *
 * The first assertion below is the important one: it proves the misleading case is REAL in shipped
 * analysis rather than hypothetical, and fails if no such case exists — because a guard written
 * against a case that cannot occur is decoration.
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
          // The three old numbers contradict each other here. The two new ones must not.
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

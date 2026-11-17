/**
 * The offline Lab scenarios hold to every rule the content validator holds an authored scenario to, and one
 * that states its fold rate is priced at that rate. The fixtures never pass through the validator, so it is
 * run over them here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectContentProblems, readRawContent } from '@prl/content';
import { LAB_SCENARIO_ANALYSIS, LAB_SCENARIOS } from '../src/fixtures/scenarios.ts';

describe('an offline scenario', () => {
  it('passes every scenario check the content validator makes', () => {
    assert.ok(LAB_SCENARIOS.length > 0, 'no fixture scenarios; a sweep of nothing');
    const problems = collectContentProblems({ ...readRawContent(), scenarios: LAB_SCENARIOS }).filter(
      (problem) => problem.startsWith('scenarios['),
    );
    assert.deepEqual(problems, []);
  });
});

describe('an offline scenario that states its fold rate', () => {
  it('declares the rate its assumptions state, and states the rate it declares', () => {
    assert.ok(LAB_SCENARIOS.length > 0, 'no fixture scenarios; a sweep of nothing');
    const problems = collectContentProblems({ ...readRawContent(), scenarios: LAB_SCENARIOS }).filter(
      (problem) => problem.includes('.assumedFoldEquity'),
    );
    assert.deepEqual(problems, []);
  });

  it('prices every bet and raise at the declared rate', () => {
    const declared = LAB_SCENARIOS.filter((scenario) => scenario.assumedFoldEquity !== undefined);
    assert.deepEqual(
      declared.map((scenario) => [scenario.id, scenario.assumedFoldEquity]),
      [
        ['preflop-set-mining-odds', 0.3],
        ['flop-spr-commitment', 0.15],
        ['preflop-squeeze-fold-equity', 0.4],
      ],
    );
    for (const scenario of declared) {
      const rates = (LAB_SCENARIO_ANALYSIS[scenario.id]?.candidates ?? []).flatMap(
        (row) => row.foldEquityAssumed ?? [],
      );
      assert.ok(rates.length > 0, `${scenario.id}: no bet or raise row; a sweep of nothing`);
      assert.deepEqual([...new Set(rates)], [scenario.assumedFoldEquity], scenario.id);
    }
  });
});

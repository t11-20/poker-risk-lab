/**
 * A size the analysis never priced must not be reported as a disagreement. The Coach prices discrete
 * rungs and the ActionBar a continuous range, so an ordinary raise between rungs reaches an analysis
 * that has no opinion about it, and `pricing` must be read, not just the boolean.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAB_SCENARIO_ANALYSIS, LAB_SCENARIOS } from '../src/fixtures/scenarios.ts';
import { judgeConsistency, nearestPricedSentence } from '../src/lib/consistency.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('an unpriced size is reported as unpriced', () => {
  it('a size between two priced rungs reports sizing-not-priced, not a disagreement (REGRESSION)', () => {
    const found: string[] = [];
    for (const scenario of LAB_SCENARIOS) {
      const report = LAB_SCENARIO_ANALYSIS[scenario.id];
      if (report === undefined) continue;
      const raises = report.candidates
        .filter((candidate) => candidate.action === 'raise' && candidate.to !== undefined)
        .map((candidate) => candidate.to as number)
        .sort((a, b) => a - b);
      if (raises.length < 2) continue;
      const priced = new Set(raises);
      const lowest = raises[0] as number;
      const highest = raises[raises.length - 1] as number;
      let between: number | null = null;
      for (let to = lowest + 1; to < highest; to += 1) {
        if (!priced.has(to)) {
          between = to;
          break;
        }
      }
      if (between === null) continue;

      const verdict = judgeConsistency(report, 'raise', between, scenario.bigBlind);
      assert.equal(
        verdict.pricing,
        'sizing-not-priced',
        `${scenario.id}: raise to ${between} sits inside the offered range and reports ${verdict.pricing}`,
      );
      assert.equal(verdict.chosenEv, null, `${scenario.id}: an unpriced size reported an EV`);
      found.push(`${scenario.id}: raise to ${between} between ${lowest} and ${highest}`);
    }

    assert.ok(
      found.length > 0,
      'no scenario offers a raise range with an unpriced value inside it. Either the Coach now ' +
        'prices every integer or this guard has stopped reaching the case it was written for.',
    );
  });

  it('the component reads pricing rather than only the boolean (REGRESSION)', () => {
    const stage = readFileSync(join(SRC, 'components', 'ScenarioStage.tsx'), 'utf8');
    // Pinned to the CHIP branch. `judgement.pricing !== 'priced'` also appears in the note beneath, and an
    // earlier bare match passed with the chip branch disabled.
    assert.match(
      stage,
      /judgement\.pricing !== 'priced' \? \(\s*<Chip tone="info"/u,
      'the unpriced chip branch is gone; an unpriced size will read as a disagreement again',
    );
    assert.match(stage, /did not price that size/u);
    assert.ok(
      !/tone="caution"[\s\S]{0,80}did not price/u.test(stage),
      'the unpriced case is being shown as a caution; it is not a mistake the learner made',
    );
  });
});

describe('an unpriced size names the priced sizes nearest it', () => {
  // Every preset and the default are priced (`lab-sizes-priced.test.ts`), so only a typed or dragged total
  // reaches this.
  it('carries the neighbours on the judgement and says them in units (REGRESSION)', () => {
    let checked = 0;
    for (const scenario of LAB_SCENARIOS) {
      const report = LAB_SCENARIO_ANALYSIS[scenario.id];
      if (report === undefined) continue;
      for (const action of ['bet', 'raise'] as const) {
        const sizes: number[] = report.candidates
          .filter((candidate) => candidate.action === action && candidate.to !== undefined)
          .map((candidate) => candidate.to as number)
          .sort((a, b) => a - b);
        const [low, high] = sizes;
        if (low === undefined || high === undefined || high - low < 2) continue;
        const between = low + 1;
        const verdict = judgeConsistency(report, action, between, scenario.bigBlind);
        assert.deepEqual(
          verdict.nearestPriced,
          { below: low, above: high },
          `${scenario.id} ${action} ${between}`,
        );
        const sentence = nearestPricedSentence(action, { below: low, above: high }, (n) => `${n} units`);
        assert.match(sentence, new RegExp(`${action} to ${low} units and ${action} to ${high} units`, 'u'));
        checked += 1;
      }
      const best = report.candidates.find((candidate) => candidate.to !== undefined);
      if (best !== undefined) {
        assert.equal(judgeConsistency(report, best.action, best.to, scenario.bigBlind).nearestPriced, null);
      }
      assert.equal(judgeConsistency(report, 'fold', undefined, scenario.bigBlind).nearestPriced, null);
    }
    assert.ok(checked > 0, 'no fixture had two priced sizes with a gap between them; a sweep of nothing');
  });

  it('is rendered by the Verdict', () => {
    const stage = readFileSync(join(SRC, 'components', 'ScenarioStage.tsx'), 'utf8');
    assert.match(stage, /nearestPricedSentence\(action, judgement\.nearestPriced, formatUnits\)/u);
  });
});

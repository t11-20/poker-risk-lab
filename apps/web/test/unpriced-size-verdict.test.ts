/**
 * A size the analysis never priced must not be reported as a disagreement.
 *
 * ## The failure this is written against
 *
 * `@prl/poker-math` states the hazard in its own source: "A caller that renders the boolean without
 * reading `pricing` will tell somebody their decision disagreed with an analysis that never looked
 * at it." `apps/web/src/lib/consistency.ts` did not carry `pricing` at all, so `ScenarioStage` had
 * a two-state chip and everything that was not `consistent` became "not the line the analysis leans
 * towards".
 *
 * It is reachable by ordinary use, not by a contrived input. The Coach prices discrete rungs; the
 * ActionBar exposes a continuous range and clamps to it. So a panel reading "Raise — 51 to 95
 * units" accepts 70, prices neither 70 nor anything strictly between the ends, and told the learner
 * their decision disagreed with an analysis that had no opinion about it.
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
      // A total strictly between the lowest and highest priced rung that is not itself a rung.
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
    // A source assertion, because the alternative is rendering React here for one branch. What must
    // be true is that the unpriced case is DISTINGUISHED before the consistent/not-consistent chip
    // is chosen — the defect was a component that never asked.
    const stage = readFileSync(join(SRC, 'components', 'ScenarioStage.tsx'), 'utf8');
    // Pinned to the CHIP branch specifically. An earlier version matched the bare condition
    // `judgement.pricing !== 'priced'`, which appears twice — once here and once in the note
    // beneath — so disabling the chip branch left the note's copy and the guard passed over the
    // very defect it was written for. Its own negative control is what caught that.
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
  // "This analysis did not price that size" was the whole message, which left the reader nowhere to
  // go. Only a typed or dragged total reaches it now — every preset and the default are priced, see
  // `lab-sizes-priced.test.ts` — and the reply names the priced sizes either side.
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
      // A priced size and an unsized action carry no neighbours.
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

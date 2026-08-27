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
import { judgeConsistency } from '../src/lib/consistency.ts';

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
      !/tone="caution"[^]{0,80}did not price/u.test(stage),
      'the unpriced case is being shown as a caution; it is not a mistake the learner made',
    );
  });
});

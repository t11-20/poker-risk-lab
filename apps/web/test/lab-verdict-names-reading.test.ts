/**
 * The Lab's Verdict panel names the row the Coach's reading stands on, beside that reading on the same
 * page. A row the reading set aside, above pot or ahead only on the assumed fold rate, would be a second
 * answer. Driven with the reports the API builds, at its sample count and seed.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { content, SCENARIO_ANALYSIS_SAMPLES, SCENARIO_ANALYSIS_SEED } from '@prl/content';
import type { CoachReport } from '@prl/contracts';
import { buildCoachReport, suggestedCandidate } from '@prl/poker-math';
import { judgeConsistency, type ScenarioAction } from '../src/lib/consistency.ts';
import { verdictRuleSentence } from '../src/lib/verdict-rule.ts';
import { coachInputFor } from './lab-coach-input.ts';

function judged(id: string, action: ScenarioAction, to?: number) {
  const scenario = content().scenarios.find((one) => one.id === id);
  assert.ok(scenario !== undefined, `no scenario ${id}`);
  const report: CoachReport = buildCoachReport(
    coachInputFor(scenario, { samples: SCENARIO_ANALYSIS_SAMPLES, seed: SCENARIO_ANALYSIS_SEED }),
  );
  const judgement = judgeConsistency(report, action, to, scenario.bigBlind);
  return { report, judgement, sentence: verdictRuleSentence(judgement, action) ?? '' };
}

describe('the Verdict panel names the reading, not a row the reading set aside', () => {
  it('above pot: fl-small-straight-beats-trips reads raise 285, so the panel names 285 (REGRESSION)', () => {
    const { report, judgement, sentence } = judged('fl-small-straight-beats-trips', 'call');
    assert.deepEqual(report.suggestion.sizeRange, { min: 285, max: 285 });
    const top = Math.max(...report.candidates.map((candidate) => candidate.ev));
    assert.ok(top > (suggestedCandidate(report)?.ev ?? top), 'the premise: a set-aside row reads higher');
    assert.equal(judgement.reading?.name, 'Raise to 285 units');
    assert.equal(judgement.reading?.ev.toFixed(1), '285.7');
    assert.match(sentence, /the Coach's reading, Raise to 285 units, is there for comparison/u);
    assert.doesNotMatch(sentence, /950/u);
    assert.equal(judgement.consistent, true, 'the verdict still judges a call against folding');
    assert.equal(judgement.benchmarkEv, 0);
  });

  it('fold rate: eq-flush-draw-turn-small-bet reads call 25, not the raise to 50 (REGRESSION)', () => {
    const { report, judgement } = judged('eq-flush-draw-turn-small-bet', 'fold');
    assert.equal(report.suggestion.action, 'call');
    assert.equal(judgement.reading?.name, 'Call 25 units');
    assert.equal(judgement.reading?.ev.toFixed(1), '20.6');
    assert.equal(judgement.consistent, false, 'a fold is still judged against the best measured row');
    assert.equal(judgement.benchmarkEv.toFixed(1), '20.6');
  });

  it('choosing the row the reading set aside says why its figure is higher (REGRESSION)', () => {
    for (const [id, to, reading] of [
      ['fl-small-straight-beats-trips', 950, 'Raise to 285 units'],
      ['eq-flush-draw-turn-small-bet', 50, 'Call 25 units'],
    ] as const) {
      const { judgement, sentence } = judged(id, 'raise', to);
      assert.ok((judgement.chosenEv ?? 0) > (judgement.reading?.ev ?? 0), `${id}: the premise`);
      assert.match(
        sentence,
        new RegExp(`it shows a higher figure than the Coach's reading, ${reading}, which sets aside`, 'u'),
        `${id}: ${sentence}`,
      );
    }
  });

  it('no higher row: rk-low-spr-commit-top-pair still names the highest row, raise to 350', () => {
    const { report, judgement, sentence } = judged('rk-low-spr-commit-top-pair', 'call');
    const top = Math.max(...report.candidates.map((candidate) => candidate.ev));
    assert.equal(judgement.reading?.ev, top);
    assert.equal(judgement.reading?.name, 'Raise to 350 units');
    assert.match(sentence, /Raise to 350 units, is there for comparison/u);
  });

  it('is the row the panel prints, under the Coach’s own label', () => {
    const stage = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'ScenarioStage.tsx'),
      'utf8',
    );
    assert.match(stage, /<dt className="prl-label">One reading of this spot<\/dt>/u);
    assert.doesNotMatch(stage, /Best row on the table/u);
    assert.match(stage, /judgement\.reading\.ev/u);
  });
});

/**
 * The Scenario Lab's verdict says, in one place and in words, what it judged.
 *
 * Measured on "Flush draw facing a small bet" at 6b3886e (UX audit, Minor 9): a call showed
 * "consistent with the analysis" beside "Best row: +56.6 — Raise to 50", and "20.6 units ahead of
 * it" beside "within the allowance of 10 units". Every figure was right and the rule — does the
 * action beat folding — was only a row label. `verdictRuleSentence` states it with the action's own
 * numbers, and this drives it over every action the shipped fixture analyses price.
 *
 * Negative control: with `<VerdictRule … />` removed from `ScenarioStage.tsx`, "is the
 * sentence the panel prints" fails; with the best-row clause removed from `verdict-rule.ts`, the
 * audit's case fails.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatSignedUnits, formatUnits } from '../../../packages/ui/src/format.ts';
import { LAB_SCENARIO_ANALYSIS, LAB_SCENARIOS } from '../src/fixtures/scenarios.ts';
import { judgeConsistency, type ScenarioAction } from '../src/lib/consistency.ts';
import { verdictRuleSentence } from '../src/lib/verdict-rule.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ACTIONS: readonly ScenarioAction[] = ['fold', 'check', 'call', 'bet', 'raise'];
/** The formatters the panel hands in. */
const FORMAT = { units: formatUnits, signedUnits: formatSignedUnits };

/** Every priced (scenario, action) the fixture carries, judged by the shared rule. */
const JUDGED = LAB_SCENARIOS.flatMap((scenario) => {
  const report = LAB_SCENARIO_ANALYSIS[scenario.id];
  if (report === undefined) return [];
  return ACTIONS.map((action) => ({
    id: `${scenario.id}/${action}`,
    action,
    judgement: judgeConsistency(report, action, undefined, scenario.bigBlind),
  })).filter((one) => one.judgement.pricing === 'priced');
});

describe('the verdict says what it judged', () => {
  it('reads a non-empty set of judged actions', () => {
    assert.ok(JUDGED.length >= 15, `only ${JUDGED.length} judged; a sweep of nothing is not a pass`);
  });

  it('is one sentence naming folding as the benchmark, and the allowance, for every priced action', () => {
    for (const { id, action, judgement } of JUDGED) {
      const sentence = verdictRuleSentence(judgement, action, FORMAT);
      assert.ok(sentence !== null, `${id}: a priced action has no sentence`);
      assert.match(sentence, /fold/u, `${id}: the sentence does not say it is measured against folding`);
      assert.ok(
        sentence.includes(FORMAT.units(judgement.toleranceUnits)),
        `${id}: no allowance in "${sentence}"`,
      );
      assert.equal(sentence.match(/\. /gu), null, `${id}: more than one sentence: "${sentence}"`);
      if (action === 'fold') assert.match(sentence, /other way round/u, `${id}: ${sentence}`);
    }
  });

  it('explains the audit’s case: a consistent call beside a better best row', () => {
    const found = JUDGED.find(
      ({ action, judgement }) =>
        action !== 'fold' &&
        judgement.consistent &&
        judgement.chosenEv !== null &&
        judgement.bestEv - judgement.chosenEv > judgement.toleranceUnits &&
        (judgement.behindBenchmarkUnits ?? 0) < 0,
    );
    assert.ok(found !== undefined, 'no shipped spot reproduces the audit’s case; check before deleting this');
    const sentence = verdictRuleSentence(found.judgement, found.action, FORMAT) ?? '';
    // "20.6 units ahead" beside "within the allowance of 10": the allowance is for falling short.
    assert.match(
      sentence,
      /does at least as well as folding, which is worth 0, allowing it to fall up to/u,
      sentence,
    );
    // "consistent" beside "Best row: +56.6 — Raise to 50": the best row is not the bar.
    assert.match(
      sentence,
      /the best row, .+, is there for comparison and does not have to be matched\.$/u,
      sentence,
    );
  });

  it('says nothing about a decision the analysis did not price', () => {
    const [first] = JUDGED;
    assert.ok(first !== undefined);
    const unpriced = { ...first.judgement, behindBenchmarkUnits: null, chosenEv: null };
    assert.equal(verdictRuleSentence(unpriced, first.action, FORMAT), null);
  });

  it('is the sentence the panel prints', () => {
    const stage = readFileSync(join(SRC, 'components', 'ScenarioStage.tsx'), 'utf8');
    assert.match(stage, /<VerdictRule judgement=\{judgement\} action=\{action\} \/>/u);
    assert.match(
      stage,
      /rule === null \? null : <p className="prl-prose prl-stage__verdict-rule">\{rule\}<\/p>/u,
    );
  });
});

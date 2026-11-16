/**
 * A call's `to` is the street total, and its Call button shows what it costs. With a blind already in,
 * the Lab named the call "Call to 7,200 units" beside a button reading "Call all in 6,400 units".
 * Driven with the reports the API builds for the two content scenarios whose call total is not its cost.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content } from '@prl/content';
import type { CoachReport } from '@prl/contracts';
import { buildCoachReport, repriceAtFoldEquity } from '@prl/poker-math';
import { formatUnits } from '@prl/ui/format';
import { judgeConsistency, rowName } from '../src/lib/consistency.ts';
import { verdictRuleSentence } from '../src/lib/verdict-rule.ts';
import { coachInputFor } from './lab-coach-input.ts';

function reportFor(id: string): CoachReport {
  const scenario = content().scenarios.find((one) => one.id === id);
  assert.ok(scenario !== undefined, `no scenario ${id}`);
  return buildCoachReport(coachInputFor(scenario));
}

const NINE_BIG_BLINDS = reportFor('rk-nine-big-blinds-call-or-fold');
const BLIND_REVERSAL = reportFor('fl-heads-up-blind-reversal');

describe('a call in the Lab is named by what it costs', () => {
  it('the premise: the call row reaches 7,200, costs 6,400 and is all in', () => {
    const call = NINE_BIG_BLINDS.candidates.find((candidate) => candidate.action === 'call');
    assert.equal(call?.to, 7_200);
    assert.equal(call?.cost, 6_400);
    assert.equal(call?.allIn, true);
  });

  it('the verdict names the reading as its Call button does (REGRESSION)', () => {
    const judgement = judgeConsistency(NINE_BIG_BLINDS, 'call', undefined, 800);
    assert.equal(judgement.reading?.name, 'Call all in, 6,400 units');
  });

  it('the verdict rule names a better call by its cost (REGRESSION)', () => {
    const withRaise: CoachReport = {
      ...NINE_BIG_BLINDS,
      candidates: [
        ...NINE_BIG_BLINDS.candidates,
        { action: 'raise', to: 9_000, cost: 8_200, ev: 100, derivation: 'EV(raise) is priced here.' },
      ],
    };
    const sentence = verdictRuleSentence(judgeConsistency(withRaise, 'raise', 9_000, 800), 'raise') ?? '';
    assert.match(sentence, /the Coach's reading, Call all in, 6,400 units, is there for comparison/u);
    assert.doesNotMatch(sentence, /7,200/u, 'the street total is not what the call costs');
  });

  it('the fold-frequency rows name a call by its cost and a raise by its total (REGRESSION)', () => {
    const repriced = repriceAtFoldEquity(BLIND_REVERSAL, 0.2);
    assert.ok(repriced.kind === 'available', 'this spot has rows that read a fold frequency');
    const names = repriced.rows.map((row) => rowName(row, formatUnits));
    assert.ok(names.includes('Call 5 units'), `no call by its cost in ${names.join(' / ')}`);
    assert.ok(names.includes('Raise to 20 units'), `no raise by its total in ${names.join(' / ')}`);
  });
});

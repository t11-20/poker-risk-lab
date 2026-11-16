/**
 * A Lab row whose total is hero's whole stack says "all in", as the Coach's rows and the table's button
 * do. Driven with the reports the API builds for scenarios whose top raise is all in.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content } from '@prl/content';
import type { CoachReport } from '@prl/contracts';
import { buildCoachReport, repriceAtFoldEquity } from '@prl/poker-math';
import { formatUnits } from '@prl/ui/format';
import { judgeConsistency, rowName } from '../src/lib/consistency.ts';
import { coachInputFor } from './lab-coach-input.ts';

function reportFor(id: string): { readonly report: CoachReport; readonly bigBlind: number } {
  const scenario = content().scenarios.find((one) => one.id === id);
  assert.ok(scenario !== undefined, `no scenario ${id}`);
  return { report: buildCoachReport(coachInputFor(scenario)), bigBlind: scenario.bigBlind };
}

describe('a Lab row that is all in says so', () => {
  it('the fold-frequency rows name the all-in raise as the Coach does (REGRESSION)', () => {
    const { report } = reportFor('fl-same-cards-on-the-button');
    assert.ok(
      report.candidates.some((row) => row.to === 1_000 && row.allIn === true),
      'the premise',
    );
    const repriced = repriceAtFoldEquity(report, Number.NaN);
    assert.ok(repriced.kind === 'available');
    const names = repriced.rows.map((row) => rowName(row, formatUnits));
    assert.ok(names.includes('Raise to 1,000 units, all in'), names.join(' / '));
    assert.ok(
      names.includes('Raise to 35 units'),
      `control: a raise with chips behind, in ${names.join(' / ')}`,
    );
  });

  it('the verdict names an all-in reading as the Coach does (REGRESSION)', () => {
    const { report, bigBlind } = reportFor('eq-equity-against-one-known-hand');
    const judgement = judgeConsistency(report, 'call', undefined, bigBlind);
    assert.equal(judgement.reading?.name, 'Raise to 400 units, all in');
  });
});

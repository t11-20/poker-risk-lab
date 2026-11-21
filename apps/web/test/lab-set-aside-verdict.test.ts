/**
 * An action a scenario's assumptions set aside is left out of the screen's verdict, as the API leaves
 * it out, while the Coach's table still shows its rows. Measured on the one shipped scenario that sets
 * an action aside, so the test fails if the field or the threading is dropped.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scenarioById } from '@prl/content';
import { buildCoachReport } from '@prl/poker-math';
import { judgeConsistency } from '../src/lib/consistency.ts';
import { coachInputFor } from './lab-coach-input.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const scenario = scenarioById('fl-board-plays-itself-river');
assert.ok(scenario !== null, 'premise: the shipped scenario exists');
const report = buildCoachReport(coachInputFor(scenario));
const raise = report.candidates.find((row) => row.action === 'raise' && row.to !== undefined);
const call = report.candidates.find((row) => row.action === 'call');

describe('a set-aside action on the Lab screen', () => {
  it('is what the shipped scenario declares', () => {
    assert.deepEqual(scenario.actionsSetAside, ['raise']);
    assert.ok(
      raise !== undefined && call !== undefined,
      'premise: the Coach still prices a raise and a call',
    );
  });

  it('is not graded when chosen', () => {
    const verdict = judgeConsistency(report, 'raise', raise?.to, scenario.bigBlind, scenario.actionsSetAside);
    assert.equal(verdict.setAside, true);
    assert.equal(verdict.pricing, 'action-not-priced');
    assert.equal(verdict.chosenEv, null);
    const control = judgeConsistency(report, 'raise', raise?.to, scenario.bigBlind);
    assert.equal(control.setAside, false);
    assert.equal(control.pricing, 'priced', 'control: without the set-aside the raise is graded');
  });

  it('is not offered as the reading beside the verdict', () => {
    assert.equal(report.suggestion.action, 'call', 'premise: the Coach suggests a call');
    const both = judgeConsistency(report, 'fold', undefined, scenario.bigBlind, ['call', 'raise']);
    assert.equal(both.reading, null);
    const control = judgeConsistency(report, 'fold', undefined, scenario.bigBlind, scenario.actionsSetAside);
    assert.notEqual(control.reading, null, 'control: a reading that is not set aside is offered');
  });

  it('is passed by the screen and by the bundled attempt', () => {
    const stage = readFileSync(join(SRC, 'components', 'ScenarioStage.tsx'), 'utf8');
    assert.match(stage, /bigBlind,\s*scenario\.actionsSetAside,\s*\)/);
    assert.match(stage, /this scenario does not evaluate that action/);
    assert.match(stage, /judgement\.setAside \? 'not evaluated in this scenario'/);
    const fixtures = readFileSync(join(SRC, 'fixtures', 'scenarios.ts'), 'utf8');
    assert.match(
      fixtures,
      /judgeConsistency\(analysis, action, to, scenario\.bigBlind, scenario\.actionsSetAside\)/,
    );
  });
});

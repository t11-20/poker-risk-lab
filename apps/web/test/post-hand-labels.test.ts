/**
 * The post-hand table names each priced row. A call's `to` is the street total, so with a blind already
 * in it read "Call 7,200" beside a cost of 6,400 and a button that said "Call all in 6,400".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { content } from '@prl/content';
import { buildCoachReport } from '@prl/poker-math';
import { pricedRowName } from '../src/lib/post-hand-labels.ts';
import { coachInputFor } from './lab-coach-input.ts';

function candidatesOf(id: string) {
  const scenario = content().scenarios.find((one) => one.id === id);
  assert.ok(scenario !== undefined, `no scenario ${id}`);
  return buildCoachReport(coachInputFor(scenario)).candidates;
}

test('a call is named by what it costs, and all in as its button says (REGRESSION)', () => {
  const call = candidatesOf('rk-nine-big-blinds-call-or-fold').find((row) => row.action === 'call');
  assert.ok(call !== undefined && call.to === 7_200 && call.cost === 6_400, 'the premise');
  assert.equal(pricedRowName(call), 'Call all in, 6,400');
});

test('a raise is named by its total, and a call with chips behind without all in', () => {
  const names = candidatesOf('fl-same-cards-on-the-button').map(pricedRowName);
  assert.deepEqual(names, [
    'Fold',
    'Call 10',
    'Raise to 20',
    'Raise to 23',
    'Raise to 27',
    'Raise to 35',
    'Raise to 1,000, all in',
  ]);
});

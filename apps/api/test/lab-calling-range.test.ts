/**
 * The Lab's readings through the task the route builds and the thread that prices it. A scenario that
 * says the opponent does not fold reaches the thread saying so, and every size keeps one fold rate.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { scenarioById } from '@prl/content';
import { coachTaskFor } from '../src/routes/content.ts';
import { WorkerPool } from '../src/workers/pool.ts';

const pool = new WorkerPool({ size: 1, timeoutMs: 60_000 });
after(async () => {
  await pool.close();
});

test('the task carries the statement, and the thread prices from it', async () => {
  const declared = scenarioById('fl-combo-draw-already-ahead');
  const silent = scenarioById('rk-high-spr-same-top-pair');
  assert.ok(declared !== null && silent !== null);
  const task = coachTaskFor(declared);
  assert.equal(task.wholeRangeContinues, true);
  assert.equal(coachTaskFor(silent).wholeRangeContinues, undefined);

  const rates = (await pool.runCoach(task)).candidates.flatMap((row) => row.foldEquityAssumed ?? []);
  assert.ok(rates.length > 1, 'no raise rows; a sweep of nothing');
  assert.deepEqual([...new Set(rates)], [0.35]);

  // The same task without the statement is priced size by size.
  const { wholeRangeContinues: _statement, ...unstated } = task;
  const sized = await pool.runCoach(unstated);
  assert.ok(sized.candidates.some((row) => row.continuingShare !== undefined));
});

test('the two scenarios whose reasoning says call read call on the thread', async () => {
  for (const id of ['rk-high-spr-same-top-pair', 'eq-second-pair-vs-wide-range']) {
    const scenario = scenarioById(id);
    assert.ok(scenario !== null, `${id} is no longer in the bundle`);
    const report = await pool.runCoach(coachTaskFor(scenario));
    assert.equal(report.suggestion.action, 'call', id);
    assert.ok(
      report.candidates.some((row) => row.action === 'raise' && row.continuingShare !== undefined),
      `${id}: no raise priced against the hands that continue`,
    );
  }
});

test('a scenario that states its fold rate reaches the thread with it, for every size', async () => {
  const scenario = scenarioById('rk-high-spr-same-top-pair');
  assert.ok(scenario !== null);
  assert.equal(coachTaskFor(scenario).assumedFoldEquity, undefined);
  const task = coachTaskFor({ ...scenario, assumedFoldEquity: 0.3 });
  const rates = (await pool.runCoach(task)).candidates.flatMap((row) => row.foldEquityAssumed ?? []);
  assert.ok(rates.length > 1, 'no raise rows; a sweep of nothing');
  assert.deepEqual([...new Set(rates)], [0.3]);
});

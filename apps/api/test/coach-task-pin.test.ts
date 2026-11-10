/**
 * The task the socket sends a calculator thread is the one it sent before the Coach's input moved
 * into `@prl/poker-math`, to the byte.
 *
 * The views and the tasks were written by the API's own `coachTaskForView` at the commit before
 * the move; `packages/poker-math/test/coach-view.test.ts` says how, and holds the reports for the
 * same views. A task is the thread's whole input, so a field that changed here would change a
 * figure on the thread with nothing on this side to show it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PlayerView } from '@prl/poker-engine';
import type { CoachTask } from '../src/workers/equity-worker.ts';
import { type CoachForViewOptions, coachTaskForView } from '../src/ws/router.ts';

interface PinnedView {
  readonly name: string;
  readonly view: PlayerView;
  readonly options: CoachForViewOptions;
  readonly task: CoachTask;
}

const PINNED = JSON.parse(
  readFileSync(
    new URL('../../../packages/poker-math/test/fixtures/coach-views.json', import.meta.url),
    'utf8',
  ),
) as readonly PinnedView[];

test('the pinned views are there to compare', () => {
  assert.equal(PINNED.length, 5, 'a sweep of nothing is not a pass');
});

for (const pinned of PINNED) {
  test(`same task, byte for byte: ${pinned.name}`, () => {
    assert.equal(JSON.stringify(coachTaskForView(pinned.view, pinned.options)), JSON.stringify(pinned.task));
  });
}

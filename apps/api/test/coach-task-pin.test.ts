// Pins the calculator-thread task byte for byte to a recorded fixture. The task is the thread's whole
// input, so any drift changes a Coach figure.
// `packages/poker-math/test/coach-view.test.ts` explains how the fixture was written.

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

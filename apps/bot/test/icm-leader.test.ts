/** The bot grades the largest stack's prize share, as the API and the web do, however content orders them. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculate } from '../src/learn.ts';

test('300 against 100 for 70/30 is 60 to the leader, however the stacks are written (REGRESSION)', () => {
  for (const stacks of [
    [300, 100],
    [100, 300],
  ]) {
    const figures = calculate({ kind: 'icm', stacks, payouts: [70, 30] }).figures;
    assert.equal(figures['chipLeaderShare']?.value, 60, `stacks ${stacks.join(' / ')}`);
    assert.match(figures['chipLeaderShare']?.label ?? '', /stack of 300$/u);
    assert.equal(figures['prizeShare1']?.value, 40);
  }
});

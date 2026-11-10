import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CoachBodyStatus, coachBodyFor } from '../src/lib/coach-body.ts';

const STATUSES: readonly CoachBodyStatus[] = ['idle', 'loading', 'ready', 'error', 'complete'];

describe('what the Coach panel holds', () => {
  it('says the hand is over beside a finished hand, even when it was handed a report (REGRESSION)', () => {
    // `/play?state=complete` handed the stage the flop decision's report, and the panel showed it
    // beside a settled table.
    assert.equal(coachBodyFor('complete', true), 'hand-over');
    assert.equal(coachBodyFor('complete', false), 'hand-over');
  });

  it('shows a report during a hand, and only then', () => {
    const shown = STATUSES.filter((status) => coachBodyFor(status, true) === 'report');
    assert.deepEqual(shown, ['idle', 'loading', 'ready', 'error']);
  });

  it('holds a skeleton only while something is loading, and says why otherwise', () => {
    assert.deepEqual(
      STATUSES.map((status) => coachBodyFor(status, false)),
      ['unavailable', 'skeleton', 'unavailable', 'unavailable', 'hand-over'],
    );
  });
});

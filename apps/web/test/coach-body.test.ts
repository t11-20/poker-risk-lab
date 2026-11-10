import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlayerView } from '@prl/poker-engine';
import { type CoachBodyStatus, coachBodyFor, reviewHrefFor } from '../src/lib/coach-body.ts';

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

/** The two fields the rule reads. `fixtures/table.ts` imports `@prl/ui`, which this runner cannot load. */
function finished(viewerSeat: number | null): PlayerView {
  return { handId: 'hand_abc', street: 'complete', viewerSeat } as unknown as PlayerView;
}

describe('the review a finished hand links to', () => {
  it('links a reader who was dealt into the hand', () => {
    assert.equal(reviewHrefFor(finished(2)), '/review/hand_abc');
    assert.equal(reviewHrefFor(finished(0)), '/review/hand_abc', 'seat 0 is a seat');
  });

  it('links nobody who watched it (REGRESSION: a spectator was sent to a 404)', () => {
    const watched = finished(null);
    assert.equal(reviewHrefFor(watched), undefined);
    assert.equal(reviewHrefFor(null), undefined);
  });
});

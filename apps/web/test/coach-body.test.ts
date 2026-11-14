import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PlayerView } from '@prl/poker-engine';
import type { TableStageStatus } from '../src/components/TableStage.tsx';
import { coachBodyFor, noAnalysisReason, readerHasDecisions, reviewHrefFor } from '../src/lib/coach-body.ts';

const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const STATUSES: readonly TableStageStatus[] = ['idle', 'loading', 'ready', 'error', 'complete'];

describe('what the Coach panel holds', () => {
  it('says the hand is over beside a finished hand, even when it was handed a report (REGRESSION)', () => {
    // `/play?state=complete` once showed the flop decision's report beside a settled table.
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

/** A view with only the reader's own seat in it, at `status`, or with no seat of theirs at all. */
function holding(status: 'active' | 'folded' | 'allIn' | 'sittingOut' | null): PlayerView {
  const seats = status === null ? [{ isSelf: false, status: 'active' }] : [{ isSelf: true, status }];
  return { seats } as unknown as PlayerView;
}

describe('what the panel says when there is no analysis mid-hand (audit at 6b3886e, minor 7)', () => {
  const PRESS = /Refresh the analysis/u;

  it('tells a reader still in the hand how to ask, and nobody else', () => {
    assert.match(noAnalysisReason(holding('active')), PRESS);
    for (const status of ['folded', 'allIn', 'sittingOut', null] as const) {
      assert.doesNotMatch(
        noAnalysisReason(holding(status)),
        PRESS,
        `told a ${String(status)} reader to press`,
      );
    }
  });

  it('says why there is nothing to price, in the reader’s own case', () => {
    assert.match(noAnalysisReason(holding('folded')), /out of this hand/u);
    assert.match(noAnalysisReason(holding('allIn')), /all in/u);
    assert.match(noAnalysisReason(holding(null)), /not dealt into this hand/u);
  });

  it('offers the control only to a reader who still has decisions', () => {
    assert.equal(readerHasDecisions(holding('active')), true);
    for (const status of ['folded', 'allIn', 'sittingOut', null] as const) {
      assert.equal(readerHasDecisions(holding(status)), false, `offered to a ${String(status)} reader`);
    }
    assert.equal(readerHasDecisions(null), false);
  });

  // `LiveTable.tsx` imports `@prl/ui`, which this runner cannot load, so the wiring is read from source.
  const wired = (source: string): boolean =>
    /coachUnavailableReason: noAnalysisReason\(live\.table\.view\)/u.test(source) &&
    /readerHasDecisions\(table\.view\) \? \(/u.test(source);

  it('is what the live table shows, and what decides whether it offers the control', () => {
    const live = readFileSync(join(WEB_SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(wired(live), 'LiveTable no longer reads the sentence or the control off the reader’s seat');
    const old =
      'if (live.table.view !== null) return { coachUnavailableReason: COACH_NOT_ASKED_REASON };\n' +
      '{isLive && seated && !table.betweenHands && live.coachOff === null ? (';
    assert.equal(wired(old), false, 'NEGATIVE CONTROL: the detector passed the old wiring');
  });

  it('NEGATIVE CONTROL: the old single sentence told a folded reader to press the button', () => {
    const old =
      'There is no analysis of this spot. The Coach prices a decision, so it is computed when one is ' +
      'yours to make — use "Refresh the analysis" to ask for it now.';
    assert.match(old, PRESS, 'the detector no longer recognises the old sentence');
  });
});

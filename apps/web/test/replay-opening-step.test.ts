/**
 * The replay names who acted on every marker, and opens on the reader's own first decision. Both
 * fixture hands open on the reader's decision, so the cases drop the opening step to get the live
 * shape where somebody else acts first. The component checks read source, because `node --test`
 * cannot load `.tsx` and the defect was in the wiring.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { REVIEW_HAND_FOLDED, REVIEW_HAND_SHOWDOWN } from '../src/fixtures/review.ts';
import { buildHandReplay, type ReplayStep } from '../src/lib/hand-replay.ts';
import { markerActor, markerShort, openingStepIndex } from '../src/lib/replay-steps.ts';

const showdown = buildHandReplay(REVIEW_HAND_SHOWDOWN);

/** The same hand with its first action removed and the rest re-indexed: the reader is not first. */
const notFirst: readonly ReplayStep[] = showdown.steps.slice(1).map((step, index) => ({ ...step, index }));

describe('the step a replay opens on', () => {
  it("is the reader's own first decision when somebody else acted first (REGRESSION)", () => {
    const opening = openingStepIndex({ steps: notFirst });
    assert.notEqual(opening, 0, 'step 1 here is another seat, which is what the replay used to open on');
    const step = notFirst[opening];
    assert.ok(step !== undefined);
    assert.equal(step.isViewerDecision, true);
    assert.ok(
      notFirst.slice(0, opening).every((earlier) => !earlier.isViewerDecision),
      'and it is the FIRST of them, not any of them',
    );
  });

  it('is step 1 when the reader acted first, and when the reader never acted at all', () => {
    assert.equal(openingStepIndex(showdown), 0);
    assert.equal(openingStepIndex(buildHandReplay(REVIEW_HAND_FOLDED)), 0);
    const nobody = notFirst.map((step) => ({ ...step, isViewerDecision: false }));
    assert.equal(openingStepIndex({ steps: nobody }), 0);
    assert.equal(openingStepIndex({ steps: [] }), 0);
  });
});

describe('a marker', () => {
  it('names who acted, on screen, for every decision (REGRESSION)', () => {
    for (const step of showdown.steps) {
      const actor = markerActor(step, showdown.seatNames);
      if (step.decision === null) {
        assert.equal(actor, null, 'the terminal frame is a position, not anybody’s action');
        continue;
      }
      const expected = step.isViewerDecision ? 'You' : showdown.seatNames[step.decision.seat];
      assert.equal(actor, expected, `step ${String(step.index + 1)}`);
    }
    const named = new Set(showdown.steps.map((step) => markerActor(step, showdown.seatNames)));
    assert.ok(named.has('You') && named.has('Quartile'), `actors seen: ${[...named].join(', ')}`);
  });

  it('falls back to the seat number, never to nothing, when the review carries no name', () => {
    const step = showdown.steps.find(
      (candidate) => candidate.decision !== null && !candidate.isViewerDecision,
    );
    assert.ok(step?.decision != null);
    assert.equal(markerActor(step, {}), `Seat ${String(step.decision.seat + 1)}`);
  });

  it('keeps the compressed action it always had', () => {
    assert.deepEqual(
      showdown.steps.slice(0, 3).map(markerShort),
      ['RAISE 60', 'FOLD', 'CALL 40'],
      'the first three markers of hand 42',
    );
  });
});

describe('the components use them', () => {
  const replay = readFileSync(new URL('../src/components/HandReplay.tsx', import.meta.url), 'utf8');
  const timeline = readFileSync(new URL('../src/components/DecisionTimeline.tsx', import.meta.url), 'utf8');

  it('HandReplay opens on openingStepIndex, not on 0 (REGRESSION)', () => {
    assert.match(replay, /useState\(\(\) => openingStepIndex\(replay\)\)/u);
    assert.doesNotMatch(replay, /useState\(0\)/u);
  });

  it('DecisionTimeline renders the actor beside the action (REGRESSION)', () => {
    assert.match(replay, /actor: markerActor\(step, replay\.seatNames\)/u);
    assert.match(timeline, /<span className="prl-timeline__actor" aria-hidden="true">\s*\{marker\.actor\}/u);
  });
});

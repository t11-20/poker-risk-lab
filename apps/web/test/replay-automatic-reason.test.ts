/**
 * The hand review says why the server made a decision, and says no more than it knows.
 *
 * ## The defect
 *
 * `HandReplay` printed "The clock ran out and the server acted" — and "(the clock ran out)" in the
 * transport's headline — for every decision with `wasAutomatic`, because that flag was the only
 * thing the review carried. The server sets it for two different things (`apps/api/src/rooms/
 * table.ts`): a seat whose clock expired, and a player who pressed "Stand up" holding cards, whose
 * seat folds when the action reaches it. A reader who chose to leave was told by their own hand
 * history that they had run out of time.
 *
 * The API now records which one it was (`HandReviewDecision.automaticReason`, migration 0009), and
 * a row archived before that carries `null` — which must read as "the server acted", not as the
 * likelier of the two reasons.
 *
 * The last assertion reads `HandReplay.tsx` as text because `node --test` cannot load a `.tsx`, and
 * the defect was in the component's wiring: two inline sentences keyed on `wasAutomatic` alone.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { AutomaticReason } from '@prl/contracts';
import { REVIEW_HAND_SHOWDOWN } from '../src/fixtures/review.ts';
import { buildHandReplay, type ReplayStep } from '../src/lib/hand-replay.ts';
import { automaticAside, automaticSentence } from '../src/lib/replay-steps.ts';

const replay = buildHandReplay(REVIEW_HAND_SHOWDOWN);
const viewerStep = replay.steps.find((step) => step.isViewerDecision && step.decision !== null);
const otherStep = replay.steps.find((step) => !step.isViewerDecision && step.decision !== null);

/** A real step from the fixture, with its decision marked as the server's for `reason`. */
function automatic(step: ReplayStep | undefined, reason: AutomaticReason | null): ReplayStep {
  assert.ok(step !== undefined && step.decision !== null, 'the fixture has no such step to mark');
  return { ...step, decision: { ...step.decision, wasAutomatic: true, automaticReason: reason } };
}

const CLOCK = /clock/iu;

describe('what the replay says about a decision the server made', () => {
  it('names the clock for a timeout, and only for a timeout', () => {
    for (const step of [viewerStep, otherStep]) {
      assert.match(
        automaticSentence(automatic(step, 'timeout')),
        /The clock ran out and the server acted\./u,
      );
      assert.equal(automaticAside(automatic(step, 'timeout')), ' (the clock ran out)');
    }
  });

  it('does not tell a reader who stood up that their clock ran out (REGRESSION)', () => {
    const mine = automatic(viewerStep, 'departed');
    assert.doesNotMatch(automaticSentence(mine), CLOCK);
    assert.doesNotMatch(automaticAside(mine), CLOCK);
    assert.match(automaticSentence(mine), /You had already stood up or left the table/u);

    const theirs = automatic(otherStep, 'departed');
    assert.doesNotMatch(automaticSentence(theirs), CLOCK);
    assert.match(automaticSentence(theirs), /They had already left the table/u);
  });

  it('guesses no reason for a decision recorded before reasons were', () => {
    for (const step of [viewerStep, otherStep]) {
      const legacy = automatic(step, null);
      assert.equal(automaticSentence(legacy), ' The server made this decision automatically.');
      assert.equal(automaticAside(legacy), ' (made automatically)');
    }
  });

  it('says nothing extra about a decision a person made', () => {
    const made = replay.steps.filter((step) => step.decision !== null && !step.decision.wasAutomatic);
    assert.ok(made.length > 0, 'a sweep of nothing is not a pass');
    for (const step of made) {
      assert.equal(automaticSentence(step), '');
      assert.equal(automaticAside(step), '');
    }
  });

  it('is what HandReplay prints: no sentence there decides from wasAutomatic alone', () => {
    const source = readFileSync(new URL('../src/components/HandReplay.tsx', import.meta.url), 'utf8');
    assert.match(source, /automaticSentence\(step\)/u);
    assert.match(source, /automaticAside\(step\)/u);
    assert.doesNotMatch(source, /wasAutomatic \?/u, 'a ternary on the flag is the guess this replaced');
  });
});

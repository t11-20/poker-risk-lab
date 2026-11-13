/**
 * The hand review says why the server made a decision, and says no more than it knows. `wasAutomatic`
 * covers both an expired clock and a reader who stood up holding cards (`apps/api/src/rooms/table.ts`).
 * `automaticReason` (migration 0009) tells them apart, and a row archived before it is `null`, which
 * must read as "the server acted" rather than the likelier reason. The wiring is read as text.
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

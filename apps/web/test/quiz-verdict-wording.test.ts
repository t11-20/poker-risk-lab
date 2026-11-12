/**
 * What a quiz verdict says, and how it is marked.
 *
 * ## The wording defect
 *
 * Measured against the running build on `/learn/pot-odds`, answering 35 to `pot-odds-q2`, whose
 * computed figure is 33.3 % and whose declared tolerance is 1.5:
 *
 *     "35.0 % is outside the tolerance of 33.3 %."
 *
 * 33.3 % is the TARGET. The sentence named it as the tolerance and never said what the tolerance
 * was, so a learner could not tell how far out they were or how close they needed to be. The
 * sentence now names both, and the tolerance it names is the band the grader applied.
 *
 * ## The marking defect
 *
 * The two multiple-choice verdicts — "That matches the answer this lesson gives" and "That is not
 * the answer this lesson gives" — were drawn in one identical neutral box, with no glyph, so at a
 * glance (and at 360x640 the box sits 1060–1210px down the page, under the options) the two could
 * only be told apart by reading the sentence. The option chips already carry `◆` for the lesson's
 * answer and `✕` for a different pick; the verdict now carries the same mark as the chip it agrees
 * with. These tests pin the mapping; the box's edge is CSS keyed off the same `data-matched`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHOICE_MARKER, numericVerdictSentence, verdictMarker } from '../src/lib/quiz-verdict.ts';

describe('the numeric verdict', () => {
  const outside = numericVerdictSentence({
    yours: '35.0 %',
    computed: '33.3 %',
    tolerance: '1.5 %',
    matched: false,
  });
  const inside = numericVerdictSentence({
    yours: '33.5 %',
    computed: '33.3 %',
    tolerance: '1.5 %',
    matched: true,
  });

  it('never calls the computed figure a tolerance', () => {
    assert.doesNotMatch(outside, /tolerance of 33\.3/);
    assert.doesNotMatch(inside, /tolerance of 33\.3/);
  });

  it('names the computed figure as the computed figure', () => {
    assert.match(outside, /^35\.0 % is more than ±1\.5 % from the computed 33\.3 %\./);
    assert.match(inside, /^33\.5 % is within ±1\.5 % of the computed 33\.3 %\.$/);
  });

  it('keeps the "nothing is deducted" sentence on a miss, and only on a miss', () => {
    assert.match(outside, /Nothing is deducted/);
    assert.doesNotMatch(inside, /Nothing is deducted/);
  });
});

describe('the verdict marker', () => {
  it('is the chip the verdict agrees with', () => {
    assert.equal(verdictMarker(true), CHOICE_MARKER.lesson);
    assert.equal(verdictMarker(false), CHOICE_MARKER.yours);
  });

  it('differs between the two verdicts', () => {
    assert.notEqual(verdictMarker(true), verdictMarker(false));
  });
});

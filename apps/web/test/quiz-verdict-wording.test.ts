/**
 * What a quiz verdict says, and how it is marked. The numeric sentence once called the computed
 * figure "the tolerance" and never named the band, so it now names both. The two multiple-choice
 * verdicts carry the mark of the option chip they agree with (`◆` or `✕`); the box's edge is CSS
 * keyed off the same `data-matched`.
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

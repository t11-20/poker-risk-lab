/**
 * Where a lesson's "Next" step goes, and where the home page's "Start with the foundations" goes.
 *
 * ## The defect these exist for
 *
 * Measured against the running build at 360x640: every lesson ended with "Back to the curriculum"
 * and "Open the glossary" and nothing else, and so did the quiz's review panel. A learner who had
 * just finished lesson one had to go back to an index, find where they were, and scroll — on
 * `/learn` the first lesson's button sat at y=1682 on a first visit. The home page's "Start with
 * the foundations" sent them to that same index rather than to a foundation.
 *
 * ## Why reading order and not the index's numbering
 *
 * The index numbers its cards in DISPLAY order, grouped by topic, and display order is not a
 * sequence a learner can follow: measured over the shipped content it numbers `bet-sizing` 11
 * and `fold-equity` 13, though `bet-sizing` declares `fold-equity` a prerequisite. A "Next" link that
 * followed the numbering would walk a reader straight past a lesson they were told to read first.
 * `lessonsInReadingOrder()` is the order the content package defines as "front to back", and the
 * lesson page already enumerates its static params from it, so every "next" it names is a page
 * that exists.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lessonsInReadingOrder } from '@prl/content';
import { TOPICS } from '@prl/contracts';
import { firstLesson, LESSON_TITLE_ID, lessonOutline, nextLesson } from '../src/lib/learn-curriculum.ts';

const ORDER = lessonsInReadingOrder();

describe('the next lesson', () => {
  it('reads a non-empty curriculum', () => {
    // A sweep of nothing is not a pass.
    assert.ok(ORDER.length > 1, 'there are lessons to step between');
  });

  it('is the following lesson in reading order, for every lesson but the last', () => {
    for (const [index, lesson] of ORDER.entries()) {
      const expected = ORDER[index + 1];
      const next = nextLesson(ORDER, lesson.id);
      if (expected === undefined) {
        assert.equal(next, null, `${lesson.id} is the last lesson and has no next`);
      } else {
        assert.equal(next?.id, expected.id, `after ${lesson.id}`);
        assert.equal(next?.title, expected.title);
      }
    }
  });

  it('never names a lesson before one of its own prerequisites has been passed', () => {
    const passed = new Set<string>();
    let current = firstLesson(ORDER);
    while (current !== null) {
      const lesson = ORDER.find((candidate) => candidate.id === current?.id);
      assert.ok(lesson !== undefined);
      for (const prerequisite of lesson.prerequisites) {
        assert.ok(passed.has(prerequisite), `${lesson.id} reached before its prerequisite ${prerequisite}`);
      }
      passed.add(lesson.id);
      current = nextLesson(ORDER, lesson.id);
    }
    assert.equal(passed.size, ORDER.length, 'following "Next" from the first lesson visits every lesson');
  });

  it('is not the index numbering, which would skip a prerequisite', () => {
    // The control for the test above: walking DISPLAY order does break a prerequisite, so the
    // assertion above is distinguishing something rather than passing over any order at all.
    const display = TOPICS.flatMap((topic) => ORDER.filter((lesson) => lesson.topic === topic));
    const passed = new Set<string>();
    const broken = display.filter((lesson) => {
      const missing = lesson.prerequisites.some((prerequisite) => !passed.has(prerequisite));
      passed.add(lesson.id);
      return missing;
    });
    assert.ok(broken.length > 0, 'display order skips at least one prerequisite');
  });

  it('is null for an id that is not in the list', () => {
    assert.equal(nextLesson(ORDER, 'not-a-lesson'), null);
    assert.equal(nextLesson([], 'hand-flow'), null);
  });

  it('starts the curriculum at the first lesson in reading order', () => {
    assert.equal(firstLesson(ORDER)?.id, ORDER[0]?.id);
    assert.equal(firstLesson([]), null);
  });
});

describe('the lesson title anchor', () => {
  it('is never also the id of a section heading', () => {
    // "Re-read" points at `#${LESSON_TITLE_ID}`. A heading that slugged to the same text would
    // make two elements with one id, and the link would land on whichever the browser found first.
    const outline = lessonOutline([{ kind: 'heading', text: LESSON_TITLE_ID.replace(/-/g, ' ') }]);
    assert.notEqual(outline.headings[0]?.id, LESSON_TITLE_ID);
  });
});

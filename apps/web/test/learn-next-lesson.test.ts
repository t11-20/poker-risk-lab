/**
 * Where a lesson's "Next" step goes, and where the home page's "Start with the foundations" goes.
 * Next follows `lessonsInReadingOrder()`, which the lesson page also enumerates its static params
 * from, so every "next" is a page that exists. The old topic-grouped order numbered `bet-sizing`
 * before its prerequisite `fold-equity` (`learn-index-reading-order.test.ts` holds the index to it).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lessonsInReadingOrder } from '@prl/content';
import { TOPICS } from '@prl/contracts';
import {
  firstLesson,
  LESSON_TITLE_ID,
  lessonOutline,
  nextLesson,
  nextLessonStep,
} from '../src/lib/learn-curriculum.ts';

const ORDER = lessonsInReadingOrder();

describe('the next lesson', () => {
  it('reads a non-empty curriculum', () => {
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

  it('is not the old topic-grouped numbering, which would skip a prerequisite', () => {
    // The control for the test above. Walking DISPLAY order does break a prerequisite.
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
    // "Re-read" points at `#${LESSON_TITLE_ID}`; a heading with the same slug would make two elements one id.
    const outline = lessonOutline([{ kind: 'heading', text: LESSON_TITLE_ID.replace(/-/g, ' ') }]);
    assert.notEqual(outline.headings[0]?.id, LESSON_TITLE_ID);
  });
});

describe('nextLessonStep: Next never promises a lesson this page cannot show (REGRESSION)', () => {
  // Offline the page has eight bodies, and reading order puts an unbundled lesson right after `hand-flow`.
  const [first, second] = ORDER;
  assert.ok(first !== undefined && second !== undefined, 'reading order has at least two lessons');
  const next = nextLesson(ORDER, first.id);

  it('links to the next lesson when every lesson is readable', () => {
    assert.deepEqual(nextLessonStep(next, null), { kind: 'link', id: second.id, title: second.title });
  });

  it('names the next lesson as unavailable, rather than linking it, when it is not in the readable set', () => {
    assert.deepEqual(nextLessonStep(next, [first.id]), { kind: 'unavailable', title: second.title });
  });

  it('links when the next lesson is in the readable set', () => {
    assert.deepEqual(nextLessonStep(next, [first.id, second.id]), {
      kind: 'link',
      id: second.id,
      title: second.title,
    });
  });

  it('has nothing after the last lesson', () => {
    assert.equal(nextLessonStep(null, [first.id]), null);
  });
});

/**
 * `/learn` must not warn a reader off a lesson that works, or claim to know what they have read.
 * `READABLE_LESSON_IDS` describes the offline bundle only, and without a session `completed` is false.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ContentId, LessonSummary } from '@prl/contracts';
import { buildCurriculum } from '../src/lib/learn-curriculum.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

const lesson = (id: string, overrides: Partial<LessonSummary> = {}): LessonSummary => ({
  id: id as ContentId,
  title: `Lesson ${id}`,
  summary: 'A summary.',
  topic: 'rules-and-flow',
  difficulty: 'intro',
  estimatedMinutes: 5,
  prerequisites: [],
  completed: false,
  ...overrides,
});

/** Three lessons in a chain, which is the shape that produces the "read first" note. */
const SUMMARIES: readonly LessonSummary[] = [
  lesson('one'),
  lesson('two', { prerequisites: ['one' as ContentId] }),
  lesson('three', { prerequisites: ['one' as ContentId, 'two' as ContentId], difficulty: 'core' }),
];

describe('with completion unknown, the index makes no claim about the reader', () => {
  const curriculum = buildCurriculum(SUMMARIES, { completionKnown: false });

  it('never reports a prerequisite as unread', () => {
    for (const entry of curriculum.entries) {
      assert.notEqual(
        entry.unlocked,
        false,
        `Lesson ${entry.summary.id} is reported as having unread prerequisites, but nobody asked the ` +
          'API who this reader is. `false` on the wire means "we did not ask", and printing it as ' +
          '"not marked read" is what warned readers off sixteen of seventeen cards.',
      );
      assert.equal(entry.unlocked, null, 'The third state has to be reachable, not just permitted.');
      assert.deepEqual(
        entry.outstandingPrerequisites,
        [],
        'There is nothing truthful to list, so the list must be empty rather than "all of them".',
      );
    }
  });

  it('never reports a lesson as read', () => {
    for (const entry of curriculum.entries) {
      assert.equal(
        entry.completed,
        null,
        'A "read" tick for a reader nobody looked up is the same lie in the other direction.',
      );
    }
  });

  it('suggests the first lesson in the syllabus, and says so through completionKnown', () => {
    assert.equal(curriculum.startHere?.summary.id, 'one');
    assert.equal(curriculum.startHere?.position, 1);
    // The screen words the panel from this, as "where the syllabus starts" rather than "not yet read".
    assert.equal(curriculum.completionKnown, false);
  });

  it('still leaves every lesson readable when no fixture coverage was declared', () => {
    // `readableIds` describes the OFFLINE bundle. Omitted, nothing is marked unreadable.
    for (const entry of curriculum.entries) assert.equal(entry.readable, true);
  });
});

describe('with completion known, the index still says everything it used to', () => {
  const summaries = [
    lesson('one', { completed: true }),
    lesson('two', { prerequisites: ['one' as ContentId], completed: false }),
    lesson('three', { prerequisites: ['one' as ContentId, 'two' as ContentId], completed: false }),
  ];
  const curriculum = buildCurriculum(summaries, { completionKnown: true });

  it('marks what was read and names what is outstanding', () => {
    const [first, second, third] = curriculum.entries;
    assert.equal(first?.completed, true);
    assert.equal(first?.unlocked, true);
    assert.equal(second?.unlocked, true, 'Its only prerequisite is read.');
    assert.equal(third?.unlocked, false, '"two" is not read.');
    assert.deepEqual(
      third?.outstandingPrerequisites.map((summary) => summary.id),
      ['two'],
    );
  });

  it('points at the earliest unread lesson whose prerequisites are met', () => {
    assert.equal(curriculum.startHere?.summary.id, 'two');
    assert.equal(curriculum.completionKnown, true);
  });

  it('reports null once everything is read', () => {
    const done = buildCurriculum(
      summaries.map((summary) => ({ ...summary, completed: true })),
      { completionKnown: true },
    );
    assert.equal(done.startHere, null);
  });
});

describe('the fixture-coverage note only appears when the index IS the fixture', () => {
  const page = read('app', 'learn', 'page.tsx');

  it('passes readableIds only for a fixture-sourced list', () => {
    assert.match(
      page,
      /\.\.\.\(lessons\.source === 'fixture' \? \{ readableIds: READABLE_LESSON_IDS \} : \{\}\)/u,
      'READABLE_LESSON_IDS is derived from the offline bundle and describes it. Passed alongside a ' +
        'live list it marks nine working lessons as unavailable.',
    );
  });

  it('no longer blames the content service for a gap in the bundle', () => {
    assert.doesNotMatch(
      page,
      /text comes from the content service, which is not reachable/u,
      'That sentence was printed on nine cards while the content service was serving all seventeen ' +
        'lessons. Say which of the two is actually missing.',
    );
    assert.match(page, /the bundled copy of the curriculum does not carry this\s*\n?\s*lesson's text/u);
  });
});

describe('the index and its loader cannot drift apart', () => {
  const page = read('app', 'learn', 'page.tsx');
  const loader = read('lib', 'learn-data.ts');

  const loadLessonList = /export async function loadLessonList\(\)[\s\S]*?\n\}/u.exec(loader)?.[0] ?? '';

  it('finds the loader, so this check cannot pass by failing to look', () => {
    assert.ok(
      loadLessonList.includes('API_PATHS.lessons()'),
      'Could not locate loadLessonList in src/lib/learn-data.ts. This test exists to keep the index ' +
        'and its loader in step; if the loader has moved or been renamed, point this at the new one ' +
        'rather than removing the check.',
    );
  });

  it('claims completion is known if and only if the loader identifies the reader', () => {
    // `readerCallOptions()` (src/lib/server-session.ts) is how a server render carries the reader's session.
    const perReader = /readerCallOptions|cookie:/u.test(loadLessonList);
    const hardcodedUnknown = /completionKnown:\s*false/u.test(page);
    const usesCookie = /reader\.cookie|readerCallOptions/u.test(page);
    assert.equal(perReader, true, 'loadLessonList must forward the reader so /learn can show their ticks.');
    assert.equal(
      hardcodedUnknown,
      false,
      'Do not hard-code completionKnown: false now that the loader identifies the reader.',
    );
    assert.equal(
      usesCookie,
      true,
      'completionKnown must follow whether a session cookie was actually forwarded, not a constant true.',
    );
  });

  it('tells the reader what the index does not know, rather than saying nothing', () => {
    // Deleting the claims would also pass this file, and leave a reader wondering why nothing is ticked.
    assert.match(page, /it does not know which lessons you have already\s*\n?\s*finished/u);
    assert.match(page, /your record/u);
  });
});

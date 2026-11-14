/**
 * The number on a lesson card is the step "Next" takes it to, and the card is the target. Next follows
 * `lessonsInReadingOrder()`, and `learn-next-lesson.test.ts` shows the old topic order skips a
 * prerequisite, so the index is numbered by reading order. Tap targets are held as stylesheet rules,
 * because `test:layout` measures glyphs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lessons, lessonsInReadingOrder } from '@prl/content';
import type { ContentId, LessonSummary } from '@prl/contracts';
import { LEARN_LESSON_SUMMARIES } from '../src/fixtures/learn-lesson-summaries.ts';
import {
  buildCurriculum,
  type CurriculumEntry,
  nextLesson,
  startHereNote,
} from '../src/lib/learn-curriculum.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

const READING = lessonsInReadingOrder();

/** The content package's lessons as the index receives them, in the package's FILE order. */
const FROM_FILES: readonly LessonSummary[] = lessons().map((lesson) => ({
  id: lesson.id,
  title: lesson.title,
  summary: lesson.summary,
  topic: lesson.topic,
  difficulty: lesson.difficulty,
  estimatedMinutes: lesson.estimatedMinutes,
  prerequisites: lesson.prerequisites,
  completed: false,
}));

function present<T>(value: T | null | undefined, what: string): T {
  assert.ok(value !== null && value !== undefined, what);
  return value;
}

describe('the index is numbered in reading order', () => {
  it('reads a non-empty curriculum', () => {
    assert.ok(READING.length > 10, 'the content package carries the curriculum');
    assert.equal(FROM_FILES.length, READING.length);
  });

  // File order (a cold build), reading order (the API, via `routes/content.ts`), and the offline fixture.
  const inputs: readonly (readonly [string, readonly LessonSummary[]])[] = [
    ['the content package in file order', FROM_FILES],
    [
      'the API list, already in reading order',
      READING.map((lesson) =>
        present(
          FROM_FILES.find((one) => one.id === lesson.id),
          lesson.id,
        ),
      ),
    ],
    ['the offline fixture', LEARN_LESSON_SUMMARIES],
  ];

  for (const [name, summaries] of inputs) {
    describe(name, () => {
      const curriculum = buildCurriculum(summaries, { completionKnown: false });

      it('is the reading order, numbered 1, 2, 3 down the page', () => {
        assert.deepEqual(
          curriculum.entries.map((entry) => entry.summary.id),
          READING.map((lesson) => lesson.id),
          'the cards must be in the order "Next" walks',
        );
        curriculum.entries.forEach((entry, index) => {
          assert.equal(entry.position, index + 1, `${entry.summary.id} is numbered ${entry.position}`);
        });
      });

      it('opens the next number from every lesson’s Next', () => {
        const byId = new Map<ContentId, CurriculumEntry>(
          curriculum.entries.map((entry) => [entry.summary.id, entry]),
        );
        for (const entry of curriculum.entries) {
          const next = nextLesson(READING, entry.summary.id);
          if (next === null) {
            assert.equal(entry.position, curriculum.entries.length, `${entry.summary.id} is the last lesson`);
            continue;
          }
          assert.equal(
            byId.get(next.id)?.position,
            entry.position + 1,
            `Lesson ${entry.position} (${entry.summary.id}) sends its reader to ${next.id}`,
          );
        }
      });

      it('lays the groups end to end, so the headings never reorder the cards', () => {
        assert.deepEqual(
          curriculum.groups.flatMap((group) => group.entries.map((entry) => entry.position)),
          curriculum.entries.map((entry) => entry.position),
        );
        assert.ok(curriculum.groups.length > 1, 'the curriculum has more than one heading');
        assert.equal(new Set(curriculum.groups.map((group) => group.key)).size, curriculum.groups.length);
      });

      it('still counts topics, which are no longer the groups', () => {
        assert.equal(curriculum.topicCount, new Set(summaries.map((summary) => summary.topic)).size);
      });
    });
  }
});

describe('"Start here" over a lesson with no prerequisites', () => {
  const summary = (id: string, prerequisites: readonly string[], completed: boolean): LessonSummary => ({
    id: id as ContentId,
    title: id,
    summary: '',
    topic: 'rules-and-flow',
    difficulty: 'intro',
    estimatedMinutes: 5,
    prerequisites: prerequisites as ContentId[],
    completed,
  });

  it('does not claim its (absent) prerequisites are marked read', () => {
    const fresh = buildCurriculum([summary('one', [], false), summary('two', ['one'], false)], {
      completionKnown: true,
    });
    assert.equal(fresh.startHere?.summary.id, 'one');
    const note = startHereNote(present(fresh.startHere, 'a start'));
    assert.doesNotMatch(note, /already marked read/u);
    assert.match(note, /assumes nothing/u);
  });

  it('still says so when the prerequisites exist and are read', () => {
    const halfway = buildCurriculum([summary('one', [], true), summary('two', ['one'], false)], {
      completionKnown: true,
    });
    assert.equal(halfway.startHere?.summary.id, 'two');
    assert.match(
      startHereNote(present(halfway.startHere, 'a start')),
      /Everything this lesson assumes is already marked read/u,
    );
  });

  it('makes no claim about a reader nobody identified', () => {
    const unknown = buildCurriculum([summary('one', [], false)], { completionKnown: false });
    const note = startHereNote(present(unknown.startHere, 'a start'));
    assert.match(note, /no way to know/u);
    assert.doesNotMatch(note, /marked read/u);
  });

  it('is the sentence the page prints', () => {
    assert.match(read('app', 'learn', 'page.tsx'), /\{startHereNote\(start\)\}/u);
  });
});

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, 'u').exec(css);
  assert.ok(match !== null, `no rule for ${selector}`);
  return match[1] ?? '';
}

describe('tap targets (Minor 1)', () => {
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, '');
  const learnCss = strip(read('styles', 'learn.css'));
  const labCss = strip(read('styles', 'lab.css'));

  it('makes the whole lesson card the link’s target, as the Lab’s cards are', () => {
    assert.match(rule(learnCss, '.prl-learn-entry'), /position: relative;/u);
    const after = rule(learnCss, '.prl-learn-entry__link::after');
    assert.match(after, /position: absolute;/u);
    assert.match(after, /inset: 0;/u);
  });

  it('keeps the prerequisite links tappable above that overlay', () => {
    const lifted = rule(learnCss, '.prl-learn-entry__prereq-link');
    assert.match(lifted, /position: relative;/u);
    assert.match(lifted, /z-index: 1;/u);
  });

  it('gives every standalone link the 44px floor', () => {
    const floor = rule(
      learnCss,
      '.prl-learn-entry__prereq-link,\n.prl-learn-lesson__prereq a,\n.prl-learn-lesson__back,\n.prl-learn-terms__list a',
    );
    assert.match(floor, /min-block-size: var\(--prl-target-min\);/u);
    assert.match(floor, /display: inline-flex;/u);
    assert.match(rule(labCss, '.prl-lab-start-link'), /min-block-size: var\(--prl-target-min\);/u);
    assert.match(read('app', 'lab', 'page.tsx'), /className="prl-lab-start-link"/u);
  });

  it('does not touch links inside lesson prose', () => {
    // A link in a paragraph that grew to 44px would push its line apart from the lines around it.
    assert.doesNotMatch(learnCss, /\.prl-prose a[^{]*\{[^}]*min-block-size/u);
  });
});

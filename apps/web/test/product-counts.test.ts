/**
 * The counts the product prints about itself, checked against `contentStats()` and the bundle. They
 * are hand-typed literals in `.tsx` (read as text, because `node --test` cannot load `.tsx`), and
 * `docs/VERIFICATION.md` §9 once said 80 quiz questions where the bundle had 81. Prose is pinned in
 * `honesty-claims.test.ts`. Every phrase must be found, so a reworded page fails rather than going quiet.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { content, contentStats } from '@prl/content';
import { LEARN_GLOSSARY } from '../src/fixtures/learn-glossary.ts';
import { LEARN_LESSON_SUMMARIES } from '../src/fixtures/learn-lesson-summaries.ts';
import { LEARN_LESSONS } from '../src/fixtures/learn-lessons.ts';
import { LEARN_QUIZZES } from '../src/fixtures/learn-quizzes.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

const HOME = read('app', 'page.tsx');
const LEARN = read('app', 'learn', 'page.tsx');
// The evidence list and its counts moved off the home page to `/checks` in the 4.0 re-identity.
const CHECKS = read('lib', 'checks.ts');

interface StatedCount {
  readonly phrase: (n: number) => string;
  readonly page: string;
  readonly where: string;
  /** The figure, derived and never copied off the page. */
  readonly computed: () => number;
}

const stats = contentStats();
const bundle = content();

const STATED_COUNTS: readonly StatedCount[] = [
  {
    where: 'home page — lessons and topics',
    page: HOME,
    phrase: (n) => `${n} lessons across`,
    computed: () => stats.lessons,
  },
  {
    // The topics the lessons span. `topicsCovered` also counts the Lab's scenarios, which gave 11
    // beside a /learn index showing 10.
    where: 'home page — topics the lessons cover',
    page: HOME,
    phrase: (n) => `lessons across ${n} topics`,
    computed: () => new Set(bundle.lessons.map((lesson) => lesson.topic)).size,
  },
  {
    where: 'home page — glossary size',
    page: HOME,
    phrase: (n) => `A glossary of ${n} terms`,
    computed: () => stats.glossaryTerms,
  },
  {
    where: 'home page — scenario count',
    page: HOME,
    phrase: (n) => `${n} scenarios, each carrying a claim`,
    computed: () => stats.scenarios,
  },
  {
    where: '/checks — every scenario carries a claim',
    page: CHECKS,
    phrase: (n) => `All ${n} scenarios carry qualitative claims`,
    computed: () => {
      const carrying = bundle.scenarios.filter((one) => one.expectedInsight.length > 0).length;
      assert.equal(carrying, stats.scenarios, 'the sentence is only true if every scenario carries one');
      return carrying;
    },
  },
  {
    where: '/checks — how many claims in total',
    page: CHECKS,
    phrase: (n) => `qualitative claims — ${n} of them`,
    computed: () => bundle.scenarios.reduce((sum, one) => sum + one.expectedInsight.length, 0),
  },
];

const SPELLED_OUT: readonly {
  readonly where: string;
  readonly word: string;
  readonly computed: () => number;
}[] = [
  { where: 'learn index — lessons', word: 'Seventeen lessons', computed: () => stats.lessons },
  { where: 'learn index — glossary', word: 'Ninety terms', computed: () => stats.glossaryTerms },
];

const WORDS: Readonly<Record<number, string>> = { 17: 'Seventeen', 36: 'Thirty-six', 90: 'Ninety' };

describe('the counts the product prints about itself', () => {
  it('match the bundle it actually ships', () => {
    const problems: string[] = [];
    for (const stated of STATED_COUNTS) {
      const expected = stated.phrase(stated.computed());
      if (!stated.page.includes(expected)) {
        problems.push(
          `${stated.where}: the bundle supports "${expected}" and the page does not say it. ` +
            'Either the figure on the page is now false, or the sentence was reworded and this ' +
            'check went blind — both need a human.',
        );
      }
    }
    assert.deepEqual(
      problems,
      [],
      `product counts that no longer match the bundle:\n  - ${problems.join('\n  - ')}`,
    );
    assert.ok(STATED_COUNTS.length >= 6, 'the registry must cover the counts the page actually prints');
  });

  it('match it where the page spells them out in words', () => {
    for (const stated of SPELLED_OUT) {
      const value = stated.computed();
      const word = WORDS[value];
      assert.ok(word !== undefined, `no spelling for ${value} — add one rather than dropping the check`);
      assert.ok(
        stated.word.startsWith(word),
        `${stated.where}: the bundle has ${value} (${word}) and the page says "${stated.word}"`,
      );
      assert.ok(LEARN.includes(stated.word), `${stated.where}: "${stated.word}" is no longer on the page`);
    }
  });

  it('the lesson-summary fixture still says what the lessons say (REGRESSION)', () => {
    // `generateMetadata` serves these copied titles when the API is unreachable, so a retitled lesson
    // would keep its old tab title for as long as the API was down.
    const byId = new Map(bundle.lessons.map((lesson) => [lesson.id, lesson]));
    assert.equal(
      LEARN_LESSON_SUMMARIES.length,
      bundle.lessons.length,
      'the fixture and the bundle no longer describe the same number of lessons',
    );
    let compared = 0;
    for (const summary of LEARN_LESSON_SUMMARIES) {
      const real = byId.get(summary.id);
      assert.ok(real !== undefined, `${summary.id} is in the fixture and not in the content bundle`);
      assert.equal(summary.title, real.title, `${summary.id}: the fixture's title is stale`);
      assert.equal(summary.summary, real.summary, `${summary.id}: the fixture's summary is stale`);
      compared += 2;
    }
    assert.ok(compared >= 30, `only ${compared} field(s) compared; a sweep of nothing is not a pass`);
  });

  /**
   * The other three fixtures (glossary, lesson bodies, quizzes) copied from `packages/content/data`.
   * On 2026-08-27 a corrected glossary definition landed in content and not in the fixture, and
   * `fixtures:check` passed, because it covers only scenario analysis. Definitions and question text
   * are compared, because an id-only join would have passed that drift.
   */
  it('the glossary fixture still says what the content package says (REGRESSION)', () => {
    const byId = new Map(bundle.glossary.map((entry) => [entry.id, entry]));
    assert.equal(LEARN_GLOSSARY.length, bundle.glossary.length, 'the fixture lost or gained entries');
    let compared = 0;
    for (const entry of LEARN_GLOSSARY) {
      const real = byId.get(entry.id);
      assert.ok(real !== undefined, `${entry.id} is in the fixture and not in the content bundle`);
      assert.equal(entry.term, real.term, `${entry.id}: the fixture's term is stale`);
      assert.equal(entry.definition, real.definition, `${entry.id}: the fixture's definition is stale`);
      compared += 2;
    }
    assert.ok(compared >= 150, `only ${compared} field(s) compared; a sweep of nothing is not a pass`);
  });

  it('the lesson fixture still says what the content package says (REGRESSION)', () => {
    // A subset of eight, chosen to exercise every `LessonBlock` variant, so the count is pinned
    // instead of matched.
    const byId = new Map(bundle.lessons.map((lesson) => [lesson.id, lesson]));
    assert.equal(LEARN_LESSONS.length, 8, 'the fixture no longer carries the eight lessons it documents');
    let compared = 0;
    for (const lesson of LEARN_LESSONS) {
      const real = byId.get(lesson.id);
      assert.ok(real !== undefined, `${lesson.id} is in the fixture and not in the content bundle`);
      assert.equal(lesson.title, real.title, `${lesson.id}: the fixture's title is stale`);
      assert.equal(lesson.summary, real.summary, `${lesson.id}: the fixture's summary is stale`);
      assert.deepEqual(
        lesson.keyTakeaways,
        real.keyTakeaways,
        `${lesson.id}: the fixture's key takeaways are stale`,
      );
      compared += 3;
      // `counting-outs` ends with an authored `scenarioLink` block, because no content lesson uses
      // that variant yet. Its other blocks are still joined.
      if (lesson.id === 'counting-outs') {
        assert.deepEqual(
          lesson.blocks.slice(0, real.blocks.length),
          real.blocks,
          `${lesson.id}: the fixture's blocks are stale ahead of its authored scenarioLink`,
        );
        assert.equal(
          lesson.blocks.at(-1)?.kind,
          'scenarioLink',
          'the documented counting-outs exception is gone; join its blocks like the others',
        );
      } else {
        assert.deepEqual(lesson.blocks, real.blocks, `${lesson.id}: the fixture's blocks are stale`);
      }
      compared += 1;
    }
    assert.ok(compared >= 30, `only ${compared} field(s) compared; a sweep of nothing is not a pass`);
  });

  it('the quiz fixture still says what the content package says, answers included (REGRESSION)', () => {
    // A drifted `correctIndex` would mark a student wrong for a right answer on the offline path.
    // A subset of eight, like the lessons.
    const byId = new Map(bundle.quizzes.map((quiz) => [quiz.id, quiz]));
    assert.equal(LEARN_QUIZZES.length, 8, 'the fixture no longer carries the eight quizzes it documents');
    let compared = 0;
    for (const quiz of LEARN_QUIZZES) {
      const real = byId.get(quiz.id);
      assert.ok(real !== undefined, `${quiz.id} is in the fixture and not in the content bundle`);
      assert.deepEqual(quiz.questions, real.questions, `${quiz.id}: the fixture's questions are stale`);
      compared += 1;
    }
    assert.ok(compared >= 8, `only ${compared} quiz(zes) compared; a sweep of nothing is not a pass`);
  });

  it('does not let the quiz-question count drift the way the verification record did', () => {
    // Not printed on a page. Asserted because it is the figure that actually drifted.
    const counted = bundle.quizzes.reduce((sum, quiz) => sum + quiz.questions.length, 0);
    assert.equal(counted, stats.quizQuestions, 'contentStats must agree with the bundle it counted');
    assert.ok(counted > 0, 'a sweep of nothing is not a pass');
  });
});

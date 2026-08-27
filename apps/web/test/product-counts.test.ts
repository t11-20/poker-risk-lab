/**
 * The counts the product prints about itself, checked against the content it ships.
 *
 * The home page tells a prospective student "17 lessons across 11 topics", "A glossary of 90
 * terms", "36 scenarios, each carrying a claim the maths re-checks on every build", "All 36
 * scenarios carry qualitative claims — 74 of them". The curriculum index spells two of the
 * same figures out in words. Every one of those is a factual claim about the bundle, every
 * one is a hand-typed literal in a `.tsx` file, and none of them was checked by anything.
 *
 * This is not hypothetical drift. `docs/VERIFICATION.md` §9 said "17 quizzes (80 questions)"
 * where `contentStats()` says **81** — a figure printed by every run of the content suite,
 * carried forward by hand for long enough to be wrong. A number nobody re-derives goes stale
 * on the first content change, and on a marketing surface it goes stale in the direction that
 * flatters: content gets added far more often than it gets removed.
 *
 * ## What this asserts and what it deliberately does not
 *
 * Only the counts, and only against `contentStats()` and the bundle itself. It has no opinion
 * on the prose around them — `honesty-claims.test.ts` is where unqualified claims are pinned —
 * and it makes no claim about the engine figures on the same page (133,784,560 seven-card
 * hands and the 200,000/20,000 ordering samples), which `test:exhaustive` and
 * `packages/poker-engine/test/evaluate.test.ts` reproduce directly.
 *
 * The pages are read as TEXT: they are `.tsx`, which `node --test` cannot load, and
 * `honesty-claims.test.ts` reads the same files the same way for the same reason.
 *
 * **A sweep of nothing is not a pass.** Every phrase below must be found, and finding none of
 * them fails as loudly as finding a wrong one — a page reworded past this check is exactly how
 * it would go quiet.
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

interface StatedCount {
  /** The sentence the page shows, with the figure in it. */
  readonly phrase: (n: number) => string;
  /** The page it must appear in. */
  readonly page: string;
  readonly where: string;
  /** The figure, DERIVED — never a literal copied off the page. */
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
    where: 'home page — topics covered',
    page: HOME,
    phrase: (n) => `lessons across ${n} topics`,
    computed: () => stats.topicsCovered,
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
    where: 'home page — every scenario carries a claim',
    page: HOME,
    phrase: (n) => `All ${n} scenarios carry qualitative claims`,
    computed: () => {
      const carrying = bundle.scenarios.filter((one) => one.expectedInsight.length > 0).length;
      assert.equal(carrying, stats.scenarios, 'the sentence is only true if every scenario carries one');
      return carrying;
    },
  },
  {
    where: 'home page — how many claims in total',
    page: HOME,
    phrase: (n) => `qualitative claims — ${n} of them`,
    computed: () => bundle.scenarios.reduce((sum, one) => sum + one.expectedInsight.length, 0),
  },
];

/** The two figures the curriculum index spells out in words rather than digits. */
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
    // `LEARN_LESSON_SUMMARIES` copies all seventeen lesson titles and summaries out of
    // `@prl/content`, and `app/learn/[lessonId]/page.tsx` serves them from `generateMetadata` when
    // `loadLesson` returns null — the path taken when the API is unreachable. Nothing joined the
    // two, so a lesson retitled in the content package would keep its old title in the tab and the
    // link preview for exactly as long as the API stayed down, which is the moment somebody is
    // most likely to be looking.
    //
    // Measured 2026-08-27: no drift today. This is the guard, not the fix — the same shape as the
    // Legends trait numbers, which were also copied, also undrifted, and also joined by nothing.
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
   * The other three fixtures, joined for the first time.
   *
   * `learn.ts`'s own header says what these are: "roughly 140 KB of teaching prose copied verbatim
   * from `packages/content/data`", split across four modules. One of the four — the lesson
   * summaries, above — was joined on this branch. The other three were not, and they carry the
   * material a fee is actually charged for: every definition, every lesson body, every quiz
   * question and its marked answer.
   *
   * This is not hypothetical drift. It was MEASURED on 2026-08-27, by causing it: a correction to
   * the `under-the-gun` definition in `packages/content/data/glossary.json` — it taught that UTG
   * is worst "on this street and on every street after it", when postflop the blinds act first,
   * which is the answer `position-q2` marks CORRECT — landed in the content package and not in the
   * fixture. `pnpm run fixtures:regenerate` reported "already the analysis the engine produces
   * today" and `fixtures:check` passed, because that script covers scenario analysis and has never
   * read these files. The web app serves these fixtures from `generateMetadata` and wherever the
   * API is unreachable, so the corrected glossary would have shipped while the fallback kept
   * teaching the error, and every gate would have stayed green.
   *
   * Definitions and question text are compared, not just ids and titles: an id-only join would
   * have passed the very drift that prompted this.
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
    // A SUBSET, deliberately: the fixture's header says eight of the seventeen, chosen so that
    // between them they exercise every `LessonBlock` variant. So this joins what is there and does
    // not assert the counts match — but it does assert the subset is non-empty and still eight, so
    // a fixture emptied by a bad edit cannot pass as "nothing to compare".
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
      // The one documented exception, named rather than skipped silently: `counting-outs` ends
      // with an authored `scenarioLink` block because no lesson in `packages/content` uses that
      // variant yet and `LessonBlockRenderer` has to handle it. Its other blocks are still joined.
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
    // The marked answer is the field that matters most here. A quiz whose `correctIndex` drifted
    // would mark a student wrong for a right answer, on the offline path, with nothing to notice.
    // A subset, like the lessons: eight of the seventeen. Non-emptiness is asserted instead.
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
    // Not printed on a page — asserted here because it is the figure that actually drifted,
    // and because the content suite prints it on every run for anyone quoting it again.
    const counted = bundle.quizzes.reduce((sum, quiz) => sum + quiz.questions.length, 0);
    assert.equal(counted, stats.quizQuestions, 'contentStats must agree with the bundle it counted');
    assert.ok(counted > 0, 'a sweep of nothing is not a pass');
  });
});

/**
 * The Learn section's fixtures, which every Learn screen renders when the API is unavailable, and the
 * lookups the screens use to reach them. The exports are the `@prl/contracts` types the API sends, so
 * a fixture cannot be shaped for a component's convenience and hide a mismatch.
 *
 * The data lives in four sibling modules copied from `packages/content/data`. `@prl/content` is not
 * imported instead because it reads its JSON with `node:fs` and is deliberately server-only.
 */

import type {
  ContentId,
  GlossaryEntry,
  GlossaryResponse,
  Lesson,
  LessonListResponse,
  LessonResponse,
  LessonSummary,
  Quiz,
} from '@prl/contracts';
import { LEARN_GLOSSARY } from '@/fixtures/learn-glossary.ts';
import { LEARN_LESSON_SUMMARIES } from '@/fixtures/learn-lesson-summaries.ts';
import { LEARN_LESSONS } from '@/fixtures/learn-lessons.ts';
import { LEARN_QUIZZES } from '@/fixtures/learn-quizzes.ts';

export { LEARN_GLOSSARY, LEARN_LESSON_SUMMARIES, LEARN_LESSONS, LEARN_QUIZZES };

/** Built once at module scope, because a lesson page looks up its quiz and glossary terms on every render. */
const LESSONS_BY_ID: ReadonlyMap<ContentId, Lesson> = new Map(
  LEARN_LESSONS.map((lesson) => [lesson.id, lesson]),
);
const SUMMARIES_BY_ID: ReadonlyMap<ContentId, LessonSummary> = new Map(
  LEARN_LESSON_SUMMARIES.map((summary) => [summary.id, summary]),
);
const QUIZZES_BY_ID: ReadonlyMap<ContentId, Quiz> = new Map(LEARN_QUIZZES.map((quiz) => [quiz.id, quiz]));
const GLOSSARY_BY_ID: ReadonlyMap<ContentId, GlossaryEntry> = new Map(
  LEARN_GLOSSARY.map((entry) => [entry.id, entry]),
);

/** The curriculum index's payload: every lesson, whether or not its body is in the fixture. */
export const LEARN_LESSON_LIST_FIXTURE: LessonListResponse = { lessons: LEARN_LESSON_SUMMARIES };

export const LEARN_GLOSSARY_FIXTURE: GlossaryResponse = { entries: LEARN_GLOSSARY };

export function lessonSummaryFixture(id: ContentId): LessonSummary | null {
  return SUMMARIES_BY_ID.get(id) ?? null;
}

export function lessonFixture(id: ContentId): Lesson | null {
  return LESSONS_BY_ID.get(id) ?? null;
}

export function glossaryEntryFixture(id: ContentId): GlossaryEntry | null {
  return GLOSSARY_BY_ID.get(id) ?? null;
}

/**
 * The glossary entries a lesson names, in the order it names them, skipping any id with no entry: the
 * lesson stays readable and `packages/content/src/validate.ts` reports the missing reference.
 */
export function glossaryEntriesFixture(ids: readonly ContentId[]): readonly GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const id of ids) {
    const entry = GLOSSARY_BY_ID.get(id);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

/**
 * The quiz attached to a lesson: `lesson.quizId` first, then a quiz claiming the lesson through its own
 * `lessonId`, as `@prl/content`'s `quizForLesson` does, because the link is optional on both sides.
 */
export function quizFixtureForLesson(lessonId: ContentId): Quiz | null {
  const lesson = LESSONS_BY_ID.get(lessonId);
  if (lesson?.quizId !== undefined) return QUIZZES_BY_ID.get(lesson.quizId) ?? null;
  return LEARN_QUIZZES.find((quiz) => quiz.lessonId === lessonId) ?? null;
}

/** A whole `LessonResponse`, or `null`, a state the page must render, when this fixture has no body for it. */
export function lessonResponseFixture(id: ContentId): LessonResponse | null {
  const lesson = LESSONS_BY_ID.get(id);
  if (lesson === undefined) return null;
  return {
    lesson,
    quiz: quizFixtureForLesson(id),
    glossary: glossaryEntriesFixture(lesson.glossaryTerms),
  };
}

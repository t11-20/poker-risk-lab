/**
 * The Learn section's fixtures, and the lookups the screens use to reach them.
 *
 * ## Why the screens are built on fixtures at all
 *
 * `apps/api/src/routes/content.ts` does not exist yet — another team is writing it. Rather
 * than block, every Learn screen renders from a typed fixture whenever the API is
 * unavailable, and `src/lib/api.ts` falls back to these when a request fails. That is not
 * mock-driven development for its own sake: it is how the reading experience gets designed
 * and reviewed in parallel with the endpoint, and how a render check runs in CI with no
 * database.
 *
 * ## Typed against the wire contract, not against convenience
 *
 * The exports below are `LessonSummary`, `Lesson`, `Quiz` and `GlossaryEntry` from
 * `@prl/contracts` — the same types the API will send. So the day the endpoint lands, the
 * only thing that changes is where the object came from. A fixture shaped for the
 * component's convenience would have hidden exactly the mismatches this is meant to catch.
 *
 * ## Where the bulk lives
 *
 * The data is four sibling modules (`learn-lesson-summaries`, `learn-lessons`,
 * `learn-quizzes`, `learn-glossary`) because it is roughly 140 KB of teaching prose copied
 * verbatim from `packages/content/data`. Splitting it keeps this file readable as what it
 * actually is: the fixture *API*.
 *
 * `@prl/content` is not imported instead, even though it holds the same material, because
 * that package reads its JSON with `node:fs` and is deliberately server-only.
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

/**
 * Indexes built once at module scope.
 *
 * A lesson page looks up one lesson, its quiz and up to thirteen glossary entries. Doing that
 * with `Array.find` would be a linear scan per term against ninety entries, on every render of
 * every lesson. These maps are built once per process and the data never changes.
 */
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
 * The glossary entries a lesson names, in the order the lesson names them, skipping any id
 * with no entry.
 *
 * Skipping rather than throwing is deliberate: a lesson that mentions a term the glossary has
 * not caught up with should still be readable, and the missing cross-reference is a content
 * problem for `packages/content/src/validate.ts` to report, not a blank page for the learner.
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
 * The quiz attached to a lesson.
 *
 * Follows `lesson.quizId` first and falls back to a quiz that claims the lesson through its own
 * `lessonId`, exactly as `@prl/content`'s `quizForLesson` does. The two directions exist
 * because the link is optional on both sides of the contract.
 */
export function quizFixtureForLesson(lessonId: ContentId): Quiz | null {
  const lesson = LESSONS_BY_ID.get(lessonId);
  if (lesson?.quizId !== undefined) return QUIZZES_BY_ID.get(lesson.quizId) ?? null;
  return LEARN_QUIZZES.find((quiz) => quiz.lessonId === lessonId) ?? null;
}

/**
 * A whole `LessonResponse`, or `null` when this fixture has no body for that lesson.
 *
 * `null` is a real state the lesson page must render — eight of the seventeen lessons have
 * bodies here — and it is the same state the page will show for a lesson id that does not
 * exist at all once the API is live.
 */
export function lessonResponseFixture(id: ContentId): LessonResponse | null {
  const lesson = LESSONS_BY_ID.get(id);
  if (lesson === undefined) return null;
  return {
    lesson,
    quiz: quizFixtureForLesson(id),
    glossary: glossaryEntriesFixture(lesson.glossaryTerms),
  };
}

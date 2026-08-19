/**
 * Where the Learn screens get their content, and the paths they get it from.
 *
 * ## The fixture is a fallback, never a disguise
 *
 * Every loader tries the API and falls back to a typed fixture, returning **which of the two it
 * used** alongside the data. The screens render a visible notice when the source is `fixture`,
 * because a product whose subject is how much confidence a number deserves cannot itself present
 * sample data as live data. The source is part of the return type, so a screen cannot read the
 * content without having been handed its provenance next to it.
 *
 * It is also simply the normal case for now: `apps/api/src/routes/content.ts` is being written in
 * parallel with these screens, and CI renders them with no database.
 *
 * This mirrors `legends-data.ts` deliberately — same `…Data<T>` envelope, same `live`/`sampled`
 * helpers, same shared path table — so that two features written by two people behave the same way
 * when the API is down.
 *
 * ## The fallback is now narrow, and that is the point
 *
 * These loaders used to sample the fixture on *any* failure. They no longer do: only a condition
 * that means "there is no API" selects the fixture (see `isApiUnavailable`). A 404 on the lesson
 * index reaches the error boundary, because the index has no identifier that can be missing and a
 * 404 there can only mean this client asked for a path the API does not serve — which is what
 * happened for the whole build-out, invisibly, while every screen quietly rendered bundled copy.
 * A 404 on one lesson id is different and is handled as one: it is `null`, and the page turns it
 * into a not-found screen.
 *
 * ## What is NOT fetched
 *
 * Any figure. The API sends lessons, quizzes and glossary entries; it sends no computed number,
 * because the content contains none (ADR 0006). Every percentage on a Learn screen is computed
 * in the browser by `learn-calculations.ts`, which means these screens show real arithmetic even
 * when the content they are wrapped around came from a fixture.
 */

import type { ContentId, GlossaryResponse, LessonListResponse, LessonResponse } from '@prl/contracts';
import {
  LEARN_GLOSSARY_FIXTURE,
  LEARN_LESSON_LIST_FIXTURE,
  LEARN_LESSONS,
  lessonResponseFixture,
} from '@/fixtures/learn.ts';
import { API_PATHS, apiGet, isApiUnavailable, isMissingResource, safeFetch } from './api.ts';
import { readerCallOptions } from './server-session.ts';

export const LEARN_PATH = '/learn';
export const GLOSSARY_PATH = '/learn/glossary';

export function lessonHref(lessonId: ContentId): string {
  return `${LEARN_PATH}/${encodeURIComponent(lessonId)}`;
}

export type LearnDataSource = 'api' | 'fixture';

export interface LearnData<T> {
  readonly data: T;
  readonly source: LearnDataSource;
  /** One sentence a screen can show a reader. Null when the content is live. */
  readonly fallbackReason: string | null;
}

function live<T>(data: T): LearnData<T> {
  return { data, source: 'api', fallbackReason: null };
}

function sampled<T>(data: T, reason: string): LearnData<T> {
  return { data, source: 'fixture', fallbackReason: reason };
}

const LESSONS_FALLBACK =
  'The content service is not reachable, so this index is listing the bundled copy of the ' +
  'curriculum. The lessons and their prerequisites are real; the read/unread marks are not yours.';

const LESSON_FALLBACK =
  'The content service is not reachable, so this lesson is the bundled copy. Every figure in it ' +
  'is still computed here, from the maths package, exactly as it would be with the API up.';

const GLOSSARY_FALLBACK =
  'The content service is not reachable, so these definitions are the bundled copy of the ' + 'glossary.';

export async function loadLessonList(): Promise<LearnData<LessonListResponse>> {
  const options = await readerCallOptions();
  const result = await safeFetch<LessonListResponse>(() =>
    apiGet<LessonListResponse>(API_PATHS.lessons(), options),
  );
  if (result.ok) return live(result.data);
  if (!isApiUnavailable(result.error)) throw result.error;
  return sampled(LEARN_LESSON_LIST_FIXTURE, `${LESSONS_FALLBACK} (${result.error.message})`);
}

/**
 * One lesson, or `null` when neither source has it.
 *
 * `null` is what the page turns into a 404, and it now has two causes worth telling apart in the
 * code even though the reader sees the same screen: the API answered 404 for this id, or there is
 * no API and the bundled copy does not carry this lesson body either. The fixture carries eight of
 * the seventeen, so the second case is real whenever the content service is down.
 */
export async function loadLesson(lessonId: ContentId): Promise<LearnData<LessonResponse> | null> {
  const result = await safeFetch<LessonResponse>(() => apiGet<LessonResponse>(API_PATHS.lesson(lessonId)));
  if (result.ok) return live(result.data);
  // The reader supplied this id, so "there is no such lesson" is an answer rather than a fault.
  if (isMissingResource(result.error)) return null;
  if (!isApiUnavailable(result.error)) throw result.error;
  const fixture = lessonResponseFixture(lessonId);
  if (fixture === null) return null;
  return sampled(fixture, `${LESSON_FALLBACK} (${result.error.message})`);
}

export async function loadGlossary(): Promise<LearnData<GlossaryResponse>> {
  const result = await safeFetch<GlossaryResponse>(() => apiGet<GlossaryResponse>(API_PATHS.glossary()));
  if (result.ok) return live(result.data);
  if (!isApiUnavailable(result.error)) throw result.error;
  return sampled(LEARN_GLOSSARY_FIXTURE, `${GLOSSARY_FALLBACK} (${result.error.message})`);
}

/**
 * Which lesson bodies this build can render without the API.
 *
 * The index uses it to say so on the card rather than sending a reader to a page that has to
 * apologise. Derived from the fixture instead of being listed by hand, so adding a lesson body to
 * the fixture updates the index with no second edit.
 */
export const READABLE_LESSON_IDS: readonly ContentId[] = LEARN_LESSONS.map((lesson) => lesson.id);

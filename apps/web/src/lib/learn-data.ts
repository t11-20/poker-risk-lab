/**
 * Where the Learn screens get their content. Every loader tries the API and falls back to a typed
 * fixture, returning which source it used, so a screen showing sample data must say so.
 * Only "there is no API" (`isApiUnavailable`) selects the fixture. Any other failure throws, and a
 * 404 on one lesson id is `null`, a not-found page. No figure is fetched (ADR 0006), because
 * `learn-calculations.ts` computes them all.
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

/** `null` when the API answers 404, or when there is no API and the fixture (8 of 17) lacks the body. */
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

/** Derived from the fixture, so a new bundled body updates the index with no second edit. */
export const READABLE_LESSON_IDS: readonly ContentId[] = LEARN_LESSONS.map((lesson) => lesson.id);

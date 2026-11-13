/**
 * `/record`'s three lists as titles and topic names, not ids and slugs. Resolved against
 * `@prl/content`, the bundle the API also serves. An id the bundle lacks (a retired scenario) prints
 * as itself, unlinked. Server-only, because the whole bundle has no business in a client chunk.
 */

import { lessonById, scenarioById } from '@prl/content';
import type { ProgressResponse } from '@prl/contracts';
import { topicLabel } from './learn-curriculum.ts';

export interface RecordEntry {
  readonly label: string;
  /** Null when there is no page for it. */
  readonly href: string | null;
}

export interface RecordLists {
  readonly topics: readonly RecordEntry[];
  readonly lessons: readonly RecordEntry[];
  readonly scenarios: readonly RecordEntry[];
}

/** In the API's order, never re-sorted, because a reordered list reads as a ranking. */
export function recordLists(progress: ProgressResponse): RecordLists {
  return {
    // `/learn` carries no anchor per topic, so a topic is an unlinked name.
    topics: progress.topicsTouched.map((topic) => ({ label: topicLabel(topic), href: null })),
    lessons: progress.lessonsCompleted.map((id) => {
      const lesson = lessonById(id);
      // `lessonHref` in `lib/learn-data.ts`, spelled out because that module reads the session cookie.
      return lesson === null
        ? { label: id, href: null }
        : { label: lesson.title, href: `/learn/${encodeURIComponent(id)}` };
    }),
    scenarios: progress.scenariosAttempted.map((id) => {
      const scenario = scenarioById(id);
      return scenario === null
        ? { label: id, href: null }
        : { label: scenario.title, href: `/lab/${encodeURIComponent(id)}` };
    }),
  };
}

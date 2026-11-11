/**
 * `/record`'s three lists as a reader reads them: titles and topic names, not ids and slugs.
 *
 * ## The defect this replaces
 *
 * Measured by the audit at 308fadf on `/record` with a guest who had tried scenarios and finished a
 * lesson: "Scenarios tried" printed `eq-flush-draw-turn-small-bet`, "Topics touched" printed
 * `positions-and-blinds`, and neither list linked anywhere — the page that tells a learner what they
 * have done named it in the database's words and gave them no way back to any of it.
 *
 * ## Where the titles come from
 *
 * The content bundle this app was built with (`@prl/content`), not a second request. The API
 * derives `topicsTouched` from the same bundle (`apps/api/src/routes/progress.ts`) and serves
 * `content().scenarios` as the scenario list, so an id the record holds is an id in the bundle —
 * and `lib/lab-next.ts` already relies on that for "Next scenario". An id the bundle does NOT carry
 * (a retired scenario) is printed as itself and is not linked: there is no page to send anyone to,
 * which is the same answer the API gives when it drops a retired lesson's topic.
 *
 * Server-only: `@prl/content` is the whole bundle and has no business in a client chunk. That is
 * also why this is not in `record-data.ts`, which client components import for `RECORD_PATH`.
 */

import { lessonById, scenarioById } from '@prl/content';
import type { ProgressResponse } from '@prl/contracts';
import { topicLabel } from './learn-curriculum.ts';

export interface RecordEntry {
  /** What the reader sees. */
  readonly label: string;
  /** Where it goes, or null when there is no page for it. */
  readonly href: string | null;
}

export interface RecordLists {
  readonly topics: readonly RecordEntry[];
  readonly lessons: readonly RecordEntry[];
  readonly scenarios: readonly RecordEntry[];
}

/**
 * The record's lists, resolved against the bundle, in the order the API sent them.
 *
 * Not re-sorted by title: the API's order is the one the counts above were made from, and a list
 * that reorders itself by a property the reader did not choose reads as a ranking.
 */
export function recordLists(progress: ProgressResponse): RecordLists {
  return {
    // Topics have no page of their own — `/learn` groups by topic but carries no anchor per topic —
    // so a topic is a name, unlinked. The lessons and scenarios beside it are the links.
    topics: progress.topicsTouched.map((topic) => ({ label: topicLabel(topic), href: null })),
    lessons: progress.lessonsCompleted.map((id) => {
      const lesson = lessonById(id);
      // `/learn/<id>` is `lessonHref` in `lib/learn-data.ts`, spelled out because that module reads
      // the session cookie and cannot be imported where this one is tested.
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

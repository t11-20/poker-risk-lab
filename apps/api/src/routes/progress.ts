/**
 * `GET /me/progress`. Counts of what a learner has looked at, never a score.
 *
 * No rank, streak, level or percentage, by design (`docs/PRODUCT-GUARDRAILS.md`). The response type
 * has no field for one. `quizQuestionsAnswered` counts distinct questions and ignores correctness.
 * `handsPlayed` and `unitsNetLifetime` count finished hands only. There is no balance column.
 * The SQL lives in `repositories/progress.ts`. Only `topicsTouched` is derived here, from the bundle.
 */

import { lessonById, scenarioById } from '@prl/content';
import type { ContentId, ProgressResponse } from '@prl/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireSession } from '../auth/session.ts';
import { getSql } from '../db.ts';
import { AppError } from '../errors.ts';
import { readProgress } from '../repositories/progress.ts';

/** Derived from the content bundle at read time so a topic is never stored in two places. */
export function topicsTouched(
  lessonIds: readonly ContentId[],
  scenarioIds: readonly ContentId[],
): readonly string[] {
  const topics = new Set<string>();
  for (const id of lessonIds) {
    const lesson = lessonById(id);
    if (lesson !== null) topics.add(lesson.topic);
  }
  for (const id of scenarioIds) {
    const scenario = scenarioById(id);
    if (scenario !== null) topics.add(scenario.topic);
  }
  return [...topics].sort();
}

/**
 * Progress has no anonymous view. An instance built without the session plugin is answered here,
 * because `requireSession` needs the decorator to tell `not_authenticated` from `session_expired`.
 */
function requireCaller(request: FastifyRequest): string {
  if (!request.server.hasRequestDecorator('session')) {
    throw new AppError('not_authenticated', {
      logDetail: 'no session plugin is registered on this instance, so nobody can be signed in',
    });
  }
  return requireSession(request).user.id;
}

const progressRoutes: FastifyPluginAsync = (app) => {
  app.get('/me/progress', async (request, reply): Promise<ProgressResponse> => {
    reply.header('cache-control', 'no-store');

    const userId = requireCaller(request);
    const snapshot = await readProgress(getSql(), userId);
    // `array_agg(distinct ...)` order is unstable. Sorted so two reads of one record match.
    const scenariosAttempted = [...snapshot.scenariosAttempted].sort();

    return {
      lessonsCompleted: snapshot.lessonsCompleted,
      scenariosAttempted,
      quizQuestionsAnswered: snapshot.quizQuestionsAnswered,
      handsPlayed: snapshot.handsPlayed,
      unitsNetLifetime: snapshot.unitsNetLifetime,
      // Completed lessons only, so no topic is claimed for a lesson merely opened.
      topicsTouched: topicsTouched(snapshot.lessonsCompleted, scenariosAttempted),
    };
  });

  return Promise.resolve();
};

export default progressRoutes;

/**
 * `GET /me/progress` — counts, and nothing that could be mistaken for a score.
 *
 * ## What is deliberately absent
 *
 * No rank. No streak. No level, no percentage complete, no "you are ahead of N% of learners", no
 * best run, no daily target. The response type has no field capable of expressing any of them,
 * the database has no column to store one (`prl.quiz_attempts` says so in a comment, and its
 * absence of an aggregate column is a design decision rather than an omission), and this file
 * computes none.
 *
 * That is not squeamishness about numbers — this is an app about numbers. It is that a streak
 * is a number about the learner rather than about poker, and a number about the learner is what
 * turns a tool for thinking into a reason to open an app. See `docs/PRODUCT-GUARDRAILS.md`.
 *
 * ## Counted, not scored
 *
 * Every figure here answers "how much have you looked at", never "how well did you do":
 *
 * - `lessonsCompleted` — the lesson ids marked finished. A list, so the client can tick them off.
 * - `scenariosAttempted` — the scenario ids tried, once each however many times they were tried.
 * - `quizQuestionsAnswered` — **distinct** questions answered, right or wrong. Answering one
 *   question five times is one question answered, and whether it was right does not appear.
 * - `handsPlayed` — seats this learner held in hands that **finished**. A hand still in progress
 *   has not been played yet, which is also why it contributes nothing to the figure below it.
 * - `unitsNetLifetime` — the sum of a learner's per-hand results, in free practice units. There
 *   is no balance column anywhere in the schema and this is not one; it is a count of a signed
 *   quantity, and it is as likely to be negative as positive, which is the honest shape of a
 *   variance lesson.
 * - `topicsTouched` — derived from the content bundle, not stored: the topics of the lessons and
 *   scenarios above. Progress rows outlive the content they name (there is no foreign key, by
 *   design), so an id that no longer exists contributes no topic rather than breaking the read.
 *
 * ## Where the query is
 *
 * `repositories/progress.ts :: readProgress` — one statement, four tables, one round trip. This
 * file held a second copy of that aggregate for a while and the two disagreed about what
 * `handsPlayed` meant, which is the whole argument for the rule that a route module contains no
 * SQL: one definition of a number, in the module that owns the tables it comes from.
 *
 * The one thing the repository deliberately does not return is `topicsTouched`, because a topic is
 * a property of the content bundle and the database has never heard of it. That mapping is below.
 */

import { lessonById, scenarioById } from '@prl/content';
import type { ContentId, ProgressResponse } from '@prl/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireSession } from '../auth/session.ts';
import { getSql } from '../db.ts';
import { AppError } from '../errors.ts';
import { readProgress } from '../repositories/progress.ts';

/**
 * The topics behind a set of lesson and scenario ids.
 *
 * Derived from the content bundle at read time. Storing a topic against a progress row would
 * mean two places had to agree about which topic a lesson belongs to, and the stored one would
 * be the stale one.
 */
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
 * The caller, or a 401.
 *
 * Progress belongs to one learner, so there is no anonymous view of it to fall back to —
 * unlike the content lists, which simply show nothing ticked. `requireSession` owns the
 * `not_authenticated` / `session_expired` split; it can only tell them apart once
 * `sessionPlugin` has decorated the request, so an instance assembled without the auth module
 * is answered here instead of reaching a decorator that does not exist.
 */
function requireCaller(request: FastifyRequest): string {
  if (!request.server.hasRequestDecorator('session')) {
    throw new AppError('not_authenticated', {
      logDetail: 'no session plugin is registered on this instance, so nobody can be signed in',
    });
  }
  return requireSession(request).user.id;
}

// A plain function returning a resolved promise, not an `async` function with no `await`: the
// route is attached synchronously and the linter is right to reject the other shape.
const progressRoutes: FastifyPluginAsync = (app) => {
  app.get('/me/progress', async (request, reply): Promise<ProgressResponse> => {
    // Always `no-store`: this is one learner's own record, and it is the response most obviously
    // wrong to hand to somebody else out of a shared cache.
    reply.header('cache-control', 'no-store');

    const userId = requireCaller(request);
    const snapshot = await readProgress(getSql(), userId);
    // `readProgress` orders the completed lessons and leaves the attempted scenarios in whatever
    // order `array_agg(distinct ...)` produced. Sorted here so the response is stable between two
    // reads of an unchanged record, which is what a client diffing the list expects.
    const scenariosAttempted = [...snapshot.scenariosAttempted].sort();

    return {
      lessonsCompleted: snapshot.lessonsCompleted,
      scenariosAttempted,
      quizQuestionsAnswered: snapshot.quizQuestionsAnswered,
      handsPlayed: snapshot.handsPlayed,
      unitsNetLifetime: snapshot.unitsNetLifetime,
      // The topics of what is *reported* above: completed lessons, not merely opened ones, so the
      // list cannot claim a topic the learner has not finished reading about.
      topicsTouched: topicsTouched(snapshot.lessonsCompleted, scenariosAttempted),
    };
  });

  return Promise.resolve();
};

export default progressRoutes;

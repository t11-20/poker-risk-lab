/**
 * `prl.lesson_progress`, `prl.quiz_attempts`, `prl.scenario_attempts` — what a learner has done.
 *
 * ## There is no score, and this file does not compute one
 *
 * No column exists for a score, a streak, a best run, a pass flag or a percentage, and
 * `docs/PRODUCT-GUARDRAILS.md` section 2 is why: "Levels, XP, badges, leaderboards, or any ladder
 * that makes quantity of play the measure of progress" are prohibited. A stored score also turns
 * a quiz into something to protect, which is exactly the pressure the product refuses to create.
 *
 * So `readProgress` counts and lists. It does not rank, does not weight, and does not average.
 * `ProgressResponse` is deliberately made of facts: which lessons are finished, which scenarios
 * were tried, how many questions were answered, how many hands were played, and the net across
 * them.
 *
 * ## Content ids are validated, not joined
 *
 * There is no `lessons` table. Content ships in `packages/content`, version-controlled and tested
 * against the maths, so a lesson's claims cannot drift from what `@prl/poker-math` computes. The
 * consequence the migration spells out is that progress rows outlive the content they point at,
 * so nothing here assumes an id still resolves — and `ProgressResponse.topicsTouched` is not
 * produced here at all, because a topic is a property of the content and the database has never
 * heard of it. The route maps the ids this returns onto topics through `@prl/content`.
 *
 * ## The expected answer is never stored
 *
 * `quiz_attempts.answer` is the learner's own submission and `was_correct` is the app's
 * comparison of it against a value computed at runtime. The expected value itself has no column,
 * because a stored answer key is a number that can silently disagree with the maths that produced
 * it — and it would be the learner who paid for the disagreement.
 */

import type { ContentId } from '@prl/contracts';
import { AppError } from '../errors.ts';
import { newLessonProgressId, newQuizAttemptId, newScenarioAttemptId } from './ids.ts';
import { type Db, jsonbText, violationError } from './sql.ts';

/**
 * `prl.content_id`'s own rule, copied from migration 0001.
 *
 * Stricter than `CONTENT_ID_PATTERN` in the contracts (`^[a-z0-9][a-z0-9-]{0,79}$`) in two ways
 * that matter: the domain caps the id at 63 characters, and it forbids a trailing hyphen. Both are
 * reachable from a request the route schema accepts, so validating against the database's rule
 * here is what turns a would-be check violation and a 500 into `invalid_request`.
 */
const CONTENT_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function assertContentId(value: string, field: string): string {
  if (!CONTENT_ID.test(value)) {
    throw new AppError('invalid_request', {
      fields: { [field]: 'is not a content identifier' },
      logDetail: `rejected a content id in ${field}`,
    });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export interface LessonProgressRow {
  readonly lesson_id: ContentId;
  readonly completed_at: Date | null;
  readonly last_viewed_at: Date;
}

export interface UpsertLessonInput {
  readonly userId: string;
  readonly lessonId: ContentId;
  /** True when the learner reached the end of the lesson. Completion is sticky; see below. */
  readonly completed?: boolean;
}

/**
 * Records that a learner opened a lesson, and optionally that they finished it.
 *
 * `on conflict (user_id, lesson_id)` is an upsert against `lesson_progress_user_lesson_key`, which
 * migration 0002 says exists partly for this: "opening a lesson twice updates rather than
 * duplicating".
 *
 * ## Completion is sticky, by `coalesce`
 *
 * `completed_at = coalesce(lesson_progress.completed_at, excluded.completed_at)` keeps the first
 * completion timestamp and never clears it. Without the `coalesce`, re-opening a finished lesson
 * with `completed: false` would un-finish it — which is both wrong and the sort of wrong that
 * looks like data loss to the learner. `lesson_progress` is the alias for the existing row inside
 * `DO UPDATE`; `excluded` is the row that was proposed.
 *
 * `now()` rather than a timestamp from this process, so a fleet with drifting clocks cannot record
 * a lesson as viewed before it was created.
 */
export async function upsertLessonProgress(sql: Db, input: UpsertLessonInput): Promise<LessonProgressRow> {
  const lessonId = assertContentId(input.lessonId, 'lessonId');
  const completed = input.completed ?? false;
  try {
    const rows = await sql<LessonProgressRow[]>`
      insert into prl.lesson_progress (id, user_id, lesson_id, completed_at, last_viewed_at)
      values (
        ${newLessonProgressId()}, ${input.userId}, ${lessonId},
        case when ${completed}::boolean then now() else null end,
        now()
      )
      on conflict (user_id, lesson_id) do update
        set last_viewed_at = now(),
            completed_at = coalesce(lesson_progress.completed_at, excluded.completed_at)
      returning lesson_id, completed_at, last_viewed_at
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new AppError('internal_error', { logDetail: 'lesson progress upsert returned no row' });
    }
    return row;
  } catch (error) {
    const mapped = violationError(error, 'recording lesson progress');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

/**
 * Deletes every lesson-progress row for a learner.
 *
 * The one thing a learner is granted the privilege to erase — `lesson_progress` is the only
 * progress table with DELETE in the grant matrix. `quiz_attempts` and `scenario_attempts` are
 * append-only and stay: they are the learner's own working history, there is no score derived from
 * them to protect, and a table the runtime can rewrite is a table whose history means nothing.
 *
 * Returns how many rows went, so a route can say "cleared 12 lessons" rather than "done".
 */
export async function clearLessonProgress(sql: Db, userId: string): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    delete from prl.lesson_progress where user_id = ${userId} returning id
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

export interface QuizAttemptInput {
  readonly userId: string;
  readonly quizId: ContentId;
  readonly questionId: ContentId;
  /**
   * The learner's submission, whatever shape the question takes. Must serialise to a JSON
   * *object*: `quiz_attempts_answer_is_object` refuses anything else, and a bare number would
   * throw away which kind of answer it was.
   */
  readonly answer: unknown;
  readonly wasCorrect: boolean;
}

/**
 * Appends one answered quiz question.
 *
 * Append-only: `prl.quiz_attempts` is granted SELECT and INSERT and nothing else, so a second
 * attempt at the same question is a second row rather than an overwrite. That is the point —
 * changing your mind is part of learning, and a table that recorded only the latest answer could
 * not show anybody how their reasoning moved.
 */
export async function recordQuizAttempt(sql: Db, input: QuizAttemptInput): Promise<void> {
  const quizId = assertContentId(input.quizId, 'quizId');
  const questionId = assertContentId(input.questionId, 'questionId');
  const answer = jsonObjectText(input.answer, 'answer');
  try {
    await sql`
      insert into prl.quiz_attempts (id, user_id, quiz_id, question_id, answer, was_correct)
      values (
        ${newQuizAttemptId()}, ${input.userId}, ${quizId}, ${questionId},
        ${answer}::text::jsonb, ${input.wasCorrect}
      )
    `;
  } catch (error) {
    const mapped = violationError(error, 'recording a quiz attempt');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

export interface ScenarioAttemptInput {
  readonly userId: string;
  readonly scenarioId: ContentId;
  /** The engine's `Action`: `{type}` plus `{to}` for bet and raise. */
  readonly action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  readonly to?: number;
  /**
   * Null when the scenario deliberately makes no claim about a single correct action.
   *
   * Nullable on purpose, and the migration says why: plenty of Scenario Lab spots turn on a range
   * assumption the learner is free to disagree with, and NULL records "this scenario makes no
   * claim" rather than silently scoring a judgement call as wrong. Never a score.
   */
  readonly matchedExpected: boolean | null;
}

/** Appends one Scenario Lab decision. Append-only, same reasoning as `recordQuizAttempt`. */
export async function recordScenarioAttempt(sql: Db, input: ScenarioAttemptInput): Promise<void> {
  const scenarioId = assertContentId(input.scenarioId, 'scenarioId');
  const chosen = chosenAction(input);
  try {
    await sql`
      insert into prl.scenario_attempts (id, user_id, scenario_id, chosen_action, matched_expected)
      values (
        ${newScenarioAttemptId()}, ${input.userId}, ${scenarioId},
        ${jsonbText(chosen, 'action')}::text::jsonb, ${input.matchedExpected}
      )
    `;
  } catch (error) {
    const mapped = violationError(error, 'recording a scenario attempt');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

/**
 * The engine's `Action` shape for the `chosen_action` column.
 *
 * Written as a function with an early narrow rather than a ternary, because the sizing has to be
 * proven present before it goes into the object: `{ type: 'bet', to: undefined }` serialises to
 * `{"type":"bet"}`, which satisfies every constraint on the column and silently records a bet of
 * no particular size.
 */
function chosenAction(input: ScenarioAttemptInput): { readonly type: string; readonly to?: number } {
  if (input.action !== 'bet' && input.action !== 'raise') return { type: input.action };
  const to = input.to;
  if (to === undefined || !Number.isInteger(to) || to < 0) {
    throw new AppError('invalid_request', {
      fields: { to: 'is required for a bet or a raise, as a whole number of units' },
      logDetail: `scenario action ${input.action} arrived without a usable sizing`,
    });
  }
  return { type: input.action, to };
}

// ---------------------------------------------------------------------------
// The aggregate read
// ---------------------------------------------------------------------------

/**
 * Everything `ProgressResponse` needs from the database.
 *
 * `topicsTouched` is absent because it is not a database fact. See the file header.
 */
export interface ProgressSnapshot {
  readonly lessonsCompleted: readonly ContentId[];
  /** Every lesson the learner has opened, finished or not. Feeds `topicsTouched` upstream. */
  readonly lessonsViewed: readonly ContentId[];
  readonly scenariosAttempted: readonly ContentId[];
  /**
   * Distinct questions answered, not attempts made.
   *
   * A learner who reconsiders one question has not answered two questions, and counting rows would
   * say they had — which would also mean the number went up for changing your mind, and rewarding
   * volume is the thing section 2 of the guardrails rules out.
   */
  readonly quizQuestionsAnswered: number;
  /** Seats the learner held in hands that finished. A hand in progress has not been played yet. */
  readonly handsPlayed: number;
  readonly unitsNetLifetime: number;
}

interface ProgressRow {
  readonly lessons_completed: readonly string[];
  readonly lessons_viewed: readonly string[];
  readonly scenarios_attempted: readonly string[];
  readonly quiz_questions_answered: number;
  readonly hands_played: number;
  readonly units_net_lifetime: number;
}

/**
 * One query for the whole progress page.
 *
 * Six numbers and three lists from four tables, as one statement with one round trip. The
 * alternative — a query per figure — is six round trips for a page a learner opens on every visit,
 * and six chances for two of the figures to be read either side of a concurrent write and disagree
 * with each other.
 *
 * Three details worth knowing:
 *
 * - Each CTE is a single-row aggregate, so the final `from a, b, c, d` is a cross join of one row
 *   by one row by one row by one row. That is deliberate and cannot fan out; a `join ... on true`
 *   would say the same thing at more length.
 * - `array_agg(... ::text)` casts away the `prl.content_id` domain before aggregating, so the
 *   `coalesce(..., '{}'::text[])` that turns "no rows" into an empty array has matching types on
 *   both sides. Without the cast the domain array and `text[]` are different types and the
 *   coalesce fails to resolve.
 * - Every count and sum is cast to `int`. `count()` and `sum(int)` are `bigint`, which postgres.js
 *   returns as a *string* rather than lose precision on values above 2^53 — and a `handsPlayed`
 *   that is sometimes `7` and sometimes `"7"` is a bug waiting in the JSON response.
 */
export async function readProgress(sql: Db, userId: string): Promise<ProgressSnapshot> {
  const rows = await sql<ProgressRow[]>`
    with lessons as (
      select
        coalesce(
          array_agg(lesson_id::text order by lesson_id) filter (where completed_at is not null),
          '{}'::text[]
        ) as completed,
        coalesce(array_agg(lesson_id::text order by lesson_id), '{}'::text[]) as viewed
        from prl.lesson_progress
       where user_id = ${userId}
    ),
    scenarios as (
      select coalesce(array_agg(distinct scenario_id::text), '{}'::text[]) as attempted
        from prl.scenario_attempts
       where user_id = ${userId}
    ),
    quizzes as (
      select count(distinct question_id)::int as answered
        from prl.quiz_attempts
       where user_id = ${userId}
    ),
    hands as (
      select count(*)::int as played, coalesce(sum(s.net_result), 0)::int as net
        from prl.hand_seats s
        join prl.hands h on h.id = s.hand_id
       where s.user_id = ${userId} and h.completed_at is not null
    )
    select lessons.completed              as lessons_completed,
           lessons.viewed                 as lessons_viewed,
           scenarios.attempted            as scenarios_attempted,
           quizzes.answered               as quiz_questions_answered,
           hands.played                   as hands_played,
           hands.net                      as units_net_lifetime
      from lessons, scenarios, quizzes, hands
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('internal_error', { logDetail: 'progress aggregate returned no row' });
  }
  return {
    lessonsCompleted: row.lessons_completed,
    lessonsViewed: row.lessons_viewed,
    scenariosAttempted: row.scenarios_attempted,
    quizQuestionsAnswered: row.quiz_questions_answered,
    handsPlayed: row.hands_played,
    unitsNetLifetime: row.units_net_lifetime,
  };
}

/**
 * Serialises a value that has to be a JSON object.
 *
 * `quiz_attempts_answer_is_object` requires `jsonb_typeof(answer) = 'object'`, so an array or a
 * bare number is a check violation and therefore a 500. Checking the first character of the
 * serialised form is enough to tell an object from anything else, and it is checked here so the
 * caller is told `invalid_request` with the field named.
 */
function jsonObjectText(value: unknown, field: string): string {
  const text = jsonbText(value, field);
  if (!text.startsWith('{')) {
    throw new AppError('invalid_request', {
      fields: { [field]: 'must be an object' },
      logDetail: `${field} was not a JSON object`,
    });
  }
  return text;
}

/**
 * `prl.lesson_progress`, `prl.quiz_attempts`, `prl.scenario_attempts`. There is no score, streak or
 * pass flag (`docs/PRODUCT-GUARDRAILS.md` section 2), so `readProgress` counts and lists and never ranks.
 * Content ids are validated, not joined, because content ships in `packages/content` and rows outlive
 * it. The expected quiz answer is never stored, so it cannot disagree with the maths.
 */

import type { ContentId } from '@prl/contracts';
import { AppError } from '../errors.ts';
import { newLessonProgressId, newQuizAttemptId, newScenarioAttemptId } from './ids.ts';
import { type Db, jsonbObjectParam, jsonbParam, violationError } from './sql.ts';

/**
 * `prl.content_id`, copied from migration 0001. Stricter than the contracts' `CONTENT_ID_PATTERN`
 * (63 characters, no trailing hyphen), so this turns a would-be check violation into `invalid_request`.
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

export interface LessonProgressRow {
  readonly lesson_id: ContentId;
  readonly completed_at: Date | null;
  readonly last_viewed_at: Date;
}

export interface UpsertLessonInput {
  readonly userId: string;
  readonly lessonId: ContentId;
  readonly completed?: boolean;
}

/**
 * Records that a learner opened a lesson, and optionally finished it. The `coalesce` keeps the first
 * completion, so re-opening a finished lesson never un-finishes it. `now()` comes from the database,
 * so drifting process clocks cannot misorder the timestamps.
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
 * `lesson_progress` is the only progress table with DELETE granted. The attempt tables are
 * append-only and stay.
 */
export async function clearLessonProgress(sql: Db, userId: string): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    delete from prl.lesson_progress where user_id = ${userId} returning id
  `;
  return rows.length;
}

export interface QuizAttemptInput {
  readonly userId: string;
  readonly quizId: ContentId;
  readonly questionId: ContentId;
  /** Must serialise to a JSON object, as `quiz_attempts_answer_is_object` requires. */
  readonly answer: unknown;
  readonly wasCorrect: boolean;
}

/** Append-only (SELECT and INSERT granted), so a second attempt is a second row. */
export async function recordQuizAttempt(sql: Db, input: QuizAttemptInput): Promise<void> {
  const quizId = assertContentId(input.quizId, 'quizId');
  const questionId = assertContentId(input.questionId, 'questionId');
  const answer = jsonbObjectParam(sql, input.answer, 'answer');
  try {
    await sql`
      insert into prl.quiz_attempts (id, user_id, quiz_id, question_id, answer, was_correct)
      values (
        ${newQuizAttemptId()}, ${input.userId}, ${quizId}, ${questionId},
        ${answer}, ${input.wasCorrect}
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
  readonly action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  readonly to?: number;
  /** Null when the scenario makes no claim about one correct action. Never a score. */
  readonly matchedExpected: boolean | null;
}

export async function recordScenarioAttempt(sql: Db, input: ScenarioAttemptInput): Promise<void> {
  const scenarioId = assertContentId(input.scenarioId, 'scenarioId');
  const chosen = chosenAction(input);
  try {
    await sql`
      insert into prl.scenario_attempts (id, user_id, scenario_id, chosen_action, matched_expected)
      values (
        ${newScenarioAttemptId()}, ${input.userId}, ${scenarioId},
        ${jsonbParam(sql, chosen, 'action')}, ${input.matchedExpected}
      )
    `;
  } catch (error) {
    const mapped = violationError(error, 'recording a scenario attempt');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

/**
 * The sizing is checked before it goes into the object, because `{ type: 'bet', to: undefined }`
 * serialises to `{"type":"bet"}`, passes every constraint, and records a bet of no size.
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

/** No `topicsTouched`, because the route derives it from `@prl/content`. */
export interface ProgressSnapshot {
  readonly lessonsCompleted: readonly ContentId[];
  readonly lessonsViewed: readonly ContentId[];
  readonly scenariosAttempted: readonly ContentId[];
  /** Distinct questions, not attempts, so reconsidering an answer does not raise the count. */
  readonly quizQuestionsAnswered: number;
  /** Seats held in finished hands only. */
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
 * One statement, so no two figures are read either side of a concurrent write. Each CTE is a one-row
 * aggregate, so the cross join cannot fan out. `::text` drops the `prl.content_id` domain so the
 * `coalesce` with `'{}'::text[]` resolves. Counts are cast to `int` because postgres.js returns
 * `bigint` as a string.
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

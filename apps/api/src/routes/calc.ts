/**
 * The two calculation endpoints: `POST /math/equity` and `POST /math/coach`.
 *
 * Both are thin. That is the design: the request is validated and costed by `calc/parse.ts`,
 * the arithmetic happens on a thread from `workers/pool.ts`, and the only work this file does
 * is turn a plan into a contract response and a failure into an `ErrorCode`. There is no
 * calculation here, and there must not be — anything computed on this thread is time no table
 * gets to act in.
 *
 * ## Why both endpoints carry the stricter rate limit
 *
 * They are the two places where a small request buys real CPU, and CPU is the one resource a
 * rate limit denominated in requests does not naturally protect. `app.expensiveRateLimit`
 * (twenty per minute by default, against the global three hundred) is what stops one caller
 * with a loop from occupying the pool while everybody else's Coach request queues behind it.
 * The bounded queue in the pool is the second line: it answers `service_unavailable`
 * immediately rather than accepting work it cannot start.
 *
 * ## What the responses always carry
 *
 * The method, and — for a sampled figure — the interval. A bare percentage is the thing this
 * whole product exists to argue against, so `EquitySummary.method` and
 * `confidenceHalfWidthPoints` are populated straight from the maths and never patched: an exact
 * result reports `null` for the interval because it has no sampling error, which is a different
 * claim from an interval of zero. The Coach report additionally carries its assumptions, and
 * this file refuses to return one without them.
 */

import type {
  CoachRequest,
  CoachResponse,
  EquityRequest,
  EquityResponse,
  EquitySummary,
} from '@prl/contracts';
import type { EquityResult } from '@prl/poker-math';
import type { FastifyPluginAsync } from 'fastify';
import {
  DEFAULT_WORK_LIMITS,
  parseCoachRequest,
  parseEquityRequest,
  type WorkLimits,
} from '../calc/parse.ts';
import { AppError } from '../errors.ts';
import { closeSharedPool, getSharedPool } from '../workers/pool.ts';

/**
 * A note appended to a sampled figure's assumptions.
 *
 * The maths states how many run-outs were sampled; what it cannot know is that this API seeds
 * them deterministically. Without that sentence a learner who reloads and sees the same number
 * twice could reasonably conclude the interval is an error bar on a fresh measurement each
 * time, which is a different — and much stronger — claim than the one being made.
 */
const REPRODUCIBILITY_NOTE =
  'Sampling here is seeded, so the same request returns the same figure every time. The interval ' +
  'is the sampling error of this one run, not the spread of answers you would get by repeating it.';

function summarise(result: EquityResult): EquitySummary {
  const hero = result.players[0];
  if (hero === undefined) {
    throw new AppError('internal_error', { logDetail: 'equity result carried no players' });
  }
  return {
    heroEquity: hero.equity,
    method: result.method,
    trials: result.trials,
    // Present for a sampled figure, null for an exact one. Straight from the maths: the
    // difference between "no sampling error" and "an error of zero" is the whole point.
    confidenceHalfWidthPoints: result.confidence?.halfWidthPoints ?? null,
    // The rule of 2 and 4 needs an out count, and outs need a single opponent and cards still
    // to come. This endpoint answers an equity question and does not compute outs, so the
    // teaching aid belongs to the Coach — where the report has the outs to compare it against.
    ruleOfThumb: null,
    perPlayer: result.players.map((player) => ({
      label: player.label,
      equity: player.equity,
      win: player.win,
      tie: player.tie,
    })),
  };
}

/**
 * The route module.
 *
 * Written as a plain function returning a resolved promise rather than as an `async` function
 * with no `await` in it. `registerRoutes` types a route module as `FastifyPluginAsync`, and the
 * linter rejects `async` without `await` — rightly, because that shape usually means a missing
 * one. Here there is genuinely nothing to wait for: every route is attached synchronously.
 */
const calcRoutes: FastifyPluginAsync = (app) => {
  const config = app.appConfig;
  const limits: WorkLimits = { ...DEFAULT_WORK_LIMITS, maxSamplesPerRequest: config.monteCarloMaxSamples };
  /**
   * The wall-clock budget for one request.
   *
   * `coachTimeoutMs` for everything, plus the one-time allowance a `top:NN` range needs while
   * the thread serving it has yet to compute the preflop strength ordering. `calc/parse.ts`
   * decides when that applies and says why.
   */
  const budgetFor = (allowanceMs: number): number => config.coachTimeoutMs + allowanceMs;

  const pool = getSharedPool(config, {
    onWarn: (warning) => {
      // The pool cannot log for itself — it must not import the logger, because the worker it
      // manages must not either. So it reports and this file logs.
      app.log.warn({ poolEvent: warning.event, poolDetail: warning.detail }, 'calculation pool');
    },
  });

  /**
   * Every thread is terminated when the instance closes.
   *
   * `onClose` runs inside `app.close()`, which `server.ts` awaits before it closes the database
   * and exits — so a deploy does not leave worker threads behind. `closeSharedPool` is
   * idempotent, so another route module registering the same hook is harmless.
   */
  app.addHook('onClose', async () => {
    await closeSharedPool();
  });

  /**
   * Ad-hoc equity.
   *
   * Exact when the plan says it fits, sampled and sharded otherwise, and the response says
   * which. `elapsedMs` is measured here rather than taken from the worker's own figure, because
   * what a caller waited for includes queueing and the thread hand-off.
   */
  app.post<{ Body: EquityRequest }>(
    '/math/equity',
    { config: app.expensiveRateLimit, schema: { body: { $ref: 'prl:equityBody#' } } },
    async (request): Promise<EquityResponse> => {
      const plan = parseEquityRequest(request.body, limits);
      const started = performance.now();
      const result = await pool.runEquity(plan.request, budgetFor(plan.timeoutAllowanceMs));
      const assumptions =
        result.method === 'monte-carlo'
          ? [...result.assumptions, REPRODUCIBILITY_NOTE]
          : [...result.assumptions];

      request.log.info(
        {
          calcMethod: result.method,
          players: plan.playerCount,
          shards: plan.request.shards,
          trials: result.trials,
          plannedEvaluations: plan.plannedEvaluations,
          timeoutAllowanceMs: plan.timeoutAllowanceMs,
        },
        'equity computed',
      );

      return { equity: summarise(result), assumptions, elapsedMs: Math.round(performance.now() - started) };
    },
  );

  /**
   * The Coach.
   *
   * One worker task, never sharded. The assertion below is not defensive programming for its
   * own sake: `assumptions` is the difference between a figure and a claim, and
   * `buildCoachReport` promises never to return an empty list. If that promise is ever broken by
   * a refactor, this endpoint must fail loudly rather than quietly serve a number that presents
   * itself as unconditional fact.
   */
  app.post<{ Body: CoachRequest }>(
    '/math/coach',
    { config: app.expensiveRateLimit, schema: { body: { $ref: 'prl:coachBody#' } } },
    async (request): Promise<CoachResponse> => {
      const plan = parseCoachRequest(request.body, limits);
      const report = await pool.runCoach(plan.task, budgetFor(plan.timeoutAllowanceMs));
      if (report.assumptions.length === 0) {
        throw new AppError('internal_error', {
          logDetail: 'buildCoachReport returned a report with no assumptions; refusing to serve it',
        });
      }
      if (report.uncertainty.method === 'monte-carlo' && report.uncertainty.confidenceInterval === null) {
        throw new AppError('internal_error', {
          logDetail: 'a sampled Coach report arrived without a confidence interval; refusing to serve it',
        });
      }

      request.log.info(
        {
          calcMethod: report.equity.method,
          players: plan.playerCount,
          street: report.street,
          suggested: report.suggestion.action,
          confidence: report.suggestion.confidence,
        },
        'coach report computed',
      );

      return { report };
    },
  );

  return Promise.resolve();
};

export default calcRoutes;

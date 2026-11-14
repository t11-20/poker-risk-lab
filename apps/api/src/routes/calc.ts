/**
 * `POST /math/equity` and `POST /math/coach`. No arithmetic runs on this thread.
 * `calc/parse.ts` validates and costs the request, and `workers/pool.ts` does the work.
 * Both use `app.expensiveRateLimit` because a small request buys real CPU.
 * Responses always carry the method, and a sampled figure carries its interval. An exact figure
 * reports `null`, which is a different claim from an interval of zero.
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
import {
  bindCalculationPoolMetrics,
  observeAnalysis,
  workerTaskOutcomeFor,
} from '../observability/telemetry.ts';
import {
  closeSharedPool,
  getSharedPool,
  type PoolWarning,
  peekSharedPool,
  type WorkerPool,
} from '../workers/pool.ts';

/** Tells a learner the sampling is seeded, so a repeated figure is not read as a fresh measurement. */
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
    confidenceHalfWidthPoints: result.confidence?.halfWidthPoints ?? null,
    // Outs need a single opponent, so the rule of 2 and 4 belongs to the Coach report.
    ruleOfThumb: null,
    perPlayer: result.players.map((player) => ({
      label: player.label,
      equity: player.equity,
      win: player.win,
      tie: player.tie,
    })),
  };
}

const calcRoutes: FastifyPluginAsync = (app) => {
  const config = app.appConfig;
  const metrics = app.appMetrics;
  const limits: WorkLimits = { ...DEFAULT_WORK_LIMITS, maxSamplesPerRequest: config.monteCarloMaxSamples };
  /** `coachTimeoutMs` plus the one-time `top:NN` ordering allowance decided in `calc/parse.ts`. */
  const budgetFor = (allowanceMs: number): number => config.coachTimeoutMs + allowanceMs;

  const poolHooks = {
    onWarn: (warning: PoolWarning) => {
      // The pool must not import the logger, because its worker must not.
      app.log.warn({ poolEvent: warning.event, poolDetail: warning.detail }, 'calculation pool');
      // Successes are counted in `prl_analysis_total`, so only failures arrive here.
      metrics.workerTasks.inc({ outcome: workerTaskOutcomeFor(warning.event) });
    },
  };

  /**
   * Looked up per request. `closeSharedPool()` drops the memo, and a captured instance would stay
   * closed and refuse every task.
   */
  const currentPool = (): WorkerPool => getSharedPool(config, poolHooks);

  /** Idempotent. `routes/content.ts` binds the same shared pool. */
  bindCalculationPoolMetrics(peekSharedPool, metrics);

  /** `server.ts` awaits `app.close()` before exit, so no worker thread outlives a deploy. Idempotent. */
  app.addHook('onClose', async () => {
    await closeSharedPool();
  });

  /** `elapsedMs` is measured here so it includes queueing and the thread hand-off. */
  app.post<{ Body: EquityRequest }>(
    '/math/equity',
    { config: app.expensiveRateLimit, schema: { body: { $ref: 'prl:equityBody#' } } },
    async (request): Promise<EquityResponse> => {
      const plan = parseEquityRequest(request.body, limits);
      const started = performance.now();
      const result = await observeAnalysis(
        'equity',
        () => currentPool().runEquity(plan.request, budgetFor(plan.timeoutAllowanceMs)),
        metrics,
      );
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

  /** One task, never sharded. A report with no assumptions is refused rather than served as fact. */
  app.post<{ Body: CoachRequest }>(
    '/math/coach',
    { config: app.expensiveRateLimit, schema: { body: { $ref: 'prl:coachBody#' } } },
    async (request): Promise<CoachResponse> => {
      const plan = parseCoachRequest(request.body, limits);
      const report = await observeAnalysis(
        'coach',
        () => currentPool().runCoach(plan.task, budgetFor(plan.timeoutAllowanceMs)),
        metrics,
      );
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

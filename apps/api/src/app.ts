/**
 * `buildApp()` assembles the Fastify instance and owns registration order (see the hook-order note
 * in `plugins/security.ts`) plus liveness, readiness and metrics. Each `register` is awaited so the
 * decorators exist before `buildApp` returns. Do not add routes here. Pass a route module to
 * `registerRoutes`, which mounts it under `API_PREFIX`.
 */

import { timingSafeEqual } from 'node:crypto';
import type { HealthResponse, ReadinessResponse } from '@prl/contracts';
import { ALL_SCHEMAS, PROTOCOL_VERSION } from '@prl/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
} from 'fastify';
import Fastify from 'fastify';
import { type AppConfig, getConfig } from './config.ts';
import {
  type DatabaseHandle,
  type DbCheck,
  database as defaultDatabase,
  READINESS_DEADLINE_MS,
} from './db.ts';
import { AppError, apiErrorBody, registerErrorHandlers } from './errors.ts';
import { buildLoggerOptions } from './logging.ts';
import { type AppMetrics, appMetrics, METRICS_CONTENT_TYPE, metricsPlugin } from './observability/metrics.ts';
import { generateRequestId, requestContextPlugin } from './plugins/request-context.ts';
import { registerRateLimitResetRoute, securityPlugin, securityServerOptions } from './plugins/security.ts';
import { sharedPoolReadiness } from './workers/pool.ts';

declare module 'fastify' {
  interface FastifyInstance {
    appConfig: AppConfig;
    /** A stub in tests, the real pool in production. */
    appDatabase: DatabaseHandle;
    appMetrics: AppMetrics;
  }
}

/** Bump only for a breaking API change. */
export const API_PREFIX = '/api/v1';

/**
 * Coarse, because a build number on an unauthenticated endpoint tells anyone which advisories apply.
 * Kept in step with `package.json` by hand, since importing it would pull a file outside `rootDir`.
 */
const SERVICE_VERSION = '0.1.0';

/** Listed so the seam is discoverable. This file must not import them. */
export const EXPECTED_ROUTE_MODULES: readonly string[] = [
  'src/routes/auth.ts', // guest sessions, OIDC start/callback, session read, sign-out
  'src/routes/content.ts', // lessons, quizzes, scenarios, glossary
  'src/routes/calc.ts', // equity and coach calculation endpoints (expensive limit)
  'src/routes/rooms.ts', // create, join by invite code, sit, stand, list
  'src/routes/hands.ts', // hand history list and single-hand review
  'src/routes/progress.ts', // progress read, unit reset
  'src/ws/hub.ts', // WebSocket upgrade + table hub (uses isAllowedOrigin)
];

export type RouteModule = FastifyPluginAsync;

export interface BuildAppOptions {
  readonly config?: AppConfig;
  /** Tests pass a stub so no database is needed. */
  readonly database?: DatabaseHandle;
  /** Merged last. Not a way to weaken the security options. */
  readonly serverOptions?: FastifyServerOptions;
  /** Tests pass their own so counters do not accumulate across cases. */
  readonly metrics?: AppMetrics;
  /** Absent by default, so test apps are ungated. `server.ts` passes the schema guard's. */
  readonly featureGate?: FeatureGate;
}

export interface FeatureGate {
  /** Synchronous and database-free, since it runs on every request. `detail` is logged, never sent. */
  readonly admits: () => { readonly ok: boolean; readonly detail?: string };
  readonly retryAfterSeconds: number;
}

/**
 * Exempt by route pattern, not registration order. On Fastify 5.12.8 an instance hook added after a
 * route still runs for it, so an order-based exemption would have gated `/ready` itself.
 */
const UNGATED_ROUTES: ReadonlySet<string> = new Set([
  `${API_PREFIX}/health`,
  `${API_PREFIX}/ready`,
  '/metrics',
]);

/**
 * Refuses traffic while the schema guard says no. The staging proxy does not route on `/ready`, so
 * without this a degraded instance would serve writes to columns that do not exist.
 * - One instance hook covers every route module and the WebSocket upgrade.
 * - Thrown as an `AppError` so body, `Retry-After`, `no-store` and the counter come from `errors.ts`.
 * - Counted by the limiter only on refusal, since counting on pass disables stricter per-route limits.
 * - A refused upgrade's socket is destroyed after the 503. Otherwise it stays open and
 *   `app.close()` never resolves.
 */
function featureGateHook(app: FastifyInstance, gate: FeatureGate) {
  const countRequest = app.rateLimit();
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (UNGATED_ROUTES.has(request.routeOptions.url ?? '')) return;
    const answer = gate.admits();
    if (answer.ok) return;
    await countRequest.call(app, request, reply);
    if (request.headers.upgrade !== undefined) {
      const socket = request.raw.socket;
      reply.raw.once('finish', () => socket.destroy());
    }
    throw new AppError('service_unavailable', {
      retryAfterSeconds: gate.retryAfterSeconds,
      logDetail: `feature gate closed: ${answer.detail ?? 'no reason given'}`,
    });
  };
}

/**
 * - `removeAdditional: false` rejects unknown fields instead of silently deleting them.
 * - `allErrors: true` reports every field. Safe because every schema is ours and bounded.
 * - `discriminator: true` is required by `wsClientMessageSchema`.
 * - `coerceTypes: 'array'` is needed for query and path integers. It also coerces bodies, so schemas
 *   use `enum` and explicit bounds.
 */
const AJV_OPTIONS = {
  customOptions: {
    coerceTypes: 'array',
    useDefaults: true,
    removeAdditional: false,
    allErrors: true,
    discriminator: true,
  },
} as const;

function healthResponse(): HealthResponse {
  return { status: 'ok', version: SERVICE_VERSION, protocolVersion: PROTOCOL_VERSION };
}

function checkEntry(check: { readonly ok: boolean; readonly detail?: string }): {
  ok: boolean;
  detail?: string;
} {
  const entry: { ok: boolean; detail?: string } = { ok: check.ok };
  if (check.detail !== undefined) entry.detail = check.detail;
  return entry;
}

function readinessResponse(
  database: { readonly ok: boolean; readonly detail?: string },
  workers: { readonly required: boolean; readonly ok: boolean; readonly detail?: string },
): ReadinessResponse {
  const checks: Record<string, { ok: boolean; detail?: string }> = {
    database: checkEntry(database),
  };
  if (workers.required) checks.workers = checkEntry(workers);
  const ready = database.ok && (!workers.required || workers.ok);
  return { status: ready ? 'ready' : 'degraded', checks };
}

/**
 * `/ready` must always answer, whatever `DatabaseHandle` implementation it gets. The real `ping()`
 * has a tighter deadline, so this is a backstop. A rejection counts as a database that did not
 * answer, never a 500. The timer is `unref`'d and always cleared.
 */
async function pingWithinDeadline(db: DatabaseHandle, deadlineMs: number): Promise<DbCheck> {
  let timer: NodeJS.Timeout | null = null;
  const probe = db.ping().catch((): DbCheck => ({ ok: false, detail: 'database did not answer' }));
  const expiry = new Promise<DbCheck>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, detail: `readiness probe did not answer within ${deadlineMs} ms` }),
      deadlineMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([probe, expiry]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Registration order is request context (request id, client key), security, metrics, feature gate,
 * schemas, error handlers (the 404 needs `app.rateLimit`), then health, readiness and metrics.
 */
export async function buildApp(overrides: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = overrides.config ?? getConfig();
  const db = overrides.database ?? defaultDatabase;
  const metrics = overrides.metrics ?? appMetrics();

  const security = securityServerOptions(config);
  const app = Fastify({
    logger: buildLoggerOptions(config),
    genReqId: generateRequestId,
    ajv: AJV_OPTIONS,
    ...security,
    // Merged, because `security.routerOptions` holds the hardening half and spreading would drop one.
    routerOptions: {
      ignoreTrailingSlash: true,
      ignoreDuplicateSlashes: true,
      caseSensitive: true,
      ...security.routerOptions,
    },
    ...overrides.serverOptions,
  });

  app.decorate('appConfig', config);
  app.decorate('appDatabase', db);
  app.decorate('appMetrics', metrics);

  await app.register(requestContextPlugin, { config });
  await app.register(securityPlugin, { config });
  // After security, so preflight rejections and 429s are counted. Before routes, so none escapes.
  await app.register(metricsPlugin, { metrics });
  metrics.dbPoolMax.set({}, config.database.poolMax);
  if (overrides.featureGate !== undefined) {
    app.addHook('onRequest', featureGateHook(app, overrides.featureGate));
  }

  for (const schema of ALL_SCHEMAS) app.addSchema(schema);

  registerErrorHandlers(app, { notFoundPreHandler: app.rateLimit() });

  /**
   * Liveness answers from memory and is exempt from the rate limit. It must never read
   * `app.appDatabase`, because a frozen database should drain the process, not restart it.
   * Keep `RATE_LIMIT_MAX` above the `/ready` probe rate.
   */
  app.get('/api/v1/health', { config: { rateLimit: false } }, async () => healthResponse());

  app.get('/api/v1/ready', async (_request, reply) => {
    // Under pool exhaustion `select 1` waits, so the duration is the saturation signal. It is
    // clipped at `READINESS_DEADLINE_MS`, and `ping()` latches a stuck query (see `db.ts`), so one
    // episode records about one slow sample. Readiness failures measure the episode length.
    const startedAt = performance.now();
    const check = await pingWithinDeadline(db, READINESS_DEADLINE_MS);
    metrics.dbProbeDuration.observe({}, (performance.now() - startedAt) / 1_000);
    const workers = sharedPoolReadiness();
    const ready = check.ok && (!workers.required || workers.ok);
    metrics.readinessState.set({}, ready ? 1 : 0);
    if (!ready) {
      metrics.readinessFailures.inc();
      if (!check.ok) metrics.dbErrors.inc({ category: 'probe' });
      app.log.warn({ check, workers }, 'readiness check failed');
    }
    reply.status(ready ? 200 : 503);
    return readinessResponse(check, workers);
  });

  // After `registerErrorHandlers`, because Fastify binds a route's error handler when it is added.
  registerRateLimitResetRoute(app, config);
  registerMetricsRoute(app, config, metrics);

  return app;
}

/**
 * Token-protected, because the body describes the deployment's routes and load. With no token in
 * production the route is not registered, so it 404s like any absent path (a 403 would confirm it).
 * `config.ts` warns at boot. Outside production a missing token leaves it open. Rate limited.
 */
function registerMetricsRoute(app: FastifyInstance, config: AppConfig, metrics: AppMetrics): void {
  const token = config.metricsToken;
  if (token === null && config.isProduction) return;

  app.get('/metrics', (request, reply) => {
    if (token !== null && !metricsTokenAccepted(request, token)) {
      request.log.warn({}, 'metrics scrape refused: bad or missing token');
      return reply.status(401).send(apiErrorBody('not_authenticated', request.id));
    }
    reply.header('content-type', METRICS_CONTENT_TYPE);
    // A cached scrape would report a stale process as healthy.
    reply.header('cache-control', 'no-store');
    return reply.send(metrics.render());
  });
}

/** Not shared with `security.ts`, so one bug cannot expose two independent credentials. */
function metricsTokenAccepted(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Each module gets an encapsulated child, and instance hooks from the security layer still apply. */
export async function registerRoutes(app: FastifyInstance, modules: readonly RouteModule[]): Promise<void> {
  for (const module of modules) {
    await app.register(module, { prefix: API_PREFIX });
  }
}

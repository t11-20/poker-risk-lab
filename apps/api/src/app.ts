/**
 * `buildApp()` — the assembled Fastify instance, with nothing in it that talks to a table.
 *
 * This is the foundation the route modules, the WebSocket hub, the bots and the
 * repositories plug into. It owns the order things are registered in, because that order is
 * load-bearing (see the hook-order note in `plugins/security.ts`), and it owns the three
 * endpoints that must exist before any feature does: liveness, readiness and metrics.
 *
 * ## Why it is async
 *
 * Every plugin is `await app.register(...)`. Fastify's `register` is deferred by default —
 * the plugin does not run until `ready()` — which would mean `app.rateLimit`,
 * `app.csrfProtection` and the rest do not exist while this function is still running, and
 * the 404 handler could not be given a rate limit. Awaiting each registration forces it to
 * load immediately, so by the time `buildApp` returns, the instance is fully decorated and
 * a caller can attach routes that depend on those decorators.
 *
 * ## The seam for everyone else
 *
 * Do NOT add routes to this file. Write a route module — a plain Fastify plugin — and pass
 * it to `registerRoutes`:
 *
 * ```ts
 * const app = await buildApp();
 * await registerRoutes(app, [authRoutes, roomRoutes]);
 * await app.listen({ port: app.appConfig.port, host: app.appConfig.host });
 * ```
 *
 * A route module receives a child instance and reads shared state from the decorators
 * `app.appConfig` and `app.appDatabase`. It is registered under `API_PREFIX`, so its own
 * paths are written without it (`/rooms/:roomId`, not `/api/v1/rooms/:roomId`).
 */

import { timingSafeEqual } from 'node:crypto';
import type { HealthResponse, ReadinessResponse } from '@prl/contracts';
import { ALL_SCHEMAS, PROTOCOL_VERSION } from '@prl/contracts';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyServerOptions } from 'fastify';
import Fastify from 'fastify';
import { type AppConfig, getConfig } from './config.ts';
import {
  type DatabaseHandle,
  type DbCheck,
  database as defaultDatabase,
  READINESS_DEADLINE_MS,
} from './db.ts';
import { apiErrorBody, registerErrorHandlers } from './errors.ts';
import { buildLoggerOptions } from './logging.ts';
import { type AppMetrics, appMetrics, METRICS_CONTENT_TYPE, metricsPlugin } from './observability/metrics.ts';
import { generateRequestId, requestContextPlugin } from './plugins/request-context.ts';
import { registerRateLimitResetRoute, securityPlugin, securityServerOptions } from './plugins/security.ts';
import { sharedPoolReadiness } from './workers/pool.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** The frozen configuration this instance was built with. */
    appConfig: AppConfig;
    /** The database seam. A stub in tests; the real pool in production. */
    appDatabase: DatabaseHandle;
    /** The metrics registry owned by this Fastify instance. */
    appMetrics: AppMetrics;
  }
}

/** Every route module lives under this prefix. Bump it only for a breaking API change. */
export const API_PREFIX = '/api/v1';

/**
 * Reported by `/health`.
 *
 * Coarse on purpose: a build number or a git SHA on an unauthenticated endpoint tells
 * anyone which published vulnerabilities apply to this deployment. Keep this in step with
 * `package.json` by hand — the alternative, importing `package.json`, puts a file from
 * outside `rootDir` into the build.
 */
const SERVICE_VERSION = '0.1.0';

/**
 * Route modules other agents are expected to create. Listed here so the seam is discoverable
 * and so two people do not write the same file twice. This file must not import them.
 *
 * Each exports a default `FastifyPluginAsync` and registers its routes relative to
 * `API_PREFIX`.
 */
export const EXPECTED_ROUTE_MODULES: readonly string[] = [
  'src/routes/auth.ts', // guest sessions, OIDC start/callback, session read, sign-out
  'src/routes/content.ts', // lessons, quizzes, scenarios, glossary
  'src/routes/calc.ts', // equity and coach calculation endpoints (expensive limit)
  'src/routes/rooms.ts', // create, join by invite code, sit, stand, list
  'src/routes/hands.ts', // hand history list and single-hand review
  'src/routes/progress.ts', // progress read, unit reset
  'src/ws/hub.ts', // WebSocket upgrade + table hub (uses isAllowedOrigin)
];

/** A route module: an ordinary Fastify plugin, registered under `API_PREFIX`. */
export type RouteModule = FastifyPluginAsync;

export interface BuildAppOptions {
  /** Defaults to the process-wide config. Tests pass a hand-built one. */
  readonly config?: AppConfig;
  /** Defaults to the real pool's handle. Tests pass a stub so no database is needed. */
  readonly database?: DatabaseHandle;
  /**
   * Merged last into the Fastify options. For tests that need to change a server-level
   * setting; not a way to weaken the security options, which are applied first for a reason.
   */
  readonly serverOptions?: FastifyServerOptions;
  /**
   * Defaults to the process-wide metrics. Tests pass their own so that counters do not
   * accumulate across cases built in one process.
   */
  readonly metrics?: AppMetrics;
}

/**
 * Ajv options.
 *
 * Three of these are deliberate departures from Fastify's defaults:
 *
 * - `removeAdditional: false`. Fastify defaults to `true`, which *silently deletes* unknown
 *   properties. That is safe against mass assignment but it hides client bugs: a request
 *   with a misspelled field succeeds and does the wrong thing. Every schema in
 *   `@prl/contracts` is closed in order to *reject* unknown fields, so rejection is what
 *   happens.
 * - `allErrors: true`. Fastify defaults to `false`, which reports one field per request and
 *   turns fixing a form into a guessing game. Safe here because the schemas are ours and
 *   every one of them is bounded — the usual `allErrors` warning is about untrusted schemas.
 * - `discriminator: true`. Required by `wsClientMessageSchema`, which uses a discriminated
 *   `oneOf` so that a malformed socket frame is rejected against one branch instead of
 *   producing seven sets of errors.
 *
 * `coerceTypes: 'array'` is kept from Fastify's defaults, and is not free: query strings and
 * path parameters arrive as strings, so an integer parameter cannot validate without it. The
 * cost is that coercion applies to bodies too. The schemas guard against the consequences by
 * using `enum` and explicit bounds rather than relying on the type alone.
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
 * `db.ping()`, with a bound this endpoint enforces itself.
 *
 * ## Why the bound is here and not only in `db.ts`
 *
 * `/ready` is the endpoint that decides whether traffic arrives, so "always answers" is its
 * contract and not a property it may inherit from a collaborator. `DatabaseHandle` is an
 * interface with several implementations — the real pool, every stub in `test/`, whatever
 * gets written next — and a handle that hangs would hang this route with it. The real
 * `ping()` carries a tighter deadline of its own (`PROBE_QUERY_DEADLINE_MS`), so in
 * production this timer is a backstop that normally never fires; it fires when the handle
 * itself is the thing that is broken, which is exactly the case an endpoint's own contract
 * has to cover.
 *
 * ## Why a rejection is caught here too
 *
 * `ping()` is documented never to throw, and this route is the reason that matters: an
 * unhandled rejection from a probe would answer 500 `internal_error` — a shape that says
 * "bug", from the endpoint whose whole job is to say "do not send me traffic". Any handle
 * that breaks its contract by throwing is treated as a database that did not answer, which
 * is both true and the safe direction.
 *
 * The timer is `unref`'d and always cleared, so an answer inside the bound leaves nothing
 * behind and a probe never holds the process open through a shutdown.
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
 * Builds the instance.
 *
 * Registration order, and why:
 *
 * 1. `requestContextPlugin` first, so every later hook and every log line has a request id
 *    and a client key to work with.
 * 2. `securityPlugin`, so headers, CORS, CSRF and the rate limit are in place before any
 *    route exists to be attacked.
 * 3. Schemas, so a route can `$ref` them.
 * 4. Error handlers, including the 404 — which needs `app.rateLimit`, hence the awaits above.
 * 5. Health, readiness and metrics.
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
    // Merged rather than replaced: `securityServerOptions` sets the hardening half of the
    // router options (parameter length, unsafe patterns) and this sets the ergonomic half.
    // Spreading `security` on its own would silently drop one or the other.
    routerOptions: {
      // Two URLs that differ only by a trailing slash are the same route. Without this,
      // `/api/v1/rooms` and `/api/v1/rooms/` are different routes, which is a needless
      // source of 404s.
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
  // After the security layer, so its `onResponse` hook is registered after the hooks that can
  // answer a request on their own — a preflight rejection and a 429 still reach `onResponse`,
  // and both should be counted. Before the routes, so no route can escape it.
  await app.register(metricsPlugin, { metrics });
  metrics.dbPoolMax.set({}, config.database.poolMax);

  // One registration for every shared schema, so route modules refer to them by `$id`
  // (`{ body: { $ref: 'prl:createRoomBody#' } }`) and no schema is defined twice.
  for (const schema of ALL_SCHEMAS) app.addSchema(schema);

  registerErrorHandlers(app, { notFoundPreHandler: app.rateLimit() });

  /**
   * Liveness. Answers from memory, touches nothing, and is exempt from the rate limit: it
   * exists so an orchestrator can tell whether this process is alive, and it must never fail
   * for a reason unrelated to that. `/ready` is NOT exempt — it queries the database, so it
   * has to be as ratelimited as anything else that does. Keep `RATE_LIMIT_MAX` comfortably
   * above the probe interval.
   *
   * The handler is deliberately a closure over `healthResponse()` and nothing else. It does
   * not read `app.appDatabase`, and it must not start: a process whose database is frozen is
   * a process that should be drained, not killed and replaced by another instance that will
   * find the same frozen database. `test/db-deadlines.test.ts` holds that line by answering
   * `/health` while a handle that never settles is wedged in `/ready`.
   */
  app.get('/api/v1/health', { config: { rateLimit: false } }, async () => healthResponse());

  app.get('/api/v1/ready', async (_request, reply) => {
    // Timed, because this probe is the one place the process routinely asks the pool for a
    // connection on a schedule. Under pool exhaustion `select 1` still succeeds — it just
    // waits — so the duration is the saturation signal that the boolean cannot carry. See
    // `DB_PROBE_BUCKETS` in `observability/metrics.ts`.
    //
    // Two things about that signal changed with the deadlines, and both are worth knowing
    // before reading this histogram. It is now CLIPPED at `READINESS_DEADLINE_MS`, which is the
    // point — the observation that used to matter most here was one this endpoint never lived
    // to make. And during one episode of trouble it records roughly ONE slow observation rather
    // than one per probe, because `ping()` latches the query it gave up on and answers the next
    // probes from that (see the latch note in `db.ts`). The count of readiness FAILURES, not the
    // shape of this histogram, is what measures how long an episode lasted.
    const startedAt = performance.now();
    const check = await pingWithinDeadline(db, READINESS_DEADLINE_MS);
    metrics.dbProbeDuration.observe({}, (performance.now() - startedAt) / 1_000);
    const workers = sharedPoolReadiness();
    const ready = check.ok && (!workers.required || workers.ok);
    metrics.readinessState.set({}, ready ? 1 : 0);
    if (!ready) {
      metrics.readinessFailures.inc();
      if (!check.ok) metrics.dbErrors.inc({ category: 'probe' });
      // Logged here rather than returned: the caller gets a fixed string, the operator gets
      // the reason.
      app.log.warn({ check, workers }, 'readiness check failed');
    }
    // 503 while degraded, so a load balancer stops sending traffic without needing to parse
    // the body.
    reply.status(ready ? 200 : 503);
    return readinessResponse(check, workers);
  });

  // Both of these come AFTER `registerErrorHandlers`, and the order is load-bearing: Fastify
  // binds a route's error handler when the route is added, so a route registered any earlier
  // answers in the framework's error shape instead of the contract's single `ApiError` shape.
  // See the ordering note on `registerRateLimitResetRoute`.
  registerRateLimitResetRoute(app, config);
  registerMetricsRoute(app, config, metrics);

  return app;
}

/**
 * `GET /metrics`, in the Prometheus text exposition format.
 *
 * ## Why it is here and not in a route module
 *
 * Same reason as `/health` and `/ready`: it is not a feature of the product, it is how an
 * operator finds out whether the product is working. It must exist before any route module
 * does, it must not be under a feature module's encapsulation, and it must keep answering
 * when everything else is failing.
 *
 * ## Why it is authenticated, and why absence is silence rather than a 403
 *
 * The body names every route pattern, counts every error code, and reports uptime and live
 * connection counts. Together that is a description of both the deployment's shape and its
 * current load — reconnaissance, handed out for free, on a path every scanner tries.
 *
 * So a token is required. And when no token is configured in production the route is not
 * registered at all, rather than registered and refusing: a 403 from `/metrics` confirms
 * both that this software is running here and that somebody meant to expose metrics, while a
 * 404 is what every other absent path returns. `config.ts` warns at boot that metrics are
 * unavailable in that case, so the silence is never a surprise to the operator.
 *
 * Outside production a missing token leaves the route open, because the alternative is that
 * a developer's first encounter with the metric they just added is a 404.
 *
 * ## Why it is rate limited like anything else
 *
 * `/health` is exempt because an orchestrator must never be told to slow down about
 * liveness. Nothing depends on `/metrics` that way — a scrape that is refused is retried in
 * fifteen seconds — and an unauthenticated caller guessing at the token should be counted.
 */
function registerMetricsRoute(app: FastifyInstance, config: AppConfig, metrics: AppMetrics): void {
  const token = config.metricsToken;
  if (token === null && config.isProduction) return;

  // Synchronous on purpose. Rendering the exposition is a string build over in-memory
  // counters — there is nothing to await — and a handler declared `async` with no `await`
  // reads as though it were doing I/O that an operator might then go looking for.
  app.get('/metrics', (request, reply) => {
    if (token !== null && !metricsTokenAccepted(request, token)) {
      request.log.warn({}, 'metrics scrape refused: bad or missing token');
      // Returning the reply is how Fastify is told the response is already handled.
      return reply.status(401).send(apiErrorBody('not_authenticated', request.id));
    }
    reply.header('content-type', METRICS_CONTENT_TYPE);
    // Explicit, although the security layer's `onSend` hook would set it for an
    // unauthenticated request anyway: a scrape held in a shared cache is a scrape that
    // reports a stale process as healthy.
    reply.header('cache-control', 'no-store');
    return reply.send(metrics.render());
  });
}

/**
 * Constant-time bearer check for the scrape token.
 *
 * Separate from `security.ts`'s equivalent rather than shared, because the two guard
 * different things and merging them would put a single helper between two independent
 * credentials — the kind of coupling that turns one mistake into two vulnerabilities.
 */
function metricsTokenAccepted(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Registers route modules under `API_PREFIX`.
 *
 * Each module gets its own encapsulated child instance, which is what makes a route-scoped
 * hook or decorator possible without leaking to the rest of the API. Instance-level hooks
 * from the security layer still apply, because encapsulation inherits downwards.
 */
export async function registerRoutes(app: FastifyInstance, modules: readonly RouteModule[]): Promise<void> {
  for (const module of modules) {
    await app.register(module, { prefix: API_PREFIX });
  }
}

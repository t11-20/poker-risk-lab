/**
 * `buildApp()` — the assembled Fastify instance, with nothing in it that talks to a table.
 *
 * This is the foundation the route modules, the WebSocket hub, the bots and the
 * repositories plug into. It owns the order things are registered in, because that order is
 * load-bearing (see the hook-order note in `plugins/security.ts`), and it owns the two
 * endpoints that must exist before any feature does: liveness and readiness.
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

import type { HealthResponse, ReadinessResponse } from '@prl/contracts';
import { ALL_SCHEMAS, PROTOCOL_VERSION } from '@prl/contracts';
import type { FastifyInstance, FastifyPluginAsync, FastifyServerOptions } from 'fastify';
import Fastify from 'fastify';
import { type AppConfig, getConfig } from './config.ts';
import { type DatabaseHandle, database as defaultDatabase } from './db.ts';
import { registerErrorHandlers } from './errors.ts';
import { buildLoggerOptions } from './logging.ts';
import { generateRequestId, requestContextPlugin } from './plugins/request-context.ts';
import { securityPlugin, securityServerOptions } from './plugins/security.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** The frozen configuration this instance was built with. */
    appConfig: AppConfig;
    /** The database seam. A stub in tests; the real pool in production. */
    appDatabase: DatabaseHandle;
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

function readinessResponse(check: { readonly ok: boolean; readonly detail?: string }): ReadinessResponse {
  const database: { ok: boolean; detail?: string } = { ok: check.ok };
  if (check.detail !== undefined) database.detail = check.detail;
  return { status: check.ok ? 'ready' : 'degraded', checks: { database } };
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
 * 5. Health and readiness.
 */
export async function buildApp(overrides: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = overrides.config ?? getConfig();
  const db = overrides.database ?? defaultDatabase;

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

  await app.register(requestContextPlugin, { config });
  await app.register(securityPlugin, { config });

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
   */
  app.get('/api/v1/health', { config: { rateLimit: false } }, async () => healthResponse());

  app.get('/api/v1/ready', async (_request, reply) => {
    const check = await db.ping();
    if (!check.ok) {
      // Logged here rather than returned: the caller gets a fixed string, the operator gets
      // the reason.
      app.log.warn({ check }, 'readiness check failed');
    }
    // 503 while degraded, so a load balancer stops sending traffic without needing to parse
    // the body.
    reply.status(check.ok ? 200 : 503);
    return readinessResponse(check);
  });

  return app;
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

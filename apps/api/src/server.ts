/**
 * The process entry point. Shutdown stops accepting, lets in-flight requests finish, lets the hub
 * send `serverShuttingDown` (`onClose`), closes the pool, all under a deadline. A crash
 * (`uncaughtException`, `unhandledRejection`) exits non-zero, because continuing could serve
 * authoritative game state that is half updated.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { type AppConfig, ConfigError, getConfig } from './config.ts';
import {
  closeDatabase,
  configureDatabase,
  type DbCheck,
  getSql,
  PROBE_QUERY_DEADLINE_MS,
  ping,
} from './db.ts';
import { startRetentionSweep } from './maintenance/retention-sweep.ts';
import { appMetrics } from './observability/metrics.ts';
import { API_ROUTE_MODULES, registerApiRoutes } from './routes/index.ts';
import { createSchemaGate, describeRefusal, readLedger } from './schema-guard.ts';
import { beginSharedPoolWarmup, closeSharedPool } from './workers/pool.ts';

const EXIT_CONFIG_INVALID = 78; // sysexits.h EX_CONFIG
const EXIT_STARTUP_FAILED = 1;
const EXIT_SHUTDOWN_FAILED = 1;
const EXIT_CRASHED = 1;

/** A second SIGTERM must not start a second shutdown and half-close the pool. */
let shuttingDown = false;

/** Module scope, because `shutdown` is a signal handler. Undefined until `listen` succeeds. */
let retention: { stop: () => void } | undefined;

/**
 * The process re-checks the schema gate itself, so a deployment with no readiness probe still
 * reopens after a degraded boot and notices a database swapped behind the DSN. One identity read
 * per tick, and short enough for `Retry-After` to promise.
 */
const SCHEMA_RECHECK_INTERVAL_MS = 5_000;

let schemaRecheck: NodeJS.Timeout | undefined;

/**
 * `forceCloseConnections: 'idle'` closes idle sockets only once, at `app.close()`. A keep-alive
 * socket that was mid-request then sat for `keepAliveTimeout` (72 s), `app.close()` never resolved
 * and every browser-driven deploy exited 1. So the drain sweeps repeatedly.
 */
const IDLE_SWEEP_INTERVAL_MS = 25;

/**
 * How long a client still sending its request may take once the drain begins. A request held in
 * full may use the whole grace, one still arriving gets this. Capped at 1 s (as `ws/hub.ts` caps
 * its close wait) and not refreshed as bytes arrive, so a trickling client cannot hold a deploy open.
 */
function clientSendGraceMs(shutdownGraceMs: number): number {
  return Math.min(1_000, Math.ceil(shutdownGraceMs / 4));
}

interface TrackedConnection {
  /** Requests on this connection whose response has not finished. */
  readonly open: Set<IncomingMessage>;
  upgraded: boolean;
}

type ConnectionRegistry = ReadonlyMap<Duplex, TrackedConnection>;

/**
 * `closeIdleConnections()` never drops a connection that has not started a request, and
 * `server.close()` waits for it. A silent TCP connection (a health probe, a scanner) held every
 * drain for the whole grace. Node exposes no connection list, so this registry is installed before
 * `listen()`.
 */
function trackConnections(app: FastifyInstance): ConnectionRegistry {
  const server = app.server;
  const tracked = new Map<Duplex, TrackedConnection>();

  server.on('connection', (socket: Duplex) => {
    tracked.set(socket, { open: new Set<IncomingMessage>(), upgraded: false });
    socket.once('close', () => {
      tracked.delete(socket);
    });
  });

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const connection = tracked.get(request.socket);
    // Cannot happen once installed before `listen()`. If it does, Node's own sweep still applies.
    if (connection === undefined) return;
    connection.open.add(request);
    const forget = (): void => {
      connection.open.delete(request);
    };
    // Both, or a request whose socket died first would block the drain forever.
    response.once('finish', forget);
    response.once('close', forget);
  });

  server.on('upgrade', (_request: IncomingMessage, socket: Duplex) => {
    const connection = tracked.get(socket);
    if (connection !== undefined) connection.upgraded = true;
  });

  return tracked;
}

/** Wrong one way and a deploy hangs, wrong the other and a learner's answer is cut off. */
function isDrainBlocking(connection: TrackedConnection, mayStillBeSending: boolean): boolean {
  // The hub closes WebSockets with `serverShuttingDown` (`ws/hub.ts`). Destroying one here would
  // beat that frame and hand the client a 1006.
  if (connection.upgraded) return true;
  for (const request of connection.open) {
    if (request.complete) return true;
    if (mayStillBeSending) return true;
  }
  return false;
}

/**
 * Drops connections as they stop blocking the drain, per `isDrainBlocking`. The name is referenced
 * by `plugins/security.ts`. `keepAliveTimeout` is collapsed so no socket outlives its request.
 */
function drainIdleConnections(
  app: FastifyInstance,
  connections: ConnectionRegistry,
  shutdownGraceMs: number,
): () => void {
  const server = app.server;
  const previousKeepAlive = server.keepAliveTimeout;
  server.keepAliveTimeout = 1;
  const sendGraceEndsAt = Date.now() + clientSendGraceMs(shutdownGraceMs);
  const sweep = setInterval(() => {
    // Redundant with the loop below, kept in case the registry ever misses a connection.
    server.closeIdleConnections();
    const mayStillBeSending = Date.now() < sendGraceEndsAt;
    for (const [socket, connection] of connections) {
      if (isDrainBlocking(connection, mayStillBeSending)) continue;
      // Destroyed, not answered. There is no complete message to reply to.
      socket.destroy();
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  sweep.unref();
  return () => {
    clearInterval(sweep);
    server.keepAliveTimeout = previousKeepAlive;
  };
}

async function shutdown(
  app: FastifyInstance,
  config: AppConfig,
  connections: ConnectionRegistry,
  reason: string,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ reason }, 'shutting down');

  const deadline = setTimeout(() => {
    app.log.error({ reason, graceMs: config.shutdownGraceMs }, 'shutdown timed out; exiting hard');
    process.exit(EXIT_SHUTDOWN_FAILED);
  }, config.shutdownGraceMs);
  deadline.unref();

  // Both would otherwise hold a pooled connection that `closeDatabase` is about to wait for.
  retention?.stop();
  if (schemaRecheck !== undefined) clearInterval(schemaRecheck);

  const stopDraining = drainIdleConnections(app, connections, config.shutdownGraceMs);
  try {
    await app.close();
    await closeDatabase(Math.floor(config.shutdownGraceMs / 2));
    // Normally a no-op after `routes/calc.ts`'s `onClose` hook. Here so live threads never depend
    // on a route module being wired.
    await closeSharedPool();
    clearTimeout(deadline);
    app.log.info({ reason }, 'shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(deadline);
    app.log.error({ err: error, reason }, 'shutdown failed');
    await closeSharedPool().catch(() => undefined);
    process.exit(EXIT_SHUTDOWN_FAILED);
  } finally {
    stopDraining();
  }
}

function installProcessHandlers(
  app: FastifyInstance,
  config: AppConfig,
  connections: ConnectionRegistry,
): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(app, config, connections, signal);
    });
  }

  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'uncaught exception; exiting');
    // No graceful shutdown. The process is in an unknown state.
    process.exit(EXIT_CRASHED);
  });

  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'unhandled rejection; exiting');
    process.exit(EXIT_CRASHED);
  });
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = getConfig();
  } catch (error) {
    // No logger yet. `ConfigError.message` lists every problem.
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(EXIT_CONFIG_INVALID);
    }
    console.error('configuration could not be read', error);
    process.exit(EXIT_CONFIG_INVALID);
  }

  // Wired here, not as `buildApp` defaults, because every test builds through `buildApp`.
  // See `schema-guard.ts`.
  const schema = createSchemaGate({
    readLedger: () => readLedger(getSql()),
    probeDeadlineMs: PROBE_QUERY_DEADLINE_MS,
    onDatabaseChanged: () => {
      app.log.warn(
        'a different database is answering DATABASE_URL; feature routes answer 503 until its schema is verified',
      );
    },
    onVerdictChanged: (verdict) => {
      if (verdict.kind === 'current') {
        app.log.info({ applied: verdict.applied, ahead: verdict.ahead }, 'database schema verified; serving');
      } else if (verdict.kind === 'refused') {
        // After boot this does not exit, so this line and the 503s are all an operator gets.
        app.log.error({ problems: verdict.problems, fix: verdict.fix }, verdict.summary);
      } else {
        app.log.warn({ reason: verdict.reason }, 'database schema not verified');
      }
    },
  });
  const probeDatabase = async (): Promise<DbCheck> => schema.readiness(await ping());
  const app = await buildApp({
    config,
    database: { ping: probeDatabase, close: closeDatabase },
    featureGate: { admits: schema.admits, retryAfterSeconds: SCHEMA_RECHECK_INTERVAL_MS / 1_000 },
  });
  const connections = trackConnections(app);
  installProcessHandlers(app, config, connections);

  for (const warning of config.warnings) {
    app.log.warn({ warning }, 'configuration warning');
  }

  // With the logger attached, so Postgres notices go through the redaction in `logging.ts`.
  configureDatabase(config, {
    onNotice: (message) => {
      app.log.warn({ notice: message }, 'postgres notice');
    },
  });

  // A database that answers with a schema behind this build is refused before any route exists.
  // One that does not answer is served degraded (`db-unavailable.md`). `console.error`, because the
  // logger is off under `test` and a refusal nobody can read is a silent exit 78.
  const verdict = await schema.verify();
  if (verdict.kind === 'refused') {
    console.error(describeRefusal(verdict));
    await closeDatabase(1_000);
    process.exit(EXIT_CONFIG_INVALID);
  }
  if (verdict.kind === 'unverified') {
    app.log.warn(
      { reason: verdict.reason },
      'database schema not verified at boot; /ready reports degraded until the migration ledger answers',
    );
  } else if (verdict.ahead.length > 0) {
    // Normal during a deploy or rollback, and also what an old build on someone else's database looks like.
    app.log.warn(
      { applied: verdict.applied, ahead: verdict.ahead },
      'database schema is ahead of this build: a newer build migrated it; serving, since migrations are additive',
    );
  } else {
    app.log.info({ applied: verdict.applied }, 'database schema matches this build');
  }
  // The `catch` keeps a future rejecting `readiness` from becoming a fatal unhandled rejection.
  schemaRecheck = setInterval(() => {
    probeDatabase().catch(() => undefined);
  }, SCHEMA_RECHECK_INTERVAL_MS);
  schemaRecheck.unref();

  try {
    // After `configureDatabase`, because the session store needs the pool.
    await registerApiRoutes(app);
    // Warmed before `listen`, or a request arriving during the table build could spend its whole
    // budget queued. About 3.3 s for four threads on the reference host.
    await beginSharedPoolWarmup(config, {
      onWarn: (warning) => {
        app.log.warn({ poolEvent: warning.event, poolDetail: warning.detail }, 'calculation pool');
      },
    });
    const address = await app.listen({ port: config.port, host: config.host });

    // After `listen`, so a sweep never delays accepting traffic. See `maintenance/retention-sweep.ts`.
    retention = startRetentionSweep({
      sql: getSql,
      onSwept: (result) => {
        // `info`, because this line is the evidence that the retention promise is kept.
        app.log.info(
          {
            sweptSessions: result.sessions,
            sweptLoginAttempts: result.loginAttempts,
            sweptGuestAccounts: result.guestAccounts,
            sweepGuestsBlocked: result.guestAccountsBlocked,
            sweepIncomplete: result.incomplete,
            sweepMs: Math.round(result.durationMs),
          },
          'retention sweep',
        );
        // Only a finished sweep reaches this, which is what the age gauge's alert relies on.
        appMetrics().markRetentionSweep(result);
      },
      onGuestBlocked: (userId, error) => {
        // The id is a log field so it never becomes a metric label.
        app.log.warn({ err: error, userId }, 'retention sweep could not erase a guest account');
      },
      onProblem: (error) => {
        // Never fatal. The next tick tries again.
        app.log.warn({ err: error }, 'retention sweep failed');
      },
    });
    app.log.info(
      {
        address,
        nodeEnv: config.nodeEnv,
        oidcEnabled: config.oidcEnabled,
        allowedOrigins: config.webOrigins,
        routeModules: API_ROUTE_MODULES.length,
      },
      'listening',
    );
  } catch (error) {
    app.log.fatal({ err: error }, 'failed to start');
    await closeSharedPool().catch(() => undefined);
    await closeDatabase(1_000);
    process.exit(EXIT_STARTUP_FAILED);
  }
}

/** Boot only as the entry point, so importing this file never opens a port. */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}

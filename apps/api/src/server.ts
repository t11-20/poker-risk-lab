/**
 * The process entry point: boot, listen, and stop cleanly.
 *
 * ## Why shutdown gets this much code
 *
 * A play-money poker table is stateful. When this process goes away mid-hand, every
 * connected client is holding a view of a hand that will never advance. The difference
 * between a good deploy and a bad one is whether in-flight requests were allowed to finish
 * and sockets were told to reconnect, or whether the socket simply died. So:
 *
 *   1. Stop accepting new connections and let in-flight requests finish (`app.close()`,
 *      which also runs every `onClose` hook — that is where the WebSocket hub will send its
 *      `serverShuttingDown` close frames).
 *   2. Close the database pool, so no connection is left half-open against Postgres.
 *   3. Give the whole thing a deadline. A shutdown that hangs is worse than one that is
 *      abrupt, because an orchestrator will eventually SIGKILL anyway — with no log line
 *      saying why.
 *
 * ## Why a crash exits instead of continuing
 *
 * `uncaughtException` and `unhandledRejection` mean some part of the process is in a state
 * nobody designed. For a server holding authoritative game state, "carry on and hope" is the
 * worst option: the next request could be served from half-updated state, and the bug
 * becomes a wrong pot rather than a stack trace. Log everything, then exit non-zero and let
 * the supervisor start a clean process.
 */

import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { type AppConfig, ConfigError, getConfig } from './config.ts';
import { closeDatabase, configureDatabase } from './db.ts';
import { API_ROUTE_MODULES, registerApiRoutes } from './routes/index.ts';
import { closeSharedPool } from './workers/pool.ts';

/** Exit codes, so a supervisor's logs mean something. */
const EXIT_CONFIG_INVALID = 78; // sysexits.h EX_CONFIG
const EXIT_STARTUP_FAILED = 1;
const EXIT_SHUTDOWN_FAILED = 1;
const EXIT_CRASHED = 1;

/**
 * Runs once, whatever arrives. Two SIGTERMs in quick succession are normal (a supervisor
 * retrying), and a second shutdown starting while the first is still closing sockets is how
 * a clean stop turns into a half-closed pool.
 */
let shuttingDown = false;

/**
 * How often, during a drain, to drop sockets that have just become idle.
 *
 * ## Why a repeating sweep is needed at all
 *
 * `forceCloseConnections: 'idle'` (see `plugins/security.ts`) makes Fastify call Node's
 * `closeIdleConnections()` ONCE, at the moment `app.close()` is invoked. A keep-alive socket that
 * was *mid-request* when SIGTERM arrived is not idle at that moment, so it is not dropped — and it
 * is never revisited. When its response finishes, the socket goes idle and then simply sits there
 * until `keepAliveTimeout` (72 s) expires, which is far beyond any deploy grace. `server.close()`
 * waits for every connection to end, so `app.close()` never resolves: the `onClose` hooks never
 * run, the worker threads are never terminated, and the deadline below fires and exits 1 — with the
 * in-flight request having been answered 200. Browsers always use keep-alive, so that was the
 * normal deploy case, and a `Connection: close` client hid it completely.
 *
 * So the sweep runs for the duration of the drain and drops each socket as soon as it is idle.
 * 25 ms is short enough that a finished request is dropped promptly and long enough to be free.
 */
const IDLE_SWEEP_INTERVAL_MS = 25;

/**
 * Drops sockets as they become idle, until the returned function is called.
 *
 * `keepAliveTimeout` is also collapsed for the duration: it is what tells Node how long to hold a
 * finished keep-alive socket open, and during a shutdown the answer is "not at all". Both together
 * mean a socket cannot outlive the request it was serving.
 */
function drainIdleConnections(app: FastifyInstance): () => void {
  const server = app.server;
  const previousKeepAlive = server.keepAliveTimeout;
  server.keepAliveTimeout = 1;
  const sweep = setInterval(() => {
    server.closeIdleConnections();
  }, IDLE_SWEEP_INTERVAL_MS);
  // So the sweep alone can never be the reason the process stays alive.
  sweep.unref();
  return () => {
    clearInterval(sweep);
    server.keepAliveTimeout = previousKeepAlive;
  };
}

async function shutdown(app: FastifyInstance, config: AppConfig, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ reason }, 'shutting down');

  // The deadline. `unref()` so this timer alone cannot keep the process alive if everything
  // else finishes first.
  const deadline = setTimeout(() => {
    app.log.error({ reason, graceMs: config.shutdownGraceMs }, 'shutdown timed out; exiting hard');
    process.exit(EXIT_SHUTDOWN_FAILED);
  }, config.shutdownGraceMs);
  deadline.unref();

  const stopDraining = drainIdleConnections(app);
  try {
    await app.close();
    // Half the remaining grace for the pool: a query that has not finished by now is not
    // going to, and holding the process open for it only delays the SIGKILL.
    await closeDatabase(Math.floor(config.shutdownGraceMs / 2));
    // Belt and braces. `routes/calc.ts` registers an `onClose` hook that closes the pool, so this
    // is normally a no-op (`closeSharedPool` is idempotent). It is here anyway because the failure
    // it guards against is silent and expensive: if that module is ever not registered, or its hook
    // ordering changes, the process would exit with four live worker threads and the only symptom
    // would be a deploy that hangs. Closing the pool on the shutdown path itself does not depend on
    // any route module having been wired.
    await closeSharedPool();
    clearTimeout(deadline);
    app.log.info({ reason }, 'shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(deadline);
    app.log.error({ err: error, reason }, 'shutdown failed');
    // The threads outlive a failed drain otherwise, and this is the last code that runs.
    await closeSharedPool().catch(() => undefined);
    process.exit(EXIT_SHUTDOWN_FAILED);
  } finally {
    stopDraining();
  }
}

function installProcessHandlers(app: FastifyInstance, config: AppConfig): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(app, config, signal);
    });
  }

  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'uncaught exception; exiting');
    // No graceful shutdown here on purpose: the process is already in an unknown state, and
    // running more of our own code through it can make things worse. Flush and go.
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
    // No logger yet — this is the one place a bare console write is the right answer, because
    // the alternative is a process that dies silently. `ConfigError.message` already lists
    // every problem.
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(EXIT_CONFIG_INVALID);
    }
    console.error('configuration could not be read', error);
    process.exit(EXIT_CONFIG_INVALID);
  }

  const app = await buildApp({ config });
  installProcessHandlers(app, config);

  for (const warning of config.warnings) {
    app.log.warn({ warning }, 'configuration warning');
  }

  // Created here, once, with the logger attached — so Postgres notices go through the
  // redaction in `logging.ts` instead of to stdout. Everything else in the codebase reaches
  // this same pool through `getSql()`.
  configureDatabase(config, {
    onNotice: (message) => {
      app.log.warn({ notice: message }, 'postgres notice');
    },
  });

  try {
    // Registers every route module under `API_PREFIX`, and the process-wide state more than one of
    // them expects: the session plugin on the root instance, and the room registry bound to the
    // Postgres archive. See `src/routes/index.ts` for why neither can be done per module. It has to
    // run after `configureDatabase` above, because the session store needs the pool.
    await registerApiRoutes(app);
    const address = await app.listen({ port: config.port, host: config.host });
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
    await closeDatabase(1_000);
    process.exit(EXIT_STARTUP_FAILED);
  }
}

/**
 * Only boot when this file is the process entry point.
 *
 * Without the guard, importing anything from here — a test reaching for `shutdown`, a script
 * reusing a constant — would start listening on a port as a side effect of the import.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}

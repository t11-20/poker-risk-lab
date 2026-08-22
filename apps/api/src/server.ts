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

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { type AppConfig, ConfigError, getConfig } from './config.ts';
import { closeDatabase, configureDatabase } from './db.ts';
import { API_ROUTE_MODULES, registerApiRoutes } from './routes/index.ts';
import { beginSharedPoolWarmup, closeSharedPool } from './workers/pool.ts';

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
 * How often, during a drain, to drop sockets that are no longer holding work of ours.
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
 * So the sweep runs for the duration of the drain and drops each socket as soon as it stops being
 * one the drain owes anything. 25 ms is short enough that a finished request is dropped promptly
 * and long enough to be free.
 */
const IDLE_SWEEP_INTERVAL_MS = 25;

/**
 * How long, once a drain has begun, a client that is still *sending* a request may take to finish
 * sending it before its connection is dropped anyway.
 *
 * ## Why waiting for a client has to be bounded separately from waiting for ourselves
 *
 * A drain owes an answer to every request it has actually received. It owes nothing to a client
 * that has announced a request and then gone quiet — and it cannot tell the two apart except by
 * waiting, because at the instant of the signal "half the body sent, rest coming" and "headers sent,
 * body never coming" are the same socket in the same state. So the two halves get different
 * budgets: a request we hold in full may use the whole grace to be computed and delivered, while a
 * request still arriving gets this much and no more.
 *
 * Capped at a second so it can never be a large share of any grace — the same ceiling `ws/hub.ts`
 * puts on waiting for a close handshake, for the same reason — and derived from the grace rather
 * than fixed so a deliberately short grace shortens it too. A quarter is generous next to the round
 * trip it has to cover: the sole legitimate client here is one whose body is mid-flight on an
 * already-open socket, and `bodyLimitBytes` caps that at 64 KiB.
 *
 * Measured from the moment the drain begins, and deliberately NOT refreshed when more of the body
 * arrives. Refreshing would be kinder to a genuinely slow uploader, and it would also hand a client
 * that trickles one byte at a time the power to hold a deploy open until the deadline — which is
 * the defect this whole file exists to close, reintroduced through the door marked "fairness". An
 * absolute bound means the drain stops waiting for clients at a known instant, whatever they do.
 * The cost is that a very slow upload loses its request during a deploy and has to retry, which is
 * a far smaller thing than a deploy that cannot finish.
 */
function clientSendGraceMs(shutdownGraceMs: number): number {
  return Math.min(1_000, Math.ceil(shutdownGraceMs / 4));
}

/** What the drain needs to know about one connection that Node is still counting. */
interface TrackedConnection {
  /** Requests handed to the application on this connection whose response has not finished. */
  readonly open: Set<IncomingMessage>;
  /** Set once the connection has left HTTP for the WebSocket protocol; see `isDrainBlocking`. */
  upgraded: boolean;
}

/** Every connection currently open, keyed by its socket. Kept by `trackConnections` below. */
type ConnectionRegistry = ReadonlyMap<Duplex, TrackedConnection>;

/**
 * Records what each open connection is doing, from before the first one is accepted.
 *
 * ## Why this bookkeeping has to exist
 *
 * Node's `closeIdleConnections()` only drops a connection that has **finished** a request and is
 * sitting between requests. A connection that never started one is invisible to it — and to
 * `server.close()`, which counts it and waits for it regardless. So a TCP connection that connects
 * and says nothing at all held the drain open for the entire grace and turned every deploy into
 * `process.exit(1)`, exactly as the mid-request keep-alive socket above once did. That is not an
 * exotic client: a load balancer's TCP health probe, a port scanner, a TLS handshake that stalls,
 * or any client that opens a connection slightly before it is ready to use it produces one, and a
 * busy service always has some.
 *
 * There is no public API that enumerates a Node server's connections, so the drain cannot ask after
 * the fact — hence a registry built as connections arrive. It is installed before `listen()` so no
 * connection can predate it, and it is three event listeners and a `Map`, which costs nothing
 * measurable next to serving the request itself.
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
    // A connection this registry never saw cannot happen once it is installed before `listen()`.
    // Returning rather than throwing is still the right answer: the cost of being wrong is one
    // connection the sweep treats as Node's `closeIdleConnections()` already treats it.
    if (connection === undefined) return;
    connection.open.add(request);
    const forget = (): void => {
      connection.open.delete(request);
    };
    // `finish` for a response that was delivered, `close` for one whose socket died first. Both,
    // because a request left in this set after its response is gone would block the drain forever.
    response.once('finish', forget);
    response.once('close', forget);
  });

  server.on('upgrade', (_request: IncomingMessage, socket: Duplex) => {
    const connection = tracked.get(socket);
    if (connection !== undefined) connection.upgraded = true;
  });

  return tracked;
}

/**
 * Whether a connection is a legitimate reason for the drain to still be waiting.
 *
 * Everything else is dropped. The three cases that are NOT dropped are the whole point of the
 * distinction — get it wrong in one direction and a deploy hangs, in the other and a learner's
 * request is cut off mid-answer.
 */
function isDrainBlocking(connection: TrackedConnection, mayStillBeSending: boolean): boolean {
  // A WebSocket belongs to the hub, which closes it with `WS_CLOSE.serverShuttingDown` in its
  // `preClose` hook and terminates it if the peer does not answer (`ws/hub.ts`). Destroying it here
  // would beat that close frame to the socket and hand every client a 1006 — indistinguishable from
  // a lost network, which is precisely the failure that hook exists to prevent.
  if (connection.upgraded) return true;
  for (const request of connection.open) {
    // We hold this request in full, so we owe an answer to it and the grace is what that is for.
    if (request.complete) return true;
    // It is still arriving. Wait, but only until the send grace is up: a stalled client must not be
    // able to hold a deploy open, and one whose body is genuinely in flight lands well inside it.
    if (mayStillBeSending) return true;
  }
  return false;
}

/**
 * Drops connections as they stop blocking the drain, until the returned function is called.
 *
 * "Idle" in the name is Node's word, and this is wider than Node's meaning of it: see
 * `isDrainBlocking`. The name is kept because `plugins/security.ts` points at this function by it.
 *
 * `keepAliveTimeout` is also collapsed for the duration: it is what tells Node how long to hold a
 * finished keep-alive socket open, and during a shutdown the answer is "not at all". Both together
 * mean a socket cannot outlive the request it was serving.
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
    // Node's own narrow sweep first. It is redundant with the loop below by construction and kept
    // deliberately: it is the documented behaviour of `forceCloseConnections: 'idle'`, and if the
    // registry ever missed a connection it still drops the ordinary keep-alive case.
    server.closeIdleConnections();
    const mayStillBeSending = Date.now() < sendGraceEndsAt;
    for (const [socket, connection] of connections) {
      if (isDrainBlocking(connection, mayStillBeSending)) continue;
      // Destroyed rather than answered: a connection that has sent nothing, or half a request, has
      // no complete message to reply to, and one Fastify has already dispatched owns a response
      // object we must not write around. `server.close()` stops counting it once it is gone.
      socket.destroy();
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  // So the sweep alone can never be the reason the process stays alive.
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

  // The deadline. `unref()` so this timer alone cannot keep the process alive if everything
  // else finishes first.
  const deadline = setTimeout(() => {
    app.log.error({ reason, graceMs: config.shutdownGraceMs }, 'shutdown timed out; exiting hard');
    process.exit(EXIT_SHUTDOWN_FAILED);
  }, config.shutdownGraceMs);
  deadline.unref();

  const stopDraining = drainIdleConnections(app, connections, config.shutdownGraceMs);
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
  // Before `listen()`, so that no connection can be accepted that the drain cannot see.
  const connections = trackConnections(app);
  installProcessHandlers(app, config, connections);

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
    // Fired, not awaited: `/health` can answer as soon as we listen, `/ready` stays 503 until
    // every calculation thread has built its strength table. Awaiting here would delay
    // liveness by the same ~3s the first Coach used to stall the event loop for.
    void beginSharedPoolWarmup(config, {
      onWarn: (warning) => {
        app.log.warn({ poolEvent: warning.event, poolDetail: warning.detail }, 'calculation pool');
      },
    }).catch((error: unknown) => {
      app.log.error({ err: error }, 'calculation worker warmup failed');
    });
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

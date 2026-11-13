/**
 * The WebSocket upgrade, which decides who may open a socket and for whom.
 * The same-origin policy does not apply to WebSockets. A browser opens `wss://` from any site with our
 * cookies attached, CORS does not cover the handshake, and page script cannot set the CSRF header. The
 * `Origin` header is the only signal, so it is checked first and a mismatch closes `4406`. A missing one
 * also closes, because every browser sends it and this API serves only its own web app.
 * Identity comes from the signed cookie, never from a frame, and it is checked once at the upgrade.
 * REST re-reads the row through `findValidByToken` on every request, a socket does not, so revocation
 * (`onSessionRevoked`) and the row's `expires_at` (per frame and on the heartbeat) both close `4401`.
 * Frames are validated with Fastify's own Ajv, so socket and REST agree on the contract. That compiler
 * exists only once a route has a schema, hence the upgrade's closed `querystring` schema.
 */

import { randomUUID } from 'node:crypto';
import websocketPlugin from '@fastify/websocket';
import type { WsClientMessage } from '@prl/contracts';
import { WS_CLOSE, WS_LIMITS, wsClientMessageSchema } from '@prl/contracts';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { onSessionRevoked, type SessionStore, sessionPlugin } from '../auth/session.ts';
import { getSql } from '../db.ts';
import type { AppMetrics } from '../observability/metrics.ts';
import { recordSecurityAudit } from '../observability/telemetry.ts';
import { isAllowedOrigin } from '../plugins/security.ts';
import { type RoomRegistry, roomRegistry } from '../rooms/registry.ts';
import { systemClock } from '../rooms/timers.ts';
import { createAuthStore } from '../routes/auth.ts';
import {
  type FrameValidation,
  type FrameValidator,
  type SocketSink,
  type WsConnection,
  WsRouter,
} from './router.ts';

/** The upgrade path, under `API_PREFIX`. */
export const WS_PATH = '/ws';

/**
 * A memory backstop above our own limit. `WS_LIMITS.maxMessageBytes` is enforced in the router so an
 * oversized frame gets the documented close code instead of the library's 1009.
 */
const LIBRARY_PAYLOAD_CEILING = WS_LIMITS.maxMessageBytes * 4;

/** Matched on `code`, which is documented `ws` API. The message is prose the library may reword. */
const WS_LIBRARY_OVERSIZE_CODE = 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';

/** True when `ws` refused a frame for being larger than `LIBRARY_PAYLOAD_CEILING`. */
export function isOversizedFrameError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === WS_LIBRARY_OVERSIZE_CODE
  );
}

/** A socket that missed this many heartbeats is gone. */
const MISSED_HEARTBEATS_ALLOWED = 2;

/**
 * Label values for `prl_websocket_refused_total`, a closed set. Each is a different incident. The
 * client-facing `reason` is prose and must never be a label.
 */
export type WsRefusalReason = 'bad_origin' | 'unauthenticated' | 'rate_limited';

/**
 * Server codes come from `WS_CLOSE`, the rest are codes a peer can produce. Anything else is `other`,
 * because a client-chosen two-byte code would otherwise mint 65,536 series.
 */
const KNOWN_CLOSE_CODES: ReadonlySet<number> = new Set<number>([
  ...Object.values(WS_CLOSE),
  1001,
  1005,
  1006,
  1009,
  1011,
]);

export function closeCodeLabel(code: number): string {
  return KNOWN_CLOSE_CODES.has(code) ? String(code) : 'other';
}

/**
 * How long a peer gets to answer a close frame. `ws`'s own fallback is 30 s, three times the default
 * `SHUTDOWN_GRACE_MS`, so one unanswered close would turn a deploy into a SIGKILL. A tenth of the grace
 * leaves the rest for the database pool and worker threads.
 */
function closeHandshakeGraceMs(shutdownGraceMs: number): number {
  return Math.min(1_000, Math.ceil(shutdownGraceMs / 10));
}

/** `unref`'d so it never holds the process open. `terminate` on a closed socket is a no-op. */
function dropUnlessAnswered(socket: { readonly terminate: () => void }, graceMs: number): NodeJS.Timeout {
  const drop = setTimeout(() => socket.terminate(), graceMs);
  drop.unref();
  return drop;
}

/** Only what the heartbeat needs from a socket, so no `ws` type is named in this module. */
interface Heartbeat {
  readonly ping: () => void;
  readonly terminate: () => void;
}

export interface WsHubOptions {
  /** Defaults to the process-wide registry, which the room routes share. */
  readonly registry?: RoomRegistry;
  /** Session persistence, for the module to stand on its own. Tests pass a fake. */
  readonly sessionStore?: SessionStore;
  /** Test seam, so a test can reach the router without opening a socket. */
  readonly onRouterReady?: (router: WsRouter) => void;
  /** Defaults to the process-wide metrics. A test that wants isolation passes its own. */
  readonly metrics?: AppMetrics;
  /**
   * Test seam for the sweep interval. Defaults to `WS_LIMITS.heartbeatIntervalMs` (15 s), at which no
   * test reached the quiet-socket expiry check, and removing that check left the suite green.
   */
  readonly heartbeatIntervalMs?: number;
}

/** Compiled lazily, because `app.validatorCompiler` is populated only after this plugin's body runs. */
export function compileFrameValidator(app: FastifyInstance): FrameValidator {
  let compiled: ((value: unknown) => unknown) | null = null;
  return (value: unknown): FrameValidation => {
    if (compiled === null) {
      const compiler = app.validatorCompiler;
      if (compiler === undefined) {
        // Refuse rather than let an unvalidated frame reach the router.
        return { ok: false, problem: 'no validator is available' };
      }
      const validate = compiler({
        schema: { $ref: `${wsClientMessageSchema.$id}#` },
        method: 'POST',
        url: WS_PATH,
        httpPart: 'body',
      });
      compiled = (candidate: unknown) => validate(candidate);
    }
    const outcome = compiled(value);
    if (outcome !== true) return { ok: false, problem: 'frame did not match the protocol schema' };
    // The single place a frame is asserted to be a protocol message.
    return { ok: true, value: value as WsClientMessage };
  };
}

/** An adapter, so `router.ts` knows nothing of `ws` and its tests drive it with two functions. */
function sinkFor(socket: {
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
}): SocketSink {
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  };
}

function originOf(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  return typeof origin === 'string' && origin !== '' ? origin : null;
}

/**
 * Writes a refused upgrade to `prl.audit_log`. A refusal is the `Origin` control firing on the endpoint
 * CORS and CSRF do not protect. Accepted upgrades are ordinary traffic and are not recorded.
 * The address and user agent are refused by `audit_log_detail_has_no_forbidden_keys` and stay in the
 * request log. `recordSecurityAudit` swallows errors, so the record cannot fail the refusal.
 * The global rate limit bounds these INSERTs. If the upgrade route is ever exempted, add a bound here.
 */
function auditRefusal(request: FastifyRequest, refusal: WsRefusalReason, userId: string | null): void {
  const origin = originOf(request);
  recordSecurityAudit(
    {
      event: 'ws.upgrade.refused',
      userId,
      detail: { refusal, ...(origin === null ? {} : { origin }) },
    },
    (message, detail) => request.log.warn({ ...detail }, message),
  );
}

/**
 * Pure, so the refusals are testable without a socket. The socket is already accepted at the protocol
 * level, so the client learns why through the close code.
 */
export function evaluateUpgrade(input: {
  readonly origin: string | null;
  readonly userId: string | null;
  readonly socketsForSession: number;
}):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: number;
      /** For the close frame and the log line. Prose; never a metric label. */
      readonly reason: string;
      /** For the counter and the audit row. One of three values; see `WsRefusalReason`. */
      readonly refusal: WsRefusalReason;
    } {
  if (input.origin === null || !isAllowedOrigin(input.origin)) {
    return { ok: false, code: WS_CLOSE.badOrigin, reason: 'origin not allowed', refusal: 'bad_origin' };
  }
  if (input.userId === null) {
    return { ok: false, code: WS_CLOSE.unauthenticated, reason: 'no session', refusal: 'unauthenticated' };
  }
  if (input.socketsForSession >= WS_LIMITS.maxSocketsPerSession) {
    return { ok: false, code: WS_CLOSE.rateLimited, reason: 'too many sockets', refusal: 'rate_limited' };
  }
  return { ok: true };
}

/** A factory so tests can pass their own registry and session store. The default export takes none. */
export function createWsHub(options: WsHubOptions = {}): FastifyPluginAsync {
  return async (app) => {
    const registry = options.registry ?? roomRegistry();
    // Follow this instance's metrics registry. The process-global fallback would silently drop
    // WebSocket observations from an app built with an injected registry.
    const metrics = options.metrics ?? app.appMetrics;
    const store =
      options.sessionStore ??
      (app.hasRequestDecorator('session') ? null : createAuthStore(getSql()).sessions);
    if (store !== null) await app.register(sessionPlugin, { store });

    /**
     * With `clientTracking: false`, `@fastify/websocket`'s `defaultPreClose` silently skips closing
     * sockets, so the `preClose` hook below closes them. Turning tracking on is not the fix. The
     * library closes with no status (the peer sees 1005, not `serverShuttingDown`) and does not bound
     * the handshake. `live` already indexes every socket.
     */
    await app.register(websocketPlugin, {
      options: { maxPayload: LIBRARY_PAYLOAD_CEILING, clientTracking: false },
    });

    const router = new WsRouter({
      registry,
      clock: systemClock,
      validate: compileFrameValidator(app),
      config: app.appConfig,
      nextRequestId: () => `ws-${randomUUID()}`,
      onProblem: (message, detail) => app.log.warn({ ...detail }, message),
      metrics,
    });
    options.onRouterReady?.(router);

    /**
     * Closes sockets on a room this process was fenced from, which would otherwise stay healthy and
     * silent. `serverShuttingDown` (4503) makes the client reconnect with backoff to the process that
     * owns the room. 4403 would wrongly tell the learner the table is not theirs.
     */
    const stopWatchingEvictions = registry.onEviction((roomId) => {
      app.log.warn({ roomId }, 'room lease lost; closing its sockets');
      router.closeRoom(roomId, WS_CLOSE.serverShuttingDown, 'this table moved to another server');
    });

    /** A practice table replaced by a new one. `normal` (1000), because nothing was lost. */
    const stopWatchingRetirements = registry.onRetirement((roomId) => {
      router.closeRoom(roomId, WS_CLOSE.normal, 'this practice table was replaced by a new one');
    });

    /** Sockets per session, for `maxSocketsPerSession`. */
    const bySession = new Map<string, number>();
    /**
     * Every open socket. `preClose` reads this rather than `router.closeAll`, because a socket that has
     * not sent `hello` is in no room and the router cannot see it. `sessionExpiresAtMs` lives here
     * because `router.ts` knows nothing of sessions.
     */
    const live = new Map<
      string,
      {
        readonly connection: WsConnection;
        readonly heartbeat: Heartbeat;
        readonly sessionExpiresAtMs: number;
      }
    >();

    /**
     * Closes a revoked session's sockets with `4401`, which tells the client to ask for a sign-in.
     * Matching is exact on session id or user id, and a revocation with neither matches nothing, so a
     * missing field can never close every socket.
     */
    const stopWatchingRevocations = onSessionRevoked((revocation) => {
      const { sessionId, userId } = revocation;
      if (sessionId === undefined && userId === undefined) return;
      for (const entry of [...live.values()]) {
        const principal = entry.connection.principal;
        const matches =
          (sessionId !== undefined && principal.sessionId === sessionId) ||
          (userId !== undefined && principal.userId === userId);
        if (!matches) continue;
        app.log.warn({ wsRefusal: 'session revoked' }, 'closing a websocket whose session ended');
        router.closeConnection(entry.connection, WS_CLOSE.unauthenticated, 'session ended');
      }
    });

    // Read from `live` at scrape time. A mirrored count drifts on any exit path nobody instrumented.
    metrics.wsConnections.setFrom(() => live.size);

    const closeGraceMs = closeHandshakeGraceMs(app.appConfig.shutdownGraceMs);

    /**
     * One `unref`'d timer for the hub. A socket that missed two pings is `terminate`d, not closed,
     * because a half-open socket never answers a close handshake.
     */
    const heartbeat = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of [...live]) {
        // Wall-clock session expiry, so a socket that sends nothing still expires.
        if (entry.sessionExpiresAtMs <= now) {
          app.log.warn({ wsRefusal: 'session expired' }, 'closing a websocket whose session expired');
          router.closeConnection(entry.connection, WS_CLOSE.unauthenticated, 'session expired');
          continue;
        }
        if (entry.connection.missedHeartbeats >= MISSED_HEARTBEATS_ALLOWED) {
          entry.heartbeat.terminate();
          router.handleClose(entry.connection);
          live.delete(id);
          continue;
        }
        entry.connection.missedHeartbeats += 1;
        entry.heartbeat.ping();
      }
    }, options.heartbeatIntervalMs ?? WS_LIMITS.heartbeatIntervalMs);
    heartbeat.unref();

    /**
     * Must be `preClose`, not `onClose`. `server.close()` waits for every upgraded socket, so closing
     * them in `onClose` waits until the grace deadline kills the process. Each socket gets a
     * `serverShuttingDown` close frame and is dropped after `closeHandshakeGraceMs`.
     */
    app.addHook('preClose', async () => {
      // Stop pinging first. `ws` reports a ping on a CLOSING socket as an `error` event.
      clearInterval(heartbeat);
      if (live.size === 0) return;

      app.log.info({ sockets: live.size, graceMs: closeGraceMs }, 'closing websockets for shutdown');
      for (const entry of [...live.values()]) {
        // The drop timers are `unref`'d and harmless after close, so they are not cancelled.
        router.closeConnection(entry.connection, WS_CLOSE.serverShuttingDown, 'server shutting down');
        dropUnlessAnswered(entry.heartbeat, closeGraceMs);
      }
      await Promise.resolve();
    });

    app.addHook('onClose', async () => {
      // Also cleared here for a close that never reached `preClose`.
      clearInterval(heartbeat);
      // The registry and the revocation bus outlive this hub when a process builds several apps. A
      // leftover listener would close sockets through a dead router.
      stopWatchingEvictions();
      stopWatchingRetirements();
      stopWatchingRevocations();
      // A backstop. `preClose` has already closed every socket.
      router.closeAll('server shutting down');
      live.clear();
      bySession.clear();
      app.log.info('websocket hub closed');
      await Promise.resolve();
    });

    app.get(
      WS_PATH,
      {
        websocket: true,
        // Takes no parameters, and makes `app.validatorCompiler` exist. See the module comment.
        schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } },
      },
      (socket, request) => {
        /**
         * Replaces `@fastify/websocket`'s `error` listener, which logged any client's oversized frame
         * as a level-50 stack, noise at paging level and an amplification primitive. Added alongside,
         * both listeners would fire, so the old one is removed.
         */
        socket.removeAllListeners('error');
        socket.on('error', (error: Error) => {
          if (!isOversizedFrameError(error)) {
            request.log.warn({ err: error }, 'websocket error');
            return;
          }
          // Same label as the router's own ceiling.
          metrics.wsFramesRejected.inc({ reason: 'too_large' });
          // No `err` field, so one line instead of a stack. The client-chosen size is not echoed.
          request.log.warn({ ceilingBytes: LIBRARY_PAYLOAD_CEILING }, 'websocket frame over the ceiling');
          // Normally a no-op, because `ws` already closed with 1009. Covers the branch where
          // `receiverOnError` skips its close.
          socket.close(WS_CLOSE.rateLimited, 'frame too large');
        });

        const session = request.session;
        const sessionId = session?.sessionId ?? '';
        const decision = evaluateUpgrade({
          origin: originOf(request),
          userId: session?.user.id ?? null,
          socketsForSession: bySession.get(sessionId) ?? 0,
        });
        /**
         * Bounds the close handshake of a refused socket. It is never in `live`, so the drain cannot
         * see it, and one unanswered refusal from any origin would make a deploy miss its grace.
         */
        const refuse = (code: number, reason: string): void => {
          socket.close(code, reason);
          const drop = dropUnlessAnswered(socket, closeGraceMs);
          socket.once('close', () => clearTimeout(drop));
        };

        if (!decision.ok) {
          // Only a close code goes back to the client.
          request.log.warn({ wsRefusal: decision.reason }, 'websocket upgrade refused');
          metrics.wsRefused.inc({ reason: decision.refusal });
          auditRefusal(request, decision.refusal, session?.user.id ?? null);
          refuse(decision.code, decision.reason);
          return;
        }
        if (session === null) {
          // Unreachable, since `evaluateUpgrade` refuses a null user id. Close rather than leave a
          // socket with nobody attached.
          metrics.wsRefused.inc({ reason: 'unauthenticated' });
          refuse(WS_CLOSE.unauthenticated, 'no session');
          return;
        }

        const sessionExpiresAtMs = session.expiresAt.getTime();
        const connection = router.open(sinkFor(socket), {
          userId: session.user.id,
          displayName: session.user.displayName,
          sessionId,
        });
        metrics.wsOpened.inc();
        bySession.set(sessionId, (bySession.get(sessionId) ?? 0) + 1);
        live.set(connection.id, {
          connection,
          heartbeat: { ping: () => socket.ping(), terminate: () => socket.terminate() },
          sessionExpiresAtMs,
        });

        socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
          // Checked before the frame is measured. The heartbeat only reaches a socket up to 15 s later.
          if (sessionExpiresAtMs <= Date.now()) {
            router.closeConnection(connection, WS_CLOSE.unauthenticated, 'session expired');
            return;
          }
          router.handleFrame(connection, toBytes(data));
        });
        socket.on('pong', () => {
          connection.missedHeartbeats = 0;
        });
        socket.on('close', (code: number) => {
          // Bounded by `closeCodeLabel`. 4503 against 1006 separates a deploy reconnect from a drop.
          metrics.wsClosed.inc({ code: closeCodeLabel(code) });
          router.handleClose(connection);
          live.delete(connection.id);
          const remaining = (bySession.get(sessionId) ?? 1) - 1;
          if (remaining <= 0) bySession.delete(sessionId);
          else bySession.set(sessionId, remaining);
        });
      },
    );
  };
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

const wsHub: FastifyPluginAsync = async (app) => {
  await app.register(createWsHub());
};

export default wsHub;

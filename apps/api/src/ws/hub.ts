/**
 * The WebSocket upgrade: who may open a socket, and on whose behalf.
 *
 * ###########################################################################
 * ##  THE SAME-ORIGIN POLICY DOES NOT APPLY TO WEBSOCKETS.                 ##
 * ##                                                                       ##
 * ##  A browser will happily open `wss://api.example` from `evil.test`,     ##
 * ##  WITH OUR COOKIES ATTACHED, and there is no preflight and no CORS to   ##
 * ##  stop it: CORS governs `fetch` and `XMLHttpRequest`, not the WebSocket ##
 * ##  handshake. Page script also cannot set a header on `new WebSocket()`, ##
 * ##  so the double-submit CSRF token this API uses everywhere else is not  ##
 * ##  available here at all.                                               ##
 * ##                                                                       ##
 * ##  The only signal left is the `Origin` header, which browsers always    ##
 * ##  send on a handshake and page script cannot forge. That is why         ##
 * ##  `isAllowedOrigin` is exported from `plugins/security.ts` and why the  ##
 * ##  first thing this handler does is check it and close `4406`.           ##
 * ###########################################################################
 *
 * A missing `Origin` is refused too. Every browser sends one, so an upgrade without it is a
 * non-browser client, and this API is only served to its own web app. Fail closed: a native client
 * would need a deliberately reviewed authentication path of its own, not a hole in this one.
 *
 * ## Authentication comes from the cookie, never from the first frame
 *
 * The upgrade is an ordinary Fastify request, so `sessionPlugin`'s hook has already resolved
 * `request.session` from the signed `prl_session` cookie by the time the handler runs. `hello`
 * carries a protocol version and a room, and no credential: a token in the first frame would end
 * up in client-side logs and browser history far more easily than an `HttpOnly` cookie does.
 *
 * ## …and it is checked ONCE, which is why this file also has to un-check it
 *
 * That is the whole difference between a request and a connection. Every REST request re-reads the
 * session row, so expiry and revocation are enforced there by `findValidByToken` and nothing else
 * has to think about it. A socket reads it at the upgrade and then never again — so before the two
 * mechanisms below, a socket was authenticated by a credential that no longer existed:
 *
 *   * `POST /auth/logout`, `POST /me/delete` and a second sign-in all revoked the session row and
 *     left the learner's open socket fully live. Measured against the shipped code, with the row
 *     deleted while the socket was open: `sit` still answered `ack`, `ping` still answered `pong`,
 *     and no close frame was ever sent.
 *   * Neither the fourteen-day idle window nor `SESSION_ABSOLUTE_TTL_SECONDS` — the sixty-day
 *     ceiling `auth/session.ts` exists to impose, because "a stolen cookie stays valid forever
 *     provided the thief keeps using it… is precisely the property an attacker wants" — applied to
 *     a socket at all. A peer that answers pings had an unbounded authenticated channel.
 *
 * So: `onSessionRevoked` closes a session's sockets the moment its row is revoked, and every
 * socket carries the row's `expires_at`, checked on each inbound frame and swept on the heartbeat.
 * Both close `4401`, which is what tells the client to ask the reader to sign in again.
 *
 * ## Why the frame validator is Fastify's own Ajv
 *
 * `wsClientMessageSchema` is registered on the instance with every other contract schema, and
 * `app.validatorCompiler` is the compiler Fastify built with the app's own Ajv options —
 * `discriminator: true` among them, which that schema requires. Using it means the socket and the
 * REST routes cannot disagree about what the contract says, and it adds no dependency (`ajv` is
 * Fastify's, not ours, and importing it directly would be an undeclared dependency).
 *
 * The compiler only exists once a route with a validation schema has been set up, which is why the
 * upgrade route carries a `querystring` schema: it is a real check — the upgrade takes no query
 * parameters and a closed schema says so — and it is what makes the compiler available.
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
 * The `ws` library's own payload ceiling, set higher than ours on purpose.
 *
 * Our limit (`WS_LIMITS.maxMessageBytes`) is enforced in the router so that an oversized frame
 * gets the documented close code instead of the library's generic 1009. This one is the backstop
 * that stops a frame large enough to matter from being buffered at all — it is a memory guard, not
 * the protocol rule.
 */
const LIBRARY_PAYLOAD_CEILING = WS_LIMITS.maxMessageBytes * 4;

/**
 * `ws`'s own code for a frame that went past `maxPayload`.
 *
 * Matched on `code` rather than on the message, because the message is prose the library is
 * free to reword and the code is documented API (`ws`'s "Error codes" section; it is set in
 * `lib/receiver.js` and in `lib/permessage-deflate.js`, which are the two places the ceiling is
 * enforced). A `code` comparison also cannot be fooled by a `RangeError` from anywhere else.
 */
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
 * Why an upgrade was refused, as a CLOSED set.
 *
 * These three values are the label on `prl_websocket_refused_total`, and the three of them are
 * three different incidents: a burst of `bad_origin` is somebody pointing a page at this API,
 * a burst of `unauthenticated` is a broken client or an expired-cookie stampede, and
 * `rate_limited` is one session opening sockets in a loop. Collapsing them into one counter
 * would mean an alert could fire without saying which of those was happening.
 *
 * Separate from the human `reason` that goes back to the client in the close frame, because that
 * string is prose and this one is a label — see `observability/registry.ts` on why a label value
 * must never be free text.
 */
export type WsRefusalReason = 'bad_origin' | 'unauthenticated' | 'rate_limited';

/**
 * The close codes this service will label a closed socket with.
 *
 * Every code the *server* sends comes from `WS_CLOSE`, so that part is bounded by the contract.
 * The rest of this set is the codes a PEER can produce — 1001 when a tab navigates away, 1005
 * when it closes with no status, 1006 for a dropped connection, 1009 from `ws`'s own payload
 * ceiling, 1011 for an internal error. Anything else becomes `other`: a close code is two bytes
 * chosen by the client, and 65,536 of them is 65,536 time series that one caller can mint.
 */
const KNOWN_CLOSE_CODES: ReadonlySet<number> = new Set<number>([
  ...Object.values(WS_CLOSE),
  1001,
  1005,
  1006,
  1009,
  1011,
]);

/** The bounded `code` label for a closed socket. */
export function closeCodeLabel(code: number): string {
  return KNOWN_CLOSE_CODES.has(code) ? String(code) : 'other';
}

/**
 * How long a peer gets to answer a close frame before its socket is dropped.
 *
 * A WebSocket close is a *handshake*: the server sends a close frame, the peer answers with one, and
 * only then does the TCP socket end. Until it ends, `http.Server#close()` is still counting it — so
 * a peer that never answers holds the whole shutdown open. `ws` does have its own fallback, but it
 * is a 30 s `closeTimeout`: three times the default `SHUTDOWN_GRACE_MS`, so a single unanswered
 * close turns a deploy into a SIGKILL. Every close this module sends is therefore bounded.
 *
 * Derived from the process's own shutdown budget rather than fixed, because it has to be a *small
 * part* of it — after the sockets, the drain still has the database pool and the worker threads to
 * close — and because that makes the bound true by construction rather than by coincidence: no
 * socket this hub has closed can outlive a tenth of the grace.
 */
function closeHandshakeGraceMs(shutdownGraceMs: number): number {
  return Math.min(1_000, Math.ceil(shutdownGraceMs / 10));
}

/**
 * Arms the drop that stops an unanswered close frame from holding a socket open.
 *
 * Returns the timer so a caller that can cheaply cancel it does. `unref`'d because this timer exists
 * to let the process go *sooner*; keeping it alive for its own sake would invert the point. Calling
 * `terminate` on a socket that has already closed is a no-op, so a timer that outlives its socket is
 * harmless rather than merely tolerable.
 */
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
  /** Test seam: lets a test reach the router without opening a socket. */
  readonly onRouterReady?: (router: WsRouter) => void;
  /** Defaults to the process-wide metrics. A test that wants isolation passes its own. */
  readonly metrics?: AppMetrics;
  /**
   * Test seam: how often the sweep below runs. Defaults to `WS_LIMITS.heartbeatIntervalMs`.
   *
   * Here because the sweep enforces something no other code path does — the session's expiry on a
   * socket that has gone QUIET — and at the shipped fifteen seconds no test could reach it. That
   * is not a hypothetical gap: an adversarial review removed the expiry check from the sweep and
   * the whole 1,001-test suite stayed green, because `ws-session-revocation.test.ts` reached the
   * per-frame check instead by sending a `ping`. A guard whose failure mode has never been
   * observed is decoration, and this option is what makes it observable.
   */
  readonly heartbeatIntervalMs?: number;
}

/**
 * Builds the frame validator from Fastify's compiled Ajv.
 *
 * Compiled lazily on first use, because `app.validatorCompiler` is only populated once the
 * instance's routes have been set up — which happens after this plugin's body has run.
 */
export function compileFrameValidator(app: FastifyInstance): FrameValidator {
  let compiled: ((value: unknown) => unknown) | null = null;
  return (value: unknown): FrameValidation => {
    if (compiled === null) {
      const compiler = app.validatorCompiler;
      if (compiler === undefined) {
        // Refuse rather than wave the frame through. An unvalidated frame reaching the router is
        // the one failure mode this function exists to prevent.
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
    // Validated against the closed, discriminated schema, so the shape is exactly one of the
    // protocol's messages. This is the single place that assertion is made.
    return { ok: true, value: value as WsClientMessage };
  };
}

/**
 * Only what the router needs from a socket, adapted from the library's.
 *
 * Written as an adapter rather than passing the socket through so that `router.ts` has no
 * knowledge of `ws` at all — which is what lets its tests drive the protocol with two functions.
 */
function sinkFor(socket: {
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
}): SocketSink {
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  };
}

/** The origin of an upgrade, or null when the client sent none. */
function originOf(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  return typeof origin === 'string' && origin !== '' ? origin : null;
}

/**
 * Writes the refused upgrade to `prl.audit_log`.
 *
 * ## Why this event and not the whole socket lifecycle
 *
 * The audit log is for security-relevant events, not for traffic. An accepted upgrade is a
 * signed-in member opening their own table, which is ordinary and is already in the request log
 * and in `prl_websocket_opened_total`. A REFUSED one is the other thing: this is the endpoint
 * that CORS and the CSRF token do not protect (see the banner at the top of this file), so the
 * `Origin` check is the only control standing between a page on another site and a socket
 * carrying this learner's cookies. A record of every time that control fired is precisely what an
 * incident responder needs and what nothing else keeps.
 *
 * ## What goes in the row, and what cannot
 *
 * The refusal reason (one of three constants), the account when there was one, and the origin —
 * which is the evidence for a `bad_origin` refusal and the only caller-supplied value here.
 * `redactDetail` clamps it to 200 characters and strips control characters. The address and the
 * user agent are deliberately absent: `audit_log_detail_has_no_forbidden_keys` refuses both, and
 * they are already in the request log line, correlated by request id, where retention is governed.
 *
 * ## Why it cannot fail the refusal
 *
 * `recordSecurityAudit` swallows and logs. Refusing an upgrade and then throwing because the
 * *record* of the refusal could not be written would turn a working security control into an
 * outage — and this is the one call in this file that touches the database.
 *
 * ## Why one row per refusal is affordable
 *
 * The upgrade route carries no `rateLimit: false`, so it is governed by the same global limiter
 * as everything else: a caller cannot turn a refused handshake into an unbounded stream of
 * INSERTs, because they run out of requests first. If that route is ever exempted, this write
 * needs a bound of its own.
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
 * The upgrade decision, as a pure function.
 *
 * Separated from the socket so the two refusals that matter most can be tested directly:
 * a rejected origin and an unauthenticated cookie. Returning a close code rather than throwing is
 * deliberate — the socket has already been accepted at the protocol level by the time we can say
 * anything, so the client is told *why* through a close code it can act on.
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

/**
 * The hub.
 *
 * Exported as a factory as well as a default, matching the other route modules: the default takes
 * no options and is what `registerRoutes` uses, and a test passes its own registry and session
 * store.
 */
export function createWsHub(options: WsHubOptions = {}): FastifyPluginAsync {
  return async (app) => {
    const registry = options.registry ?? roomRegistry();
    // The assembled server owns one metrics registry per Fastify instance. Keep the explicit
    // option for isolated hub tests, but make the default follow that instance rather than the
    // process-global fallback: otherwise the default route factory silently drops WebSocket
    // observations from an app built with an injected registry.
    const metrics = options.metrics ?? app.appMetrics;
    const store =
      options.sessionStore ??
      (app.hasRequestDecorator('session') ? null : createAuthStore(getSql()).sessions);
    if (store !== null) await app.register(sessionPlugin, { store });

    /**
     * `clientTracking: false` is deliberate, and it has one trap that has already cost a release.
     *
     * `ws` only builds its `WebSocketServer#clients` Set when client tracking is on. The library's
     * `defaultPreClose` closes sockets with `if (server.clients) { … }`
     * (`@fastify/websocket/index.js`) — so with tracking off that guard is false, the loop is
     * SILENTLY SKIPPED, and every upgraded socket stays open. `server.close()` waits for every
     * connection, so `app.close()` never resolves, the `onClose` hook below never runs, and the
     * deadline in `server.ts` fires `process.exit(1)`: one idle socket turned every deploy into a
     * hard kill, and the client saw 1006 (a dropped connection) rather than a shutdown.
     *
     * Turning tracking on would fix the hang but not the rest of it. `defaultPreClose` calls
     * `client.close()` with no arguments, which sends a close frame carrying NO status code, and
     * the peer reports 1005 — so `apps/web/src/lib/table-socket.ts`, which has a dedicated
     * "the server is restarting" state keyed on `WS_CLOSE.serverShuttingDown`, could not reach it.
     * It also puts no bound on the close handshake (see `closeHandshakeGraceMs`).
     *
     * So tracking stays off — the hub already indexes every socket in `live` for the heartbeat, and
     * `ws`'s Set would be a second registry of the same thing — and the `preClose` hook below does
     * the closing, with the protocol's own code. Anyone reaching for `clientTracking: true` should
     * read that hook first: it, not the library, is what closes these sockets.
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
     * Sockets watching a room this process has been FENCED from.
     *
     * The registry has already closed the table and dropped the room by the time this runs — that
     * ordering is deliberate and is documented on `RoomRegistry.evict` — so what is left is a set of
     * sockets attached to a table that will never send another frame. Left open they are the worst
     * failure shape this hub has: the connection is healthy, pings are answered, the client's
     * watchdog never fires, and the learner simply watches a table that has stopped moving. The
     * registry's own header records the same symptom from an in-process version of this bug.
     *
     * `serverShuttingDown` (4503) rather than a code of this hub's own, because it is exactly what
     * the client must do: `describeClose` in `apps/web/src/lib/table-socket.ts` treats it as
     * retryable and reconnects with backoff, which lands the learner on the process that does own
     * the room. 4403 would be permanent and would tell them the table is not theirs, which is false.
     */
    const stopWatchingEvictions = registry.onEviction((roomId) => {
      app.log.warn({ roomId }, 'room lease lost; closing its sockets');
      router.closeRoom(roomId, WS_CLOSE.serverShuttingDown, 'this table moved to another server');
    });

    /** Sockets per session, for `maxSocketsPerSession`. */
    const bySession = new Map<string, number>();
    /**
     * Everything open, so the heartbeat can read a counter and reach a socket — and so the drain
     * below can close every socket, including the ones the router has never heard of.
     *
     * That last part is the reason `preClose` reads this map rather than calling `router.closeAll`:
     * the router indexes connections by room, so a socket that is open but has not sent `hello` yet
     * is in no room and `closeAll` cannot see it. It is still an upgraded TCP connection that
     * `server.close()` will wait for.
     *
     * `sessionExpiresAtMs` is the session row's own `expires_at`, read once during the upgrade. It
     * is here rather than on `WsConnection` because it is a property of the CREDENTIAL and not of
     * the protocol, and `router.ts` deliberately knows nothing about cookies or sessions.
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
     * Closes every socket a revoked session was holding.
     *
     * ## The defect
     *
     * A socket is authenticated ONCE, at the upgrade, and never again. So revocation reached
     * every REST request — each of which re-reads the row — and reached no socket at all.
     * Measured against the shipped code: with the session row deleted while the socket was open,
     * `sit` still came back `ack` and `ping` still came back `pong`, and the socket was never
     * closed. `POST /auth/logout`, `POST /me/delete` and signing in a second time were all in that
     * position: the credential was revoked and the channel it had opened was not.
     *
     * `4401` rather than a code of this hub's own, because it is exactly what the client must do —
     * `describeClose` in `apps/web/src/lib/table-socket.ts` treats `unauthenticated` as a signal to
     * stop and ask the reader to sign in, which is true: the session is gone and a reconnect with
     * the same cookie would be refused by `evaluateUpgrade` anyway.
     *
     * Matching is exact on either the session id or the user id, never a prefix, and a revocation
     * carrying neither matches nothing — a bus message that closed every socket in the process
     * because a field was absent is the failure this guard exists to make impossible.
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

    // Read at scrape time from the map that already holds the answer, never incremented and
    // decremented alongside it. A mirrored count drifts the first time a socket leaves by a path
    // somebody forgot to instrument — the heartbeat's `terminate`, the shutdown drain, a refused
    // upgrade — and this hub has four of them. `Gauge.setFrom` in `observability/registry.ts` sets
    // out why a drifting gauge is worse than an absent one.
    metrics.wsConnections.setFrom(() => live.size);

    /** Read once: `appConfig` is frozen, and every close in this plugin is bounded by the same value. */
    const closeGraceMs = closeHandshakeGraceMs(app.appConfig.shutdownGraceMs);

    /**
     * One heartbeat timer for the whole hub rather than one per socket.
     *
     * `unref`'d, so a quiet server with open sockets can still exit, and cleared on `onClose` so a
     * closed app leaves nothing running. A socket that has missed two pings is treated as gone and
     * `terminate`d rather than closed — a half-open socket will never answer a close handshake, and
     * waiting for one is how a dead connection holds a seat's turn open until the timer expires.
     */
    const heartbeat = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of [...live]) {
        // The session's own expiry, enforced on the connection.
        //
        // `auth/session.ts` sets a ceiling — `SESSION_ABSOLUTE_TTL_SECONDS`, sixty days — and says
        // why: "sliding expiry with no ceiling means a stolen cookie stays valid forever provided
        // the thief keeps using it, which is precisely the property an attacker wants". That
        // ceiling is enforced by `findValidByToken`, which every REST request goes through and no
        // socket does. A socket answering pings therefore had NO lifetime at all: neither the
        // fourteen-day idle window nor the sixty-day ceiling applied to it, and the one connection
        // in this product that carries a learner's cards was the one credential-expiry did not
        // reach. Checked on the heartbeat rather than per frame because it is a wall-clock deadline
        // and a socket that sends nothing must expire too.
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
     * Closing the sockets HAS to happen here, in `preClose`, and not in `onClose`.
     *
     * Fastify's close sequence is: `preClose` hooks → `server.close()` → `onClose` hooks. Node's
     * `server.close()` waits for every connection it is still counting, and an upgraded WebSocket
     * is one of those. So a hub that only closed its sockets in `onClose` would be waiting for a
     * callback that is waiting for it — which is exactly what shipped, via the library's
     * `defaultPreClose` no-op described above: `app.close()` never resolved, the process hit the
     * grace deadline, and every connected learner's socket died as a 1006 with no close frame.
     *
     * The close is polite first and forced second. `router.closeConnection` sends a real close
     * frame carrying `WS_CLOSE.serverShuttingDown`, which is what lets a client tell a deploy from
     * a network fault and reconnect with backoff instead of surfacing an error, and it releases the
     * room state the connection held. Anything whose peer has not completed the handshake within
     * `closeHandshakeGraceMs` is then dropped, because a socket nobody is listening on must not be
     * the reason a deploy is SIGKILLed.
     */
    app.addHook('preClose', async () => {
      // Stop pinging first: a `ping` on a socket that is already CLOSING is refused by `ws` and
      // arrives as an `error` event, which would fill the shutdown log with noise about sockets
      // that are closing exactly as intended.
      clearInterval(heartbeat);
      if (live.size === 0) return;

      app.log.info({ sockets: live.size, graceMs: closeGraceMs }, 'closing websockets for shutdown');
      for (const entry of [...live.values()]) {
        // The close frame carries `WS_CLOSE.serverShuttingDown`, and the drop below bounds the
        // answer. Nothing here waits: `server.close()` is the thing that waits for these sockets,
        // and it now has a guarantee that they all end within `closeGraceMs`. The timers are not
        // cancelled on close because they are `unref`'d and `terminate` is a no-op on a socket that
        // has gone — cancelling them would be bookkeeping for its own sake on the exit path.
        router.closeConnection(entry.connection, WS_CLOSE.serverShuttingDown, 'server shutting down');
        dropUnlessAnswered(entry.heartbeat, closeGraceMs);
      }
      await Promise.resolve();
    });

    app.addHook('onClose', async () => {
      // Idempotent, and both calls are meant: `preClose` stops the pings as early as it can, and
      // this runs even for a close that never reached `preClose` (a hook before it having thrown).
      clearInterval(heartbeat);
      // The registry outlives this hub in a process that builds several apps — every test that
      // does, and `resetRoomRegistryForTests` exists precisely because it is shared. A listener
      // left behind would hold a closed router alive and, on the next eviction, close sockets
      // through it: the same shape as the room subscription `handleClose` is careful to drop.
      stopWatchingEvictions();
      // Same reason, same shape: the revocation bus is module scope in `auth/session.ts` and
      // outlives this hub in any process that builds more than one app. A listener left behind
      // would hold a closed router alive and close sockets through it on the next sign-out.
      stopWatchingRevocations();
      // A backstop, not the mechanism — `preClose` has already closed every socket by now, and
      // `closeConnection` is a no-op on a connection that is already closed. It stays because it
      // costs nothing and because a router left holding room subscriptions for a closed app is a
      // leak that no test would see.
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
        // A closed schema for a request that takes no parameters. It is also what makes
        // `app.validatorCompiler` exist — see the module comment.
        schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } },
      },
      (socket, request) => {
        /**
         * Takes over the socket's `error` handling from the library, for every socket — refused
         * upgrades included, because a refused socket is still a real WebSocket that can be sent
         * a frame before its close handshake finishes.
         *
         * ## The defect
         *
         * `@fastify/websocket` attaches `socket.on('error', (error) => fastify.log.error(error))`
         * inside its `handleUpgrade`, before this handler runs. So a frame larger than
         * `LIBRARY_PAYLOAD_CEILING` — which any client can send at will, without a session and
         * from any origin — put a full `RangeError: Max payload size exceeded` stack from
         * `Receiver.haveLength` into the log at level 50. That is noise on the level operators
         * page on, and it is a small amplification primitive: a few bytes of request turns into
         * a multi-line error record. The router's own oversize path (`WS_LIMITS.maxMessageBytes`)
         * has always handled the same event correctly — count it, close, log one line — and this
         * makes the library's path match.
         *
         * ## Why `removeAllListeners` rather than living alongside it
         *
         * An `error` event with a listener is not throwable, so both listeners would simply fire
         * and the level-50 line would still be written. The listener being removed logs and does
         * nothing else, and the one installed here logs everything it did — so nothing is lost,
         * and there is no window in which the socket has no `error` listener at all.
         */
        socket.removeAllListeners('error');
        socket.on('error', (error: Error) => {
          if (!isOversizedFrameError(error)) {
            request.log.warn({ err: error }, 'websocket error');
            return;
          }
          // The same label the router uses for its own ceiling: one metric answers "how many
          // oversized frames", whichever limit caught it. The two limits differ by design (see
          // `LIBRARY_PAYLOAD_CEILING`); the incident does not.
          metrics.wsFramesRejected.inc({ reason: 'too_large' });
          // No `err` field, so pino writes one line rather than a stack, and the size that was
          // exceeded rather than the caller's — a client-chosen byte count is a value this
          // process has no reason to echo.
          request.log.warn({ ceilingBytes: LIBRARY_PAYLOAD_CEILING }, 'websocket frame over the ceiling');
          // Normally a no-op: `ws` calls `websocket.close(1009)` from `receiverOnError` BEFORE it
          // emits this event, and a close on an already-closing socket is ignored — which is why
          // `1009` is in `KNOWN_CLOSE_CODES` and why this cannot re-code the frame. It is here
          // for the branch where `ws` only emits (`receiverOnError` skips its close when the
          // socket has already been detached), so that the socket is never left open with a
          // client that has proved it will oversend.
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
         * Refuses this upgrade, and makes sure the refusal actually ends the connection.
         *
         * A refused socket is never adopted into `live`, so the shutdown drain above cannot see it
         * — and by then it is far too late anyway. The upgrade has already completed at the
         * protocol level, so this is a real WebSocket that `http.Server#close()` counts, and a peer
         * that ignores the close frame keeps it counted. That is a socket anyone can open, from any
         * origin, without a session: without the bound below, one of them is enough to make every
         * deploy miss its grace and die by SIGKILL.
         */
        const refuse = (code: number, reason: string): void => {
          socket.close(code, reason);
          const drop = dropUnlessAnswered(socket, closeGraceMs);
          socket.once('close', () => clearTimeout(drop));
        };

        if (!decision.ok) {
          // Logged with the reason, answered with only a close code. Nothing about the session or
          // the origin goes back to the client.
          request.log.warn({ wsRefusal: decision.reason }, 'websocket upgrade refused');
          metrics.wsRefused.inc({ reason: decision.refusal });
          auditRefusal(request, decision.refusal, session?.user.id ?? null);
          refuse(decision.code, decision.reason);
          return;
        }
        if (session === null) {
          // Unreachable: `evaluateUpgrade` refuses a null user id, so an accepted decision implies a
          // session. Closing rather than returning means that if the two ever disagree, the socket
          // is shut instead of left open with nobody attached to it.
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
          // Read from the session the upgrade resolved, so the socket cannot outlive the cookie
          // that opened it. See the heartbeat above.
          sessionExpiresAtMs,
        });

        socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
          // Before the frame is even measured, because an expired credential must not be able to
          // act. The heartbeat above sweeps a socket that has gone quiet; this is what stops one
          // that has not, in the up-to-fifteen-second window before the sweep reaches it. One
          // comparison per frame, ahead of a size check that is already one comparison.
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
          // Labelled through `closeCodeLabel`, so a peer cannot mint a series per invented code.
          // Compared against `prl_websocket_opened_total`, this is what distinguishes a client
          // reconnecting after a deploy (4503) from one being dropped by the network (1006).
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

/** Normalises whatever `ws` hands us into bytes, without assuming which form it used. */
function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

const wsHub: FastifyPluginAsync = async (app) => {
  await app.register(createWsHub());
};

export default wsHub;

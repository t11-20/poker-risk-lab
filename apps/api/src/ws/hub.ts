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
import { type SessionStore, sessionPlugin } from '../auth/session.ts';
import { getSql } from '../db.ts';
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

/** A socket that missed this many heartbeats is gone. */
const MISSED_HEARTBEATS_ALLOWED = 2;

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
}): { readonly ok: true } | { readonly ok: false; readonly code: number; readonly reason: string } {
  if (input.origin === null || !isAllowedOrigin(input.origin)) {
    return { ok: false, code: WS_CLOSE.badOrigin, reason: 'origin not allowed' };
  }
  if (input.userId === null) {
    return { ok: false, code: WS_CLOSE.unauthenticated, reason: 'no session' };
  }
  if (input.socketsForSession >= WS_LIMITS.maxSocketsPerSession) {
    return { ok: false, code: WS_CLOSE.rateLimited, reason: 'too many sockets' };
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
    const store =
      options.sessionStore ??
      (app.hasRequestDecorator('session') ? null : createAuthStore(getSql()).sessions);
    if (store !== null) await app.register(sessionPlugin, { store });

    await app.register(websocketPlugin, {
      options: { maxPayload: LIBRARY_PAYLOAD_CEILING, clientTracking: false },
    });

    const router = new WsRouter({
      registry,
      clock: systemClock,
      validate: compileFrameValidator(app),
      nextRequestId: () => `ws-${randomUUID()}`,
      onProblem: (message, detail) => app.log.warn({ ...detail }, message),
    });
    options.onRouterReady?.(router);

    /** Sockets per session, for `maxSocketsPerSession`. */
    const bySession = new Map<string, number>();
    /** Everything open, so the heartbeat can read a counter and reach a socket. */
    const live = new Map<string, { readonly connection: WsConnection; readonly heartbeat: Heartbeat }>();

    /**
     * One heartbeat timer for the whole hub rather than one per socket.
     *
     * `unref`'d, so a quiet server with open sockets can still exit, and cleared on `onClose` so a
     * closed app leaves nothing running. A socket that has missed two pings is treated as gone and
     * `terminate`d rather than closed — a half-open socket will never answer a close handshake, and
     * waiting for one is how a dead connection holds a seat's turn open until the timer expires.
     */
    const heartbeat = setInterval(() => {
      for (const [id, entry] of [...live]) {
        if (entry.connection.missedHeartbeats >= MISSED_HEARTBEATS_ALLOWED) {
          entry.heartbeat.terminate();
          router.handleClose(entry.connection);
          live.delete(id);
          continue;
        }
        entry.connection.missedHeartbeats += 1;
        entry.heartbeat.ping();
      }
    }, WS_LIMITS.heartbeatIntervalMs);
    heartbeat.unref();

    app.addHook('onClose', async () => {
      clearInterval(heartbeat);
      router.closeAll('server shutting down');
      live.clear();
      bySession.clear();
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
        const session = request.session;
        const sessionId = session?.sessionId ?? '';
        const decision = evaluateUpgrade({
          origin: originOf(request),
          userId: session?.user.id ?? null,
          socketsForSession: bySession.get(sessionId) ?? 0,
        });
        if (!decision.ok) {
          // Logged with the reason, answered with only a close code. Nothing about the session or
          // the origin goes back to the client.
          request.log.warn({ wsRefusal: decision.reason }, 'websocket upgrade refused');
          socket.close(decision.code, decision.reason);
          return;
        }
        if (session === null) {
          // Unreachable: `evaluateUpgrade` refuses a null user id, so an accepted decision implies a
          // session. Closing rather than returning means that if the two ever disagree, the socket
          // is shut instead of left open with nobody attached to it.
          socket.close(WS_CLOSE.unauthenticated, 'no session');
          return;
        }

        const connection = router.open(sinkFor(socket), {
          userId: session.user.id,
          displayName: session.user.displayName,
          sessionId,
        });
        bySession.set(sessionId, (bySession.get(sessionId) ?? 0) + 1);
        live.set(connection.id, {
          connection,
          heartbeat: { ping: () => socket.ping(), terminate: () => socket.terminate() },
        });

        socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
          router.handleFrame(connection, toBytes(data));
        });
        socket.on('pong', () => {
          connection.missedHeartbeats = 0;
        });
        socket.on('error', (error: Error) => {
          request.log.warn({ err: error }, 'websocket error');
        });
        socket.on('close', () => {
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

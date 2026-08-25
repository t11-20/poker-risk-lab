/**
 * The WebSocket message handler, with no socket in it.
 *
 * Everything about *what a frame means* lives here; everything about sockets, upgrades, origins
 * and cookies lives in `hub.ts`. The split is what makes this testable: a `SocketSink` is two
 * methods, so `test/ws-router.test.ts` drives the real protocol — handshake timeout, rate limit,
 * oversized frame, duplicate action, stale sequence, per-recipient redaction — with no network, no
 * port and no timing.
 *
 * ## State goes out whole, never as a delta
 *
 * Every change sends the complete redacted view (ADR 0009). A delta protocol needs client and
 * server to agree on a base state, and any disagreement — a dropped frame, a reconnect at the
 * wrong moment — produces a table that is subtly wrong and extremely hard to reproduce. The cost
 * is a few kilobytes per update; the benefit is that reconnect is just "send the current view",
 * with no resynchronisation protocol to get wrong. `WsState.revision` is monotonic **per socket**
 * so a client can discard an out-of-order frame without needing to understand the sequence.
 *
 * ## Broadcast is per recipient, always
 *
 * `broadcast` loops over the sockets in a room and calls `table.viewFor(thatSocket.userId)` for
 * each one. There is deliberately no "build the view once and send it to everybody" path: that is
 * exactly the shape in which one player's hole cards reach the whole table, and it is a
 * one-character change away from being introduced by accident. `test/ws-router.test.ts` asserts
 * two sockets at the same table receive *different* frames and that neither contains the other's
 * cards, by scanning the serialised text.
 *
 * ## Validation before routing
 *
 * Every inbound frame is validated against `wsClientMessageSchema` before anything reads a field
 * off it. The validator is Fastify's own compiled Ajv instance (see `compileFrameValidator` in
 * `hub.ts`) rather than a second one, so the socket and the REST routes cannot disagree about what
 * the contract means. One consequence of sharing it is worth naming: the app's Ajv has
 * `coerceTypes: 'array'`, so `{"seat": "3"}` is accepted and coerced. Every field in the schema is
 * bounded or an enum, so coercion cannot produce an out-of-range value, and the alternative — a
 * second Ajv with different options — would be a second definition of the contract.
 *
 * ## Limits are enforced here, not hoped for
 *
 * `maxMessageBytes` (drop and close), `messagesPerSecond` with `burstAllowance` (a token bucket),
 * and `coachRequestsPerMinute` (the analysis is not free to compute). `maxSocketsPerSession` is
 * the hub's, because it is a property of the upgrade rather than of a message.
 *
 * The first two are PER SOCKET and the third is PER SESSION, which is not an inconsistency. A
 * token bucket bounds what one connection may push through the frame path, and a socket is the
 * right unit for that. A Coach request is answered by the shared worker pool, which is a
 * process-wide resource, so the unit has to be the thing a caller is allowed several of: a
 * session may hold `maxSocketsPerSession` sockets, and a per-socket Coach window handed one
 * session four times its published budget. See `takeCoachToken` and `bySession`.
 *
 * ## The Coach analysis happens on a thread, and that is not an optimisation
 *
 * `requestCoach` used to call `coachForView` — a 2,000-sample Monte Carlo, plus the preflop
 * strength table the default `top:NN` range needs — inline, on the event loop. Measured on this
 * machine before the change: 3,034 ms for the first analysis in a fresh process (the strength
 * table), 56-84 ms warm, and the event loop's own p99 for that window was 3,029 ms. Every socket,
 * every turn clock and every timer in the process stopped for exactly that long, which is the
 * thing `workers/pool.ts` exists to prevent and which the REST Coach path already avoided.
 *
 * So the socket now builds a `CoachTask` here — validation, redaction and the numbers read off
 * the view, all of which are microseconds — and hands it to the same shared pool
 * `routes/calc.ts` uses. Three consequences are deliberate and are handled rather than hoped
 * about, in `onCoach`: a full queue answers `service_unavailable` immediately, an overrun
 * answers `computation_timeout`, and a socket that closes while its analysis is in flight has
 * the result dropped.
 *
 * The cost, stated plainly: the answer is no longer computed in the same tick the request
 * arrived in, so it describes the spot AS IT STOOD WHEN THE REQUEST WAS ACCEPTED. A player who
 * acts while the analysis is running gets a report about the decision they have just made. That
 * is the same report they would have got before — the analysis was always of the view at request
 * time — but it can now arrive after the fact, and the frame carries the `requestId` so a client
 * can tell which question it answers.
 */

import type {
  ApiError,
  CoachReport,
  ErrorCode,
  RoomSummary,
  WsClientMessage,
  WsCloseCode,
  WsServerMessage,
} from '@prl/contracts';
import { ERROR_MESSAGES, WS_CLOSE, WS_LIMITS, WS_PROTOCOL_VERSION, wsCloseForError } from '@prl/contracts';
import type { Card, PlayerView, SeatView } from '@prl/poker-engine';
import { contestablePotFor } from '@prl/poker-engine';
import { type Street as BettingStreetName, buildCoachReport, type CoachAction } from '@prl/poker-math';
import { STRENGTH_TABLE_ALLOWANCE_MS } from '../calc/parse.ts';
import type { AppConfig } from '../config.ts';
import { AppError, isAppError } from '../errors.ts';
import { type AppMetrics, appMetrics } from '../observability/metrics.ts';
import { observeAnalysis, type ProblemHook } from '../observability/telemetry.ts';
import { assumedRange, DEFAULT_ASSUMED_RANGE_PERCENT } from '../rooms/bots.ts';
import type { LiveRoom, RoomRegistry } from '../rooms/registry.ts';
import { toRoomSummary } from '../rooms/registry.ts';
import type { TableNotice } from '../rooms/table.ts';
import type { Clock, ScheduledTask } from '../rooms/timers.ts';
import type { CoachTask, WireRange } from '../workers/equity-worker.ts';
import { getSharedPool } from '../workers/pool.ts';

/** The two things this module needs from a socket. */
export interface SocketSink {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** Who the socket belongs to, established during the upgrade from the session cookie. */
export interface WsPrincipal {
  readonly userId: string;
  readonly displayName: string;
  /**
   * The session, used only as the key for `maxSocketsPerSession`. Never sent anywhere and never
   * logged: `logging.ts` censors anything matching `/session/i` in a log object, and this is a
   * session identifier rather than a token, but the same care applies.
   */
  readonly sessionId: string;
}

/** One live socket. */
export interface WsConnection {
  readonly id: string;
  readonly sink: SocketSink;
  readonly principal: WsPrincipal;
  /** Null until `hello` has been accepted. */
  roomId: string | null;
  /**
   * True from the moment a `hello` is accepted for validation until it has joined a room or failed.
   *
   * Only `roomId` existed, and it was enough while the handshake was synchronous. Reopening a room
   * after a restart reads the database, so there is now a window in which `roomId` is still null and
   * a second `hello` would be let through to join the same socket twice. See `onHello`.
   */
  joining: boolean;
  /** Monotonic per socket, so a client can discard an out-of-order frame. */
  revision: number;
  /** Token bucket for `messagesPerSecond` / `burstAllowance`. */
  tokens: number;
  lastRefillMs: number;
  handshake: ScheduledTask | null;
  /** Heartbeats sent since the last pong. Two means the socket is gone (`hub.ts` acts on it). */
  missedHeartbeats: number;
  closed: boolean;
}

/** The outcome of validating a frame. `value` is only present when it validated. */
export type FrameValidation =
  | { readonly ok: true; readonly value: WsClientMessage }
  | { readonly ok: false; readonly problem: string };

export type FrameValidator = (value: unknown) => FrameValidation;

/**
 * Why an inbound frame was refused, as a CLOSED set.
 *
 * This is a metric label (`prl_websocket_frames_rejected_total`), and a metric label whose value
 * comes from the caller is an unbounded in-process memory leak that anybody with a socket can
 * reach — the failure `observability/registry.ts` opens by describing. So the reason is chosen
 * from this union at the rejection site and NEVER derived from the frame: not from the schema
 * error, not from the message type the client claimed, not from the JSON parser's complaint.
 *
 * Snake_case because these are label values, not `ProblemEvent`s; the two vocabularies are
 * deliberately spelled differently so one cannot be passed where the other is expected.
 */
export type WsFrameRejection =
  /** Over `WS_LIMITS.maxMessageBytes`. Dropped unparsed; the socket is closed. */
  | 'too_large'
  /** The per-socket token bucket was empty. The socket is closed. */
  | 'rate_limited'
  /** Not JSON at all. */
  | 'not_json'
  /** Valid JSON, but not a message the contract's schema accepts. */
  | 'schema'
  /** A schema-valid message whose `type` this router has no branch for. */
  | 'unknown_type'
  /** An intent arrived before `hello` had joined a room. */
  | 'before_handshake'
  /** A second `hello` on a socket that has already sent one. */
  | 'duplicate_hello'
  /** `hello` named a protocol version this server does not speak. */
  | 'bad_protocol_version';

export interface WsRouterOptions {
  readonly registry: RoomRegistry;
  readonly clock: Clock;
  readonly validate: FrameValidator;
  /** The app-owned calculator budget and pool size; never read from process-global config. */
  readonly config: AppConfig;
  /** A request id for the error bodies. Fastify's per-request id is not available on a frame. */
  readonly nextRequestId?: () => string;
  /** Non-fatal problems, with a typed `event`. See `observability/telemetry.ts`. */
  readonly onProblem?: ProblemHook;
  /** Defaults to the process-wide metrics. A test that wants isolation passes its own. */
  readonly metrics?: AppMetrics;
  /**
   * Monte Carlo samples for a Coach answer over a socket. Lower than a REST Coach request on
   * purpose: this one is answered while a player is waiting on their own clock.
   */
  readonly coachSamples?: number;
  /**
   * Where a Coach task is computed. Defaults to the process-wide calculator pool.
   *
   * A seam rather than a hard-wired `getSharedPool(...)` call for the reason every other
   * collaborator here is one: a test that wants to drive the refusals — a full queue, a
   * deadline, a thread that died — needs to produce them without arranging real thread
   * exhaustion first. The DEFAULT is the pool, not an in-process call, so that a deployment
   * which forgets to pass anything still keeps the analysis off the event loop; the defect this
   * closes was precisely a path that quietly computed on the main thread.
   */
  readonly analyseCoach?: CoachAnalyser;
}

/**
 * Runs one Coach task somewhere that is not this thread, and answers with the report.
 *
 * Rejections are `AppError`s and reach the socket through `guard`, so the four the pool can
 * produce — `service_unavailable` for a full queue or a closed pool, `computation_timeout` for
 * an overrun, `computation_rejected` for maths that refused the task, `internal_error` for a
 * thread that died — arrive as error frames carrying the contract's own wording.
 */
export type CoachAnalyser = (task: CoachTask) => Promise<CoachReport>;

/**
 * The default: the shared pool, under the configured Coach budget.
 *
 * The allowance is the same one `routes/calc.ts` applies and for the same reason: a `top:NN`
 * range cannot be expanded without the preflop strength table, which is about three seconds on
 * the first request a thread serves and memoised per thread afterwards. Without the allowance
 * the very first live Coach request in a process would be terminated for overrunning
 * `coachTimeoutMs`, taking the half-built table with it — and the next one would start cold and
 * fail in exactly the same way. See `STRENGTH_TABLE_ALLOWANCE_MS`.
 *
 * The app config is passed in by `ws/hub.ts`, so the WebSocket path uses the same timeout and
 * worker-pool sizing as the REST calculation routes. Reading process-global configuration here
 * would make isolated app instances impossible to test and would let the first unrelated config
 * parse decide the socket budget.
 */
function pooledCoachAnalyser(config: AppConfig): CoachAnalyser {
  return (task) => {
    const allowanceMs = task.spec.opponents.some((range) => range.kind === 'topPercent')
      ? STRENGTH_TABLE_ALLOWANCE_MS
      : 0;
    return getSharedPool(config).runCoach(task, config.coachTimeoutMs + allowanceMs);
  };
}

/**
 * The assumed range when a client does not name one, as the two forms the contract accepts.
 *
 * Parsed through `assumedRange`, which is the one place `top:NN` becomes notation — see `bots.ts`.
 */
const DEFAULT_COACH_RANGE = `top:${DEFAULT_ASSUMED_RANGE_PERCENT}`;
const DEFAULT_COACH_SAMPLES = 2_000;
/** One minute, for the Coach limiter's window. */
const COACH_WINDOW_MS = 60_000;

/**
 * The per-SESSION state, which is everything a limit whose unit is the session needs.
 *
 * `sockets` is a reference count: it is incremented in `open` and decremented in `handleClose`,
 * the same lifetime `hub.ts` gives its own `bySession` counter (the one that enforces
 * `maxSocketsPerSession`), so there is one answer to "is this session still connected" rather
 * than two that can disagree. It is a separate map only because the hub's belongs to the upgrade
 * and this belongs to the frames; if a third per-session limit appears they should become one.
 *
 * ## Why the entry does not simply die with the last socket
 *
 * That was the first version, and it reintroduced the defect through the back door. Reconnecting
 * is free — a client does it on every network hiccup — so an entry discarded the instant the last
 * socket closed would let a caller clear their Coach window by closing the socket and opening
 * another, which is a cheaper reset than the per-socket window ever was. The upgrade is only
 * bounded by the global HTTP limiter (300/minute by default), so "the window survives the socket"
 * is the difference between 30 analyses a minute and several thousand.
 *
 * So an entry with spent Coach tokens outlives its sockets by one window, on a timer. An entry
 * with none is deleted immediately, which is the common case: a socket that never asked for a
 * Coach analysis leaves nothing behind. The map is therefore bounded by the sessions that have
 * actually used the Coach in the last two minutes, and NOT by every session that has ever
 * connected — which is what an unswept map keyed on caller-supplied ids would be.
 */
interface SessionState {
  /** Live sockets this session holds. Zero means only the window below is keeping it alive. */
  sockets: number;
  /** Timestamps of accepted Coach requests inside the window, for `coachRequestsPerMinute`. */
  coachRequests: number[];
  /** The pending deletion, armed when the last socket goes and cancelled if one comes back. */
  expiry: ScheduledTask | null;
}

export class WsRouter {
  private readonly registry: RoomRegistry;
  private readonly clock: Clock;
  private readonly validate: FrameValidator;
  private readonly nextRequestId: () => string;
  private readonly onProblem: ProblemHook;
  private readonly metrics: AppMetrics;
  private readonly coachSamples: number;
  private readonly analyseCoach: CoachAnalyser;
  /** Sockets by room, and one table subscription per room rather than per socket. */
  private readonly byRoom = new Map<string, Set<WsConnection>>();
  private readonly subscriptions = new Map<string, () => void>();
  /** Per-session state that outlives any one socket. See `SessionState` and `takeCoachToken`. */
  private readonly bySession = new Map<string, SessionState>();
  private counter = 0;

  constructor(options: WsRouterOptions) {
    this.registry = options.registry;
    this.clock = options.clock;
    this.validate = options.validate;
    this.nextRequestId = options.nextRequestId ?? ((): string => `ws-${this.nextCount()}`);
    this.onProblem = options.onProblem ?? ((): void => undefined);
    this.metrics = options.metrics ?? appMetrics();
    this.coachSamples = options.coachSamples ?? DEFAULT_COACH_SAMPLES;
    this.analyseCoach = options.analyseCoach ?? pooledCoachAnalyser(options.config);
  }

  /** A monotonic counter for socket ids and fallback request ids. */
  private nextCount(): number {
    this.counter += 1;
    return this.counter;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Registers a socket that has already been authenticated and origin-checked.
   *
   * The handshake timer starts here: a socket that never sends `hello` has cost us an accepted
   * connection and holds a slot against `maxSocketsPerSession`, so it is closed rather than left
   * to sit. Closing with `4408` tells an honest client exactly what went wrong.
   */
  open(sink: SocketSink, principal: WsPrincipal): WsConnection {
    const connection: WsConnection = {
      id: `conn-${this.nextCount()}`,
      sink,
      principal,
      roomId: null,
      joining: false,
      revision: 0,
      tokens: WS_LIMITS.burstAllowance,
      lastRefillMs: this.clock.now(),
      handshake: null,
      missedHeartbeats: 0,
      closed: false,
    };
    // The session's entry is claimed here and released in `handleClose`, whatever ends the socket
    // — a peer close, the heartbeat's `terminate`, the shutdown drain. A Coach window that only
    // lived as long as one socket was the defect; one that never goes away is a leak. See
    // `SessionState`.
    const session = this.bySession.get(principal.sessionId) ?? {
      sockets: 0,
      coachRequests: [],
      expiry: null,
    };
    // A session that reconnects inside its window keeps the window. Cancelling the pending
    // deletion rather than letting it fire and re-creating the entry is what makes "close the
    // socket and open another" useless as a way to clear the Coach limit.
    session.expiry?.cancel();
    session.expiry = null;
    session.sockets += 1;
    this.bySession.set(principal.sessionId, session);
    connection.handshake = this.clock.schedule(WS_LIMITS.handshakeTimeoutMs, () => {
      if (connection.closed || connection.roomId !== null) return;
      this.closeConnection(connection, WS_CLOSE.handshakeTimeout, 'no hello');
    });
    return connection;
  }

  /** Releases a socket. Idempotent, because a close can arrive from either side. */
  handleClose(connection: WsConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.handshake?.cancel();
    connection.handshake = null;
    // BEFORE the `roomId === null` return below, because a socket that never sent `hello` still
    // claimed a session entry in `open`. Releasing it only on the room path would leave one entry
    // per handshake that timed out, held for the life of the process.
    this.releaseSession(connection.principal.sessionId);
    const roomId = connection.roomId;
    if (roomId === null) return;
    const sockets = this.byRoom.get(roomId);
    sockets?.delete(connection);
    this.registry.noteSocket(roomId, connection.principal.userId, -1);
    if (sockets !== undefined && sockets.size === 0) {
      this.byRoom.delete(roomId);
      // The room's table subscription belongs to the sockets watching it. Dropping it when the
      // last one goes stops a closed-over listener keeping this router alive for a dead room.
      this.subscriptions.get(roomId)?.();
      this.subscriptions.delete(roomId);
    } else {
      // Somebody's `connected` flag just changed, and that is on the wire.
      this.broadcast(roomId);
    }
  }

  /**
   * Drops one socket's claim on its session's state, and arms the state's own expiry.
   *
   * The deletion is the point. A `Map` keyed on something the caller supplies — a session id is
   * one per guest session, and a guest session costs one `POST /auth/guest` — is unbounded growth
   * unless every entry has something that removes it. Two things do here: the last socket
   * leaving, when there is no window to preserve, and a timer for when there is.
   */
  private releaseSession(sessionId: string): void {
    const session = this.bySession.get(sessionId);
    if (session === undefined) return;
    session.sockets -= 1;
    if (session.sockets > 0) return;
    if (session.coachRequests.length === 0) {
      // Nothing to remember. The overwhelmingly common case: most sockets never ask for a Coach
      // analysis at all, so most sessions leave no residue whatsoever.
      this.bySession.delete(sessionId);
      return;
    }
    // One window from now, not from the oldest token: it is an upper bound, it is one timer
    // instead of a re-arming chain, and over-retaining a handful of timestamps by up to a minute
    // costs nothing. The task is `unref`'d by `systemClock`, so it never holds the process open.
    session.expiry?.cancel();
    session.expiry = this.clock.schedule(COACH_WINDOW_MS, () => {
      // Re-checked rather than assumed: a socket may have come back and cancelled this, and a
      // stale timer deleting a live session's window would hand it a free reset.
      const current = this.bySession.get(sessionId);
      if (current === session && current.sockets <= 0) this.bySession.delete(sessionId);
    });
  }

  /**
   * Sessions this router currently holds state for.
   *
   * Public for the leak assertions in `test/ws-coach-session-limit.test.ts`: a limit whose
   * bookkeeping only ever grows is a different defect from the one it fixed, and "the map is
   * empty again afterwards" is the only way to see that from outside.
   */
  sessionsTracked(): number {
    return this.bySession.size;
  }

  /** Every socket currently attached to a room. */
  socketsIn(roomId: string): readonly WsConnection[] {
    return [...(this.byRoom.get(roomId) ?? [])];
  }

  /**
   * Closes every socket watching one room.
   *
   * Exists for one caller: a room this process has been FENCED from (`RoomRegistry.onEviction`).
   * The registry has already closed the table and dropped the room, so these sockets are attached
   * to something that will never send another frame — and a client sitting on a healthy socket that
   * has silently stopped receiving state is the worst possible version of this, because its ping
   * watchdog is answered and it never reconnects. Closing them with a real code is what sends it to
   * the process that does own the room.
   */
  closeRoom(roomId: string, code: WsCloseCode, reason: string): void {
    for (const connection of this.socketsIn(roomId)) this.closeConnection(connection, code, reason);
  }

  /** Closes every socket. The server's shutdown path calls this before the registry's. */
  closeAll(reason = 'server shutting down'): void {
    for (const sockets of [...this.byRoom.values()]) {
      for (const connection of [...sockets]) {
        this.closeConnection(connection, WS_CLOSE.serverShuttingDown, reason);
      }
    }
    // The session windows go with the sockets. Their expiry timers are `unref`'d and would not
    // hold the process open, but a router that has been shut down should be holding nothing at
    // all — an armed timer closing over a dead router is the shape `handleClose` drops a room's
    // table subscription to avoid.
    for (const session of this.bySession.values()) session.expiry?.cancel();
    this.bySession.clear();
  }

  // -----------------------------------------------------------------------
  // Inbound frames
  // -----------------------------------------------------------------------

  /**
   * Handles one inbound frame.
   *
   * The order is the security property, and it is cheapest-first: size, then rate, then parse,
   * then schema, then routing. A caller who sends a megabyte of malformed JSON at 500 frames a
   * second is refused by the first two checks, having cost one length comparison and one
   * subtraction each.
   */
  handleFrame(connection: WsConnection, raw: string | Uint8Array): void {
    if (connection.closed) return;

    const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
    if (bytes > WS_LIMITS.maxMessageBytes) {
      // Dropped without being parsed — the point of a size cap is to refuse before doing work —
      // and the socket is closed, because a client that oversends once will do it again.
      this.rejectFrame('too_large');
      this.closeConnection(connection, WS_CLOSE.rateLimited, 'frame too large');
      return;
    }
    if (!this.takeToken(connection)) {
      this.rejectFrame('rate_limited');
      this.closeConnection(connection, WS_CLOSE.rateLimited, 'too many messages');
      return;
    }

    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.rejectFrame('not_json');
      this.sendError(connection, null, 'invalid_request');
      return;
    }

    const validated = this.validate(parsed);
    if (!validated.ok) {
      // `validated.problem` is deliberately not the label. It is a sentence, and one that a
      // future validator could easily start deriving from the frame — which is how a caller
      // starts minting time series.
      this.rejectFrame('schema');
      this.sendError(connection, null, 'invalid_request');
      return;
    }
    const message = validated.value;

    if (connection.roomId === null && message.type !== 'hello') {
      // Not a close: an honest client that raced its own `hello` deserves to be told rather than
      // dropped, and the handshake timer is still running.
      this.rejectFrame('before_handshake');
      this.sendError(connection, requestIdOf(message), 'invalid_request');
      return;
    }

    switch (message.type) {
      case 'hello':
        void this.onHello(connection, message);
        return;
      case 'ping':
        this.send(connection, { type: 'pong', nonce: message.nonce, serverTimeMs: this.clock.now() });
        return;
      case 'sit':
        void this.guard(connection, message.requestId, () =>
          this.onSit(connection, message.seat, message.requestId),
        );
        return;
      case 'stand':
        void this.guard(connection, message.requestId, () => this.onStand(connection, message.requestId));
        return;
      case 'startHand':
        void this.guard(connection, message.requestId, () => this.onStartHand(connection, message.requestId));
        return;
      case 'action':
        void this.guard(connection, message.requestId, () => this.onAction(connection, message));
        return;
      case 'requestCoach':
        void this.guard(connection, message.requestId, () => this.onCoach(connection, message));
        return;
      default:
        // Unreachable while the schema and this switch agree: the validator has already narrowed
        // the frame to one of the contract's message types. It stays because the two can drift —
        // a message added to the contract and not handled here would otherwise be silently
        // ignored — and this counter is how that drift becomes visible.
        this.rejectFrame('unknown_type');
        this.sendError(connection, null, 'invalid_request');
        return;
    }
  }

  /**
   * Counts one refused frame against a reason from the closed set above.
   *
   * One method rather than eight `inc` calls so that the label can only ever be a
   * `WsFrameRejection` — a call site cannot pass a string that happens to be handy.
   */
  private rejectFrame(reason: WsFrameRejection): void {
    this.metrics.wsFramesRejected.inc({ reason });
  }

  /**
   * Runs one intent, turning a thrown `AppError` into an error frame.
   *
   * Every handler below is allowed to throw the same `AppError` a REST route would, so the two
   * transports report a rejection with the same code and the same wording, and neither can leak
   * an internal message: only `ERROR_MESSAGES[code]` is ever sent.
   */
  private async guard(connection: WsConnection, requestId: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (isAppError(error)) {
        this.sendError(connection, requestId, error.code);
        return;
      }
      this.onProblem('a socket intent failed unexpectedly', {
        event: 'socket-intent',
        error: String(error),
      });
      this.sendError(connection, requestId, 'internal_error');
    }
  }

  // -----------------------------------------------------------------------
  // The intents
  // -----------------------------------------------------------------------

  /**
   * `hello`: the protocol version, the room, and the membership check.
   *
   * Authentication is *not* here. It happened during the upgrade, from the session cookie, and a
   * token in the first frame would end up in client logs and browser history far more easily than
   * an `HttpOnly` cookie does.
   *
   * ## An empty registry is not a refusal
   *
   * This used to be `registry.require` on its own, and room state is in memory by design, so an API
   * restart stranded every open table: the first `hello` afterwards found no live room, answered
   * `room_not_found_or_not_permitted`, and the client showed a member of their own table "Not your
   * table… either it does not exist or this session is not a member of it". The row was still
   * there, and so was their membership. `reopenFor` rebuilds it from the database the way the REST
   * path (`openRoomFor` in `routes/rooms.ts`) always has.
   */
  private async onHello(
    connection: WsConnection,
    message: WsClientMessage & { type: 'hello' },
  ): Promise<void> {
    // `joining` as well as `roomId`, because reopening a room reads the database and this handler
    // is dispatched with `void`. Two `hello` frames arriving in one tick would both pass a
    // `roomId === null` test, both await, and both run the join below — registering the same socket
    // twice and leaving `noteSocket` one increment over, so a member who has disconnected still
    // shows as connected at the table. Set synchronously, before anything can suspend.
    if (connection.roomId !== null || connection.joining) {
      this.rejectFrame('duplicate_hello');
      this.sendError(connection, null, 'invalid_request');
      return;
    }
    if (message.protocolVersion !== WS_PROTOCOL_VERSION) {
      // The version itself is not the label. It is a number the client chose, so labelling by it
      // would let one caller mint a series per integer it feels like sending.
      this.rejectFrame('bad_protocol_version');
      this.sendError(connection, null, 'unsupported_protocol_version');
      this.closeConnection(connection, WS_CLOSE.protocolMismatch, 'protocol version');
      return;
    }
    connection.joining = true;

    let room: LiveRoom;
    try {
      // A room already in memory is taken with no `await` EVALUATED on this path — the branch is
      // the point, not an optimisation. `await` on an already-resolved promise still suspends for
      // a microtask, and suspending here would move every handshake behind one: a client whose
      // `hello` and `sit` arrive in a single read would have the `sit` refused by the "no room
      // yet" guard in `handleFrame`, and `test/ws-router.test.ts` — which drives the protocol with
      // no event loop between frames — would stop seeing a welcome at all. Only the first `hello`
      // for a room this process has not loaded, which is to say the first one after a restart,
      // waits for anything.
      const live = this.registry.get(message.roomId);
      room =
        live === null
          ? await this.reopenFor(message.roomId, connection.principal.userId)
          : this.registry.require(message.roomId, connection.principal.userId);
    } catch (error) {
      connection.joining = false;
      const code: ErrorCode = isAppError(error) ? error.code : 'internal_error';
      this.sendError(connection, null, code);
      // The close code comes from the SAME error the frame does. It used to be a hard-coded
      // `WS_CLOSE.forbidden` here, justified by a comment that only held for one of the errors
      // this block can catch: "4403 for both 'no such room' and 'not your room' — the frame
      // already carries the one code that does not distinguish them, and the close code must not
      // either." That reasoning is still exactly right for `room_not_found_or_not_permitted`, and
      // `wsCloseForError` keeps it: a 4xx code still closes 4403, so a stranger and a room that
      // never existed remain indistinguishable, close code included.
      //
      // What the comment did not cover is everything else that can be thrown here. Nothing on the
      // `reopenFor` path is wrapped — `store.byId`, `store.memberOf` and `ensureOpen`'s
      // `membersOfRooms` all reach Postgres directly — so a connection blip arrived as a plain
      // `Error`, became `internal_error` in the frame, and was still closed 4403. 4403 is
      // `retryable: false` in `describeClose` (`apps/web/src/lib/table-socket.ts`), so the client
      // set status `closed` and never tried again: a member of their own table was told, until
      // they reloaded by hand, that the table was not theirs. A 5xx code now closes 4503, which
      // that same client reconnects from with backoff.
      const closeCode = wsCloseForError(code);
      this.closeConnection(
        connection,
        closeCode,
        // The reason is diagnostic only — browsers do not show it — so it says which of the two
        // things happened, which the close code deliberately no longer does on its own.
        closeCode === WS_CLOSE.forbidden ? 'not permitted' : 'handshake failed',
      );
      return;
    }
    connection.joining = false;
    // The socket may have gone while the room was being read back from the database. Joining it now
    // would put a closed connection in `byRoom` that `handleClose` has already been through, so the
    // room would carry a socket nothing will ever remove.
    if (connection.closed) return;

    connection.handshake?.cancel();
    connection.handshake = null;
    connection.roomId = message.roomId;

    const sockets = this.byRoom.get(message.roomId) ?? new Set<WsConnection>();
    sockets.add(connection);
    this.byRoom.set(message.roomId, sockets);
    this.registry.noteSocket(message.roomId, connection.principal.userId, 1);
    this.ensureSubscription(message.roomId);

    const summary = toRoomSummary(room);
    this.send(connection, {
      type: 'welcome',
      protocolVersion: WS_PROTOCOL_VERSION,
      clientNonce: message.clientNonce,
      userId: connection.principal.userId,
      room: summary,
      seat: room.table.seatOf(connection.principal.userId),
      serverTimeMs: this.clock.now(),
    });
    // Reconnect is exactly this: send the current view. There is no catch-up protocol.
    this.sendState(connection, summary);
    // Everybody else's `connected` flag just changed.
    this.broadcastExcept(message.roomId, connection);
    await Promise.resolve();
  }

  /**
   * Rebuilds a room this process has never seen, and refuses a stranger without telling them it
   * exists.
   *
   * Only called when `registry.get` came back null — `onHello` takes a live room synchronously, and
   * the comment there says why that branch is load-bearing rather than an optimisation. The `get`
   * is repeated here anyway so this method is correct on its own terms: a caller that reached it
   * with a live room would otherwise re-read the durable rows for no reason.
   *
   * ## The order of the two checks is a security property
   *
   * Membership is read from the durable rows BEFORE anything is built. Opening first and checking
   * afterwards would be shorter and would let anybody who guessed a room id make this process
   * construct a live table — a `HandState`, a turn timer, a bot runner — before being told no.
   *
   * Every refusal is the same `room_not_found_or_not_permitted`, with the detail only in the log:
   * "that room exists but is not yours" is a free way to confirm a room id, which is why the REST
   * side answers a 404 that does not confirm the room exists and the socket answers one error code
   * and one close code (4403) for both cases.
   *
   * This deliberately mirrors `openRoomFor` in `routes/rooms.ts` step for step, including the
   * `logDetail`. The two really should be one method on `RoomRegistry` — that is the file both
   * transports already depend on, and a rule about who may open a room belongs next to the opening.
   * Left duplicated here only because this change could not touch either of those files; if you are
   * editing one of these two functions, move both.
   */
  private async reopenFor(roomId: string, userId: string): Promise<LiveRoom> {
    const live = this.registry.get(roomId);
    if (live !== null) return this.registry.require(roomId, userId);

    const refuse = (): never => {
      throw new AppError('room_not_found_or_not_permitted', {
        logDetail: `room ${roomId} is unknown, closed, or not this caller's`,
      });
    };
    const row = await this.registry.store.byId(roomId);
    if (row === null || row.status === 'closed') refuse();
    const member = await this.registry.store.memberOf(roomId, userId);
    if (member === null && row?.owner_user_id !== userId) refuse();

    // The row is durable, the table is not. This is what makes a room usable again after a restart:
    // it rebuilds the table from the roster, re-taking the seats the database records.
    if ((await this.registry.ensureOpen(roomId)) === null) refuse();
    return this.registry.require(roomId, userId);
  }

  private async onSit(connection: WsConnection, seat: number, requestId: string): Promise<void> {
    const roomId = this.requireRoom(connection);
    await this.registry.sitAtTable(roomId, connection.principal, seat);
    this.send(connection, { type: 'ack', requestId });
    this.broadcast(roomId);
  }

  private async onStand(connection: WsConnection, requestId: string): Promise<void> {
    const roomId = this.requireRoom(connection);
    await this.registry.standFromTable(roomId, connection.principal.userId);
    this.send(connection, { type: 'ack', requestId });
    this.broadcast(roomId);
  }

  private async onStartHand(connection: WsConnection, requestId: string): Promise<void> {
    const roomId = this.requireRoom(connection);
    const room = this.registry.require(roomId, connection.principal.userId);
    await room.table.startHand();
    this.send(connection, { type: 'ack', requestId });
    // The state frames go out through the table's own notice, which fires inside `startHand`.
  }

  /**
   * `action`: the one intent that changes a hand.
   *
   * Everything that decides whether it is legal is the table's and the engine's. The router's job
   * is to hand over `actionId`, `expectedSequence` and the intent unchanged, and to report what
   * came back — including `deduplicated: true` for a retry, which is a success and not an error.
   */
  private async onAction(
    connection: WsConnection,
    message: WsClientMessage & { type: 'action' },
  ): Promise<void> {
    const roomId = this.requireRoom(connection);
    const room = this.registry.require(roomId, connection.principal.userId);
    const outcome = await room.table.submitAction(connection.principal.userId, {
      action: message.action,
      actionId: message.actionId,
      expectedSequence: message.expectedSequence,
    });
    this.send(connection, {
      type: 'ack',
      requestId: message.requestId,
      appliedSequence: outcome.appliedSequence,
      ...(outcome.deduplicated ? { deduplicated: true } : {}),
    });
  }

  /**
   * `requestCoach`: the analysis for the caller's own decision.
   *
   * Built from the caller's own redacted view and nothing else, which is what makes it safe: the
   * view carries that seat's own cards (and nobody else's), so answering it needs no new exit from
   * the trust zone. A report for somebody else's decision is not representable here.
   *
   * ## The order of the four gates is load-bearing
   *
   * Difficulty, then the rate limit, then the hand, then the pool. The two refusals that cost
   * nothing come first, so an Expert table — which sells "Coach in review only" — never queues a
   * task it is going to refuse, and a session over its minute limit never occupies a thread. That
   * ordering was already here for the rate-limit token; it matters more now that what follows it
   * is a queue slot rather than a stretch of this thread's time.
   *
   * ## What crosses to the thread, and what comes back
   *
   * A `CoachTask`: two cards the caller already holds, the public board, the pot, the stacks, the
   * street, the engine's own `legalActions` and a range DESCRIPTOR. No `HandState`, no deck, no
   * salt, no other seat's cards — the calculator could not leak one if it wanted to, because it
   * is never given one (see `equity-worker.ts`). What comes back is a `CoachReport`, and
   * `WorkerPool.runCoach` checks it against the task's own legal set before it returns, so the
   * socket path now gets the guarantee `assertReportStaysInsideItsLegalSet` was written for and
   * previously only the REST path had.
   */
  private async onCoach(
    connection: WsConnection,
    message: WsClientMessage & { type: 'requestCoach' },
  ): Promise<void> {
    const roomId = this.requireRoom(connection);
    const room = this.registry.require(roomId, connection.principal.userId);
    // Expert Legends sells "Coach in review only". Refuse before spending a rate-limit token,
    // and — since the analysis moved to a thread — before anything is queued.
    if (!room.bots.coachDuringHand()) {
      throw new AppError('coach_not_available', {
        logDetail: `live Coach refused in ${roomId}: a seated bot plays a difficulty that turns it off`,
      });
    }
    if (!this.takeCoachToken(connection)) {
      throw new AppError('rate_limited', {
        retryAfterSeconds: 5,
        // "for this session", not "on this socket": the window is the session's, so closing this
        // socket and opening another does not clear it. The log detail said the wrong one while
        // the limiter did too.
        logDetail: 'coach requests per minute exceeded for this session',
      });
    }
    const view = room.table.viewFor(connection.principal.userId);
    if (view === null) throw new AppError('hand_not_active', { logDetail: 'no hand to analyse' });
    // Everything that can refuse this request from the view alone happens here, on this thread,
    // in microseconds: no seat, no cards, no decision to make, an unreadable range. A task is
    // only built once the answer is known to be worth computing.
    const task = coachTaskForView(view, {
      samples: this.coachSamples,
      ...(message.opponentRange === undefined ? {} : { opponentRange: message.opponentRange }),
    });
    // Timed and counted like the REST analyses. `scripts/load-test.mjs` states in its own header
    // that the socket Coach feeds no server-side histogram and has to be measured client-side;
    // it does now, under the same `kind="coach"` label, because it is the same work on the same
    // threads and an operator asking "is the Coach slow?" should not have to know which transport
    // asked for it.
    const report = await observeAnalysis('coach', () => this.analyseCoach(task), this.metrics);
    // The socket may have gone while the thread was working. Dropping the report is the whole
    // handling: `send` would refuse it anyway, and saying so here is what stops a future reader
    // adding a "deliver it somewhere" branch for a connection that no longer exists.
    if (connection.closed) return;
    this.send(connection, { type: 'coach', requestId: message.requestId, report });
  }

  // -----------------------------------------------------------------------
  // Outbound
  // -----------------------------------------------------------------------

  /**
   * Sends every socket in a room its own view.
   *
   * One `viewFor` call per socket. Never one object shared between recipients — see the file
   * comment for why that is the shape this method exists to prevent.
   */
  broadcast(roomId: string): void {
    this.broadcastExcept(roomId, null);
  }

  private broadcastExcept(roomId: string, skip: WsConnection | null): void {
    const room = this.registry.get(roomId);
    if (room === null) return;
    this.dropDepartedSockets(roomId);
    const summary = toRoomSummary(room);
    for (const connection of this.socketsIn(roomId)) {
      if (connection === skip || connection.closed) continue;
      this.sendState(connection, summary);
    }
  }

  /**
   * Closes the sockets of anyone who is no longer a member of the room they are watching.
   *
   * ## The defect
   *
   * `onHello` checks membership — `registry.require`, or `reopenFor`'s two durable reads — and the
   * socket is never asked again. `POST /rooms/:roomId/leave` drops the membership durably and in
   * memory, so a FRESH `hello` from the departed learner is correctly refused
   * `room_not_found_or_not_permitted`; the socket they already had went on receiving the private
   * table. Measured against the code this was written for, after `leaveRoom` for that learner:
   *
   *     ex-member's socket -> {"type":"event","event":{"kind":"playerJoined",...}}
   *                        -> {"type":"state","room":{...members:[...]},...}
   *     ex-member's fresh hello -> {"type":"error","error":{"code":"room_not_found_or_not_permitted"}}
   *
   * An invite-only table is invite-only for the duration, not only at the door. The frames carry
   * the roster, the seats, the stacks and — once a hand is dealt — the spectator's view of it.
   *
   * ## Why it is checked here rather than announced by the registry
   *
   * Because the check is a `Map` lookup and this is the one place every outbound frame passes
   * through. An event on the registry would have to be raised by `leaveRoom` and by every future
   * path that ends a membership, and a path that forgot to raise it would be this defect again
   * with no test to notice. Asking the question where the frame is about to go cannot be forgotten
   * by a new caller.
   *
   * The cost is that a departure is acted on at the next table change rather than at the instant
   * it happens. That is not a hole: nothing is SENT between the two, because the next thing sent
   * is what triggers this. It is bounded, it is `O(sockets in the room)`, and it is the same
   * comparison `registry.require` makes.
   */
  private dropDepartedSockets(roomId: string): void {
    const room = this.registry.get(roomId);
    if (room === null) return;
    for (const connection of this.socketsIn(roomId)) {
      if (connection.closed) continue;
      const userId = connection.principal.userId;
      if (room.member(userId) !== null || room.record.ownerUserId === userId) continue;
      // 4403 and not 4401: the session is fine, the table is not theirs any more. That is what
      // `describeClose` in `apps/web/src/lib/table-socket.ts` renders as "not your table", which is
      // exactly right for somebody who has just left it, and it is permanent — a reconnect would
      // be refused by `onHello` for the same reason.
      this.closeConnection(connection, WS_CLOSE.forbidden, 'no longer a member of this table');
    }
  }

  /** Attaches this router to a room's table, once, however many sockets are watching. */
  private ensureSubscription(roomId: string): void {
    if (this.subscriptions.has(roomId)) return;
    const unsubscribe = this.registry.subscribe(roomId, (notice) => this.onTableChange(roomId, notice));
    this.subscriptions.set(roomId, unsubscribe);
  }

  private onTableChange(roomId: string, notice: TableNotice): void {
    const serverTimeMs = this.clock.now();
    // BEFORE the events, not only before the state below: an `action` or `showdown` event is a
    // frame about a private table like any other, and `broadcast` at the end of this method would
    // be too late to keep it from somebody who has left. See `dropDepartedSockets`.
    this.dropDepartedSockets(roomId);
    for (const connection of this.socketsIn(roomId)) {
      if (connection.closed) continue;
      // Events first, then state. An event is for animation and the action log and is never
      // load-bearing; the state that follows it is the truth, so a client that ignored every
      // event would still render a correct table.
      for (const event of notice.events) this.send(connection, { type: 'event', event, serverTimeMs });
    }
    this.broadcast(roomId);
  }

  private sendState(connection: WsConnection, summary: RoomSummary): void {
    const room = this.registry.get(summary.id);
    if (room === null) return;
    connection.revision += 1;
    this.send(connection, {
      type: 'state',
      view: room.table.viewFor(connection.principal.userId),
      room: summary,
      deadlineMs: room.table.snapshot().deadlineMs,
      serverTimeMs: this.clock.now(),
      revision: connection.revision,
    });
  }

  private send(connection: WsConnection, message: WsServerMessage): void {
    if (connection.closed) return;
    try {
      connection.sink.send(JSON.stringify(message));
    } catch (error) {
      // A send that throws means the socket is gone; the close event will follow. Recorded rather
      // than rethrown, because a dead socket must not fail the action that triggered the frame.
      this.onProblem('a socket send failed', { event: 'socket-send', error: String(error) });
    }
  }

  private sendError(connection: WsConnection, requestId: string | null, code: ErrorCode): void {
    const error: ApiError['error'] = {
      code,
      // Only the contract's own wording, never an internal message. Same rule as `errors.ts`.
      message: ERROR_MESSAGES[code],
      requestId: this.nextRequestId(),
    };
    this.send(connection, { type: 'error', requestId, error });
  }

  /** Closes a socket and releases everything it held. */
  closeConnection(connection: WsConnection, code: number, reason: string): void {
    if (connection.closed) {
      return;
    }
    try {
      connection.sink.close(code, reason);
    } catch (error) {
      this.onProblem('a socket close failed', { event: 'socket-close', error: String(error) });
    }
    this.handleClose(connection);
  }

  // -----------------------------------------------------------------------
  // Limits
  // -----------------------------------------------------------------------

  /**
   * The per-socket token bucket.
   *
   * Capacity `burstAllowance`, refilled at `messagesPerSecond`. A bucket rather than a fixed
   * window because a client legitimately bursts — a reconnect sends `hello` and then several
   * intents in the same tick — and a fixed window either forbids that or has to be set so high
   * that it stops limiting anything.
   */
  private takeToken(connection: WsConnection): boolean {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - connection.lastRefillMs);
    connection.lastRefillMs = now;
    connection.tokens = Math.min(
      WS_LIMITS.burstAllowance,
      connection.tokens + (elapsed * WS_LIMITS.messagesPerSecond) / 1_000,
    );
    if (connection.tokens < 1) return false;
    connection.tokens -= 1;
    return true;
  }

  /**
   * The Coach window, keyed on the SESSION rather than on the socket.
   *
   * ## What was wrong
   *
   * This used to filter and push `connection.coachRequests`, a `WsConnection` field. The contract
   * has always said `coachRequestsPerMinute` is "per minute per session", and a session is
   * permitted `WS_LIMITS.maxSocketsPerSession` sockets at once, so the enforced limit was four
   * times the published one: one session opening its four permitted sockets could put
   * 4 × 30 = 120 analyses a minute onto the shared worker pool — which is precisely the
   * process-wide resource the number exists to protect, and which every other session is queuing
   * behind. Measured before: 4 sockets, one session, 30 accepted on each, 120 total. After: 30
   * accepted across all four, the 31st refused with `rate_limited` on whichever socket sent it.
   *
   * ## Why a session entry and not a `WsConnection` field
   *
   * The counter has to outlive any one socket, or a caller resets it by reconnecting — which is
   * free and which a client already does on every network hiccup. It must also not outlive the
   * session, or the map grows one entry per session forever; `open` and `handleClose` reference-
   * count it, the same lifetime `hub.ts` gives `maxSocketsPerSession`.
   *
   * A missing entry means the socket has already been released, which `handleFrame`'s
   * `connection.closed` guard makes unreachable. It is refused rather than lazily recreated: a
   * recreated entry would be a fresh window for a caller whose bookkeeping we have already
   * dropped, and re-adding it here is how the leak comes back.
   */
  private takeCoachToken(connection: WsConnection): boolean {
    const session = this.bySession.get(connection.principal.sessionId);
    if (session === undefined) return false;
    const now = this.clock.now();
    session.coachRequests = session.coachRequests.filter((at) => now - at < COACH_WINDOW_MS);
    if (session.coachRequests.length >= WS_LIMITS.coachRequestsPerMinute) return false;
    session.coachRequests.push(now);
    return true;
  }

  private requireRoom(connection: WsConnection): string {
    const roomId = connection.roomId;
    if (roomId === null) {
      throw new AppError('invalid_request', { logDetail: 'an intent arrived before hello' });
    }
    return roomId;
  }
}

/** The `requestId` a message carries, or null for the two that have none. */
function requestIdOf(message: WsClientMessage): string | null {
  return 'requestId' in message ? message.requestId : null;
}

export interface CoachForViewOptions {
  readonly samples: number;
  readonly opponentRange?: string;
}

/**
 * The seed every live Coach analysis runs under.
 *
 * `1` is not arbitrary: it is the seed `monteCarloEquity` falls back to when no caller names one,
 * which is what this path has always used because `coachForView` never passed one. `CoachTask`
 * requires the field — a task is a complete description of a reproducible computation — so it is
 * written down here rather than defaulted somewhere invisible. Changing this number changes every
 * live Coach figure in the product, which is the reason it is a named constant and not a literal.
 */
const COACH_SEED = 1;

/**
 * Everything a Coach answer needs from one redacted view, with every refusal already made.
 *
 * Extracted so that the two things built from a view — the task the thread runs, and the report
 * `coachForView` computes here — cannot disagree about WHO may ask, WHAT is refused, or WHICH
 * numbers are read off the view. Only the range differs between them, and it differs in exactly
 * one way: a task carries a range descriptor for the thread to expand, where the in-process path
 * expands it itself.
 */
interface CoachSituation {
  readonly own: SeatView;
  readonly heroCards: readonly Card[];
  readonly street: BettingStreetName;
  readonly opponents: readonly SeatView[];
  readonly legalActions: readonly CoachAction[];
  /**
   * The part of `view.potTotal` hero could actually win, from the engine's own layering.
   *
   * Read once, here, for the same reason `legalActions` is: the task a thread runs and the report
   * `coachForView` computes must not be able to disagree about it. It is the whole middle in every
   * ordinary spot and less than it exactly when hero is all-in for less than the bet — the case
   * that used to price a call against a side pot hero is not in.
   */
  readonly contestablePot: number;
  /** Hero's cards and the board: what no opponent can be holding. */
  readonly dead: readonly Card[];
  /** The range the caller named, or the default. Still a string: `top:NN` must not expand here. */
  readonly notation: string;
}

/**
 * Reads one view, or refuses it.
 *
 * Deliberately a function of the view: the caller's own cards are in it, nobody else's are, and
 * therefore there is no way to ask this for an analysis of an opponent's decision.
 *
 * ## The view's own `legalActions` is passed straight through
 *
 * `PlayerView.legalActions` is `legalActions(state, seat)` — the engine's single definition of
 * legality — and it is populated only when it is the recipient's turn. Handing it to the Coach is
 * what closes the last hole in "never recommend an action the server would reject": sizes were
 * already checked against the engine's minimum, but the *availability* of a bet or raise is a
 * different question and one the Coach cannot answer from the pot and the stacks. Measured, before
 * this: a three-handed preflop spot with one opponent folded and the other all-in, the engine
 * offering `fold, call`, and the Coach's headline suggestion "raise to 80-100".
 *
 * An empty list means there is no decision — betting is closed for the hand, or the seat is not to
 * act — and that is refused here rather than answered with a report whose every candidate the
 * table would reject.
 */
function readCoachSituation(view: PlayerView, options: CoachForViewOptions): CoachSituation {
  const own = view.seats.find((seat) => seat.isSelf);
  const heroCards = own?.holeCards ?? null;
  if (own === undefined || heroCards === null) {
    throw new AppError('not_seated', { logDetail: 'a Coach request needs a seat holding cards' });
  }
  const street = view.street;
  if (street === 'showdown' || street === 'complete') {
    throw new AppError('hand_not_active', { logDetail: `no decision to analyse during ${street}` });
  }
  const opponents = view.seats.filter(
    (seat) => !seat.isSelf && (seat.status === 'active' || seat.status === 'allIn'),
  );
  if (opponents.length === 0) {
    throw new AppError('hand_not_active', { logDetail: 'no live opponent to analyse against' });
  }
  // `redactFor` only fills this in for the seat that is to act, so the guard covers both "not
  // your turn" and "betting is closed for the hand" — the two states in which every action,
  // including folding, would be rejected.
  const legalActions: readonly CoachAction[] = view.legalActions.map((entry) => entry.type);
  if (legalActions.length === 0) {
    throw new AppError('hand_not_active', {
      logDetail:
        view.toAct === own.seat
          ? 'betting is closed for the hand, so there is no decision to analyse'
          : `a Coach request arrived for seat ${own.seat} while seat ${String(view.toAct)} is to act`,
    });
  }
  // Asked of the engine rather than derived from the view's numbers. `view.seats` carries every
  // seat's street commitment and status, which is exactly what the layering rule reads, and
  // `view.amountToCall` is already capped at hero's stack — so this is the same question the
  // dealer answers when the hand is settled, asked one call early. Every seat is passed, folded
  // ones included: their chips are in the middle and hero can win them.
  const { contestable } = contestablePotFor({
    seats: view.seats,
    heroSeat: own.seat,
    callAmount: view.amountToCall,
    potTotal: view.potTotal,
  });

  return {
    own,
    heroCards,
    street,
    opponents,
    legalActions,
    contestablePot: contestable,
    dead: [...heroCards, ...view.board],
    notation: options.opponentRange ?? DEFAULT_COACH_RANGE,
  };
}

/**
 * The assumed range as a DESCRIPTOR for a calculator thread, having been checked here.
 *
 * The check and the expansion are separated on purpose, and the split is the whole point of this
 * function. A `top:NN` range can only be expanded by building the preflop strength ordering —
 * about three seconds, memoised per thread — so expanding it on this thread is the stall that
 * made the live Coach a defect in the first place. The percentage is therefore validated
 * (`1..100`, which is what `assumedRange` checks before it expands) and sent as a number.
 *
 * Notation is different: `parseRange` is microseconds, and running it here is what turns a range
 * this server cannot read into a `400` with a named field instead of a thread that dies of a
 * `RangeParseError` and a caller told `internal_error`. The expansion it produces is discarded —
 * the thread parses the same string again against the same blockers and must, because the
 * expansion is not a thing the wire protocol carries — so the cost of the check is one parse of a
 * few hundred combinations and the benefit is an honest refusal.
 */
function coachRangeFor(situation: CoachSituation, label: string): WireRange {
  const percent = /^top:(\d{1,3})$/.exec(situation.notation.trim());
  if (percent !== null) {
    const value = Number(percent[1]);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new AppError('invalid_request', {
        fields: { opponentRange: 'a top percentage must be between 1 and 100' },
        logDetail: `rejected range "${situation.notation}"`,
      });
    }
    return { kind: 'topPercent', label, percent: value };
  }
  assumedRange(situation.notation, situation.dead);
  return { kind: 'notation', label, notation: situation.notation };
}

/**
 * One redacted view, as the task a calculator thread runs.
 *
 * This is what `requestCoach` sends to the pool. Everything expensive is described rather than
 * computed: the range is a descriptor (see `coachRangeFor`), and the arithmetic is the thread's.
 * Everything cheap — the refusals, the redaction rule, the numbers read off the view — has
 * already happened by the time this returns.
 */
export function coachTaskForView(view: PlayerView, options: CoachForViewOptions): CoachTask {
  const situation = readCoachSituation(view, options);
  return {
    kind: 'coach',
    spec: {
      heroLabel: 'you',
      heroCards: situation.heroCards,
      board: view.board,
      // The same assumed range for each opponent. A per-seat range would need a read this
      // endpoint does not have, and pretending otherwise would put false precision in front of a
      // learner. Five is `buildCoachReport`'s own ceiling; a six-max table cannot exceed it.
      opponents: situation.opponents.slice(0, 5).map((seat) => coachRangeFor(situation, `seat ${seat.seat}`)),
    },
    street: situation.street,
    pot: view.potTotal,
    contestablePot: situation.contestablePot,
    toCall: view.amountToCall,
    // Both taken from the view rather than derived: `to` is a total street commitment,
    // and the minimum is the engine's own, so no size the Coach publishes here can be
    // one this table would refuse.
    heroCommittedThisStreet: situation.own.committedThisStreet,
    heroStack: situation.own.stack,
    opponentStacks: situation.opponents.map((seat) => seat.stack),
    bigBlind: view.config.bigBlind,
    minimumRaiseTo: view.minimumRaiseTo,
    legalActions: situation.legalActions,
    samples: options.samples,
    seed: COACH_SEED,
  };
}

/**
 * The same analysis, computed on the calling thread.
 *
 * ## Why this still exists now that the socket uses a thread
 *
 * It is the reference implementation, and it is load-bearing as one. `coachTaskForView` describes
 * a computation that happens somewhere else, in a process this file cannot see; the only way to
 * know that the description still means what it used to mean is to run the analysis both ways and
 * compare the reports. `test/event-loop-budget.test.ts` does exactly that — same view, same
 * samples, same seed, one report from here and one from a real worker thread, asserted equal — so
 * a future edit to either side that changes a figure fails a test instead of quietly changing what
 * a learner is told. `test/ws-router.test.ts` uses it for the same reason: it is the definition of
 * the analysis, with no pool to arrange.
 *
 * The range is expanded here, which means a `top:NN` range builds the preflop strength table on
 * THIS thread. That is the cost this function is not allowed to pay in production and is why no
 * production path calls it any more.
 */
export function coachForView(view: PlayerView, options: CoachForViewOptions): CoachReport {
  const situation = readCoachSituation(view, options);
  return buildCoachReport({
    heroCards: situation.heroCards,
    board: view.board,
    street: situation.street,
    opponents: situation.opponents.slice(0, 5).map((seat) => ({
      label: `seat ${seat.seat}`,
      range: assumedRange(situation.notation, situation.dead),
    })),
    pot: view.potTotal,
    contestablePot: situation.contestablePot,
    toCall: view.amountToCall,
    heroCommittedThisStreet: situation.own.committedThisStreet,
    heroStack: situation.own.stack,
    opponentStacks: situation.opponents.map((seat) => seat.stack),
    bigBlind: view.config.bigBlind,
    minimumRaiseTo: view.minimumRaiseTo,
    legalActions: situation.legalActions,
    samples: options.samples,
    seed: COACH_SEED,
  });
}

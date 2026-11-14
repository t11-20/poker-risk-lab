/**
 * The WebSocket message handler, with no socket in it. Sockets, upgrades, origins and cookies live in
 * `hub.ts`, so a test can drive the real protocol through a two-method `SocketSink`.
 * Every change sends the complete redacted view (ADR 0009), never a delta, so reconnect is "send the
 * current view". `broadcast` builds a view per recipient, because a shared view is how hole cards leak.
 * Frames are validated with Fastify's own Ajv, which has `coerceTypes: 'array'`. Every schema field is
 * bounded or an enum, so coercion cannot produce an out-of-range value.
 * Frame limits are per socket. The Coach limit is per session, because the worker pool is
 * process-wide and a session may hold several sockets.
 * Coach analysis runs on the shared worker pool. Inline, it stalled the event loop for 3,034 ms cold.
 * The report describes the view when the request was accepted, and carries its `requestId`.
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
import type { PlayerView } from '@prl/poker-engine';
import { type CoachRefusal, coachSpotForView, LIVE_COACH_POLICY } from '@prl/poker-math';
import { STRENGTH_TABLE_ALLOWANCE_MS } from '../calc/parse.ts';
import type { AppConfig } from '../config.ts';
import { AppError, isAppError } from '../errors.ts';
import { type AppMetrics, appMetrics } from '../observability/metrics.ts';
import { observeAnalysis, type ProblemHook } from '../observability/telemetry.ts';
import { assumedRange, opponentRangeOption } from '../rooms/bots.ts';
import type { LiveRoom, RoomRegistry } from '../rooms/registry.ts';
import { toRoomSummary } from '../rooms/registry.ts';
import type { TableNotice } from '../rooms/table.ts';
import type { Clock, ScheduledTask } from '../rooms/timers.ts';
import type { CoachTask } from '../workers/equity-worker.ts';
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
  /** The key for per-session limits. Never sent and never logged. */
  readonly sessionId: string;
}

export interface WsConnection {
  readonly id: string;
  readonly sink: SocketSink;
  readonly principal: WsPrincipal;
  /** Null until `hello` has been accepted. */
  roomId: string | null;
  /**
   * True while a `hello` is being handled. Reopening a room reads the database, so a second `hello`
   * could otherwise join the same socket twice. See `onHello`.
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
 * Label values for `prl_websocket_frames_rejected_total`, a closed set. Chosen at the rejection site
 * and NEVER derived from the frame, or a caller could mint unbounded series. Snake_case, so these
 * cannot be confused with `ProblemEvent` names.
 */
export type WsFrameRejection =
  /** Over `WS_LIMITS.maxMessageBytes`. Dropped unparsed; the socket is closed. */
  | 'too_large'
  /** The per-socket token bucket was empty. The socket is closed. */
  | 'rate_limited'
  | 'not_json'
  | 'schema'
  | 'unknown_type'
  | 'before_handshake'
  | 'duplicate_hello'
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
  /** Monte Carlo samples over a socket. Lower than REST, because the player is on their own clock. */
  readonly coachSamples?: number;
  /**
   * Defaults to the shared pool, so a deployment that passes nothing still keeps the analysis off the
   * event loop. A seam so tests can drive the pool's refusals.
   */
  readonly analyseCoach?: CoachAnalyser;
}

/**
 * Pool rejections are `AppError`s, which reach the socket through `guard` as error frames with the
 * contract's wording.
 */
export type CoachAnalyser = (task: CoachTask) => Promise<CoachReport>;

/**
 * The shared pool, under the configured Coach budget. A `top:NN` range needs the preflop strength
 * table, about 3 s cold per thread, so without `STRENGTH_TABLE_ALLOWANCE_MS` the first request in a
 * process would time out and the next would start cold again. `config` comes from `ws/hub.ts`, so
 * sockets and REST share one budget.
 */
function pooledCoachAnalyser(config: AppConfig): CoachAnalyser {
  return (task) => {
    const allowanceMs = task.spec.opponents.some((range) => range.kind === 'topPercent')
      ? STRENGTH_TABLE_ALLOWANCE_MS
      : 0;
    return getSharedPool(config).runCoach(task, config.coachTimeoutMs + allowanceMs);
  };
}

const COACH_WINDOW_MS = 60_000;

/**
 * Per-session state. `sockets` is a reference count with the same lifetime as `hub.ts`'s `bySession`.
 * An entry with spent Coach tokens outlives its last socket by one window, because reconnecting is
 * free and would otherwise reset the Coach limit. An entry with none is deleted at once, so the map
 * holds only sessions that used the Coach recently.
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
    this.coachSamples = options.coachSamples ?? LIVE_COACH_POLICY.samples;
    this.analyseCoach = options.analyseCoach ?? pooledCoachAnalyser(options.config);
  }

  /** A monotonic counter for socket ids and fallback request ids. */
  private nextCount(): number {
    this.counter += 1;
    return this.counter;
  }

  /**
   * Registers an authenticated, origin-checked socket. A socket that never sends `hello` holds a slot,
   * so it is closed with `4408`.
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
    // Claimed here and released in `handleClose`, whatever ends the socket.
    const session = this.bySession.get(principal.sessionId) ?? {
      sockets: 0,
      coachRequests: [],
      expiry: null,
    };
    // Cancelling the pending deletion keeps the window, so reconnecting does not clear the Coach limit.
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
    // Before the `roomId` return, because a socket that never sent `hello` still claimed a session
    // entry.
    this.releaseSession(connection.principal.sessionId);
    const roomId = connection.roomId;
    if (roomId === null) return;
    const sockets = this.byRoom.get(roomId);
    sockets?.delete(connection);
    this.registry.noteSocket(roomId, connection.principal.userId, -1);
    if (sockets !== undefined && sockets.size === 0) {
      this.byRoom.delete(roomId);
      // Drop the subscription with the last socket, or the listener keeps this router alive.
      this.subscriptions.get(roomId)?.();
      this.subscriptions.delete(roomId);
    } else {
      // Somebody's `connected` flag just changed, and that is on the wire.
      this.broadcast(roomId);
    }
  }

  /**
   * Drops one socket's claim. Session ids are caller-supplied, so every entry needs something that
   * removes it.
   */
  private releaseSession(sessionId: string): void {
    const session = this.bySession.get(sessionId);
    if (session === undefined) return;
    session.sockets -= 1;
    if (session.sockets > 0) return;
    if (session.coachRequests.length === 0) {
      // Most sessions never ask for a Coach analysis and leave nothing behind.
      this.bySession.delete(sessionId);
      return;
    }
    // One window from now is an upper bound and a single timer. `systemClock` `unref`s it.
    session.expiry?.cancel();
    session.expiry = this.clock.schedule(COACH_WINDOW_MS, () => {
      // Re-checked. A stale timer deleting a live session's window would hand it a free reset.
      const current = this.bySession.get(sessionId);
      if (current === session && current.sockets <= 0) this.bySession.delete(sessionId);
    });
  }

  sessionsTracked(): number {
    return this.bySession.size;
  }

  socketsIn(roomId: string): readonly WsConnection[] {
    return [...(this.byRoom.get(roomId) ?? [])];
  }

  /**
   * For a room this process was fenced from. A healthy socket that silently stops receiving state
   * never reconnects, so it is closed with a real code.
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
    // A shut-down router should hold nothing, including armed timers.
    for (const session of this.bySession.values()) session.expiry?.cancel();
    this.bySession.clear();
  }

  /** Cheapest check first. Size, then rate, then parse, then schema, then routing. */
  handleFrame(connection: WsConnection, raw: string | Uint8Array): void {
    if (connection.closed) return;

    const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
    if (bytes > WS_LIMITS.maxMessageBytes) {
      // Dropped unparsed and closed, because a client that oversends once will do it again.
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
      // `validated.problem` is prose and is never the label.
      this.rejectFrame('schema');
      this.sendError(connection, null, 'invalid_request');
      return;
    }
    const message = validated.value;

    if (connection.roomId === null && message.type !== 'hello') {
      // Not a close. An honest client may have raced its own `hello`, and the handshake timer still
      // runs.
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
        // Unreachable while the schema and this switch agree. Counts the drift if a contract message
        // goes unhandled.
        this.rejectFrame('unknown_type');
        this.sendError(connection, null, 'invalid_request');
        return;
    }
  }

  /** One method, so the label can only be a `WsFrameRejection`. */
  private rejectFrame(reason: WsFrameRejection): void {
    this.metrics.wsFramesRejected.inc({ reason });
  }

  /**
   * Handlers throw the same `AppError` as REST, so both transports report the same code and wording.
   * Only `ERROR_MESSAGES[code]` is ever sent.
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

  /**
   * Identity comes from the upgrade, never from this frame. After a restart the registry is empty, so
   * `reopenFor` rebuilds the room from the database, as `openRoomFor` in `routes/rooms.ts` does.
   */
  private async onHello(
    connection: WsConnection,
    message: WsClientMessage & { type: 'hello' },
  ): Promise<void> {
    // `joining` as well as `roomId`, set before anything suspends. Two `hello` frames in one tick would
    // otherwise both join and leave `noteSocket` one increment over.
    if (connection.roomId !== null || connection.joining) {
      this.rejectFrame('duplicate_hello');
      this.sendError(connection, null, 'invalid_request');
      return;
    }
    if (message.protocolVersion !== WS_PROTOCOL_VERSION) {
      // Not labelled by the version, which the client chose.
      this.rejectFrame('bad_protocol_version');
      this.sendError(connection, null, 'unsupported_protocol_version');
      this.closeConnection(connection, WS_CLOSE.protocolMismatch, 'protocol version');
      return;
    }
    connection.joining = true;

    let room: LiveRoom;
    try {
      // A live room is taken with no `await` evaluated. Even a resolved `await` suspends for a
      // microtask, so a `sit` in the same read as `hello` would be refused.
      const live = this.registry.get(message.roomId);
      room =
        live === null
          ? await this.reopenFor(message.roomId, connection.principal.userId)
          : this.registry.require(message.roomId, connection.principal.userId);
    } catch (error) {
      connection.joining = false;
      const code: ErrorCode = isAppError(error) ? error.code : 'internal_error';
      this.sendError(connection, null, code);
      // The close code comes from the same error as the frame. A 4xx closes 4403, so a stranger and a
      // missing room stay indistinguishable. A 5xx (a database blip in `reopenFor`) closes 4503, which
      // the client retries, so a member is not told their own table is not theirs.
      const closeCode = wsCloseForError(code);
      this.closeConnection(
        connection,
        closeCode,
        // Diagnostic only. Browsers do not show it.
        closeCode === WS_CLOSE.forbidden ? 'not permitted' : 'handshake failed',
      );
      return;
    }
    connection.joining = false;
    // The socket may have closed during the database read. Joining it now would leave a socket in
    // `byRoom` that nothing removes.
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
    // Reconnect is just sending the current view. There is no catch-up protocol.
    this.sendState(connection, summary);
    // Everybody else's `connected` flag just changed.
    this.broadcastExcept(message.roomId, connection);
    await Promise.resolve();
  }

  /**
   * Rebuilds a room this process has never seen. Membership is read from the durable rows BEFORE
   * anything is built, so a guessed room id cannot make this process build a live table. Every
   * refusal is the same `room_not_found_or_not_permitted`, so it cannot confirm a room exists.
   * Mirrors `openRoomFor` in `routes/rooms.ts` step for step. Change both together.
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

    // The row is durable, the table is not. This rebuilds the table from the roster after a restart.
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
   * Legality belongs to the table and the engine. `deduplicated: true` for a retry is a success.
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
   * Built from the caller's own redacted view, so it cannot report on anybody else's cards. Gates run
   * cheapest first (difficulty, rate limit, hand, pool), so a refused request never takes a queue
   * slot. The `CoachTask` carries no `HandState`, deck, salt or other seat's cards, and
   * `WorkerPool.runCoach` checks the report against the task's legal set.
   */
  private async onCoach(
    connection: WsConnection,
    message: WsClientMessage & { type: 'requestCoach' },
  ): Promise<void> {
    const roomId = this.requireRoom(connection);
    const room = this.registry.require(roomId, connection.principal.userId);
    // Expert Legends offers "Coach in review only". Refused before a rate-limit token is spent.
    if (!room.bots.coachDuringHand()) {
      throw new AppError('coach_not_available', {
        logDetail: `live Coach refused in ${roomId}: a seated bot plays a difficulty that turns it off`,
      });
    }
    if (!this.takeCoachToken(connection)) {
      throw new AppError('rate_limited', {
        retryAfterSeconds: 5,
        // The window is the session's, so a new socket does not clear it.
        logDetail: 'coach requests per minute exceeded for this session',
      });
    }
    const view = room.table.viewFor(connection.principal.userId);
    if (view === null) throw new AppError('hand_not_active', { logDetail: 'no hand to analyse' });
    // Refusals that need only the view happen here, in microseconds, before a task is built.
    const task = coachTaskForView(view, {
      samples: this.coachSamples,
      names: room.table.dealtNames(),
      ...(message.opponentRange === undefined ? {} : { opponentRange: message.opponentRange }),
    });
    // Same `kind="coach"` histogram as the REST analyses, because it is the same work on the same
    // threads.
    const report = await observeAnalysis('coach', () => this.analyseCoach(task), this.metrics);
    // The socket may have closed while the thread worked. Dropping the report is the whole handling.
    if (connection.closed) return;
    this.send(connection, { type: 'coach', requestId: message.requestId, report });
  }

  /** One `viewFor` call per socket, never one shared object. See the file comment. */
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
   * Closes the sockets of anyone no longer a member. `onHello` checks membership once, so after
   * `leaveRoom` the old socket would keep receiving the private table. Checked here because every outbound
   * frame passes through, so a new path that ends a membership cannot forget to announce it. Nothing
   * is sent between a departure and this check.
   */
  private dropDepartedSockets(roomId: string): void {
    const room = this.registry.get(roomId);
    if (room === null) return;
    for (const connection of this.socketsIn(roomId)) {
      if (connection.closed) continue;
      const userId = connection.principal.userId;
      if (room.member(userId) !== null || room.record.ownerUserId === userId) continue;
      // 4403, not 4401. The session is fine but the table is not theirs, and a reconnect would be
      // refused.
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
    // Before the events too, since an event is also a frame about a private table.
    this.dropDepartedSockets(roomId);
    for (const connection of this.socketsIn(roomId)) {
      if (connection.closed) continue;
      // Events first, then state. Events are for animation, and the state is the truth.
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
      // The socket is gone and its close event follows. A dead socket must not fail the action.
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

  /**
   * A token bucket, not a fixed window, because a reconnect legitimately bursts `hello` and several
   * intents in one tick.
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
   * The Coach window, keyed on the SESSION. Per socket, one session's four permitted sockets would
   * get 4 x 30 = 120 analyses a minute onto the shared pool; per session it is 30 across all four.
   * A missing entry means the socket was released. It is refused, not recreated, because a recreated
   * entry would be a fresh window and the leak coming back.
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
  /**
   * The names the table dealt in, so the Coach names opponents the way the seat plates do. Absent,
   * opponents are `seat N`.
   */
  readonly names?: ReadonlyMap<number, string>;
}

/**
 * One redacted view as a calculator task. Refusals and the numbers come from `coachSpotForView`.
 * A notation range is parsed here once, so an unreadable range is a `400` with a named field, not a
 * thread that dies as `internal_error`. A `top:NN` range is only bounds-checked, because expanding it
 * is the three-second stall this path avoids.
 */
export function coachTaskForView(view: PlayerView, options: CoachForViewOptions): CoachTask {
  const range =
    options.opponentRange === undefined
      ? LIVE_COACH_POLICY.range
      : opponentRangeOption(options.opponentRange);
  const names = options.names;
  const reading = coachSpotForView(
    view,
    { ...LIVE_COACH_POLICY, range, samples: options.samples },
    names === undefined ? undefined : (seat) => names.get(seat),
  );
  if (reading.kind === 'refused') throw refusalError(reading.refusal);
  const { spot } = reading;
  if (range.kind === 'notation') assumedRange(range, [...spot.heroCards, ...spot.board]);
  return {
    kind: 'coach',
    spec: {
      heroLabel: 'you',
      heroCards: spot.heroCards,
      board: spot.board,
      opponents: spot.opponents.map(({ label, range: assumed }) =>
        assumed.kind === 'topPercent'
          ? { kind: 'topPercent', label, percent: assumed.percent }
          : { kind: 'notation', label, notation: assumed.notation },
      ),
    },
    street: spot.street,
    pot: spot.pot,
    contestablePot: spot.contestablePot,
    toCall: spot.toCall,
    heroCommittedThisStreet: spot.heroCommittedThisStreet,
    heroStack: spot.heroStack,
    opponentStacks: spot.opponentStacks,
    bigBlind: spot.bigBlind,
    minimumRaiseTo: spot.minimumRaiseTo,
    legalActions: spot.legalActions,
    samples: spot.samples,
    seed: spot.seed,
  };
}

/**
 * `redactFor` fills `legalActions` only for the seat to act, so `betting-closed` and `not-to-act`
 * have no legal action at all.
 */
function refusalError(refusal: CoachRefusal): AppError {
  switch (refusal.kind) {
    case 'not-seated':
      return new AppError('not_seated', { logDetail: 'a Coach request needs a seat holding cards' });
    case 'hand-over':
      return new AppError('hand_not_active', {
        logDetail: `no decision to analyse during ${refusal.street}`,
      });
    case 'no-opponent':
      return new AppError('hand_not_active', { logDetail: 'no live opponent to analyse against' });
    case 'betting-closed':
      return new AppError('hand_not_active', {
        logDetail: 'betting is closed for the hand, so there is no decision to analyse',
      });
    case 'not-to-act':
      return new AppError('hand_not_active', {
        logDetail: `a Coach request arrived for seat ${refusal.seat} while seat ${String(refusal.toAct)} is to act`,
      });
  }
}

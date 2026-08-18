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
 */

import type {
  ApiError,
  CoachReport,
  ErrorCode,
  RoomSummary,
  WsClientMessage,
  WsServerMessage,
} from '@prl/contracts';
import { ERROR_MESSAGES, WS_CLOSE, WS_LIMITS, WS_PROTOCOL_VERSION } from '@prl/contracts';
import type { Card, PlayerView } from '@prl/poker-engine';
import { buildCoachReport, type CoachAction } from '@prl/poker-math';
import { AppError, isAppError } from '../errors.ts';
import { assumedRange, DEFAULT_ASSUMED_RANGE_PERCENT } from '../rooms/bots.ts';
import type { LiveRoom, RoomRegistry } from '../rooms/registry.ts';
import { toRoomSummary } from '../rooms/registry.ts';
import type { TableNotice } from '../rooms/table.ts';
import type { Clock, ScheduledTask } from '../rooms/timers.ts';

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
  /** Monotonic per socket, so a client can discard an out-of-order frame. */
  revision: number;
  /** Token bucket for `messagesPerSecond` / `burstAllowance`. */
  tokens: number;
  lastRefillMs: number;
  /** Timestamps of recent Coach requests, for `coachRequestsPerMinute`. */
  coachRequests: number[];
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

export interface WsRouterOptions {
  readonly registry: RoomRegistry;
  readonly clock: Clock;
  readonly validate: FrameValidator;
  /** A request id for the error bodies. Fastify's per-request id is not available on a frame. */
  readonly nextRequestId?: () => string;
  readonly onProblem?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  /**
   * Monte Carlo samples for a Coach answer over a socket. Lower than a REST Coach request on
   * purpose: this one is answered while a player is waiting on their own clock.
   */
  readonly coachSamples?: number;
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

export class WsRouter {
  private readonly registry: RoomRegistry;
  private readonly clock: Clock;
  private readonly validate: FrameValidator;
  private readonly nextRequestId: () => string;
  private readonly onProblem: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  private readonly coachSamples: number;
  /** Sockets by room, and one table subscription per room rather than per socket. */
  private readonly byRoom = new Map<string, Set<WsConnection>>();
  private readonly subscriptions = new Map<string, () => void>();
  private counter = 0;

  constructor(options: WsRouterOptions) {
    this.registry = options.registry;
    this.clock = options.clock;
    this.validate = options.validate;
    this.nextRequestId = options.nextRequestId ?? ((): string => `ws-${this.nextCount()}`);
    this.onProblem = options.onProblem ?? ((): void => undefined);
    this.coachSamples = options.coachSamples ?? DEFAULT_COACH_SAMPLES;
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
      revision: 0,
      tokens: WS_LIMITS.burstAllowance,
      lastRefillMs: this.clock.now(),
      coachRequests: [],
      handshake: null,
      missedHeartbeats: 0,
      closed: false,
    };
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

  /** Every socket currently attached to a room. */
  socketsIn(roomId: string): readonly WsConnection[] {
    return [...(this.byRoom.get(roomId) ?? [])];
  }

  /** Closes every socket. The server's shutdown path calls this before the registry's. */
  closeAll(reason = 'server shutting down'): void {
    for (const sockets of [...this.byRoom.values()]) {
      for (const connection of [...sockets]) {
        this.closeConnection(connection, WS_CLOSE.serverShuttingDown, reason);
      }
    }
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
      this.closeConnection(connection, WS_CLOSE.rateLimited, 'frame too large');
      return;
    }
    if (!this.takeToken(connection)) {
      this.closeConnection(connection, WS_CLOSE.rateLimited, 'too many messages');
      return;
    }

    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendError(connection, null, 'invalid_request');
      return;
    }

    const validated = this.validate(parsed);
    if (!validated.ok) {
      this.sendError(connection, null, 'invalid_request');
      return;
    }
    const message = validated.value;

    if (connection.roomId === null && message.type !== 'hello') {
      // Not a close: an honest client that raced its own `hello` deserves to be told rather than
      // dropped, and the handshake timer is still running.
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
        this.sendError(connection, null, 'invalid_request');
        return;
    }
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
      this.onProblem('a socket intent failed unexpectedly', { error: String(error) });
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
   */
  private async onHello(
    connection: WsConnection,
    message: WsClientMessage & { type: 'hello' },
  ): Promise<void> {
    if (connection.roomId !== null) {
      this.sendError(connection, null, 'invalid_request');
      return;
    }
    if (message.protocolVersion !== WS_PROTOCOL_VERSION) {
      this.sendError(connection, null, 'unsupported_protocol_version');
      this.closeConnection(connection, WS_CLOSE.protocolMismatch, 'protocol version');
      return;
    }

    let room: LiveRoom;
    try {
      room = this.registry.require(message.roomId, connection.principal.userId);
    } catch (error) {
      const code: ErrorCode = isAppError(error) ? error.code : 'internal_error';
      this.sendError(connection, null, code);
      // 4403 for both "no such room" and "not your room": the frame already carries the one code
      // that does not distinguish them, and the close code must not either.
      this.closeConnection(connection, WS_CLOSE.forbidden, 'not permitted');
      return;
    }

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
   */
  private async onCoach(
    connection: WsConnection,
    message: WsClientMessage & { type: 'requestCoach' },
  ): Promise<void> {
    const roomId = this.requireRoom(connection);
    if (!this.takeCoachToken(connection)) {
      throw new AppError('rate_limited', {
        retryAfterSeconds: 5,
        logDetail: 'coach requests per minute exceeded on a socket',
      });
    }
    const room = this.registry.require(roomId, connection.principal.userId);
    const view = room.table.viewFor(connection.principal.userId);
    if (view === null) throw new AppError('hand_not_active', { logDetail: 'no hand to analyse' });
    const report = coachForView(view, {
      samples: this.coachSamples,
      ...(message.opponentRange === undefined ? {} : { opponentRange: message.opponentRange }),
    });
    this.send(connection, { type: 'coach', requestId: message.requestId, report });
    await Promise.resolve();
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
    const summary = toRoomSummary(room);
    for (const connection of this.socketsIn(roomId)) {
      if (connection === skip || connection.closed) continue;
      this.sendState(connection, summary);
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
      this.onProblem('a socket send failed', { error: String(error) });
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
      this.onProblem('a socket close failed', { error: String(error) });
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

  private takeCoachToken(connection: WsConnection): boolean {
    const now = this.clock.now();
    connection.coachRequests = connection.coachRequests.filter((at) => now - at < COACH_WINDOW_MS);
    if (connection.coachRequests.length >= WS_LIMITS.coachRequestsPerMinute) return false;
    connection.coachRequests.push(now);
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
 * A Coach report built from one redacted view.
 *
 * Deliberately a function of the view: the caller's own cards are in it, nobody else's are, and
 * therefore there is no way to ask this for an analysis of an opponent's decision. The range is
 * an assumption and the report says so — `buildCoachReport` puts every assumption in
 * `assumptions`, which the contract makes non-optional.
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
export function coachForView(view: PlayerView, options: CoachForViewOptions): CoachReport {
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

  const dead: Card[] = [...heroCards, ...view.board];
  const notation = options.opponentRange ?? DEFAULT_COACH_RANGE;
  return buildCoachReport({
    heroCards,
    board: view.board,
    street,
    // The same assumed range for each opponent. A per-seat range would need a read this endpoint
    // does not have, and pretending otherwise would put false precision in front of a learner.
    opponents: opponents.slice(0, 5).map((seat) => ({
      label: `seat ${seat.seat}`,
      range: assumedRange(notation, dead),
    })),
    pot: view.potTotal,
    toCall: view.amountToCall,
    // Both taken from the view rather than derived: `to` is a total street commitment,
    // and the minimum is the engine's own, so no size the Coach publishes here can be
    // one this table would refuse.
    heroCommittedThisStreet: own.committedThisStreet,
    heroStack: own.stack,
    opponentStacks: opponents.map((seat) => seat.stack),
    bigBlind: view.config.bigBlind,
    minimumRaiseTo: view.minimumRaiseTo,
    legalActions,
    samples: options.samples,
  });
}

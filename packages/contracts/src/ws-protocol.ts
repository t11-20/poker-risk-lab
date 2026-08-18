/**
 * The WebSocket protocol for live tables.
 *
 * ## Design decisions that matter
 *
 * **The server never trusts a client message to describe state.** A client can only
 * express intent: "I want to act", "I want to sit". Every message the server sends
 * back is derived from server-held state and redacted per recipient. There is no
 * message in which a client tells the server a card, a stack, a pot, or whose turn
 * it is.
 *
 * **Every action carries an idempotency key and an expected sequence.** A dropped
 * response, a reconnect mid-request, or a double-tap on a slow connection would
 * otherwise risk applying an action twice or applying it to a hand that has moved
 * on. `actionId` makes a retry a no-op; `expectedSequence` makes a stale action a
 * rejection rather than a surprise.
 *
 * **State is sent whole, not as deltas.** A delta protocol needs the client and
 * server to agree on a base state, and any disagreement produces a subtly wrong
 * table that is very hard to debug. Sending the full redacted view on every change
 * costs a few kilobytes and removes that entire class of bug — and makes reconnect
 * trivial, because reconnect is just "send the current view".
 */

import type { PlayerView } from '@prl/poker-engine';
import type { CoachReport, RoomSummary } from './api-types.ts';
import type { ApiError, ErrorCode } from './errors.ts';

export const WS_PROTOCOL_VERSION = 1;

/** Reasons the server may close a socket, as WebSocket close codes. */
export const WS_CLOSE = {
  /** Normal shutdown. */
  normal: 1000,
  /** The client's protocol version is not supported. */
  protocolMismatch: 4400,
  /** No valid session cookie, or the session expired. */
  unauthenticated: 4401,
  /** Authenticated but not permitted in this room. */
  forbidden: 4403,
  /** Origin header did not match an allowed origin. */
  badOrigin: 4406,
  /** Too many messages, or too many connections from one session. */
  rateLimited: 4429,
  /** No `hello` within the handshake window. */
  handshakeTimeout: 4408,
  /** The server is shutting down; the client should reconnect with backoff. */
  serverShuttingDown: 4503,
} as const;

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/**
 * First message on every socket. Nothing else is accepted until it arrives, and a
 * socket that does not send it within the handshake window is closed.
 *
 * Authentication is NOT in this message: it comes from the session cookie sent
 * during the HTTP upgrade. A token in the first frame would end up in client-side
 * logs and browser history far more easily than a `HttpOnly` cookie does.
 */
export interface WsHello {
  readonly type: 'hello';
  readonly protocolVersion: number;
  readonly roomId: string;
  /**
   * Echoed back in `welcome`, so a client with several sockets open can tell which
   * one a message belongs to.
   */
  readonly clientNonce: string;
}

/** Take a seat at the table. */
export interface WsSit {
  readonly type: 'sit';
  readonly seat: number;
  readonly requestId: string;
}

/** Stand up. Folds any live hand — leaving mid-hand is not a way to avoid a bet. */
export interface WsStand {
  readonly type: 'stand';
  readonly requestId: string;
}

/** Submit a decision. */
export interface WsAction {
  readonly type: 'action';
  /**
   * Client-generated and stable across retries. The server records it and refuses
   * to apply the same `actionId` twice, so a retry after a dropped response is safe.
   */
  readonly actionId: string;
  /**
   * The `actionSequence` the client's view was at. If the hand has advanced, the
   * action is rejected with `stale_action_sequence` rather than applied to a spot
   * the player never saw.
   */
  readonly expectedSequence: number;
  readonly action:
    | { readonly type: 'fold' }
    | { readonly type: 'check' }
    | { readonly type: 'call' }
    | { readonly type: 'bet'; readonly to: number }
    | { readonly type: 'raise'; readonly to: number };
  readonly requestId: string;
}

/** Ask for a Coach analysis of the current decision. */
export interface WsRequestCoach {
  readonly type: 'requestCoach';
  readonly requestId: string;
  /**
   * Range assumption to analyse against. Omitted means "use the table default for
   * this opponent's profile", which the report states explicitly.
   */
  readonly opponentRange?: string;
}

/** Ask the owner's table to deal the next hand. */
export interface WsStartHand {
  readonly type: 'startHand';
  readonly requestId: string;
}

/** Liveness. The server replies with `pong` carrying the same nonce. */
export interface WsPing {
  readonly type: 'ping';
  readonly nonce: string;
}

export type WsClientMessage = WsHello | WsSit | WsStand | WsAction | WsRequestCoach | WsStartHand | WsPing;

export type WsClientMessageType = WsClientMessage['type'];

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export interface WsWelcome {
  readonly type: 'welcome';
  readonly protocolVersion: number;
  readonly clientNonce: string;
  readonly userId: string;
  readonly room: RoomSummary;
  /** Your seat, or null if you are watching. */
  readonly seat: number | null;
  /** Server time, so the client can render turn timers without trusting its own clock. */
  readonly serverTimeMs: number;
}

/**
 * The authoritative table state, redacted for this recipient.
 *
 * `view` is null between hands. `deadlineMs` is absolute server time by which the
 * player to act must act; the client renders a countdown from it rather than
 * receiving ticks.
 */
export interface WsState {
  readonly type: 'state';
  readonly view: PlayerView | null;
  readonly room: RoomSummary;
  readonly deadlineMs: number | null;
  readonly serverTimeMs: number;
  /** Monotonic per-socket, so a client can discard an out-of-order frame. */
  readonly revision: number;
}

/**
 * Something happened, for animation and for the action log. Never load-bearing:
 * `state` is always the truth, and a client that ignored every event would still
 * render a correct table.
 */
export interface WsEvent {
  readonly type: 'event';
  readonly event:
    | { readonly kind: 'handStarted'; readonly handId: string; readonly commitmentRoot: string }
    | { readonly kind: 'forcedBets'; readonly detail: string }
    | {
        readonly kind: 'action';
        readonly seat: number;
        readonly description: string;
        readonly wasAutomatic: boolean;
      }
    | { readonly kind: 'street'; readonly street: string; readonly newCards: readonly string[] }
    | { readonly kind: 'showdown'; readonly summaries: readonly string[] }
    | { readonly kind: 'handComplete'; readonly summaries: readonly string[] }
    | { readonly kind: 'playerJoined'; readonly displayName: string }
    | { readonly kind: 'playerLeft'; readonly displayName: string }
    | { readonly kind: 'seatTimedOut'; readonly seat: number };
  readonly serverTimeMs: number;
}

export interface WsCoach {
  readonly type: 'coach';
  readonly requestId: string;
  readonly report: CoachReport;
}

export interface WsAck {
  readonly type: 'ack';
  readonly requestId: string;
  /** Sequence the action was applied at, for `action` acks. */
  readonly appliedSequence?: number;
  /** True when this was a duplicate `actionId` and the original still stands. */
  readonly deduplicated?: boolean;
}

export interface WsErrorMessage {
  readonly type: 'error';
  readonly requestId: string | null;
  readonly error: ApiError['error'];
}

export interface WsPong {
  readonly type: 'pong';
  readonly nonce: string;
  readonly serverTimeMs: number;
}

export type WsServerMessage = WsWelcome | WsState | WsEvent | WsCoach | WsAck | WsErrorMessage | WsPong;

export type WsServerMessageType = WsServerMessage['type'];

// ---------------------------------------------------------------------------
// Limits — enforced by the server, published so the client can behave well
// ---------------------------------------------------------------------------

export const WS_LIMITS = {
  /** Bytes. Anything larger is dropped and the socket closed. */
  maxMessageBytes: 8 * 1024,
  /** Messages per second per socket, sustained. */
  messagesPerSecond: 20,
  /** Short bursts above the sustained rate are tolerated up to this many. */
  burstAllowance: 40,
  /** Sockets one session may hold open at once. */
  maxSocketsPerSession: 4,
  /** Milliseconds a socket has to send `hello` before it is closed. */
  handshakeTimeoutMs: 5_000,
  /** Server ping interval; a socket that misses two is considered gone. */
  heartbeatIntervalMs: 15_000,
  /** Coach requests per minute per session — the analysis is not free to compute. */
  coachRequestsPerMinute: 30,
} as const;

/** Narrowing helper shared by the server router and the client reducer. */
export function isClientMessageType(value: unknown): value is WsClientMessageType {
  return (
    typeof value === 'string' &&
    ['hello', 'sit', 'stand', 'action', 'requestCoach', 'startHand', 'ping'].includes(value)
  );
}

/** Builds the one error shape both transports use. */
export function wsError(
  requestId: string | null,
  code: ErrorCode,
  message: string,
  requestIdForLog: string,
): WsErrorMessage {
  return { type: 'error', requestId, error: { code, message, requestId: requestIdForLog } };
}

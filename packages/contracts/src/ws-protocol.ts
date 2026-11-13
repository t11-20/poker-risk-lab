/**
 * The WebSocket protocol for live tables.
 * A client only expresses intent. Every server message is derived from server state and redacted per
 * recipient. `actionId` makes a retry a no-op and `expectedSequence` turns a stale action into a
 * rejection. State is sent whole, not as deltas, so reconnect is "send the current view".
 */

import type { PlayerView } from '@prl/poker-engine';
import type { CoachReport, RoomSummary } from './api-types.ts';
import type { ApiError, ErrorCode } from './errors.ts';
import { ERROR_STATUS } from './errors.ts';

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

/**
 * The close code for an error frame already sent. `describeClose` in `apps/web` decides retry from the
 * code alone, and 4403 is permanent, so a server fault must not close with 4403.
 * Derived from `ERROR_STATUS` so the two transports agree:
 *  - 5xx: 4503, retryable, the client reconnects with backoff.
 *  - 401: no session, the client asks the reader to sign in.
 *  - 429: the client waits.
 *  - any other 4xx: a refusal, 4403.
 * 5xx uses 4503 because `apps/web` has no branch for a dedicated internal-error code.
 */
export function wsCloseForError(code: ErrorCode): WsCloseCode {
  const status = ERROR_STATUS[code];
  if (status >= 500) return WS_CLOSE.serverShuttingDown;
  if (status === 401) return WS_CLOSE.unauthenticated;
  if (status === 429) return WS_CLOSE.rateLimited;
  return WS_CLOSE.forbidden;
}

/**
 * First message on every socket. Nothing else is accepted before it, and a socket that does not send
 * it within the handshake window is closed. Authentication comes from the `HttpOnly` session cookie
 * on the upgrade, never from this frame.
 */
export interface WsHello {
  readonly type: 'hello';
  readonly protocolVersion: number;
  readonly roomId: string;
  /** Echoed in `welcome`, so a client with several sockets can tell them apart. */
  readonly clientNonce: string;
}

export interface WsSit {
  readonly type: 'sit';
  readonly seat: number;
  readonly requestId: string;
}

/** Stand up. Folds any live hand, so leaving mid-hand does not avoid a bet. */
export interface WsStand {
  readonly type: 'stand';
  readonly requestId: string;
}

export interface WsAction {
  readonly type: 'action';
  /** Client-generated and stable across retries. The server never applies the same `actionId` twice. */
  readonly actionId: string;
  /** The client view's `actionSequence`. If the hand moved on, this fails with `stale_action_sequence`. */
  readonly expectedSequence: number;
  readonly action:
    | { readonly type: 'fold' }
    | { readonly type: 'check' }
    | { readonly type: 'call' }
    | { readonly type: 'bet'; readonly to: number }
    | { readonly type: 'raise'; readonly to: number };
  readonly requestId: string;
}

export interface WsRequestCoach {
  readonly type: 'requestCoach';
  readonly requestId: string;
  /** Range to analyse against. Omitted means the profile's table default, which the report states. */
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
 * The authoritative table state, redacted for this recipient. `view` is null between hands.
 * `deadlineMs` is absolute server time for the player to act. The client counts down from it.
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

/** Something happened, for animation and the action log. `state` is always the truth. */
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
  /**
   * Coach requests per minute per session, summed across its sockets, because the analysis uses the
   * process-wide worker pool. A per-socket window would give one session 4 times this budget.
   */
  coachRequestsPerMinute: 30,
} as const;

export function isClientMessageType(value: unknown): value is WsClientMessageType {
  return (
    typeof value === 'string' &&
    ['hello', 'sit', 'stand', 'action', 'requestCoach', 'startHand', 'ping'].includes(value)
  );
}

export function wsError(
  requestId: string | null,
  code: ErrorCode,
  message: string,
  requestIdForLog: string,
): WsErrorMessage {
  return { type: 'error', requestId, error: { code, message, requestId: requestIdForLog } };
}

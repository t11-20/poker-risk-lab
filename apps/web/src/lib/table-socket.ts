/**
 * The live-table WebSocket client: transport, handshake, reconnect, and narrowing of every inbound frame.
 * It renders nothing and decides no poker question.
 * Every frame is untrusted. Rendered members are validated field by field, while carried-only members
 * (commitment context, the Merkle reveal) are checked for kind and presence.
 * `sendAction` sends the caller's `actionId` and `expectedSequence` unchanged, because a retry must
 * carry the same id or it is a second bet. A token bucket matching `WS_LIMITS` and the 8 KiB ceiling
 * are enforced locally, since exceeding either costs the reader their socket.
 */

import {
  API_PATHS,
  WS_CLOSE,
  WS_LIMITS,
  WS_PROTOCOL_VERSION,
  type WsAck,
  type WsClientMessage,
  type WsCoach,
  type WsErrorMessage,
  type WsEvent,
  type WsPong,
  type WsServerMessage,
  type WsState,
  type WsWelcome,
} from '@prl/contracts';
import type { LegalAction, PlayerView, PotLayer, SeatView, TableAction } from '@prl/ui';
import { checkHoleCardEntitlement, describeUnentitledSeats } from './hole-card-entitlement.ts';

/** Just enough of `Location` to build the URL, so this is testable without a DOM. */
export interface SocketOrigin {
  readonly protocol: string;
  readonly host: string;
}

/**
 * Same origin as the page, because the `__Host-` session cookie goes only to the host that set it and
 * page script cannot add headers to a WebSocket. `wss:` for an `https:` page, or the browser blocks it as
 * mixed content.
 */
export function tableSocketUrl(origin: SocketOrigin): string {
  const scheme = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${origin.host}${API_PATHS.ws()}`;
}

export interface CloseMeaning {
  readonly code: number;
  readonly title: string;
  /** States the cause, never "something went wrong". */
  readonly detail: string;
  /** False when retrying would fail identically. */
  readonly retryable: boolean;
  readonly action?: 'signIn' | 'reload';
}

/** A table, so each close code visibly gets its own message. Includes browser-generated codes. */
export function describeClose(code: number, wasClean: boolean): CloseMeaning {
  switch (code) {
    case WS_CLOSE.normal:
      return {
        code,
        title: 'Table closed',
        detail: 'The connection to the table was closed normally. Nothing was lost.',
        retryable: true,
      };
    case WS_CLOSE.protocolMismatch:
      return {
        code,
        title: 'This page is out of date',
        detail:
          `The server does not speak protocol version ${WS_PROTOCOL_VERSION}, which is the version ` +
          'this page was built against. Reloading will fetch a build that matches it.',
        retryable: false,
        action: 'reload',
      };
    case WS_CLOSE.unauthenticated:
      return {
        code,
        title: 'You are not signed in',
        detail:
          'The table needs a session, and the browser sent none — it has expired, or it was never ' +
          'created. Start a guest session and the table will open. No email and no password are involved.',
        retryable: false,
        action: 'signIn',
      };
    case WS_CLOSE.forbidden:
      return {
        code,
        title: 'Not your table',
        detail:
          'The server refused this room: either it does not exist or this session is not a member of ' +
          'it. Rooms here are invite-only, so there is no list to browse — start your own table instead.',
        retryable: false,
      };
    case WS_CLOSE.badOrigin:
      return {
        code,
        title: 'This origin is not allowed to open a table',
        detail:
          'The server rejected the page’s origin. A WebSocket handshake is not covered by CORS, so the ' +
          'Origin header is the only check there is, and it failed. This is a deployment configuration ' +
          'problem (PUBLIC_WEB_ORIGIN on the API), not something retrying will fix.',
        retryable: false,
      };
    case WS_CLOSE.rateLimited:
      return {
        code,
        title: 'Too many messages',
        detail:
          'The server closed the socket for exceeding its rate limit, or because this session already ' +
          `holds ${WS_LIMITS.maxSocketsPerSession} sockets. Close the table in your other tabs; this one ` +
          'will wait before trying again.',
        retryable: true,
      };
    case WS_CLOSE.handshakeTimeout:
      return {
        code,
        title: 'The handshake did not finish in time',
        detail:
          'The server closes a socket that has not introduced itself within ' +
          `${WS_LIMITS.handshakeTimeoutMs / 1000} seconds. That usually means a very slow link.`,
        retryable: true,
      };
    case WS_CLOSE.serverShuttingDown:
      return {
        code,
        title: 'The server is restarting',
        detail:
          'The table server is shutting down — a deploy, or a restart. Any hand in progress is held ' +
          'server-side; this page will reconnect on its own with a widening delay.',
        retryable: true,
      };
    case 1001:
      return {
        code,
        title: 'The connection went away',
        detail: 'The browser or the server ended the connection, usually because the page was hidden.',
        retryable: true,
      };
    case 1006:
      return {
        code,
        title: 'The connection dropped',
        detail:
          'The socket closed without a close frame, which is what a lost network, a suspended laptop or ' +
          'a proxy timeout looks like. The table state is on the server, so reconnecting restores it whole.',
        retryable: true,
      };
    case 1011:
      return {
        code,
        title: 'The server hit an error',
        detail: 'The server ended the connection because of a fault on its side. Reconnecting is safe.',
        retryable: true,
      };
    default:
      return {
        code,
        title: 'Disconnected',
        detail:
          `The socket closed with code ${code}${wasClean ? '' : ' and without a close handshake'}. ` +
          'That is not a code this client knows; reconnecting is safe because the server holds the table.',
        retryable: true,
      };
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Finite, so `NaN` and `Infinity` are refused. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isArrayOf(value: unknown, item: (candidate: unknown) => boolean): value is readonly unknown[] {
  return Array.isArray(value) && value.every(item);
}

function isCard(value: unknown): boolean {
  return isInteger(value) && value >= 0 && value < 52;
}

function isSeatIndex(value: unknown): boolean {
  return isInteger(value) && value >= 0 && value < 10;
}

const SEAT_STATUSES: readonly string[] = ['active', 'folded', 'allIn', 'sittingOut'];
const STREETS: readonly string[] = ['preflop', 'flop', 'turn', 'river', 'showdown', 'complete'];
const ACTION_TYPES: readonly string[] = ['fold', 'check', 'call', 'bet', 'raise'];

function isHoleCards(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 2 && value.every(isCard));
}

function isSeatView(value: unknown): value is SeatView {
  if (!isObject(value)) return false;
  return (
    isSeatIndex(value['seat']) &&
    isString(value['playerId']) &&
    isNumber(value['stack']) &&
    isNumber(value['committedThisStreet']) &&
    isNumber(value['committedTotal']) &&
    isString(value['status']) &&
    SEAT_STATUSES.includes(value['status']) &&
    (value['position'] === null || isString(value['position'])) &&
    isHoleCards(value['holeCards']) &&
    isBoolean(value['isSelf']) &&
    isBoolean(value['isButton']) &&
    isBoolean(value['isToAct'])
  );
}

/** The optional bounds are load-bearing. The bet sizer clamps into `[minTo, maxTo]`. */
function isLegalAction(value: unknown): value is LegalAction {
  if (!isObject(value)) return false;
  const optionalNumbers = ['minTo', 'maxTo', 'costAtMin'];
  return (
    isString(value['type']) &&
    ACTION_TYPES.includes(value['type']) &&
    optionalNumbers.every((key) => value[key] === undefined || isNumber(value[key])) &&
    (value['allInAtMax'] === undefined || isBoolean(value['allInAtMax'])) &&
    (value['note'] === undefined || isString(value['note']))
  );
}

function isPot(value: unknown): value is PotLayer {
  if (!isObject(value)) return false;
  return (
    isNumber(value['amount']) &&
    isArrayOf(value['eligibleSeats'], isSeatIndex) &&
    isNumber(value['capPerSeat']) &&
    isInteger(value['index'])
  );
}

function isTableConfig(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isNumber(value['smallBlind']) &&
    isNumber(value['bigBlind']) &&
    isNumber(value['ante']) &&
    isInteger(value['maxSeats']) &&
    isNumber(value['actionTimeoutSeconds'])
  );
}

/** `reveal` carries Merkle proofs this client never opens, so it is checked for presence only. */
function isHandResult(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const showdownOk = (entry: unknown): boolean =>
    isObject(entry) &&
    isSeatIndex(entry['seat']) &&
    isString(entry['description']) &&
    isHoleCards(entry['holeCards']) &&
    isArrayOf(entry['bestFive'], isCard);
  const awardOk = (entry: unknown): boolean =>
    isObject(entry) &&
    isSeatIndex(entry['seat']) &&
    isNumber(entry['amount']) &&
    isInteger(entry['potIndex']);
  return (
    isArrayOf(value['showdowns'], showdownOk) &&
    isArrayOf(value['awards'], awardOk) &&
    isArrayOf(value['pots'], isPot) &&
    isObject(value['netBySeat']) &&
    isBoolean(value['endedByFold']) &&
    isObject(value['reveal'])
  );
}

function hasViewScalars(value: JsonObject): boolean {
  return (
    isString(value['handId']) &&
    isString(value['roomId']) &&
    isInteger(value['handNumber']) &&
    isString(value['street']) &&
    STREETS.includes(value['street']) &&
    isSeatIndex(value['buttonSeat']) &&
    (value['toAct'] === null || isSeatIndex(value['toAct'])) &&
    isNumber(value['betLevel']) &&
    isNumber(value['minimumRaiseTo']) &&
    isNumber(value['potTotal']) &&
    isInteger(value['actionSequence']) &&
    isNumber(value['amountToCall']) &&
    isString(value['commitmentRoot']) &&
    isString(value['commitmentContext']) &&
    (value['viewerSeat'] === null || isSeatIndex(value['viewerSeat'])) &&
    isString(value['randomSourceKind'])
  );
}

/**
 * Shape only. Consistency is the server's job. The hole-card entitlement check lives in `narrowState`,
 * so a rejection can say whether shape or content failed.
 */
export function isPlayerView(value: unknown): value is PlayerView {
  if (!isObject(value)) return false;
  return (
    hasViewScalars(value) &&
    isTableConfig(value['config']) &&
    isArrayOf(value['board'], isCard) &&
    isArrayOf(value['seats'], isSeatView) &&
    isArrayOf(value['pots'], isPot) &&
    isArrayOf(value['legalActions'], isLegalAction) &&
    isArrayOf(value['forcedBets'], isObject) &&
    isArrayOf(value['actions'], isObject) &&
    isHandResult(value['result'])
  );
}

function isRoomMember(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isString(value['userId']) &&
    isString(value['displayName']) &&
    (value['seat'] === null || isSeatIndex(value['seat'])) &&
    isNumber(value['stack']) &&
    isBoolean(value['isBot']) &&
    (value['botProfile'] === null || isString(value['botProfile'])) &&
    isBoolean(value['connected']) &&
    // Required. A frame without it would render a seat awaiting the big blind as an ordinary player
    // dealt no cards.
    isBoolean(value['awaitingBigBlind'])
  );
}

function isRoomSummary(value: unknown): value is WsWelcome['room'] {
  if (!isObject(value)) return false;
  return (
    isString(value['id']) &&
    isString(value['name']) &&
    // Null once the creator erased their account. Requiring a string would reject the whole welcome.
    (value['ownerUserId'] === null || isString(value['ownerUserId'])) &&
    isInteger(value['maxSeats']) &&
    isNumber(value['smallBlind']) &&
    isNumber(value['bigBlind']) &&
    isNumber(value['ante']) &&
    isNumber(value['startingStack']) &&
    isNumber(value['actionTimeoutSeconds']) &&
    isString(value['status']) &&
    isString(value['visibility']) &&
    isArrayOf(value['members'], isRoomMember) &&
    isString(value['createdAt'])
  );
}

function isApiErrorEnvelope(value: unknown): value is WsErrorMessage['error'] {
  if (!isObject(value)) return false;
  return isString(value['code']) && isString(value['message']) && isString(value['requestId']);
}

function narrowWelcome(value: JsonObject): WsWelcome | null {
  if (
    !isInteger(value['protocolVersion']) ||
    !isString(value['clientNonce']) ||
    !isString(value['userId']) ||
    !isRoomSummary(value['room']) ||
    !(value['seat'] === null || isSeatIndex(value['seat'])) ||
    !isNumber(value['serverTimeMs'])
  ) {
    return null;
  }
  return {
    type: 'welcome',
    protocolVersion: value['protocolVersion'],
    clientNonce: value['clientNonce'],
    userId: value['userId'],
    room: value['room'],
    seat: value['seat'] === null ? null : Number(value['seat']),
    serverTimeMs: value['serverTimeMs'],
  };
}

function narrowState(value: JsonObject): WsState | null {
  const view = value['view'];
  if (!(view === null || isPlayerView(view))) return null;
  // Refused whole, not stripped. The cards already reached the browser, so a stopped table is the
  // only way the defect gets reported. See `hole-card-entitlement.ts`.
  if (checkHoleCardEntitlement(view).unentitled.length > 0) return null;
  if (!isRoomSummary(value['room'])) return null;
  if (!(value['deadlineMs'] === null || isNumber(value['deadlineMs']))) return null;
  if (!isNumber(value['serverTimeMs']) || !isInteger(value['revision'])) return null;
  return {
    type: 'state',
    view,
    room: value['room'],
    deadlineMs: value['deadlineMs'] === null ? null : Number(value['deadlineMs']),
    serverTimeMs: value['serverTimeMs'],
    revision: value['revision'],
  };
}

/** Never load-bearing; `state` is the truth. */
const EVENT_SHAPES: Readonly<Record<string, readonly [string, (value: unknown) => boolean][]>> = {
  handStarted: [
    ['handId', isString],
    ['commitmentRoot', isString],
  ],
  forcedBets: [['detail', isString]],
  action: [
    ['seat', isSeatIndex],
    ['description', isString],
    ['wasAutomatic', isBoolean],
  ],
  street: [
    ['street', isString],
    ['newCards', (value) => isArrayOf(value, isString)],
  ],
  showdown: [['summaries', (value) => isArrayOf(value, isString)]],
  handComplete: [['summaries', (value) => isArrayOf(value, isString)]],
  playerJoined: [['displayName', isString]],
  playerLeft: [['displayName', isString]],
  seatTimedOut: [['seat', isSeatIndex]],
};

function isTableEvent(value: unknown): value is WsEvent['event'] {
  if (!isObject(value)) return false;
  const kind = value['kind'];
  if (!isString(kind)) return false;
  const shape = EVENT_SHAPES[kind];
  if (shape === undefined) return false;
  return shape.every(([key, check]) => check(value[key]));
}

function narrowEvent(value: JsonObject): WsEvent | null {
  if (!isTableEvent(value['event']) || !isNumber(value['serverTimeMs'])) return null;
  return { type: 'event', event: value['event'], serverTimeMs: value['serverTimeMs'] };
}

/** `oddsRatio` is `number | null` per the contract. Null means the call is free. */
function checkPotOdds(value: unknown): string | null {
  if (!isObject(value)) return 'potOdds is not an object';
  const numbers = ['pot', 'toCall', 'breakEvenEquity', 'equitySurplus'];
  const bad = numbers.find((key) => !isNumber(value[key]));
  if (bad !== undefined) {
    return `potOdds.${bad} is not a finite number (received ${JSON.stringify(value[bad])})`;
  }
  const ratio = value['oddsRatio'];
  if (!(ratio === null || isNumber(ratio))) {
    return `potOdds.oddsRatio is neither a finite number nor null (received ${JSON.stringify(ratio)})`;
  }
  return isString(value['explanation']) ? null : 'potOdds.explanation is not a string';
}

/**
 * Returns the first failing member's name. A Coach frame is asked for and answered once, so its
 * rejection must be explained to the reader.
 */
function checkCoachReport(value: unknown): string | null {
  if (!isObject(value)) return 'report is not an object';
  const objects = ['equity', 'suggestion', 'stackContext', 'uncertainty'];
  const missing = objects.find((key) => !isObject(value[key]));
  if (missing !== undefined) return `report.${missing} is missing or not an object`;
  const potOdds = checkPotOdds(value['potOdds']);
  if (potOdds !== null) return `report.${potOdds}`;
  if (!isArrayOf(value['candidates'], isObject)) return 'report.candidates is not an array of objects';
  if (!isArrayOf(value['assumptions'], isString)) return 'report.assumptions is not an array of strings';
  if (!isArrayOf(value['teachingNotes'], isString)) return 'report.teachingNotes is not an array of strings';
  if (!isString(value['street'])) return 'report.street is not a string';
  if (!isNumber(value['potTotal'])) return 'report.potTotal is not a finite number';
  if (!isNumber(value['toCall'])) return 'report.toCall is not a finite number';
  if (!(value['outs'] === null || isObject(value['outs'])))
    return 'report.outs is neither null nor an object';
  return null;
}

function isCoachReport(value: unknown): value is WsCoach['report'] {
  return checkCoachReport(value) === null;
}

function narrowCoach(value: JsonObject): WsCoach | null {
  if (!isString(value['requestId']) || !isCoachReport(value['report'])) return null;
  return { type: 'coach', requestId: value['requestId'], report: value['report'] };
}

function narrowAck(value: JsonObject): WsAck | null {
  if (!isString(value['requestId'])) return null;
  const applied = value['appliedSequence'];
  const deduplicated = value['deduplicated'];
  if (!(applied === undefined || isInteger(applied))) return null;
  if (!(deduplicated === undefined || isBoolean(deduplicated))) return null;
  // Built member by member because `exactOptionalPropertyTypes` rejects an explicit `undefined`.
  return {
    type: 'ack',
    requestId: value['requestId'],
    ...(applied === undefined ? {} : { appliedSequence: applied }),
    ...(deduplicated === undefined ? {} : { deduplicated }),
  };
}

function narrowError(value: JsonObject): WsErrorMessage | null {
  const requestId = value['requestId'];
  if (!(requestId === null || isString(requestId))) return null;
  if (!isApiErrorEnvelope(value['error'])) return null;
  return { type: 'error', requestId: requestId === null ? null : String(requestId), error: value['error'] };
}

function narrowPong(value: JsonObject): WsPong | null {
  if (!isString(value['nonce']) || !isNumber(value['serverTimeMs'])) return null;
  return { type: 'pong', nonce: value['nonce'], serverTimeMs: value['serverTimeMs'] };
}

export interface FrameRejection {
  /** Null for unparseable input. */
  readonly claimedType: string | null;
  readonly reason: string;
  /**
   * Set only when a `state` frame carried unentitled hole cards. A field, not a substring of `reason`,
   * so improving the prose cannot break a branch.
   */
  readonly unentitledSeats?: readonly number[];
}

export type FrameOutcome =
  | { readonly ok: true; readonly frame: WsServerMessage }
  | { readonly ok: false; readonly rejection: FrameRejection };

const NARROWERS: Readonly<Record<string, (value: JsonObject) => WsServerMessage | null>> = {
  welcome: narrowWelcome,
  state: narrowState,
  event: narrowEvent,
  coach: narrowCoach,
  ack: narrowAck,
  error: narrowError,
  pong: narrowPong,
};

/**
 * Most refusals need no reader-facing sentence, since the next whole `state` frame corrects them.
 * Two exceptions. A `coach` frame is answered once. A hole-card leak recurs every frame, so the
 * table stops, and `unentitledSeats` lets the caller say why.
 */
export function readServerMessage(raw: string): FrameOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, rejection: { claimedType: null, reason: 'the frame was not valid JSON' } };
  }
  if (!isObject(parsed)) {
    return { ok: false, rejection: { claimedType: null, reason: 'the frame was not a JSON object' } };
  }
  const claimed = parsed['type'];
  const claimedType = isString(claimed) ? claimed : null;
  const narrow = claimedType === null ? undefined : NARROWERS[claimedType];
  if (narrow === undefined) {
    return {
      ok: false,
      rejection: { claimedType, reason: 'the frame named no server message type this client knows' },
    };
  }
  const frame = narrow(parsed);
  if (frame !== null) return { ok: true, frame };
  if (claimedType === 'state') {
    // A hole-card leak had the right shape, so the generic shape sentence would be false. Re-run
    // here so every narrower stays `(value) => T | null`.
    const unentitledSeats = checkHoleCardEntitlement(parsed['view']).unentitled;
    if (unentitledSeats.length > 0) {
      return {
        ok: false,
        rejection: { claimedType, reason: describeUnentitledSeats(unentitledSeats), unentitledSeats },
      };
    }
  }
  const reason =
    claimedType === 'coach'
      ? (checkCoachReport(parsed['report']) ?? 'the requestId was missing or not a string')
      : `the ${claimedType} frame did not match the shape the contract describes`;
  return { ok: false, rejection: { claimedType, reason } };
}

export function narrowServerMessage(raw: string): WsServerMessage | null {
  const outcome = readServerMessage(raw);
  return outcome.ok ? outcome.frame : null;
}

/** Two methods, so a test can be a pair of functions. */
export interface RawSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RawSocketHandlers {
  readonly onOpen: () => void;
  readonly onMessage: (data: string) => void;
  readonly onClose: (code: number, reason: string, wasClean: boolean) => void;
  readonly onError: () => void;
}

export type RawSocketFactory = (url: string, handlers: RawSocketHandlers) => RawSocket;

/** No headers and no query string. The session cookie rides the upgrade, and a URL token would leak. */
export const browserSocketFactory: RawSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  });
  socket.addEventListener('close', (event: CloseEvent) => {
    handlers.onClose(event.code, event.reason, event.wasClean);
  });
  socket.addEventListener('error', () => handlers.onError());
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
};

export interface Scheduler {
  readonly now: () => number;
  readonly delay: (ms: number, run: () => void) => () => void;
}

export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  delay: (ms, run) => {
    const handle = setTimeout(run, ms);
    return () => clearTimeout(handle);
  },
};

export type TableSocketStatus =
  | 'connecting'
  | 'handshaking'
  | 'live'
  | 'reconnecting'
  /** Not coming back without the reader doing something. */
  | 'closed';

export interface TableSocketOptions {
  readonly roomId: string;
  readonly url: string;
  readonly onFrame: (frame: WsServerMessage) => void;
  readonly onStatus: (status: TableSocketStatus) => void;
  /** Null once a connection is live again. */
  readonly onClose: (meaning: CloseMeaning | null) => void;
  /** A dropped frame. Separate from `onProblem` because some, like a Coach report, matter to a reader. */
  readonly onRejected?: (rejection: FrameRejection) => void;
  /** Developer-only. Never shown to a reader. */
  readonly onProblem?: (message: string) => void;
  readonly socketFactory?: RawSocketFactory;
  readonly scheduler?: Scheduler;
}

/**
 * Not a boolean. A disconnected frame is held and replayed on the next `welcome`, while a rate-limited
 * one is gone and the reader must decide again. Conflating them reported a rate limit for a dropped
 * connection.
 */
export type SendOutcome =
  | 'sent'
  /** No open socket. `useLiveTable` replays the decision on `welcome` with the same `actionId`. */
  | 'disconnected'
  /** Nothing will send it later; the reader decides again. */
  | 'rate-limited'
  /** Over the 8 KiB ceiling, or `send` threw. */
  | 'undeliverable';

export interface TableSocketHandle {
  sit(seat: number, requestId: string): SendOutcome;
  stand(requestId: string): SendOutcome;
  startHand(requestId: string): SendOutcome;
  /** A retry MUST reuse both `actionId` and `expectedSequence`, so the server treats it as a no-op. */
  action(input: {
    readonly action: TableAction;
    readonly actionId: string;
    readonly expectedSequence: number;
    readonly requestId: string;
  }): SendOutcome;
  requestCoach(requestId: string, opponentRange?: string): SendOutcome;
  /** Safe to call twice. */
  dispose(): void;
}

/** Doubling and capped, with jitter so many tabs do not return in lockstep. */
const BACKOFF_FIRST_MS = 500;
const BACKOFF_CAP_MS = 15_000;
/** A `4429` means slow down, so start near the ceiling. */
const BACKOFF_RATE_LIMITED_MS = 10_000;
/** Just over the server's handshake timeout. */
const HANDSHAKE_GRACE_MS = WS_LIMITS.handshakeTimeoutMs + 2_000;
/** Two unanswered pings and the socket is treated as gone. */
const PING_INTERVAL_MS = WS_LIMITS.heartbeatIntervalMs;
const PINGS_UNANSWERED_ALLOWED = 2;

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/** The server's token bucket, so we are refused locally instead of disconnected. */
function takeToken(bucket: Bucket, now: number): boolean {
  const elapsed = Math.max(0, now - bucket.lastRefillMs);
  bucket.lastRefillMs = now;
  bucket.tokens = Math.min(
    WS_LIMITS.burstAllowance,
    bucket.tokens + (elapsed * WS_LIMITS.messagesPerSecond) / 1_000,
  );
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * `dispose` is the only way it stops, and a disposed handle schedules nothing again. A leaked socket
 * per navigation would hit the four-per-session cap and lock the reader out.
 */
export function openTableSocket(options: TableSocketOptions): TableSocketHandle {
  const factory = options.socketFactory ?? browserSocketFactory;
  const scheduler = options.scheduler ?? systemScheduler;
  const problem = options.onProblem ?? ((): void => undefined);
  const rejected = options.onRejected ?? ((): void => undefined);

  let socket: RawSocket | null = null;
  let disposed = false;
  let attempt = 0;
  let cancelReconnect: (() => void) | null = null;
  let cancelHandshake: (() => void) | null = null;
  let cancelPing: (() => void) | null = null;
  let unansweredPings = 0;
  let generation = 0;
  const bucket: Bucket = { tokens: WS_LIMITS.burstAllowance, lastRefillMs: scheduler.now() };

  const setStatus = (status: TableSocketStatus): void => {
    if (!disposed) options.onStatus(status);
  };

  const clearTimers = (): void => {
    cancelHandshake?.();
    cancelHandshake = null;
    cancelPing?.();
    cancelPing = null;
  };

  const sendRaw = (message: WsClientMessage): SendOutcome => {
    if (disposed) return 'undeliverable';
    if (socket === null) return 'disconnected';
    const text = JSON.stringify(message);
    // The server drops an oversized frame AND closes the socket.
    if (new TextEncoder().encode(text).length > WS_LIMITS.maxMessageBytes) {
      problem(`refusing to send a ${message.type} frame larger than the protocol's 8 KiB ceiling`);
      return 'undeliverable';
    }
    if (!takeToken(bucket, scheduler.now())) {
      problem(`refusing to send ${message.type}: the client-side rate limit would be exceeded`);
      return 'rate-limited';
    }
    try {
      socket.send(text);
      return 'sent';
    } catch (cause) {
      problem(`sending ${message.type} threw: ${cause instanceof Error ? cause.message : 'unknown'}`);
      return 'undeliverable';
    }
  };

  const armPing = (mine: number): void => {
    cancelPing?.();
    cancelPing = scheduler.delay(PING_INTERVAL_MS, () => {
      if (disposed || mine !== generation) return;
      if (unansweredPings >= PINGS_UNANSWERED_ALLOWED) {
        // A half-open socket never fires `close`, so force one before the seat's clock runs out.
        problem('no pong for two intervals; treating the socket as gone');
        socket?.close(WS_CLOSE.normal, 'no pong');
        handleClose(1006, 'no pong', false, mine);
        return;
      }
      unansweredPings += 1;
      sendRaw({ type: 'ping', nonce: `ping-${String(scheduler.now())}` });
      armPing(mine);
    });
  };

  function scheduleReconnect(meaning: CloseMeaning): void {
    if (disposed) return;
    if (!meaning.retryable) {
      setStatus('closed');
      return;
    }
    attempt += 1;
    const base =
      meaning.code === WS_CLOSE.rateLimited
        ? BACKOFF_RATE_LIMITED_MS
        : Math.min(BACKOFF_FIRST_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
    // ±20%, from the CSPRNG because a release gate bans the non-crypto RNG in every src tree.
    const jittered = Math.round(base * (0.8 + randomUnitInterval() * 0.4));
    setStatus('reconnecting');
    cancelReconnect?.();
    cancelReconnect = scheduler.delay(jittered, () => {
      cancelReconnect = null;
      connect();
    });
  }

  function handleClose(code: number, reason: string, wasClean: boolean, mine: number): void {
    if (mine !== generation) return;
    generation += 1;
    clearTimers();
    socket = null;
    if (disposed) return;
    const meaning = describeClose(code, wasClean);
    options.onClose(meaning);
    problem(`socket closed ${code} ${reason}`);
    scheduleReconnect(meaning);
  }

  function connect(): void {
    if (disposed) return;
    generation += 1;
    const mine = generation;
    unansweredPings = 0;
    setStatus('connecting');
    socket = factory(options.url, {
      onOpen: () => {
        if (disposed || mine !== generation) return;
        setStatus('handshaking');
        // Must be the first frame. The server closes a socket without it 4408.
        sendRaw({
          type: 'hello',
          protocolVersion: WS_PROTOCOL_VERSION,
          roomId: options.roomId,
          clientNonce: newRequestId('hello'),
        });
        cancelHandshake?.();
        cancelHandshake = scheduler.delay(HANDSHAKE_GRACE_MS, () => {
          if (disposed || mine !== generation) return;
          problem('no welcome within the handshake window; reconnecting');
          socket?.close(WS_CLOSE.normal, 'handshake stalled');
          handleClose(1006, 'handshake stalled', false, mine);
        });
      },
      onMessage: (data) => {
        if (disposed || mine !== generation) return;
        const outcome = readServerMessage(data);
        if (!outcome.ok) {
          problem(
            `dropped a ${outcome.rejection.claimedType ?? 'malformed'} frame: ${outcome.rejection.reason}`,
          );
          rejected(outcome.rejection);
          return;
        }
        const frame = outcome.frame;
        if (frame.type === 'pong') unansweredPings = 0;
        if (frame.type === 'welcome') {
          cancelHandshake?.();
          cancelHandshake = null;
          attempt = 0;
          unansweredPings = 0;
          options.onClose(null);
          setStatus('live');
          armPing(mine);
        }
        options.onFrame(frame);
      },
      onClose: (code, reason, wasClean) => handleClose(code, reason, wasClean, mine),
      onError: () => {
        // `error` carries nothing by design and `close` always follows it.
        problem('the socket reported an error; waiting for its close');
      },
    });
  }

  connect();

  return {
    sit: (seat, requestId) => sendRaw({ type: 'sit', seat, requestId }),
    stand: (requestId) => sendRaw({ type: 'stand', requestId }),
    startHand: (requestId) => sendRaw({ type: 'startHand', requestId }),
    action: (input) =>
      sendRaw({
        type: 'action',
        actionId: input.actionId,
        expectedSequence: input.expectedSequence,
        action: input.action,
        requestId: input.requestId,
      }),
    requestCoach: (requestId, opponentRange) =>
      sendRaw({
        type: 'requestCoach',
        requestId,
        ...(opponentRange === undefined ? {} : { opponentRange }),
      }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancelReconnect?.();
      cancelReconnect = null;
      clearTimers();
      socket?.close(WS_CLOSE.normal, 'leaving the table');
      socket = null;
    },
  };
}

/**
 * `^[A-Za-z0-9_-]{8,64}$`. These are idempotency keys, so a collision replays another's action.
 * `randomUUID` needs a secure context, so the fallback uses the CSPRNG too.
 */
let idCounter = 0;

export function newRequestId(prefix: string): string {
  idCounter += 1;
  const unique =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${String(Date.now())}-${String(idCounter)}-${randomToken(8)}`;
  return `${prefix}-${unique}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

/** `[0, 1)` from the CSPRNG. Dividing by `2 ** 32` keeps 1 out of range. */
function randomUnitInterval(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, length);
}

/**
 * The live-table WebSocket client: transport, handshake, reconnect, and the narrowing of every
 * frame the server sends.
 *
 * Nothing in this module renders anything and nothing in it decides a poker question. It carries
 * intent one way and authoritative state the other, and it refuses to believe a frame it has not
 * checked. `use-live-table.ts` turns what arrives here into React state; `app/play/LiveTable.tsx`
 * draws it.
 *
 * ## Where the socket connects, and why it is the page's own origin
 *
 * `ws(s)://<the page's own host>/api/v1/ws`. Three facts decide that:
 *
 *  1. **The upgrade path is `/api/v1/ws`**, and it now comes from `API_PATHS.ws()` in
 *     `@prl/contracts` rather than from a constant in this file. `WS_PATH` in
 *     `apps/api/src/ws/hub.ts` is `/ws`, but the hub is registered under `API_PREFIX` like every
 *     other route module, so the mounted path is `/api/v1/ws`. It therefore sits *inside*
 *     `/api/:path*` and is matched by the rewrite in `next.config.ts` — which is what makes the
 *     same-origin answer work in the dev loop as well as behind the container stack's reverse
 *     proxy. (This was not assumed: it was measured — a full hand was played through `next dev`'s
 *     rewrite.) `apps/api/test/web-api-paths.test.ts` asserts the published path against a real
 *     `buildApp()`, and `apps/api/test/ws-socket.test.ts` completes a real handshake on it.
 *  2. **The session cookie is `__Host-` prefixed with no `Domain`** (`plugins/security.ts` in the
 *     API), so it is only ever sent back to the exact host that set it. A socket opened against a
 *     second origin would arrive unauthenticated and be closed `4401`, and page script cannot set a
 *     header on `new WebSocket()` to compensate.
 *  3. **There is no build-time variable to read.** `NEXT_PUBLIC_*` is inlined by `next build`, so a
 *     built image could never be pointed at its own API — a defect that was removed from this app
 *     and must not come back. The browser addresses its own origin and something in front routes
 *     `/api/*`; that is the same arrangement `lib/api.ts` uses for REST, and this module deliberately
 *     makes no independent decision about where the API lives.
 *
 * The scheme is derived, never hard-coded: `https:` gives `wss:`, anything else gives `ws:`. A
 * secure page opening an insecure socket is blocked by the browser as mixed content, so getting this
 * wrong is a silent failure on exactly the deployment that matters.
 *
 * ## Everything from the server is untrusted input
 *
 * `JSON.parse` returns `unknown`, and every field this client reads is checked before it is read.
 * There is one deliberate boundary in that rule, stated here rather than hidden: the members of
 * `PlayerView` that the UI *renders* are validated field by field (seats, cards, legal actions,
 * pots, the sequence, the totals), and the members it only carries — the commitment context, the
 * Merkle reveal inside a completed hand's result — are checked for kind and presence rather than
 * structure. Validating a Merkle proof's interior here would be a second implementation of the
 * engine's own definition, and the client has no use for the contents.
 *
 * ## Idempotency and sequencing are the caller's to supply, and this module will not invent them
 *
 * `sendAction` takes an `actionId` and an `expectedSequence` and sends exactly those. It does not
 * generate an id per attempt, because that is precisely what makes a retry unsafe: the server
 * refuses to apply the same `actionId` twice, so a retry after a dropped response must carry the
 * *same* id or it is a second bet. See `use-live-table.ts`, which mints one id per decision and
 * replays it unchanged across a reconnect.
 *
 * ## Limits are respected here, not left to the server
 *
 * `WS_LIMITS` publishes them so a client can behave. A token bucket matching the server's
 * (`burstAllowance` capacity, refilled at `messagesPerSecond`) means a runaway effect loop is
 * refused locally instead of costing the reader their socket with a `4429`; the 8 KiB ceiling is
 * checked before `send`, because a frame that exceeds it is dropped *and* the socket closed.
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

// ---------------------------------------------------------------------------
// Where the socket goes
// ---------------------------------------------------------------------------

/** Just enough of `Location` to build the URL, so this is testable without a DOM. */
export interface SocketOrigin {
  readonly protocol: string;
  readonly host: string;
}

/**
 * The socket URL for a page served from `origin`.
 *
 * The path comes from `API_PATHS.ws()` — the contract — and no longer from a `WS_ROUTE` constant
 * kept here. That constant mirrored `WS_PATH` in `apps/api/src/ws/hub.ts` by hand, which is exactly
 * the arrangement `api-paths.ts` exists to abolish: a path written on one side of the wire drifts
 * the moment the other side is renamed, and nothing fails until a reader opens a table.
 * `apps/api/test/web-api-paths.test.ts` now asserts that path against a real `buildApp()`.
 *
 * The scheme and host are still assembled here, and deliberately: `wss:` for a secure page, `ws:`
 * otherwise, against the page's OWN host. A hard-coded scheme is a mixed-content failure on the only
 * deployment where it matters, and a second origin would not receive the `__Host-` session cookie.
 */
export function tableSocketUrl(origin: SocketOrigin): string {
  const scheme = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${origin.host}${API_PATHS.ws()}`;
}

// ---------------------------------------------------------------------------
// Close codes, as sentences a reader can act on
// ---------------------------------------------------------------------------

/** What a closed socket means, and whether reconnecting could possibly help. */
export interface CloseMeaning {
  readonly code: number;
  /** Short, for a heading. */
  readonly title: string;
  /** One or two sentences. States the cause, never "something went wrong". */
  readonly detail: string;
  /** False when retrying would fail identically — the reader has to do something. */
  readonly retryable: boolean;
  /** Set when there is a specific thing the reader can do about it. */
  readonly action?: 'signIn' | 'reload';
}

/**
 * Every close code this server can send, plus the ones a browser produces on its own.
 *
 * Written as a table rather than a chain of conditionals so that "distinct message per code" is a
 * property you can read off the page. A reader who has been signed out is told that; they are not
 * shown a generic "disconnected" that leaves them clicking a button that will never work.
 */
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

// ---------------------------------------------------------------------------
// Narrowing every inbound frame
// ---------------------------------------------------------------------------

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

/** Finite, because `NaN` and `Infinity` survive `JSON.parse` via no path we want to trust. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isArrayOf(value: unknown, item: (candidate: unknown) => boolean): value is readonly unknown[] {
  return Array.isArray(value) && value.every(item);
}

/** A card is an index into the 52-card deck. Anything else is not a card. */
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

/**
 * A legal action, with the bounds the server will accept.
 *
 * The optional members are checked as "absent, or the right type". They are load-bearing: the bet
 * sizer clamps into `[minTo, maxTo]`, which is what stops the UI from ever offering a size the
 * server did not.
 */
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

/**
 * A completed hand's result.
 *
 * The showdown members the table draws — the seat, its five best cards, the sentence describing the
 * hand — are checked. `reveal` carries Merkle proofs this client never opens, so it is checked for
 * presence and kind only; see the module comment for why that line is drawn where it is.
 */
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

/** The scalar members of a view, split out to keep each predicate readable. */
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
 * The redacted table state.
 *
 * Note what is *not* here: any check that the view is consistent, that the pot adds up, or that a
 * legal action is sensible. That is the server's job and it is the only authority. This asks one
 * question — "is this the shape the contract describes?" — so that a malformed or hostile frame
 * produces a refusal rather than `undefined` reaching a renderer.
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
    // Required, and checked: a seat awaiting the big blind holds a chair but is not dealt in, and a
    // frame missing the field would validate, read `undefined`, and render that seat as an ordinary
    // player receiving no cards with nothing explaining why — the exact defect the field was added
    // to remove. Adding a field is wire-compatible; silently accepting its absence is not.
    isBoolean(value['awaitingBigBlind'])
  );
}

function isRoomSummary(value: unknown): value is WsWelcome['room'] {
  if (!isObject(value)) return false;
  return (
    isString(value['id']) &&
    isString(value['name']) &&
    isString(value['ownerUserId']) &&
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

/** Event kinds, with the members each one carries. Never load-bearing; `state` is the truth. */
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

/** True when `value` is one of the contract's event members, checked kind-first then field by field. */
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

/**
 * The members `PotOddsSummary` promises, checked one by one.
 *
 * `oddsRatio` is checked as `number | null` because that is what the contract declares and what the
 * wire carries: `null` means the call is free, so there is no "X to 1" price to quote. It is not a
 * missing figure and not a bad one, and `formatOdds` in `@prl/ui` renders it as "no cost to
 * continue". Accepting it is therefore narrowing the frame, not relaxing the check — the frame that
 * is refused is one where the member is a string, a boolean, `NaN` or absent.
 */
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
 * The Coach report, checked to the depth `CoachPanel` renders it.
 *
 * Returns the name of the first member that failed, or null when the report is renderable. A name
 * rather than a boolean because this is the one frame whose rejection a reader has to be told about:
 * every other frame type is followed by another one, but an analysis is asked for and answered once.
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
  // Built member by member rather than spread: `exactOptionalPropertyTypes` rejects an explicit
  // `undefined`, and an ack without `appliedSequence` is a different fact from one carrying it.
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

/** A frame that did not match the contract, described well enough to act on. */
export interface FrameRejection {
  /** The `type` the frame claimed, when it had a readable one. Null for unparseable input. */
  readonly claimedType: string | null;
  /** Which member failed, in the contract's own vocabulary. Never a stack trace. */
  readonly reason: string;
}

export type FrameOutcome =
  | { readonly ok: true; readonly frame: WsServerMessage }
  | { readonly ok: false; readonly rejection: FrameRejection };

/** The type-specific narrowers, so the switch below is a lookup rather than eight branches. */
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
 * One inbound frame, or a description of why it was refused.
 *
 * A refusal is usually not something a reader needs to see: `state` is sent whole on every change,
 * so a dropped frame is corrected by the next one, and that is the benefit of a non-delta protocol.
 * The exception is a `coach` frame — an analysis is asked for once and answered once, so dropping it
 * silently leaves a panel that will never fill. Hence the reason string: the caller decides which
 * refusals are worth a sentence.
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
  const reason =
    claimedType === 'coach'
      ? (checkCoachReport(parsed['report']) ?? 'the requestId was missing or not a string')
      : `the ${claimedType} frame did not match the shape the contract describes`;
  return { ok: false, rejection: { claimedType, reason } };
}

/** The same check as a plain narrowing, for callers that do not care why a frame was refused. */
export function narrowServerMessage(raw: string): WsServerMessage | null {
  const outcome = readServerMessage(raw);
  return outcome.ok ? outcome.frame : null;
}

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/** What this module needs from a socket. Two methods, so a test can be a pair of functions. */
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

/**
 * The real one.
 *
 * No headers and no query string: the session travels as a cookie on the upgrade, which is the only
 * mechanism a browser offers and the one the server expects. A token in the URL would end up in
 * proxy logs and browser history.
 */
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

/** Timers, injectable so the reconnect schedule can be tested without waiting for it. */
export interface Scheduler {
  readonly now: () => number;
  /** Returns a cancel function. */
  readonly delay: (ms: number, run: () => void) => () => void;
}

export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  delay: (ms, run) => {
    const handle = setTimeout(run, ms);
    return () => clearTimeout(handle);
  },
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export type TableSocketStatus =
  /** A socket is being opened. */
  | 'connecting'
  /** Open, `hello` sent, waiting for `welcome`. */
  | 'handshaking'
  /** `welcome` received. Frames are flowing. */
  | 'live'
  /** Closed for a retryable reason; a reconnect is scheduled. */
  | 'reconnecting'
  /** Closed and not coming back without the reader doing something. */
  | 'closed';

export interface TableSocketOptions {
  readonly roomId: string;
  readonly url: string;
  /** Every frame that survived narrowing, in arrival order. */
  readonly onFrame: (frame: WsServerMessage) => void;
  readonly onStatus: (status: TableSocketStatus) => void;
  /** The last close, as a sentence. Null once a connection is live again. */
  readonly onClose: (meaning: CloseMeaning | null) => void;
  /**
   * A frame that did not match the contract and was dropped.
   *
   * Separate from `onProblem` because some of these are worth telling a reader about — an analysis
   * the panel cannot render is one the reader is waiting for — and the caller is the only one that
   * knows which.
   */
  readonly onRejected?: (rejection: FrameRejection) => void;
  /** Something the developer needs to see. Never shown to a reader. */
  readonly onProblem?: (message: string) => void;
  readonly socketFactory?: RawSocketFactory;
  readonly scheduler?: Scheduler;
}

/** What the caller can do with a live table. */
export interface TableSocketHandle {
  /** Sends `sit`. Returns false when the frame was refused locally (rate limit, or no socket). */
  sit(seat: number, requestId: string): boolean;
  stand(requestId: string): boolean;
  startHand(requestId: string): boolean;
  /**
   * Sends one decision.
   *
   * `actionId` and `expectedSequence` are the caller's, unchanged. A retry MUST reuse both: the
   * server refuses a repeated `actionId`, which is what makes a retry after a dropped response a
   * no-op instead of a second bet.
   */
  action(input: {
    readonly action: TableAction;
    readonly actionId: string;
    readonly expectedSequence: number;
    readonly requestId: string;
  }): boolean;
  requestCoach(requestId: string, opponentRange?: string): boolean;
  /** Closes and stops reconnecting. Safe to call twice. */
  dispose(): void;
}

/** Reconnect schedule: doubling, capped, with jitter so many tabs do not return in lockstep. */
const BACKOFF_FIRST_MS = 500;
const BACKOFF_CAP_MS = 15_000;
/** A `4429` means we have been told to slow down, so the schedule starts near its ceiling. */
const BACKOFF_RATE_LIMITED_MS = 10_000;
/** How long to wait for `welcome` before treating the socket as dead. Just over the server's. */
const HANDSHAKE_GRACE_MS = WS_LIMITS.handshakeTimeoutMs + 2_000;
/** App-level liveness. Two unanswered pings and the socket is treated as gone. */
const PING_INTERVAL_MS = WS_LIMITS.heartbeatIntervalMs;
const PINGS_UNANSWERED_ALLOWED = 2;

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/** The same token bucket the server runs, so we are refused locally instead of disconnected. */
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
 * Opens a table socket and keeps it open.
 *
 * Written as a closure rather than a class because everything it owns is private and the caller
 * needs five verbs. It starts connecting immediately; `dispose` is the only way it stops, and a
 * disposed handle never schedules anything again — a leaked socket per navigation would reach the
 * four-per-session cap and lock the reader out of their own table.
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

  const sendRaw = (message: WsClientMessage): boolean => {
    if (socket === null || disposed) return false;
    const text = JSON.stringify(message);
    // Checked before `send`: the server drops an oversized frame AND closes the socket, so an
    // accidental giant frame costs the reader their table rather than one message.
    if (new TextEncoder().encode(text).length > WS_LIMITS.maxMessageBytes) {
      problem(`refusing to send a ${message.type} frame larger than the protocol's 8 KiB ceiling`);
      return false;
    }
    if (!takeToken(bucket, scheduler.now())) {
      problem(`refusing to send ${message.type}: the client-side rate limit would be exceeded`);
      return false;
    }
    try {
      socket.send(text);
      return true;
    } catch (cause) {
      problem(`sending ${message.type} threw: ${cause instanceof Error ? cause.message : 'unknown'}`);
      return false;
    }
  };

  const armPing = (mine: number): void => {
    cancelPing?.();
    cancelPing = scheduler.delay(PING_INTERVAL_MS, () => {
      if (disposed || mine !== generation) return;
      if (unansweredPings >= PINGS_UNANSWERED_ALLOWED) {
        // A half-open socket answers nothing and never fires `close`. Forcing one is the only way
        // to stop a seat's clock running out against a connection that is already gone.
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
    // ±20%, so a server that dropped every socket at once does not get them all back in one tick.
    // From the CSPRNG, not `Math.random`: this repository bans `Math.random` outright and a
    // release gate enforces it across every source tree. Backoff jitter is not a security
    // boundary, but a per-file exemption is how the ban stops being checkable — and the cost of
    // using the CSPRNG for one float is nothing.
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
        // The first frame, always. Nothing else is accepted until it lands, and a socket that has
        // not sent it inside the server's window is closed 4408.
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
        // `error` on a WebSocket carries nothing useful by design (it would be a cross-origin
        // information leak), and `close` always follows it. Recorded, not acted on.
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

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * A request id the contract will accept: `^[A-Za-z0-9_-]{8,64}$`.
 *
 * `crypto.randomUUID()` where it exists, falling back to `randomUnitInterval`'s CSPRNG rather
 * than to `Math.random`. The distinction matters more than it looks: `randomUUID` is restricted
 * to secure contexts, but `getRandomValues` is not — so the fallback path is reached exactly
 * when the page is least trustworthy, which is the worst possible moment to switch to a
 * predictable generator. These ids are idempotency keys, and a collision means one player's
 * action is silently treated as a replay of another's.
 */
let idCounter = 0;

export function newRequestId(prefix: string): string {
  idCounter += 1;
  const unique =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${String(Date.now())}-${String(idCounter)}-${randomToken(8)}`;
  // Trimmed to the contract's 64-character ceiling, and stripped of anything outside its alphabet.
  return `${prefix}-${unique}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

/**
 * A float in `[0, 1)` from the platform CSPRNG — the `Math.random` replacement this file uses.
 *
 * Divides by `2 ** 32` rather than by `0xffffffff`, so the result can never reach 1 and the
 * distribution stays uniform over the whole 32-bit range.
 */
function randomUnitInterval(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}

/** `length` lowercase hex characters from the platform CSPRNG. */
function randomToken(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, length);
}

'use client';

/**
 * The live table as React state: one reducer over the server's frames, and the reader's verbs.
 * Everything on screen came from a frame. Nothing here moves a chip on a click, and enabled buttons
 * come only from `view.legalActions`.
 * One `actionId` per decision, replayed unchanged with the same `expectedSequence` across a reconnect,
 * so a dropped response cannot become a second bet. A stale sequence is refused and applies nothing.
 * State is sent whole (ADR 0009), so reconnect just renders the next view. `revision` is monotonic
 * per socket and resets on `welcome`.
 * Announcements are diffed in the reducer, the only place the previous frame exists, so whole-state
 * frames do not make the live region speak on every frame.
 */

import {
  type CoachReport,
  type CreateRoomRequest,
  type ErrorCode,
  inSecondPerson,
  type RoomSummary,
  type WsServerMessage,
} from '@prl/contracts';
import type { PlayerView, TableAction, TurnClock } from '@prl/ui';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { TableSubmission } from '@/components/TableStage.tsx';
import { notifySessionChanged } from './api.ts';
import {
  BOT_TABLE_REQUEST,
  chooseRoom,
  createLegendMatch,
  createRoom,
  ensureSession,
  FRIENDS_TABLE_REQUEST,
  firstFreeSeat,
  joinRoomByInviteCode,
  listRooms,
  normaliseInviteCode,
  READER_SEAT,
  resumeRememberedTable,
} from './table-rooms.ts';
import {
  type CloseMeaning,
  newRequestId,
  openTableSocket,
  type RawSocketFactory,
  type Scheduler,
  type SendOutcome,
  type TableSocketHandle,
  type TableSocketStatus,
  tableSocketUrl,
} from './table-socket.ts';

/** When the header re-reads the session after a hand settles. */
export const SETTLED_ASK_MS = 1_000;
export const SETTLED_RETRY_MS = 5_000;

/** Where the tab remembers its room, so a reload rejoins instead of creating another table. */
const ROOM_STORAGE_KEY = 'prl.play.roomId';

function rememberRoom(roomId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (roomId === null) window.sessionStorage.removeItem(ROOM_STORAGE_KEY);
    else window.sessionStorage.setItem(ROOM_STORAGE_KEY, roomId);
  } catch {
    // Storage can be disabled or full. Losing it costs one extra room, not correctness.
  }
}

function rememberedRoom(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(ROOM_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Replayed unchanged across a reconnect. */
export interface PendingDecision {
  readonly action: TableAction;
  readonly actionId: string;
  readonly expectedSequence: number;
  readonly requestId: string;
}

export interface TableState {
  readonly room: RoomSummary | null;
  readonly userId: string | null;
  readonly seat: number | null;
  /** Kept between hands so a finished hand stays readable. */
  readonly view: PlayerView | null;
  /** The most recent `state` carried `view: null`. */
  readonly betweenHands: boolean;
  readonly deadlineMs: number | null;
  readonly serverTimeMs: number;
  /**
   * This turn's budget, `deadlineMs - serverTimeMs` from the first frame with this deadline. The server
   * gives a person alone with bots 240s, not the room's 60s, so the room clock is only a floor (see
   * `turnClockFor`).
   */
  readonly turnBudgetMs: number | null;
  /**
   * Set when the server acted because the reader's clock ran out, until the next deal. `wasAutomatic`
   * alone also covers a seat that stood up mid-hand, so this needs `clockExpiredSeat`.
   */
  readonly autoActed: string | null;
  /**
   * The seat a `seatTimedOut` just named, until its automatic action arrives. The server sends that
   * event immediately before the action. A stand-up fold has none. Unknown is never reported as a
   * timeout.
   */
  readonly clockExpiredSeat: number | null;
  /** Resets on `welcome`. */
  readonly revision: number;
  readonly announcement: string;
  /**
   * The deal sentence held back until the forced bets of the same notice. Two writes into one atomic
   * polite region are one announcement. See `onEventFrame`.
   */
  readonly carried: string;
  /**
   * The reader's own turn, separate from `announcement` because `state` and `event` frames for one
   * change race, and one field would let either overwrite the other. Empty when not their turn, so
   * the next turn re-announces.
   */
  readonly turnAnnouncement: string;
  readonly summary: readonly string[];
  /** `key` is the spot the request was SENT for, not the one on screen. See `onCoachFrame`. */
  readonly coach: { readonly key: string; readonly report: CoachReport } | null;
  /** A `coach` frame carries only a `requestId`, so this is the only record of its spot. */
  readonly coachRequest: { readonly requestId: string; readonly key: string } | null;
  /** Why there is no analysis, when the reason is something other than "none was asked for". */
  readonly coachProblem: string | null;
  /** False after Expert Legends or a `coach_not_available` refusal. */
  readonly coachDuringHand: boolean;
  /**
   * The server's own wording for `coach_not_available`, so the panel does not claim an Expert
   * difficulty it never saw (a reused room on plain `/play` printed the Expert sentence). Null while
   * Coach is on or when this page chose Expert itself.
   */
  readonly coachRefusal: string | null;
  readonly pending: PendingDecision | null;
  readonly submission: TableSubmission | null;
  /** The server's wording for the last refusal that was not about a decision. */
  readonly notice: string | null;
  /**
   * The contract code beside `notice`, so the UI branches on the code and never on prose. Only
   * `enrolment_required` gets its own treatment today.
   */
  readonly noticeCode: ErrorCode | null;
  /**
   * Set when this client refused a `state` frame for unentitled hole cards. Not `notice`, whose panel
   * says the server refused something. Sticky until `reset`, because a leaking server resends the view.
   */
  readonly dataRefusal: string | null;
}

export const EMPTY_TABLE_STATE: TableState = {
  room: null,
  userId: null,
  seat: null,
  view: null,
  betweenHands: true,
  deadlineMs: null,
  serverTimeMs: 0,
  turnBudgetMs: null,
  autoActed: null,
  clockExpiredSeat: null,
  revision: 0,
  announcement: '',
  carried: '',
  turnAnnouncement: '',
  summary: [],
  coach: null,
  coachRequest: null,
  coachProblem: null,
  coachDuringHand: true,
  coachRefusal: null,
  pending: null,
  submission: null,
  notice: null,
  noticeCode: null,
  dataRefusal: null,
};

export type TableEvent =
  | { readonly kind: 'frame'; readonly frame: WsServerMessage }
  /** `delivery` has no default. Only the caller knows whether the frame went out. */
  | { readonly kind: 'submit'; readonly pending: PendingDecision; readonly delivery: SendOutcome }
  | { readonly kind: 'coachRequested'; readonly requestId: string; readonly key: string }
  | { readonly kind: 'coachFailed'; readonly reason: string }
  | { readonly kind: 'notice'; readonly message: string | null; readonly code?: ErrorCode | null }
  /** Seats, not a sentence, so the reducer owns the wording. */
  | { readonly kind: 'dataRefused'; readonly seats: readonly number[] }
  | { readonly kind: 'reset' };

export function decisionKey(view: PlayerView | null): string {
  return view === null ? '' : `${view.handId}:${String(view.actionSequence)}`;
}

/** Read from the roster, not remembered. */
function seatFrom(room: RoomSummary, userId: string | null): number | null {
  if (userId === null) return null;
  return room.members.find((member) => member.userId === userId)?.seat ?? null;
}

/**
 * Exported and pure so the reducer, hook and tests agree. The server empties `legalActions` for
 * everybody it is not asking, so an empty list means no decision whatever `toAct` says.
 */
export function isViewersTurn(view: PlayerView | null, betweenHands: boolean): boolean {
  if (view === null || betweenHands) return false;
  return view.viewerSeat !== null && view.toAct === view.viewerSeat && view.legalActions.length > 0;
}

/**
 * Not `formatUnits` from `@prl/ui`. That package is consumed as source and re-exports `.tsx`, so a
 * runtime import makes this module unloadable under `node --test` (`ERR_UNKNOWN_FILE_EXTENSION`).
 */
function units(value: number): string {
  const whole = Math.round(value);
  return `${new Intl.NumberFormat('en-GB').format(whole)} ${Math.abs(whole) === 1 ? 'unit' : 'units'}`;
}

/** No Oxford comma, because this is read aloud. */
function listActions(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1] ?? ''}`;
}

function streetPhrase(street: PlayerView['street']): string {
  if (street === 'preflop') return 'preflop';
  if (street === 'showdown' || street === 'complete') return 'at the end of the hand';
  return `on the ${street}`;
}

/**
 * One sentence on the edge, in decision order, instead of four regions racing. No hole cards (already
 * in the accessibility tree) and no equity figure.
 */
export function turnAnnouncementFor(view: PlayerView): string {
  const hero = view.seats.find((seat) => seat.isSelf) ?? null;
  const price = view.amountToCall > 0 ? `${units(view.amountToCall)} to call` : 'Nothing to call';
  const stack = hero === null ? '' : `, your stack ${units(hero.stack)}`;
  const actions = listActions(view.legalActions.map((action) => action.type));
  const offer = actions === '' ? '' : ` You can ${actions}.`;
  return `Your turn ${streetPhrase(view.street)}. ${price}. Pot ${units(view.potTotal)}${stack}.${offer}`;
}

/**
 * Announced once as a state change. Prefixed onto every announcement in `TableStage`, it stuck to the
 * front of every later event, since `role="status"` is atomic.
 */
export function spokenDecision(action: TableAction): string {
  if (action.type === 'bet' || action.type === 'raise') {
    return `You chose to ${action.type} to ${units(action.to)}.`;
  }
  return `You chose to ${action.type}.`;
}

/**
 * Exported so tests assert the reducer's output rather than a copied literal. No figures. J3.11 in
 * `scripts/ax-assertions.mjs` keys on the ready sentence's opening words. It names the phone handle,
 * since the panel is a collapsed bottom sheet there.
 */
export const COACH_READY_ANNOUNCEMENT =
  'The analysis of this decision is ready in the Coach panel. On a phone it opens from “Show the analysis”.';
export const COACH_FAILED_ANNOUNCEMENT = 'The analysis could not be shown.';

/**
 * Must say the table stopped and nothing was staked. Must not claim the cards were kept from anybody,
 * since they reached this browser. See `hole-card-entitlement.ts`.
 */
export function dataRefusalSentence(seats: readonly number[]): string {
  // 1-based, like every other seat number shown to the reader.
  const named = seats.map((seat) => (seat < 0 ? 'an unnumbered seat' : `seat ${String(seat + 1)}`));
  const one = named.length === 1;
  const list = one ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return (
    `The table stopped because the server sent this browser the hole cards of ${list} — cards ` +
    `${one ? 'that seat had' : 'those seats had'} not shown and that are not yours. Nothing was ` +
    'staked and no decision was sent. This page refused the frame rather than drawing those cards, ' +
    'but it cannot unsend them, so the right thing to do is to report it: the hand this happened ' +
    'in is not a fair hand for anybody at the table.'
  );
}

/** Refused by this page, not the server. Nothing retries it, so the sentence says what to do. */
const COACH_NOT_SENT: Readonly<Record<'rate-limited' | 'undeliverable', string>> = {
  'rate-limited':
    'This page refused to exceed the rate limit the protocol sets for one socket, so the request ' +
    'never left your browser. Nothing is holding it — ask again in a moment.',
  undeliverable:
    'This page could not put the request on the wire, so it never reached the table. Nothing is ' +
    'holding it — ask again, and if it happens twice the connection itself is the thing to reload.',
};

export const DEAL_ANNOUNCEMENT = 'A new hand was dealt.';

type WireEvent = Extract<WsServerMessage, { type: 'event' }>['event'];

/**
 * Events arrive before the same notice's `state` frame, so mid-hand `viewerSeat` is right and null
 * means not dealt in. Falling back to `state.seat` would make a mid-hand sitter the previous occupant.
 */
function readersSeat(state: TableState): number | null {
  const view = state.view;
  if (view !== null && view.street !== 'complete') return view.viewerSeat;
  return state.seat;
}

/**
 * Seatless sentences (blinds, showdown, awards) carry only a name, and names are not unique (Devin on
 * PR #33). Rewrite only when the reader holds a seat, no other member's name contains theirs as a
 * whole word, and every dealt player is a member. Any doubt leaves the server's sentence.
 */
function onlyTheReaderIsNamed(state: TableState, name: string): boolean {
  if (readersSeat(state) === null) return false;
  const members = state.room?.members ?? [];
  const word = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapedName(name)}(?:$|[^\\p{L}\\p{N}])`, 'u');
  const named = members.some((member) => member.userId !== state.userId && word.test(member.displayName));
  if (named) return false;
  const known = new Set(members.map((member) => member.userId));
  return (state.view?.seats ?? []).every((seat) => known.has(seat.playerId));
}

function escapedName(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The reader's own sentences in the second person (audit at 308fadf). Actions are matched by seat;
 * seatless events only when `onlyTheReaderIsNamed`. Unrecognised sentences are left as written.
 */
function inReadersWords(event: WireEvent, state: TableState): WireEvent {
  const name = state.room?.members.find((member) => member.userId === state.userId)?.displayName ?? null;
  if (name === null) return event;
  if (event.kind === 'action') {
    const own = event.seat === readersSeat(state);
    return own ? { ...event, description: inSecondPerson(event.description, name) } : event;
  }
  if (!onlyTheReaderIsNamed(state, name)) return event;
  switch (event.kind) {
    case 'forcedBets':
      return { ...event, detail: inSecondPerson(event.detail, name) };
    case 'showdown':
    case 'handComplete':
      return { ...event, summaries: event.summaries.map((line) => inSecondPerson(line, name)) };
    default:
      return event;
  }
}

/**
 * `clockExpired` says the preceding `seatTimedOut` named this seat. `ownSeat` lets seat-numbered
 * sentences say "you" to the reader.
 */
function announce(event: WireEvent, clockExpired = false, ownSeat: number | null = null): string {
  const own = ownSeat !== null && 'seat' in event && event.seat === ownSeat;
  switch (event.kind) {
    case 'handStarted':
      return DEAL_ANNOUNCEMENT;
    case 'forcedBets':
      return event.detail;
    case 'action':
      if (!event.wasAutomatic) return event.description;
      return clockExpired
        ? `${event.description} (the clock ran out, so the server acted)`
        : `${event.description} (the server acted for ${own ? 'you' : 'this seat'})`;
    case 'street':
      return event.newCards.length === 0
        ? `The ${event.street}.`
        : `The ${event.street}: ${event.newCards.join(', ')}.`;
    case 'showdown':
      return `Showdown. ${event.summaries.join(' ')}`;
    case 'handComplete':
      return `The hand is complete. ${event.summaries.join(' ')}`;
    case 'playerJoined':
      return `${event.displayName} joined the table.`;
    case 'playerLeft':
      return `${event.displayName} left the table.`;
    case 'seatTimedOut':
      return own
        ? 'You ran out of time and the server acted for you.'
        : `Seat ${String(event.seat + 1)} ran out of time and the server acted for it.`;
    default:
      return '';
  }
}

/**
 * `handStarted` and `forcedBets` are written back to back in one notice, and two writes into one
 * atomic polite region are heard as only the second. So `handStarted` writes nothing and leaves the
 * deal sentence carried onto the forced bets, one write however the frames arrive. Measured by
 * assertion 3.3 in `scripts/ax-assertions.mjs`. 3.17 catches a sentence left stapled to later ones.
 */
function onEventFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'event' }>): TableState {
  if (frame.event.kind === 'handStarted') {
    // No `announcement`, so a `handStarted` in its own commit cannot re-announce the last sentence.
    return { ...state, carried: announce(frame.event), summary: [], autoActed: null, clockExpiredSeat: null };
  }
  // Consumed by the very next event, since `seatTimedOut` and its action are adjacent in one notice.
  const clockExpired =
    frame.event.kind === 'action' && frame.event.wasAutomatic && frame.event.seat === state.clockExpiredSeat;
  const clockExpiredSeat = frame.event.kind === 'seatTimedOut' ? frame.event.seat : null;
  const event = inReadersWords(frame.event, state);
  const sentence = announce(event, clockExpired, readersSeat(state));
  const announcement = state.carried === '' ? sentence : `${state.carried} ${sentence}`;
  const next: TableState = { ...state, announcement, carried: '', clockExpiredSeat };
  if (event.kind === 'showdown') {
    return { ...next, summary: event.summaries };
  }
  if (event.kind === 'handComplete') {
    // Appended to the showdown's lines, never written over them. `showdown` says what was shown and
    // `handComplete` who was paid. `handStarted` empties the list.
    return { ...next, summary: [...state.summary, ...event.summaries] };
  }
  // Only a clock expiry at the reader's seat. A fold after "Stand up" has no `seatTimedOut`.
  if (clockExpired && frame.event.kind === 'action' && frame.event.seat === state.seat) {
    return { ...next, autoActed: AUTO_ACTED_NOTICE };
  }
  return next;
}

/**
 * States the rule (`timeoutAction` in `packages/poker-engine`), because the event carries prose, not a
 * verb, and parsing prose breaks when it is reworded.
 */
export const AUTO_ACTED_NOTICE =
  'Your clock ran out, so the server acted for you. A seat whose time runs out checks when checking ' +
  'is free and folds otherwise — it never puts more units in.';

function onStateFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'state' }>): TableState {
  // An out-of-order frame would draw the past over the present.
  if (frame.revision <= state.revision) return state;

  const view = frame.view ?? state.view;
  const key = decisionKey(view);
  const movedOn = key !== decisionKey(state.view);
  // Mirrors `LiveTable.handInProgress` in `rooms/table.ts`. A finished hand still carries a view, so
  // "no view" alone left "Deal the next hand" disabled forever.
  const betweenHands = frame.view === null || frame.view.street === 'complete';
  // The edge, not the level, keyed on the decision key. Two consecutive decisions of the reader's
  // (closing preflop, first to act on the flop) have no frame between them, and "was their turn last
  // frame" re-spoke the dead sentence (audit at 308fadf).
  const wasTurn = isViewersTurn(state.view, state.betweenHands);
  const nowTurn = isViewersTurn(view, betweenHands);
  const sameTurn = wasTurn && !movedOn;
  const turnAnnouncement =
    nowTurn && view !== null ? (sameTurn ? state.turnAnnouncement : turnAnnouncementFor(view)) : '';
  // A new deadline is a new turn. See `turnBudgetMs`.
  const turnBudgetMs =
    frame.deadlineMs === null
      ? null
      : frame.deadlineMs === state.deadlineMs && state.turnBudgetMs !== null
        ? state.turnBudgetMs
        : Math.max(frame.deadlineMs - frame.serverTimeMs, 0);
  return {
    ...state,
    revision: frame.revision,
    room: frame.room,
    seat: seatFrom(frame.room, state.userId),
    view,
    turnAnnouncement,
    betweenHands,
    deadlineMs: frame.deadlineMs,
    serverTimeMs: frame.serverTimeMs,
    turnBudgetMs,
    // An analysis belongs to its spot, so it and its failure reason drop when the spot changes.
    coach: state.coach !== null && state.coach.key === key ? state.coach : null,
    coachProblem: movedOn ? null : state.coachProblem,
    // The request closes with the spot too, so a late answer from the worker is discarded rather than
    // filed under the new spot.
    coachRequest: movedOn ? null : state.coachRequest,
    // A finished decision stops disabling the controls once the hand has actually moved.
    submission: movedOn && state.pending === null ? null : state.submission,
  };
}

function onAckFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'ack' }>): TableState {
  const pending = state.pending;
  if (pending === null || pending.requestId !== frame.requestId) {
    return { ...state, notice: null, noticeCode: null };
  }
  // No sequence number in the sentence; it means nothing to a person.
  const detail =
    frame.deduplicated === true
      ? 'This decision had already been applied, so the server counted the retry as the same one. ' +
        'Nothing was staked twice.'
      : 'The table has it. The controls come back when the next decision is yours.';
  return {
    ...state,
    pending: null,
    submission: { action: pending.action, status: 'accepted', message: detail },
  };
}

function onErrorFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'error' }>): TableState {
  if (state.coachRequest !== null && frame.requestId === state.coachRequest.requestId) {
    const reviewOnly = frame.error.code === 'coach_not_available';
    return {
      ...state,
      coachRequest: null,
      coach: null,
      coachProblem: reviewOnly ? null : frame.error.message,
      coachDuringHand: reviewOnly ? false : state.coachDuringHand,
      // The only thing this client learns about why Coach is off. See `coachRefusal`.
      coachRefusal: reviewOnly ? frame.error.message : state.coachRefusal,
      announcement: reviewOnly
        ? 'The Coach is off during this hand. It is available in review afterwards.'
        : `${COACH_FAILED_ANNOUNCEMENT} ${frame.error.message}`,
    };
  }
  const pending = state.pending;
  // The server's sentence only, no trailing contract token (audit at 308fadf). The code goes in `noticeCode`.
  if (pending === null || pending.requestId !== frame.requestId) {
    return { ...state, notice: frame.error.message, noticeCode: frame.error.code };
  }
  const stale = frame.error.code === 'stale_action_sequence';
  return {
    ...state,
    pending: null,
    submission: {
      action: pending.action,
      status: 'rejected',
      message: stale
        ? 'The hand moved on before this arrived, so the server applied nothing. It refuses to put a ' +
          'decision into a spot you never saw. The table below is the spot as it is now.'
        : `${frame.error.message} Nothing was applied.`,
    },
  };
}

function onFrame(state: TableState, frame: WsServerMessage): TableState {
  switch (frame.type) {
    case 'welcome':
      return {
        ...state,
        userId: frame.userId,
        room: frame.room,
        seat: frame.seat,
        serverTimeMs: frame.serverTimeMs,
        revision: 0,
        notice: null,
        // The request died with the old socket, since the server matches `requestId` per connection.
        // `coach` stays, because its spot has not changed; `onStateFrame` drops it when it does.
        coachRequest: null,
      };
    case 'state':
      return onStateFrame(state, frame);
    case 'event':
      return onEventFrame(state, frame);
    case 'coach':
      return onCoachFrame(state, frame);
    case 'ack':
      return onAckFrame(state, frame);
    case 'error':
      return onErrorFrame(state, frame);
    case 'pong':
      return state;
    default:
      return state;
  }
}

/**
 * Files an analysis under the spot it was REQUESTED for, or drops it. A `coach` frame carries only a
 * `requestId`, and keying on the spot on screen at arrival once printed a flop analysis beside a
 * finished hand. `onStateFrame` closes the request when the spot moves, and this refuses any late
 * frame that slips past.
 */
function onCoachFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'coach' }>): TableState {
  const request = state.coachRequest;
  if (request === null || request.requestId !== frame.requestId) return state;
  // Closed either way; no second answer is coming.
  if (request.key !== decisionKey(state.view)) return { ...state, coachRequest: null };
  return {
    ...state,
    coach: { key: request.key, report: frame.report },
    coachRequest: null,
    coachProblem: null,
    // Announce where the analysis is, never a figure, as `ScenarioStage.tsx` does. Below 600px the
    // panel is a collapsed sheet. Only on this path, since a dropped report fills nothing.
    announcement: COACH_READY_ANNOUNCEMENT,
  };
}

/**
 * One sentence per send outcome, each saying what the reader can do. A single "Sent." sentence once
 * claimed delivery during a reconnect while an alert blamed the rate limit. `held` is not lost.
 * `onFrame` replays it on the next `welcome` with the same `actionId`.
 */
const SUBMISSION_FOR: Readonly<Record<SendOutcome, (action: TableAction) => TableSubmission>> = {
  sent: (action) => ({
    action,
    status: 'pending',
    message:
      'Sent. The server is the only authority on a hand, so the controls stay disabled until it ' +
      'answers.',
  }),
  disconnected: (action) => ({
    action,
    status: 'held',
    message:
      'Not sent yet: this page has no connection to the table. Your decision is held here, ' +
      'unchanged, and goes out as soon as the connection is back — with the same decision id, so ' +
      'the server applies it once and only once. Nothing has been staked twice and nothing has ' +
      'been lost. The controls stay disabled until the server answers.',
  }),
  'rate-limited': (action) => ({
    action,
    status: 'not-sent',
    message:
      'Not sent, and not by the server: this page refused to exceed the rate limit the protocol ' +
      'sets for one socket, so the decision never left your browser and nothing was staked. ' +
      'Nothing is holding it either — decide again in a moment.',
  }),
  undeliverable: (action) => ({
    action,
    status: 'not-sent',
    message:
      'This page could not put the decision on the wire, so it never reached the table and nothing ' +
      'was staked. Nothing is holding it — decide again, and if it happens twice the connection ' +
      'itself is the thing to reload.',
  }),
};

/**
 * `pending` disables the controls and is what the reconnect replays, so it is kept only for these.
 * Kept after a refusal nothing retries, it would disable the table forever.
 */
const WILL_STILL_BE_SENT: ReadonlySet<SendOutcome> = new Set<SendOutcome>(['sent', 'disconnected']);

export function tableReducer(state: TableState, event: TableEvent): TableState {
  switch (event.kind) {
    case 'frame':
      return onFrame(state, event.frame);
    case 'submit':
      return {
        ...state,
        pending: WILL_STILL_BE_SENT.has(event.delivery) ? event.pending : null,
        // Said whatever became of the frame, since it echoes the reader's own choice. `turnAnnouncement`
        // is left alone, so a refused decision still has its spot's sentence and nothing is said twice.
        announcement: spokenDecision(event.pending.action),
        submission: SUBMISSION_FOR[event.delivery](event.pending.action),
        // The refusal belongs to `submission` only. Also dispatching a `notice` once showed "Decision
        // sent" beside an alert saying it was not.
        notice: null,
        noticeCode: null,
      };
    case 'coachRequested':
      // The key is the only record of which decision the answer will be about. See `onCoachFrame`.
      return {
        ...state,
        coachRequest: { requestId: event.requestId, key: event.key },
        coach: null,
        coachProblem: null,
      };
    case 'coachFailed':
      // The request is over. Announced, since silence reads as "still working", and a reason is
      // complete on its own where a figure is not.
      return {
        ...state,
        coachRequest: null,
        coach: null,
        coachProblem: event.reason,
        announcement: `${COACH_FAILED_ANNOUNCEMENT} ${event.reason}`,
      };
    case 'notice':
      return { ...state, notice: event.message, noticeCode: event.code ?? null };
    case 'dataRefused':
      // The view stays as the last frame this client could vouch for, so the reader can report the hand.
      return { ...state, dataRefusal: dataRefusalSentence(event.seats) };
    case 'reset':
      return EMPTY_TABLE_STATE;
    default:
      return state;
  }
}

/**
 * `budgetSeconds` comes from `turnBudgetMs`, with the room's clock as a floor for a page that arrived
 * mid-turn. Rounded UP, because the first frame reads 239,999ms of a 240s turn.
 */
export function turnClockFor(
  state: Pick<TableState, 'deadlineMs' | 'serverTimeMs' | 'turnBudgetMs' | 'room' | 'betweenHands'>,
): TurnClock | null {
  if (state.deadlineMs === null || state.room === null || state.betweenHands) return null;
  const served = state.turnBudgetMs === null ? 0 : Math.ceil(state.turnBudgetMs / 1000);
  return {
    deadlineMs: state.deadlineMs,
    serverTimeMs: state.serverTimeMs,
    budgetSeconds: Math.max(served, state.room.actionTimeoutSeconds),
  };
}

// ---------------------------------------------------------------------------
// Setup, as a small machine
// ---------------------------------------------------------------------------

export type SetupPhase =
  /** The reader has not opted in. */
  | 'idle'
  | 'preparing'
  /** The socket owns what happens next. */
  | 'ready'
  | 'failed';

/**
 * "Deal me in" takes the seat and asks for the first deal, each only after the server confirmed the
 * step before. A step is sent on the transition OUT of `wantSeat`, so re-runs on every frame and
 * `welcome` send it at most once per press. Every in-flight state exits to `off` (a refusal, a failed
 * send, the socket leaving `live`), so the manual buttons always come back. Only `start` sets it.
 */
export type DealIn = 'off' | 'wantSeat' | 'sitSent' | 'dealSent';

export interface DealInSnapshot {
  readonly live: boolean;
  /** `notice` set means the server refused something that was not a decision. */
  readonly table: Pick<TableState, 'seat' | 'betweenHands' | 'notice' | 'revision' | 'room' | 'userId'>;
  readonly readerSeat: number | null;
}

export type DealInSend = { readonly kind: 'sit'; readonly seat: number } | { readonly kind: 'deal' } | null;

const STAY = (next: DealIn): { readonly next: DealIn; readonly send: DealInSend } => ({ next, send: null });

/**
 * Pure, so `test/deal-me-in.test.ts` drives it with real frames (no renderer, ADR 0008). A seat
 * already held or a hand already in progress converge on the same end state without sending.
 */
export function dealInStep(
  step: DealIn,
  seen: DealInSnapshot,
): { readonly next: DealIn; readonly send: DealInSend } {
  const { table } = seen;
  if (step === 'off') return STAY('off');
  if (table.notice !== null) return STAY('off');
  // Never deal for a reader the roster shows at stack 0. The server deals them out, and on a server
  // without PR #25 the bots-only hand would settle 0 back over a units reset. Ends at `off`, which
  // brings back the manual buttons and the out-of-units notice.
  const deal: ReturnType<typeof STAY> = outOfUnits(table)
    ? STAY('off')
    : { next: 'dealSent', send: { kind: 'deal' } };
  if (step === 'wantSeat') {
    if (!seen.live) return STAY('wantSeat');
    // `welcome` carries no view, so `betweenHands` is stale until a `state` frame (revision > 0).
    // Reading it earlier sent a deal into a hand in progress.
    if (table.revision === 0) return STAY('wantSeat');
    if (table.seat === null) {
      return seen.readerSeat === null
        ? STAY('off')
        : { next: 'sitSent', send: { kind: 'sit', seat: seen.readerSeat } };
    }
    return table.betweenHands ? deal : STAY('off');
  }
  if (!seen.live) return STAY('off');
  if (step === 'sitSent') {
    if (table.seat === null) return STAY('sitSent');
    return table.betweenHands ? deal : STAY('off');
  }
  return table.betweenHands ? STAY('dealSent') : STAY('off');
}

/**
 * At stack 0 the server deals the reader out but keeps them seated, and nothing said so. Read off the
 * roster, because a seat waiting for the big blind is also absent from the view.
 */
export function outOfUnits(table: Pick<TableState, 'room' | 'userId' | 'seat'>): boolean {
  if (table.room === null || table.userId === null || table.seat === null) return false;
  const me = table.room.members.find((member) => member.userId === table.userId);
  return me !== undefined && me.seat !== null && me.stack <= 0;
}

export type JoinPhase =
  | { readonly state: 'idle' }
  | { readonly state: 'joining' }
  /** The field keeps what was typed so it can be corrected. */
  | { readonly state: 'refused'; readonly message: string }
  | { readonly state: 'joined'; readonly roomName: string };

/** Two kinds, not a boolean, so the panel never states Expert for a server refusal. */
export type CoachOff =
  /** This page opened an Expert Legends match itself. */
  | { readonly kind: 'expertLegends' }
  /**
   * The server refused with `coach_not_available`, which carries no difficulty. `serverReason` is the
   * API's own wording.
   */
  | { readonly kind: 'refusedByServer'; readonly serverReason: string };

export interface LiveTable {
  readonly phase: SetupPhase;
  /** Reconnecting on load to this tab's table, while `phase` stays `idle`. See `resumeRememberedTable`. */
  readonly resuming: boolean;
  readonly status: TableSocketStatus | null;
  readonly closed: CloseMeaning | null;
  readonly setupError: string | null;
  readonly displayName: string | null;
  /**
   * Only for a room THIS page just created. The server stores only `sha256(code)`, so it is held in
   * React state and written nowhere (no storage, no URL). Null when a room was reused.
   */
  readonly inviteCode: string | null;
  readonly join: JoinPhase;
  readonly table: TableState;
  readonly turn: TurnClock | null;
  readonly report: CoachReport | null;
  readonly coachProblem: string | null;
  /** Null while live Coach is on. The copy lives in `app/play/LiveTable.tsx`. */
  readonly coachOff: CoachOff | null;
  readonly seatNames: Readonly<Record<number, string>>;
  readonly highlightedCards: readonly number[];
  readonly isMyTurn: boolean;
  /** The seat `sit()` will ask for, or null when every seat is taken. */
  readonly readerSeat: number | null;
  readonly dealingIn: boolean;
  /** Seated at stack 0, so the server deals every hand without the reader. */
  readonly outOfUnits: boolean;
  /** Session, room, socket, then the seat and the first deal. Safe to call twice. */
  readonly start: () => void;
  /** Abandons the remembered room and builds a fresh bot table. */
  readonly startFreshTable: () => void;
  /**
   * Separate from `startFreshTable` because the bot table is full by construction, so its code would
   * only earn a `room_full`.
   */
  readonly startPrivateTable: () => void;
  readonly joinByInviteCode: (code: string) => void;
  readonly sit: () => void;
  readonly stand: () => void;
  readonly deal: () => void;
  readonly act: (action: TableAction) => void;
  readonly askCoach: () => void;
}

export interface UseLiveTableOptions {
  /** Test seams. The browser supplies none of these. */
  readonly socketFactory?: RawSocketFactory;
  readonly scheduler?: Scheduler;
  readonly url?: string;
  /** When set, open a Legends match against these profiles instead of the generic bot table. */
  readonly legendMatch?: {
    readonly profileId: string;
    readonly difficulty: 'educational' | 'realistic' | 'expert';
  };
}

/** Bots are named by the server, never here. */
function namesFor(room: RoomSummary | null): Readonly<Record<number, string>> {
  if (room === null) return {};
  const names: Record<number, string> = {};
  for (const member of room.members) {
    if (member.seat !== null) names[member.seat] = member.displayName;
  }
  return names;
}

/** Empty unless the hand reached showdown. */
function winningCards(view: PlayerView | null): readonly number[] {
  const result = view?.result ?? null;
  if (result === null) return [];
  const winners = new Set(result.awards.map((award) => award.seat));
  return result.showdowns.filter((showdown) => winners.has(showdown.seat)).flatMap((s) => [...s.bestFive]);
}

/** The server's own wording, without its contract code (audit at 308fadf). */
export function refusalSentence(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return 'the table could not be prepared';
}

async function openPracticeRoom(
  session: { readonly user: { readonly id: string }; readonly csrfToken: string },
  request: CreateRoomRequest,
  legendMatch: UseLiveTableOptions['legendMatch'],
  fresh: boolean,
  signal: AbortSignal,
): Promise<{ room: RoomSummary; inviteCode: string | null }> {
  const rooms = await listRooms(signal);
  const reuse = !fresh && legendMatch === undefined;
  const existing = reuse ? chooseRoom(rooms, session.user.id, rememberedRoom()) : null;
  if (existing !== null) return { room: existing, inviteCode: null };
  if (legendMatch !== undefined) {
    const match = await createLegendMatch(
      session.csrfToken,
      {
        profileIds: [legendMatch.profileId],
        difficulty: legendMatch.difficulty,
        startingStack: 1_000,
        smallBlind: 5,
        bigBlind: 10,
      },
      signal,
    );
    const after = await listRooms(signal);
    const room = after.find((entry) => entry.id === match.roomId);
    if (room === undefined) {
      throw new Error('the Legends match was created but did not appear in the room list');
    }
    return { room, inviteCode: null };
  }
  const created = await createRoom(session.csrfToken, request, signal);
  return { room: created.room, inviteCode: created.inviteCode };
}

/**
 * Unmount closes the socket, cancels every timer and aborts setup. A socket leaked per navigation hits
 * `maxSocketsPerSession` (four) and locks the reader out with a `4429`.
 */
export function useLiveTable(options: UseLiveTableOptions = {}): LiveTable {
  const [table, dispatch] = useReducer(tableReducer, EMPTY_TABLE_STATE);
  const [phase, setPhase] = useState<SetupPhase>('idle');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<TableSocketStatus | null>(null);
  const [closed, setClosed] = useState<CloseMeaning | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [join, setJoin] = useState<JoinPhase>({ state: 'idle' });
  const [dealIn, setDealIn] = useState<DealIn>('off');
  const [resuming, setResuming] = useState(false);

  const socketRef = useRef<TableSocketHandle | null>(null);
  const pendingRef = useRef<PendingDecision | null>(null);
  const viewRef = useRef<PlayerView | null>(null);
  const coachAskedRef = useRef<string | null>(null);
  /** Readable from a frame callback. See the `welcome` case below. */
  const coachRequestRef = useRef<TableState['coachRequest']>(null);
  const setupRef = useRef<AbortController | null>(null);

  pendingRef.current = table.pending;
  viewRef.current = table.view;
  coachRequestRef.current = table.coachRequest;

  const { socketFactory, scheduler, url, legendMatch } = options;

  /**
   * One abortable pass. Unmount aborts it, or a `POST /rooms` left in flight creates an orphan table.
   */
  const prepare = useCallback(
    (fresh: boolean, request: CreateRoomRequest = BOT_TABLE_REQUEST) => {
      setupRef.current?.abort();
      setResuming(false);
      setPhase('preparing');
      setSetupError(null);
      const controller = new AbortController();
      setupRef.current = controller;
      void (async (): Promise<void> => {
        try {
          const session = await ensureSession(controller.signal);
          setDisplayName(session.user.displayName);
          const opened = await openPracticeRoom(session, request, legendMatch, fresh, controller.signal);
          if (controller.signal.aborted) return;
          rememberRoom(opened.room.id);
          dispatch({ kind: 'reset' });
          setInviteCode(opened.inviteCode);
          setJoin({ state: 'idle' });
          setRoomId(opened.room.id);
          setPhase('ready');
        } catch (cause) {
          if (controller.signal.aborted) return;
          setSetupError(refusalSentence(cause));
          setPhase('failed');
        }
      })();
    },
    [legendMatch],
  );

  useEffect(() => () => setupRef.current?.abort(), []);

  /**
   * Reconnects on return to `/play` (UI audit of 308fadf, item 15). It only reconnects. No guest is
   * minted and no other room is created or chosen. Never on a Legends page, where the press opens the
   * match. Runs in an effect because `sessionStorage` is absent on the server and would mismatch
   * hydration. `dealIn` stays `off`, since the reader may be mid-hand.
   */
  useEffect(() => {
    if (legendMatch !== undefined) return;
    const remembered = rememberedRoom();
    if (remembered === null) return;
    const controller = new AbortController();
    setupRef.current = controller;
    setResuming(true);
    void (async (): Promise<void> => {
      try {
        const resumed = await resumeRememberedTable(remembered, controller.signal);
        if (controller.signal.aborted) return;
        if (resumed === null) {
          // The remembered table is unreachable now. Forget it so the next press does not aim at it.
          rememberRoom(null);
          return;
        }
        setDisplayName(resumed.session.user.displayName);
        dispatch({ kind: 'reset' });
        setInviteCode(null);
        setJoin({ state: 'idle' });
        setRoomId(resumed.room.id);
        setPhase('ready');
      } catch {
        // A failed reconnect leaves the first-visit page, and "Deal me in" retries with its own errors.
      } finally {
        // Only this pass's flag. A press meanwhile cleared it, and the dev double-mount runs a second
        // pass before the first one's `finally`.
        if (setupRef.current === controller) setResuming(false);
      }
    })();
    return () => controller.abort();
  }, [legendMatch]);

  const start = useCallback((): void => {
    if (phase === 'preparing' || phase === 'ready') return;
    setDealIn('wantSeat');
    prepare(false);
  }, [phase, prepare]);

  const buildFresh = useCallback(
    (request: CreateRoomRequest): void => {
      socketRef.current?.dispose();
      socketRef.current = null;
      setDealIn('off');
      setRoomId(null);
      setStatus(null);
      setClosed(null);
      setInviteCode(null);
      setJoin({ state: 'idle' });
      rememberRoom(null);
      prepare(true, request);
    },
    [prepare],
  );

  const startFreshTable = useCallback((): void => buildFresh(BOT_TABLE_REQUEST), [buildFresh]);

  /** Never reuses a room, because a code is issued once, only on creation. */
  const startPrivateTable = useCallback(() => buildFresh(FRIENDS_TABLE_REQUEST), [buildFresh]);

  /**
   * Session (often a new guest), then `POST /rooms/join`, then the socket. Shares `setupRef`, so the
   * later of a join and a fresh table wins. A refusal shows the server's own words, and the open
   * socket is untouched until the join succeeds.
   */
  const joinByInviteCode = useCallback((code: string): void => {
    const normalised = normaliseInviteCode(code);
    if (normalised === null) {
      // Below eight characters nothing could match, so spend no rate-limit token.
      setJoin({
        state: 'refused',
        message:
          'That is not a complete invite code. They are nineteen characters in four groups, like ' +
          'ABCD-EFGH-JKMN-PQRS — spaces and lower case are fine, and are tidied up for you.',
      });
      return;
    }

    setupRef.current?.abort();
    setResuming(false);
    const controller = new AbortController();
    setupRef.current = controller;
    setDealIn('off');
    setJoin({ state: 'joining' });
    setSetupError(null);
    setPhase('preparing');
    void (async (): Promise<void> => {
      try {
        const session = await ensureSession(controller.signal);
        setDisplayName(session.user.displayName);
        const room = await joinRoomByInviteCode(session.csrfToken, normalised, controller.signal);
        if (controller.signal.aborted) return;
        socketRef.current?.dispose();
        socketRef.current = null;
        setStatus(null);
        setClosed(null);
        // Not this session's code; it was issued to the room's creator.
        setInviteCode(null);
        rememberRoom(room.id);
        dispatch({ kind: 'reset' });
        setJoin({ state: 'joined', roomName: room.name });
        setRoomId(room.id);
        setPhase('ready');
      } catch (cause) {
        if (controller.signal.aborted) return;
        // Not `failed`. A wrong code must not throw away a table the reader may be sitting at.
        setPhase(socketRef.current === null ? 'idle' : 'ready');
        setJoin({ state: 'refused', message: refusalSentence(cause) });
      }
    })();
  }, []);

  /**
   * The socket's lifetime, tied to one room id. Strict mode's double run in development is what
   * would expose a leak as a second socket.
   */
  useEffect(() => {
    if (roomId === null) return;
    const target = url ?? tableSocketUrl(window.location);
    const handle = openTableSocket({
      roomId,
      url: target,
      onStatus: setStatus,
      onClose: setClosed,
      onProblem: (message) => console.warn(`[table-socket] ${message}`),
      /**
       * Most dropped frames are repaired by the next whole `state`. A dropped `coach` frame is not.
       * A hole-card refusal is logged with `console.error`, unfenced by `NODE_ENV`, so it shows in a
       * support screenshot, and `dataRefusal` tells the person at the table.
       */
      onRejected: (rejection) => {
        const unentitled = rejection.unentitledSeats;
        if (unentitled !== undefined && unentitled.length > 0) {
          console.error(`[table-socket] refused a state frame: ${rejection.reason}`);
          dispatch({ kind: 'dataRefused', seats: unentitled });
          return;
        }
        if (rejection.claimedType !== 'coach') return;
        dispatch({ kind: 'coachFailed', reason: rejection.reason });
      },
      onFrame: (frame) => {
        dispatch({ kind: 'frame', frame });
        // A reconnect replays an unanswered decision unchanged; the server dedupes by `actionId`.
        if (frame.type === 'welcome') {
          const replay = pendingRef.current;
          if (replay !== null) handle.action(replay);
          /**
           * A Coach request dies with its socket, since the server matches `requestId` per connection.
           * Without dropping the memo, the panel sat on "No analysis" forever after a reconnect
           * (measured in Chrome 151 by dropping one `coach` frame and closing the socket).
           * `coachRequestRef` still holds the pre-`welcome` value here because refs are assigned in
           * render. Guarded so a reconnect does not re-ask for an analysis already on screen.
           */
          if (coachRequestRef.current !== null) coachAskedRef.current = null;
        }
      },
      ...(socketFactory === undefined ? {} : { socketFactory }),
      ...(scheduler === undefined ? {} : { scheduler }),
    });
    socketRef.current = handle;
    return () => {
      handle.dispose();
      socketRef.current = null;
    };
  }, [roomId, url, socketFactory, scheduler]);

  /**
   * The seat already held, or the first free one. Seat 0 is the owner's at an invited table. Null
   * means full, and the control is hidden.
   */
  const readerSeat = useMemo<number | null>(() => {
    if (table.room === null || table.userId === null) return READER_SEAT;
    return firstFreeSeat(table.room, table.userId);
  }, [table.room, table.userId]);

  const sit = useCallback((): void => {
    if (readerSeat === null) return;
    socketRef.current?.sit(readerSeat, newRequestId('sit'));
  }, [readerSeat]);

  const stand = useCallback((): void => {
    socketRef.current?.stand(newRequestId('stand'));
  }, []);

  const deal = useCallback((): void => {
    socketRef.current?.startHand(newRequestId('deal'));
  }, []);

  const dealInLive = phase === 'ready' && status === 'live';
  const { seat: dealInSeat, betweenHands, notice, revision, room: dealInRoom, userId: dealInUser } = table;
  /**
   * One step per commit (see `DealIn`). The send's outcome is read, not assumed, because a send that
   * did not go out will never be confirmed and would hide the manual buttons for good.
   */
  useEffect(() => {
    const { next, send } = dealInStep(dealIn, {
      live: dealInLive,
      table: { seat: dealInSeat, betweenHands, notice, revision, room: dealInRoom, userId: dealInUser },
      readerSeat,
    });
    let after = next;
    if (send !== null) {
      const handle = socketRef.current;
      const outcome =
        handle === null
          ? null
          : send.kind === 'sit'
            ? handle.sit(send.seat, newRequestId('sit'))
            : handle.startHand(newRequestId('deal'));
      if (outcome !== 'sent') after = 'off';
    }
    if (after !== dealIn) setDealIn(after);
  }, [dealIn, dealInLive, dealInSeat, betweenHands, notice, revision, dealInRoom, dealInUser, readerSeat]);

  const act = useCallback((action: TableAction): void => {
    const view = viewRef.current;
    const handle = socketRef.current;
    if (view === null || handle === null) return;
    // One id per decision, minted once. A retry with a new id is a second bet.
    const pending: PendingDecision = {
      action,
      actionId: newRequestId('act'),
      expectedSequence: view.actionSequence,
      requestId: newRequestId('req'),
    };
    // Sent BEFORE the dispatch, which carries the outcome, because `sendRaw` cannot be asked later
    // whether the socket was null or throttled.
    dispatch({ kind: 'submit', pending, delivery: handle.action(pending) });
  }, []);

  const view = table.view;
  // The reducer's own predicate, so live buttons and the turn announcement never disagree.
  const isMyTurn = isViewersTurn(view, table.betweenHands);
  const key = decisionKey(view);

  const askCoach = useCallback((): void => {
    const handle = socketRef.current;
    if (handle === null) return;
    const requestId = newRequestId('coach');
    const asked = decisionKey(viewRef.current);
    // Sent before the dispatch, as in `act`, so a refused request does not open a pending one.
    const delivery = handle.requestCoach(requestId);
    coachAskedRef.current = asked;
    if (delivery === 'rate-limited' || delivery === 'undeliverable') {
      // No automatic retry. Nothing holds the request, and a re-ask would spend another token.
      dispatch({ kind: 'coachFailed', reason: COACH_NOT_SENT[delivery] });
      return;
    }
    // `disconnected` stays open, since the `welcome` handler drops `coachAskedRef` and the effect asks again.
    dispatch({ kind: 'coachRequested', requestId, key: asked });
  }, []);

  /** Legends Expert is checked first, since this page chose that difficulty itself. See `CoachOff`. */
  const coachOff: CoachOff | null =
    options.legendMatch?.difficulty === 'expert'
      ? { kind: 'expertLegends' }
      : table.coachRefusal !== null
        ? { kind: 'refusedByServer', serverReason: table.coachRefusal }
        : null;
  const coachDuringHand = coachOff === null && table.coachDuringHand;

  /**
   * A dependency, not a ref read, so the effect re-runs after a reconnect clears the dead request
   * while `isMyTurn` and `key` are unchanged. It also stops overlapping asks against the server's
   * thirty Coach requests a minute. The effect asks once per decision, keyed on the spot.
   */
  const coachOutstanding = table.coachRequest !== null;

  useEffect(() => {
    if (!coachDuringHand) return;
    if (!isMyTurn || key === '') return;
    if (coachOutstanding) return;
    if (coachAskedRef.current === key) return;
    askCoach();
  }, [coachDuringHand, isMyTurn, key, coachOutstanding, askCoach]);

  const { deadlineMs, serverTimeMs, turnBudgetMs, room } = table;
  const turn = useMemo<TurnClock | null>(
    () => turnClockFor({ deadlineMs, serverTimeMs, turnBudgetMs, room, betweenHands }),
    [deadlineMs, serverTimeMs, turnBudgetMs, room, betweenHands],
  );

  /**
   * Once per settled hand the reader was dealt into, the header is told to re-read the session.
   * The API writes stacks on its archive queue after broadcasting the final frame, measured 12-34ms
   * later, so an immediate ask trailed by one hand. Hence `SETTLED_ASK_MS`, plus a retry for a slow
   * queue. A still-stale answer just keeps the figure the pill already showed.
   */
  const settledHand =
    view !== null && view.street === 'complete' && view.viewerSeat !== null ? view.handId : null;
  // The timers outlive the hand, so pressing Deal does not cancel the re-read. Only unmount clears them.
  const settleTimers = useRef<number[]>([]);
  useEffect(() => {
    if (settledHand === null || typeof window === 'undefined') return;
    for (const ms of [SETTLED_ASK_MS, SETTLED_RETRY_MS]) {
      settleTimers.current.push(window.setTimeout(notifySessionChanged, ms));
    }
  }, [settledHand]);
  useEffect(
    () => () => {
      for (const timer of settleTimers.current) window.clearTimeout(timer);
    },
    [],
  );

  const seatNames = useMemo(() => namesFor(table.room), [table.room]);
  const highlightedCards = useMemo(() => winningCards(view), [view]);
  const report = table.coach !== null && table.coach.key === key ? table.coach.report : null;

  return {
    phase,
    resuming,
    status,
    closed,
    setupError,
    displayName,
    inviteCode,
    join,
    table,
    turn,
    report,
    coachProblem: table.coachProblem,
    coachOff,
    seatNames,
    highlightedCards,
    isMyTurn,
    readerSeat,
    dealingIn: dealIn !== 'off',
    outOfUnits: outOfUnits(table),
    start,
    startFreshTable,
    startPrivateTable,
    joinByInviteCode,
    sit,
    stand,
    deal,
    act,
    askCoach,
  };
}

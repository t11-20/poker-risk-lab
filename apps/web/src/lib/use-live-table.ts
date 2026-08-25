'use client';

/**
 * The live table as React state: one reducer over the server's frames, and the five verbs a reader
 * has.
 *
 * ## The rule this module exists to keep
 *
 * **Everything on screen came from a frame.** No cards, no stacks, no pot, no turn order and no
 * legality is computed here. When the reader clicks Call, this sends an `action` frame and waits;
 * it does not move a chip. That is not caution, it is the only way a client can be correct: a
 * client that guessed the result of its own action would disagree with the table it is drawing the
 * first time the server saw the spot differently — a timed-out seat, a side pot, a raise that came
 * in while the click was in flight.
 *
 * The one thing derived rather than received is which buttons are *enabled*, and it is derived from
 * `view.legalActions` — the server's own list, with the server's own bounds. `ActionBar` clamps
 * every size into those bounds, so no control here can propose an amount the server did not offer.
 *
 * ## Idempotency: one id per decision, not one per attempt
 *
 * A decision mints exactly one `actionId` and keeps it. If the socket drops between `action` and
 * `ack`, the reconnect replays the *same* frame — same `actionId`, same `expectedSequence`, same
 * `requestId` — and the server answers `ack { deduplicated: true }` with the original outcome
 * standing. Minting a fresh id on retry would turn a dropped response into a second bet, which is
 * the exact failure `actionId` exists to prevent.
 *
 * ## Sequencing: the spot you saw, or nothing
 *
 * `expectedSequence` is the `actionSequence` of the view the button was drawn from. If the hand
 * moved on — a turn timer fired, another seat acted — the server answers `stale_action_sequence`
 * and applies nothing. The reader is told the spot changed rather than having their fold land on a
 * street they never saw.
 *
 * ## "Not sent" is three different sentences, and saying the wrong one is a defect
 *
 * A decision can fail to leave the browser for reasons that mean opposite things to the reader: the
 * connection is down and the decision is held and replayed, or this page's own rate limiter refused
 * it and nothing will send it. `sendRaw` used to answer both with `false`, so this file reported the
 * rate limit for a decision that was refused because there was no socket — while the panel beside it
 * said "Decision sent". `SendOutcome` is what that `false` became; `SUBMISSION_FOR` is the sentence
 * per outcome, and `act` dispatches the outcome rather than assuming one.
 *
 * ## Reconnect is "render the current view"
 *
 * State is sent whole, so there is no catch-up protocol and nothing to resynchronise: the socket
 * reconnects, `hello` goes out, `welcome` and a full `state` come back, and the table is right
 * again. `revision` is monotonic per socket, so a frame that arrives out of order is dropped; it
 * restarts at zero on each new socket, which is why `welcome` resets it here.
 *
 * ## Announcements are diffed here, because here is the only place the PREVIOUS frame exists
 *
 * ADR 0009 sends state whole: every `state` frame carries the entire table, changed or not. A live
 * region fed from a whole-state frame therefore fires on every frame, and a screen reader that says
 * "pot 300 units, your stack 950 units" four times a second is worse than one that says nothing —
 * the reader turns it off, and then the announcements that mattered are gone too.
 *
 * So what is announced is computed by comparing the incoming frame with the state it replaces, and
 * the reducer is the only place both exist at once. `turnAnnouncement` is the case that made this
 * necessary: whose decision it is, is the single most important fact at a table (`Seat.tsx` marks it
 * three ways visually) and it was announced by nothing at all. It is set on the EDGE — the frame
 * where the decision becomes the reader's — and carried unchanged for as long as it stays theirs, so
 * the region speaks once per turn rather than once per frame.
 */

import type { CoachReport, CreateRoomRequest, ErrorCode, RoomSummary, WsServerMessage } from '@prl/contracts';
import type { PlayerView, TableAction, TurnClock } from '@prl/ui';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { TableSubmission } from '@/components/TableStage.tsx';
import { ApiRequestError } from './api.ts';
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

/** Where the tab remembers its room, so a reload rejoins instead of creating another table. */
const ROOM_STORAGE_KEY = 'prl.play.roomId';

function rememberRoom(roomId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (roomId === null) window.sessionStorage.removeItem(ROOM_STORAGE_KEY);
    else window.sessionStorage.setItem(ROOM_STORAGE_KEY, roomId);
  } catch {
    // Storage can be disabled or full. Losing the memory costs one extra room, not correctness.
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

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/** A decision that has been sent and not yet answered. Replayed unchanged across a reconnect. */
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
  /** The last view the server sent. Kept between hands so a finished hand stays readable. */
  readonly view: PlayerView | null;
  /** True when the most recent `state` carried `view: null` — no hand is in progress. */
  readonly betweenHands: boolean;
  readonly deadlineMs: number | null;
  readonly serverTimeMs: number;
  /** Monotonic per socket; resets on `welcome`. */
  readonly revision: number;
  readonly announcement: string;
  /**
   * A sentence that has been produced and deliberately not written into the region yet, because the
   * event that produced it arrives in the same table notice as the one after it.
   *
   * Empty except between `handStarted` and the forced bets that always follow it in the same table
   * notice, which is microseconds. See `onEventFrame` for the measurement this exists because of:
   * two writes into one atomic polite region for one notice are one announcement, and it is the
   * second one, so the first is never spoken at all.
   */
  readonly carried: string;
  /**
   * One sentence for the region that announces the reader's OWN decision being due.
   *
   * Separate from `announcement`, which narrates the table, because the two are different kinds of
   * news and they race: a `state` frame and the `event` frame describing the same change arrive back
   * to back, in an order this client does not control, so a single field would let "seat 3 called 50
   * units" overwrite "your turn" — or the reverse — depending on which landed second. Empty whenever
   * it is not this seat's decision, which is what lets the same sentence be announced again next time
   * round.
   */
  readonly turnAnnouncement: string;
  readonly summary: readonly string[];
  /**
   * The report, with the decision it was computed for. Never rendered against a different one.
   *
   * `key` is the spot the request was SENT for, carried through the round trip in `coachRequest`
   * below — not the spot on screen when the answer landed. Those are routinely different, and the
   * difference is the whole reason this field is a pair rather than a report: see `onCoachFrame`.
   */
  readonly coach: { readonly key: string; readonly report: CoachReport } | null;
  /**
   * The outstanding request: its id, and the decision it asked about.
   *
   * One object rather than two fields, because the two must never be apart. A `coach` frame carries
   * a `requestId` and nothing else — no hand id, no sequence — so the only record of what the
   * server is computing is the one this client kept when it asked.
   */
  readonly coachRequest: { readonly requestId: string; readonly key: string } | null;
  /** Why there is no analysis, when the reason is something other than "none was asked for". */
  readonly coachProblem: string | null;
  /**
   * False when this table has turned live Coach off (Expert Legends, or a `coach_not_available`
   * refusal). Default true: private tables and educational/realistic matches keep the panel.
   */
  readonly coachDuringHand: boolean;
  readonly pending: PendingDecision | null;
  readonly submission: TableSubmission | null;
  /** The server's own wording for the last refusal that was not about a decision. */
  readonly notice: string | null;
  /**
   * The contract code that refusal came with, so the UI can say more than "the server refused
   * something" when it has something more to say.
   *
   * Kept beside `notice` rather than parsed back out of it. `notice` is prose meant for a person
   * and its wording is allowed to change; the code is the contract, and a screen that branches on
   * a substring of a sentence breaks the first time somebody improves the sentence.
   *
   * Exactly one branch reads it today — `enrolment_required`, which needs a heading and a next
   * step rather than a generic refusal panel (see `ConnectionNotices` in `app/play/LiveTable.tsx`).
   * Every other code keeps the general treatment, which is right: a seat somebody else took a
   * moment ago needs no explanation beyond the sentence.
   */
  readonly noticeCode: ErrorCode | null;
}

export const EMPTY_TABLE_STATE: TableState = {
  room: null,
  userId: null,
  seat: null,
  view: null,
  betweenHands: true,
  deadlineMs: null,
  serverTimeMs: 0,
  revision: 0,
  announcement: '',
  carried: '',
  turnAnnouncement: '',
  summary: [],
  coach: null,
  coachRequest: null,
  coachProblem: null,
  coachDuringHand: true,
  pending: null,
  submission: null,
  notice: null,
  noticeCode: null,
};

export type TableEvent =
  | { readonly kind: 'frame'; readonly frame: WsServerMessage }
  /**
   * A decision the reader made, with what the socket did with it.
   *
   * `delivery` is not optional and has no default on purpose: it is the answer to "did this
   * actually go out", and the caller is the only one who knows. A default would restore the
   * assumption the old code made — that dispatching this means the frame was sent — which is the
   * defect `SUBMISSION_FOR` is written against.
   */
  | { readonly kind: 'submit'; readonly pending: PendingDecision; readonly delivery: SendOutcome }
  | { readonly kind: 'coachRequested'; readonly requestId: string; readonly key: string }
  | { readonly kind: 'coachFailed'; readonly reason: string }
  | { readonly kind: 'notice'; readonly message: string | null; readonly code?: ErrorCode | null }
  | { readonly kind: 'reset' };

/** Identifies one decision: a hand, and the point in it the view was drawn at. */
export function decisionKey(view: PlayerView | null): string {
  return view === null ? '' : `${view.handId}:${String(view.actionSequence)}`;
}

/** The seat the server says this user holds, read from the room roster rather than remembered. */
function seatFrom(room: RoomSummary, userId: string | null): number | null {
  if (userId === null) return null;
  return room.members.find((member) => member.userId === userId)?.seat ?? null;
}

/**
 * Is the decision in this view the reader's?
 *
 * Exported and pure so the reducer, the hook and a test all decide it the same way. It used to be
 * written out inline in the hook only, which is why the reducer had no way to notice the moment it
 * became true — and that moment is the one thing a screen-reader user most needs to be told.
 *
 * `legalActions.length > 0` is part of the definition rather than a belt-and-braces extra: the
 * server empties that list for everybody it is not currently asking, so a view where it is empty is
 * a view with no decision in it whatever `toAct` says.
 */
export function isViewersTurn(view: PlayerView | null, betweenHands: boolean): boolean {
  if (view === null || betweenHands) return false;
  return view.viewerSeat !== null && view.toAct === view.viewerSeat && view.legalActions.length > 0;
}

/**
 * A number of units, as it should be read aloud.
 *
 * A local formatter and not `formatUnits` from `@prl/ui`, and the reason is mechanical rather than
 * stylistic: `@prl/ui` is consumed as SOURCE (its `exports` map points at `src/index.ts`, there is
 * no build output) and that entry re-exports every component, including `.tsx` files. Node's
 * type-stripping handles `.ts` and not `.tsx`, so one runtime import of `@prl/ui` anywhere in this
 * module's graph makes the whole module unloadable under `node --test` with
 * `ERR_UNKNOWN_FILE_EXTENSION`. `tableReducer` is driven for real by `test/live-regions.test.ts`,
 * and a reducer that cannot be imported cannot be tested — which is a worse outcome than four lines
 * of formatting living here.
 *
 * It is deliberately NOT a promise of byte-identical output with the panel's figures. What it owes
 * is that the sentence reads correctly: a thousands separator so "1505" is not read as a digit
 * string, and the singular where the plural would be wrong.
 */
function units(value: number): string {
  const whole = Math.round(value);
  return `${new Intl.NumberFormat('en-GB').format(whole)} ${Math.abs(whole) === 1 ? 'unit' : 'units'}`;
}

/** "fold, call or raise". No Oxford comma, because this is read aloud rather than printed. */
function listActions(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1] ?? ''}`;
}

/** How to name the street in a sentence. `preflop` is an adverb; the rest take an article. */
function streetPhrase(street: PlayerView['street']): string {
  if (street === 'preflop') return 'preflop';
  if (street === 'showdown' || street === 'complete') return 'at the end of the hand';
  return `on the ${street}`;
}

/**
 * What the reader is told, once, when the decision becomes theirs.
 *
 * ## Why one sentence and not four regions
 *
 * What a screen-reader user needs at this moment is what the layout guarantees a sighted one
 * (`TableStage`'s module comment, guarantees 1 to 4): the pot, the price, what they have behind, and
 * what they may do. Four live regions for four figures would announce them in whatever order the
 * regions happened to update, interleaved with the table's narration. One sentence, fired on the
 * edge, arrives in the order a decision is actually made in.
 *
 * It deliberately does NOT include the hole cards. They are already in the accessibility tree with
 * their full names, on the seat plate and in the decision band's own readout, and repeating them
 * every turn makes the sentence long enough that a reader starts talking over it. The figures are
 * what change from turn to turn; the cards are not.
 *
 * No equity figure either, for the reason given in the `coach` case of `onFrame`: a number read out
 * of the Coach panel has left the assumptions it rests on behind.
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
 * The echo of the reader's own decision, for the table's polite region.
 *
 * It belongs in the reducer rather than beside the markup, and that is a fix rather than a tidy-up.
 * `TableStage` used to PREFIX this phrase onto every announcement it passed down, so the region's
 * text stayed "You chose to fold. …" for as long as the submission was on screen — and because
 * `role="status"` is atomic, every subsequent table event was then read out with "You chose to
 * fold." stapled to the front of it. Announced as a state change here, it is said once and replaced
 * by whatever the table says next.
 */
export function spokenDecision(action: TableAction): string {
  if (action.type === 'bet' || action.type === 'raise') {
    return `You chose to ${action.type} to ${units(action.to)}.`;
  }
  return `You chose to ${action.type}.`;
}

/**
 * The two sentences the Coach contributes to the table's polite live region.
 *
 * Exported so a test can assert the reducer produces exactly these, rather than asserting a string
 * literal it has copied — a test that carries its own copy of the text passes after somebody
 * deletes the announcement and pastes the sentence into the test.
 *
 * Neither one carries a number. See `onCoachFrame` for why.
 */
export const COACH_READY_ANNOUNCEMENT =
  'The analysis of this decision is ready in the Coach panel, below the table on a narrow screen.';
export const COACH_FAILED_ANNOUNCEMENT = 'The analysis could not be shown.';

/**
 * What a reader is told when a hand starts, and it is not announced on its own.
 *
 * Exported so a test asserts the sentence the reducer produces rather than carrying its own copy —
 * the same reason `COACH_READY_ANNOUNCEMENT` is exported.
 */
export const DEAL_ANNOUNCEMENT = 'A new hand was dealt.';

/** One sentence for the table's single polite live region. */
function announce(event: Extract<WsServerMessage, { type: 'event' }>['event']): string {
  switch (event.kind) {
    case 'handStarted':
      return DEAL_ANNOUNCEMENT;
    case 'forcedBets':
      return event.detail;
    case 'action':
      return `${event.description}${event.wasAutomatic ? ' (the clock ran out, so the server acted)' : ''}`;
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
      return `Seat ${String(event.seat + 1)} ran out of time and the server acted for it.`;
    default:
      return '';
  }
}

/**
 * ## Why the deal does not take the region on its own
 *
 * `handStarted` and `forcedBets` are two events of ONE table notice: `apps/api/src/ws/router.ts`
 * writes every event of a notice back to back into the same socket, and `packages/poker-engine`'s
 * `machine.ts` pushes `forcedBetsPosted` unconditionally in the same `startHand` call that pushes
 * `handStarted`. So the deal sentence and the blinds sentence are always produced microseconds
 * apart into one atomic polite region — and a polite region is read when the platform services its
 * notification, not when the write happens. Two writes for one notice are one announcement, and it
 * is the second one.
 *
 * "A new hand was dealt." was therefore never heard. That is assertion 3.3 of
 * `docs/production/accessibility-certification.md`, filed there as something only a person could
 * judge, and it is a defect. Measured in Chrome 151 by `scripts/ax-assertions.mjs`, on a hand
 * played through the product's own screens:
 *
 *   - before the region moved out of `PokerTable`, the table had no narration region at all at the
 *     moment "Deal the next hand" was pressed, so the sentence arrived inside the node that held
 *     it and nothing was notified of anything;
 *   - with the region mounted but the deal still writing on its own, the region took two writes for
 *     the one notice — "A new hand was dealt.", then "smallBlind 5 from seat 3, bigBlind 10 from
 *     seat 4" — the same loss, now visible to a probe;
 *   - as it stands, one write: "A new hand was dealt. smallBlind 5 from seat 3, bigBlind 10 from
 *     seat 4."
 *
 * So `handStarted` writes no sentence of its own. It leaves one to be CARRIED onto the front of the
 * first thing the hand says, which is the forced bets.
 *
 * Carrying rather than writing-then-appending is the whole point, and it is what keeps this from
 * becoming the opposite defect: an implementation that wrote the deal and then appended the blinds
 * would say the deal twice whenever the two frames landed in separate commits. This one produces
 * exactly one write however they arrive, so there is no timing under which a reader hears it twice.
 * `role="status"` is atomic, and 3.17 is the assertion that catches a sentence left stapled to the
 * front of everything after it.
 */
function onEventFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'event' }>): TableState {
  if (frame.event.kind === 'handStarted') {
    // No `announcement` here on purpose: leaving the region exactly as it is means this dispatch
    // mutates nothing, so a `handStarted` that did arrive in a commit of its own cannot re-announce
    // the previous hand's last sentence either.
    return { ...state, carried: announce(frame.event), summary: [] };
  }
  const sentence = announce(frame.event);
  const announcement = state.carried === '' ? sentence : `${state.carried} ${sentence}`;
  if (frame.event.kind === 'showdown' || frame.event.kind === 'handComplete') {
    return { ...state, announcement, carried: '', summary: frame.event.summaries };
  }
  return { ...state, announcement, carried: '' };
}

function onStateFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'state' }>): TableState {
  // Monotonic per socket. A frame that arrived out of order describes a table that has already
  // moved on, and applying it would draw the past over the present.
  if (frame.revision <= state.revision) return state;

  const view = frame.view ?? state.view;
  const key = decisionKey(view);
  const movedOn = key !== decisionKey(state.view);
  // The server's own rule, mirrored exactly: `LiveTable.handInProgress` in `rooms/table.ts` is
  // `street !== undefined && street !== 'complete'`. Reading it as "the frame carried no view"
  // instead is wrong and was a real defect: a finished hand is still sent — with its cards, its
  // pot and its result — so `view` stays non-null after the hand is over, and "Deal the next
  // hand" stayed disabled forever from the first completed hand onwards.
  const betweenHands = frame.view === null || frame.view.street === 'complete';
  // The edge, not the level. Carried unchanged while the decision stays the reader's, so a burst of
  // whole-state frames cannot re-announce a turn they are already in the middle of.
  const wasTurn = isViewersTurn(state.view, state.betweenHands);
  const nowTurn = isViewersTurn(view, betweenHands);
  const turnAnnouncement =
    nowTurn && view !== null ? (wasTurn ? state.turnAnnouncement : turnAnnouncementFor(view)) : '';
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
    // An analysis belongs to the spot it was computed for. The moment the spot changes it is
    // dropped rather than left on screen beside different numbers — and so is the reason the last
    // one could not be shown, which described a different spot too.
    coach: state.coach !== null && state.coach.key === key ? state.coach : null,
    coachProblem: movedOn ? null : state.coachProblem,
    // The request goes with the spot, and this line is half of a real defect's fix.
    //
    // Dropping the report above was never enough on its own: it runs when the frame that MOVES the
    // spot arrives, and the analysis of the spot just left is still being computed at that moment
    // — on a worker thread, with a three-second budget. It lands afterwards, against a table that
    // has moved on. Leaving the request open let that late frame in, and `onFrame` then filed it
    // under whatever was on screen. Closing the request here means a late answer is discarded for
    // the same reason an answer to a request nobody made is: nothing is waiting for it.
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
  const applied = frame.appliedSequence;
  const detail =
    frame.deduplicated === true
      ? 'This decision had already been applied, so the server counted the retry as the same one. ' +
        'Nothing was staked twice.'
      : `The server applied it${applied === undefined ? '' : ` at sequence ${String(applied)}`}.`;
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
      announcement: reviewOnly
        ? 'The Coach is off during this hand. It is available in review afterwards.'
        : `${COACH_FAILED_ANNOUNCEMENT} ${frame.error.message}`,
    };
  }
  const pending = state.pending;
  if (pending === null || pending.requestId !== frame.requestId) {
    return { ...state, notice: `${frame.error.message} (${frame.error.code})`, noticeCode: frame.error.code };
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
        : `${frame.error.message} (${frame.error.code}). Nothing was applied.`,
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
        // Per socket, so a reconnect starts the ordering again from zero.
        revision: 0,
        notice: null,
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
 * Files an analysis under the decision it was COMPUTED for, or drops it.
 *
 * ## The defect this is written against
 *
 * This used to key the report on `decisionKey(state.view)` — the spot on screen at the moment the
 * frame arrived — while the key that was actually asked about travelled in the `coachRequested`
 * action and was read by nothing. The two are routinely different: the server computes on a worker
 * thread with a three-second budget, and a `coach` frame carries a `requestId` and nothing else, so
 * there is no hand id and no sequence in the answer to re-derive it from.
 *
 * What that cost a reader: the turn opens at `hand-1:7` and the effect below asks automatically;
 * the reader folds; the hand ends; the last `state` frame of the hand lands at `hand-1:11`; the
 * analysis arrives after it and was keyed `hand-1:11`. `CoachPanel` then printed "flop · 100 units
 * in the pot · 35 to call" beside a finished hand whose pot was 1,505 and whose price to call was
 * 0 — and since no further `state` frame arrives until the reader deals again, it stayed there. The
 * hook's `coach.key === decisionKey(view)` guard could not catch it, because the key had already
 * been rewritten to the value that guard compares against.
 *
 * Two guards now, and they are not redundant: `onStateFrame` closes the request the moment the spot
 * changes, so a late frame is usually discarded before it gets here; and if one arrives against a
 * spot that changed without a `state` frame, it is refused here rather than re-keyed. Dropping it
 * is the honest outcome — nothing is on screen to describe, and the reader is between hands.
 */
function onCoachFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'coach' }>): TableState {
  const request = state.coachRequest;
  if (request === null || request.requestId !== frame.requestId) return state;
  // Closed either way: this request has been answered, and no second answer is coming for it.
  if (request.key !== decisionKey(state.view)) return { ...state, coachRequest: null };
  return {
    ...state,
    coach: { key: request.key, report: frame.report },
    coachRequest: null,
    coachProblem: null,
    // The analysis ARRIVING is news, and it was silent. The panel fills in beside the
    // buttons with no announcement at all, and below 600px it is not even on screen —
    // `styles/play.css` makes it a bottom sheet that starts collapsed, so a reader who
    // cannot see the panel had no way to learn the thing they are waiting for is there.
    //
    // The same event is already announced correctly one screen away, in
    // `ScenarioStage.tsx`'s reveal region, and this is that pattern rather than a new one:
    // one short sentence, in the polite region the table already owns, saying WHERE the
    // analysis is rather than what it says. It must not carry a figure — a number read out
    // of the panel it came from has lost the assumptions it rests on, which is the one
    // thing this product refuses to do with a number.
    //
    // Only on the path that actually fills the panel. A report that is dropped above changes
    // nothing on screen, and announcing it would send a reader to look for a panel that never
    // filled.
    announcement: COACH_READY_ANNOUNCEMENT,
  };
}

/**
 * What became of a decision, as one sentence per fate — and only one.
 *
 * ## The defect this table exists for
 *
 * There used to be a single sentence here, "Sent. The server is the only authority…", written on
 * the assumption that dispatching `submit` meant the frame had gone out. It did not. `sendRaw`
 * refuses a frame when the client's own token bucket is empty AND when there is no socket at all,
 * and `socket` is null for the whole reconnect backoff — up to fifteen seconds — during which
 * `stageStatusOf` still reports `ready`, so the controls are live and a reader does press Fold.
 * They were then told their decision had been sent, and simultaneously, in a `role="alert"`, that
 * "this page is refusing to exceed the socket rate limit" — a cause that was not the cause, beside
 * a conclusion that was not true either, because the decision was replayed on reconnect and
 * applied.
 *
 * Four fates, four sentences, and each says what the reader can do about it. `held` is the one
 * worth reading twice: nothing has been sent, but the decision is not lost — `onFrame` replays it
 * on the next `welcome` with the same `actionId`, so the server applies it once or answers
 * `deduplicated`, and there is nothing for the reader to do but wait.
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
 * The fates a decision is still going to be sent under.
 *
 * `pending` is what the reconnect replays and what disables the controls, so it is kept for exactly
 * these two and dropped for the rest. Keeping it after a refusal nothing will retry leaves the
 * table disabled forever against a decision that is never coming back.
 */
const WILL_STILL_BE_SENT: ReadonlySet<SendOutcome> = new Set<SendOutcome>(['sent', 'disconnected']);

export function tableReducer(state: TableState, event: TableEvent): TableState {
  switch (event.kind) {
    case 'frame':
      return onFrame(state, event.frame);
    case 'submit':
      return {
        ...state,
        // Kept only while something is still going to send it. See `SUBMISSION_FOR`.
        pending: WILL_STILL_BE_SENT.has(event.delivery) ? event.pending : null,
        // The echo, as a state change rather than a prefix. See `spokenDecision`.
        //
        // Said whatever became of the frame, because it describes the reader's own choice rather
        // than the table's response to it — and the response is in `submission`, one region over.
        //
        // `turnAnnouncement` is deliberately left alone. Clearing it here would look tidy and would
        // cost the reader the one case that matters: a decision the server REFUSES leaves the spot
        // exactly as it was, and an emptied region has nothing left to re-announce it with. Carried
        // as it is, the sentence does not change, so nothing is said twice either.
        announcement: spokenDecision(event.pending.action),
        submission: SUBMISSION_FOR[event.delivery](event.pending.action),
        // The refusal is the submission, and only the submission.
        //
        // This is the second half of a real defect. `act` used to dispatch a `notice` as well, so a
        // reader who pressed Fold during a reconnect got a polite "Decision sent — the server is the
        // only authority…" and, at the same moment, a `role="alert"` saying "The decision was not
        // sent". `notice` is for the server refusing something that was not a decision (a seat that
        // had gone, a hand somebody else started); a decision's fate belongs to the region that is
        // labelled "What happened to your decision", where there is exactly one of it.
        notice: null,
        noticeCode: null,
      };
    case 'coachRequested':
      // The key is kept, not just the id. It is the only record of which decision the answer will
      // be about, because the answer itself carries no hand and no sequence. See `onCoachFrame`.
      return {
        ...state,
        coachRequest: { requestId: event.requestId, key: event.key },
        coach: null,
        coachProblem: null,
      };
    case 'coachFailed':
      // The request is over: no second answer is coming for it, so the outstanding id is cleared
      // and the reason takes the place of the analysis rather than sitting beside a stale one.
      //
      // Announced for the same reason the success is: a reader who asked for the analysis is
      // waiting for it, and silence is indistinguishable from "still working". The reason is
      // included because, unlike a figure, it is complete on its own.
      return {
        ...state,
        coachRequest: null,
        coach: null,
        coachProblem: event.reason,
        announcement: `${COACH_FAILED_ANNOUNCEMENT} ${event.reason}`,
      };
    case 'notice':
      return { ...state, notice: event.message, noticeCode: event.code ?? null };
    case 'reset':
      return EMPTY_TABLE_STATE;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Setup, as a small machine
// ---------------------------------------------------------------------------

export type SetupPhase =
  /** Nothing has been asked for yet. The reader has not opted in. */
  | 'idle'
  /** Reading the session, creating a guest if needed, finding or creating the room. */
  | 'preparing'
  /** A room id is in hand and the socket owns what happens next. */
  | 'ready'
  /** Setup failed for a reason the reader is told about. */
  | 'failed';

/** Where a join-by-invite-code attempt has got to. */
export type JoinPhase =
  | { readonly state: 'idle' }
  | { readonly state: 'joining' }
  /** The server refused, in its own words. The field keeps what was typed so it can be corrected. */
  | { readonly state: 'refused'; readonly message: string }
  | { readonly state: 'joined'; readonly roomName: string };

export interface LiveTable {
  readonly phase: SetupPhase;
  readonly status: TableSocketStatus | null;
  readonly closed: CloseMeaning | null;
  readonly setupError: string | null;
  readonly displayName: string | null;
  /**
   * The invite code of a room THIS page just created, and only that.
   *
   * Null at every other moment, and that is the contract rather than an implementation detail: the
   * server stores `sha256(code)` and nothing else, so the code exists exactly once, in the response
   * to `POST /rooms`. It is held in React state for the life of this component and written nowhere
   * — not `sessionStorage`, not `localStorage`, not the URL. A reload does not bring it back, which
   * is the honest behaviour: the room's owner shares it now or creates another room.
   *
   * Null also when an EXISTING room was reused (`chooseRoom`), because no code was issued for that
   * request and there is no way to recover the one issued for the original.
   */
  readonly inviteCode: string | null;
  readonly join: JoinPhase;
  readonly table: TableState;
  readonly turn: TurnClock | null;
  readonly report: CoachReport | null;
  /** Why the Coach panel is empty, when it is empty for a reason worth naming. */
  readonly coachProblem: string | null;
  /** False on Expert Legends (and after a `coach_not_available` refusal). */
  readonly coachDuringHand: boolean;
  readonly seatNames: Readonly<Record<number, string>>;
  readonly highlightedCards: readonly number[];
  readonly isMyTurn: boolean;
  /** The seat `sit()` will ask for, or null when every seat is taken. */
  readonly readerSeat: number | null;
  /** Opts in: session, room, socket. Safe to call twice. */
  readonly start: () => void;
  /** Abandons the remembered room and builds a fresh bot table. */
  readonly startFreshTable: () => void;
  /**
   * Builds a private table with seats free for other people, and surfaces its invite code.
   *
   * Separate from `startFreshTable` because the bot table is FULL by construction — six seats, five
   * bots, the owner in the sixth — so its invite code is a code to a table the server will refuse
   * anybody at with `room_full`. An invite code nobody can use is not the feature.
   */
  readonly startPrivateTable: () => void;
  /** Joins somebody else's private room with the code they shared, then opens a socket to it. */
  readonly joinByInviteCode: (code: string) => void;
  readonly sit: () => void;
  readonly stand: () => void;
  readonly deal: () => void;
  readonly act: (action: TableAction) => void;
  readonly askCoach: () => void;
}

export interface UseLiveTableOptions {
  /** Test seams. The browser supplies neither. */
  readonly socketFactory?: RawSocketFactory;
  readonly scheduler?: Scheduler;
  readonly url?: string;
  /** When set, open a Legends match against these profiles instead of the generic bot table. */
  readonly legendMatch?: {
    readonly profileId: string;
    readonly difficulty: 'educational' | 'realistic' | 'expert';
  };
}

/** Display names by seat, from the room roster. Bots are named by the server, never invented here. */
function namesFor(room: RoomSummary | null): Readonly<Record<number, string>> {
  if (room === null) return {};
  const names: Record<number, string> = {};
  for (const member of room.members) {
    if (member.seat !== null) names[member.seat] = member.displayName;
  }
  return names;
}

/** The five cards that won, for the ring the table draws. Empty unless the hand reached showdown. */
function winningCards(view: PlayerView | null): readonly number[] {
  const result = view?.result ?? null;
  if (result === null) return [];
  const winners = new Set(result.awards.map((award) => award.seat));
  return result.showdowns.filter((showdown) => winners.has(showdown.seat)).flatMap((s) => [...s.bestFive]);
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) return `${cause.message} (${cause.code})`;
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
 * Opens a live table and keeps it open for the life of the component.
 *
 * Everything it owns is released on unmount: the socket is closed, every timer is cancelled and the
 * in-flight setup request is aborted. That is not tidiness — a socket leaked per navigation reaches
 * `maxSocketsPerSession` (four) in four page views and locks the reader out of their own table with
 * a `4429`.
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

  const socketRef = useRef<TableSocketHandle | null>(null);
  const pendingRef = useRef<PendingDecision | null>(null);
  const viewRef = useRef<PlayerView | null>(null);
  const coachAskedRef = useRef<string | null>(null);
  const setupRef = useRef<AbortController | null>(null);

  pendingRef.current = table.pending;
  viewRef.current = table.view;

  const { socketFactory, scheduler, url, legendMatch } = options;

  /**
   * Session, then room. One abortable pass; a second click while it runs is ignored.
   *
   * The controller is kept so unmount can abort it. Without that, a reader who navigates away
   * mid-setup leaves a `POST /rooms` in flight that creates a table nobody will ever sit at.
   */
  const prepare = useCallback(
    (fresh: boolean, request: CreateRoomRequest = BOT_TABLE_REQUEST) => {
      setupRef.current?.abort();
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
          setSetupError(messageOf(cause));
          setPhase('failed');
        }
      })();
    },
    [legendMatch],
  );

  /** Whatever setup pass is still running when the component goes away. */
  useEffect(() => () => setupRef.current?.abort(), []);

  const start = useCallback((): void => {
    if (phase === 'preparing' || phase === 'ready') return;
    prepare(false);
  }, [phase, prepare]);

  /** Abandons whatever room is open and builds a new one to `request`. */
  const buildFresh = useCallback(
    (request: CreateRoomRequest): void => {
      socketRef.current?.dispose();
      socketRef.current = null;
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

  /**
   * Creates a table for people, always fresh.
   *
   * Never reuses an existing room, unlike `start`. "Make me a private table to invite somebody to"
   * is an explicit act with an answer the reader is waiting for — the invite code — and a version
   * of it that quietly handed back a room they made yesterday would hand back a room whose code was
   * issued once and is gone. Only a creation produces a code.
   */
  const startPrivateTable = useCallback(() => buildFresh(FRIENDS_TABLE_REQUEST), [buildFresh]);

  /**
   * Joins somebody else's private room, then opens a socket to it.
   *
   * The same ordered set of HTTP calls `prepare` makes, with the room supplied instead of found: a
   * session (a guest one if there is none — the joiner is usually a second person who has never
   * been here), then `POST /rooms/join`, then the socket. It uses the same `setupRef` controller,
   * so a join and a "start a fresh table" cannot both be in flight; the later one wins.
   *
   * A refusal is a value, not an error page. `invite_code_invalid` is the ordinary answer to a
   * mistyped code and the server's own wording for it is what the reader sees, because a client
   * that rewrote it would be guessing at which of several refusals it had received. The socket is
   * not touched until the join has succeeded, so a bad code leaves whatever table is already open
   * exactly as it was.
   */
  const joinByInviteCode = useCallback((code: string): void => {
    const normalised = normaliseInviteCode(code);
    if (normalised === null) {
      // Refused here rather than sent: below eight characters there is nothing the server could
      // match, and spending a rate-limit token to be told so helps nobody.
      setJoin({
        state: 'refused',
        message:
          'That is not a complete invite code. They are nineteen characters in four groups, like ' +
          'ABCD-EFGH-JKMN-PQRS — spaces and lower case are fine, and are tidied up for you.',
      });
      return;
    }

    setupRef.current?.abort();
    const controller = new AbortController();
    setupRef.current = controller;
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
        // Not this session's code to show: it was issued to whoever created the room.
        setInviteCode(null);
        rememberRoom(room.id);
        dispatch({ kind: 'reset' });
        setJoin({ state: 'joined', roomName: room.name });
        setRoomId(room.id);
        setPhase('ready');
      } catch (cause) {
        if (controller.signal.aborted) return;
        // `phase` goes back to whatever the socket can still support rather than to `failed`: a
        // wrong code is not a broken page, and turning the whole screen into an error state would
        // throw away a table the reader may already be sitting at.
        setPhase(socketRef.current === null ? 'idle' : 'ready');
        setJoin({ state: 'refused', message: messageOf(cause) });
      }
    })();
  }, []);

  /**
   * The socket's whole lifetime, tied to one room id.
   *
   * The cleanup disposes it, which closes the underlying socket and cancels the reconnect timer.
   * React's strict mode runs this twice in development on purpose, and that is the point: a version
   * of this that leaked would show up here as a second socket rather than in production as a
   * locked-out reader.
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
       * A dropped frame is usually invisible on purpose — `state` arrives whole on every change, so
       * the next one repairs whatever the last one lost. A `coach` frame is the exception: it is
       * asked for once and answered once, so dropping it silently leaves a panel that will never
       * fill and a reader with no idea why.
       */
      onRejected: (rejection) => {
        if (rejection.claimedType !== 'coach') return;
        dispatch({ kind: 'coachFailed', reason: rejection.reason });
      },
      onFrame: (frame) => {
        dispatch({ kind: 'frame', frame });
        // A reconnect replays an unanswered decision, unchanged. The server dedupes by `actionId`,
        // so this is either applied once or answered `deduplicated` — never twice.
        if (frame.type === 'welcome') {
          const replay = pendingRef.current;
          if (replay !== null) handle.action(replay);
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
   * The seat `sit()` will ask for: the one this reader already holds, or the first free one.
   *
   * `READER_SEAT` alone was right for exactly one table — the bot table this page creates, where
   * `seatRequestedBots` fills from seat 1 upwards specifically to leave seat 0 free. It was wrong
   * for every room reached by invite code, because seat 0 is where the room's owner is sitting, so
   * the second person to arrive at a private table could only ever ask for a taken seat. Null means
   * the table is full, and the control that offers it is hidden rather than offering a refusal.
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

  const act = useCallback((action: TableAction): void => {
    const view = viewRef.current;
    const handle = socketRef.current;
    if (view === null || handle === null) return;
    // One id for this decision, minted once and kept. See the module comment: a retry that mints a
    // new one is a second bet.
    const pending: PendingDecision = {
      action,
      actionId: newRequestId('act'),
      expectedSequence: view.actionSequence,
      requestId: newRequestId('req'),
    };
    // Sent BEFORE the state change, and the state change carries what happened to it.
    //
    // The order is the fix. This used to dispatch `submit` — whose one message said "Sent." — and
    // then, if the send had failed, a separate `notice` saying it had not been sent and blaming the
    // rate limiter. Two regions, two claims, and during a reconnect both were wrong: the socket was
    // null rather than throttled, and the decision was replayed on the next `welcome` and applied.
    // `sendRaw` cannot be asked afterwards which it was, so the answer travels with the event.
    dispatch({ kind: 'submit', pending, delivery: handle.action(pending) });
  }, []);

  const view = table.view;
  // The same predicate the reducer diffs on, so "the buttons are live" and "the reader was told it
  // is their turn" can never disagree.
  const isMyTurn = isViewersTurn(view, table.betweenHands);
  const key = decisionKey(view);

  const askCoach = useCallback((): void => {
    const handle = socketRef.current;
    if (handle === null) return;
    const requestId = newRequestId('coach');
    coachAskedRef.current = decisionKey(viewRef.current);
    dispatch({ kind: 'coachRequested', requestId, key: coachAskedRef.current });
    handle.requestCoach(requestId);
  }, []);

  /**
   * The analysis is asked for once per decision, when the decision becomes the reader's.
   *
   * Keyed on the spot rather than on a render, so a re-render does not spend another of the thirty
   * Coach requests a minute the server allows. Asking before it is the reader's turn would price a
   * decision nobody is being asked to make.
   */
  const coachDuringHand = options.legendMatch?.difficulty === 'expert' ? false : table.coachDuringHand;

  useEffect(() => {
    if (!coachDuringHand) return;
    if (!isMyTurn || key === '') return;
    if (coachAskedRef.current === key) return;
    askCoach();
  }, [coachDuringHand, isMyTurn, key, askCoach]);

  const turn = useMemo<TurnClock | null>(() => {
    if (table.deadlineMs === null || table.room === null || table.betweenHands) return null;
    return {
      deadlineMs: table.deadlineMs,
      serverTimeMs: table.serverTimeMs,
      budgetSeconds: table.room.actionTimeoutSeconds,
    };
  }, [table.deadlineMs, table.serverTimeMs, table.room, table.betweenHands]);

  const seatNames = useMemo(() => namesFor(table.room), [table.room]);
  const highlightedCards = useMemo(() => winningCards(view), [view]);
  const report = table.coach !== null && table.coach.key === key ? table.coach.report : null;

  return {
    phase,
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
    coachDuringHand,
    seatNames,
    highlightedCards,
    isMyTurn,
    readerSeat,
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

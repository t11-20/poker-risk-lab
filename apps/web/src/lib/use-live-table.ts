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
 * ## Reconnect is "render the current view"
 *
 * State is sent whole, so there is no catch-up protocol and nothing to resynchronise: the socket
 * reconnects, `hello` goes out, `welcome` and a full `state` come back, and the table is right
 * again. `revision` is monotonic per socket, so a frame that arrives out of order is dropped; it
 * restarts at zero on each new socket, which is why `welcome` resets it here.
 */

import type { CoachReport, RoomSummary, WsServerMessage } from '@prl/contracts';
import type { PlayerView, TableAction, TurnClock } from '@prl/ui';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { TableSubmission } from '@/components/TableStage.tsx';
import { ApiRequestError } from './api.ts';
import { chooseRoom, createBotRoom, ensureSession, listRooms, READER_SEAT } from './table-rooms.ts';
import {
  type CloseMeaning,
  newRequestId,
  openTableSocket,
  type RawSocketFactory,
  type Scheduler,
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
  readonly summary: readonly string[];
  /** The report, with the decision it was computed for. Never rendered against a different one. */
  readonly coach: { readonly key: string; readonly report: CoachReport } | null;
  readonly coachRequestId: string | null;
  /** Why there is no analysis, when the reason is something other than "none was asked for". */
  readonly coachProblem: string | null;
  readonly pending: PendingDecision | null;
  readonly submission: TableSubmission | null;
  /** The server's own wording for the last refusal that was not about a decision. */
  readonly notice: string | null;
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
  summary: [],
  coach: null,
  coachRequestId: null,
  coachProblem: null,
  pending: null,
  submission: null,
  notice: null,
};

export type TableEvent =
  | { readonly kind: 'frame'; readonly frame: WsServerMessage }
  | { readonly kind: 'submit'; readonly pending: PendingDecision }
  | { readonly kind: 'coachRequested'; readonly requestId: string; readonly key: string }
  | { readonly kind: 'coachFailed'; readonly reason: string }
  | { readonly kind: 'notice'; readonly message: string | null }
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

/** One sentence for the table's single polite live region. */
function announce(event: Extract<WsServerMessage, { type: 'event' }>['event']): string {
  switch (event.kind) {
    case 'handStarted':
      return 'A new hand was dealt.';
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

function onEventFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'event' }>): TableState {
  const announcement = announce(frame.event);
  if (frame.event.kind === 'handStarted') {
    return { ...state, announcement, summary: [] };
  }
  if (frame.event.kind === 'showdown' || frame.event.kind === 'handComplete') {
    return { ...state, announcement, summary: frame.event.summaries };
  }
  return { ...state, announcement };
}

function onStateFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'state' }>): TableState {
  // Monotonic per socket. A frame that arrived out of order describes a table that has already
  // moved on, and applying it would draw the past over the present.
  if (frame.revision <= state.revision) return state;

  const view = frame.view ?? state.view;
  const key = decisionKey(view);
  const movedOn = key !== decisionKey(state.view);
  return {
    ...state,
    revision: frame.revision,
    room: frame.room,
    seat: seatFrom(frame.room, state.userId),
    view,
    // The server's own rule, mirrored exactly: `LiveTable.handInProgress` in `rooms/table.ts` is
    // `street !== undefined && street !== 'complete'`. Reading it as "the frame carried no view"
    // instead is wrong and was a real defect: a finished hand is still sent — with its cards, its
    // pot and its result — so `view` stays non-null after the hand is over, and "Deal the next
    // hand" stayed disabled forever from the first completed hand onwards.
    betweenHands: frame.view === null || frame.view.street === 'complete',
    deadlineMs: frame.deadlineMs,
    serverTimeMs: frame.serverTimeMs,
    // An analysis belongs to the spot it was computed for. The moment the spot changes it is
    // dropped rather than left on screen beside different numbers — and so is the reason the last
    // one could not be shown, which described a different spot too.
    coach: state.coach !== null && state.coach.key === key ? state.coach : null,
    coachProblem: movedOn ? null : state.coachProblem,
    // A finished decision stops disabling the controls once the hand has actually moved.
    submission: movedOn && state.pending === null ? null : state.submission,
  };
}

function onAckFrame(state: TableState, frame: Extract<WsServerMessage, { type: 'ack' }>): TableState {
  const pending = state.pending;
  if (pending === null || pending.requestId !== frame.requestId) {
    return { ...state, notice: null };
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
  const pending = state.pending;
  if (pending === null || pending.requestId !== frame.requestId) {
    return { ...state, notice: `${frame.error.message} (${frame.error.code})` };
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
      return frame.requestId === state.coachRequestId
        ? {
            ...state,
            coach: { key: decisionKey(state.view), report: frame.report },
            coachRequestId: null,
            coachProblem: null,
          }
        : state;
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

export function tableReducer(state: TableState, event: TableEvent): TableState {
  switch (event.kind) {
    case 'frame':
      return onFrame(state, event.frame);
    case 'submit':
      return {
        ...state,
        pending: event.pending,
        submission: {
          action: event.pending.action,
          status: 'pending',
          message:
            'Sent. The server is the only authority on a hand, so the controls stay disabled until it ' +
            'answers.',
        },
      };
    case 'coachRequested':
      return { ...state, coachRequestId: event.requestId, coach: null, coachProblem: null };
    case 'coachFailed':
      // The request is over: no second answer is coming for it, so the outstanding id is cleared
      // and the reason takes the place of the analysis rather than sitting beside a stale one.
      return { ...state, coachRequestId: null, coach: null, coachProblem: event.reason };
    case 'notice':
      return { ...state, notice: event.message };
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

export interface LiveTable {
  readonly phase: SetupPhase;
  readonly status: TableSocketStatus | null;
  readonly closed: CloseMeaning | null;
  readonly setupError: string | null;
  readonly displayName: string | null;
  readonly table: TableState;
  readonly turn: TurnClock | null;
  readonly report: CoachReport | null;
  /** Why the Coach panel is empty, when it is empty for a reason worth naming. */
  readonly coachProblem: string | null;
  readonly seatNames: Readonly<Record<number, string>>;
  readonly highlightedCards: readonly number[];
  readonly isMyTurn: boolean;
  /** Opts in: session, room, socket. Safe to call twice. */
  readonly start: () => void;
  /** Abandons the remembered room and builds a fresh one. */
  readonly startFreshTable: () => void;
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

  const socketRef = useRef<TableSocketHandle | null>(null);
  const pendingRef = useRef<PendingDecision | null>(null);
  const viewRef = useRef<PlayerView | null>(null);
  const coachAskedRef = useRef<string | null>(null);
  const setupRef = useRef<AbortController | null>(null);

  pendingRef.current = table.pending;
  viewRef.current = table.view;

  const { socketFactory, scheduler, url } = options;

  /**
   * Session, then room. One abortable pass; a second click while it runs is ignored.
   *
   * The controller is kept so unmount can abort it. Without that, a reader who navigates away
   * mid-setup leaves a `POST /rooms` in flight that creates a table nobody will ever sit at.
   */
  const prepare = useCallback((fresh: boolean) => {
    setupRef.current?.abort();
    setPhase('preparing');
    setSetupError(null);
    const controller = new AbortController();
    setupRef.current = controller;
    void (async (): Promise<void> => {
      try {
        const session = await ensureSession(controller.signal);
        setDisplayName(session.user.displayName);
        const rooms = await listRooms(controller.signal);
        const preferred = fresh ? null : rememberedRoom();
        const existing = fresh ? null : chooseRoom(rooms, session.user.id, preferred);
        const chosen = existing ?? (await createBotRoom(session.csrfToken, controller.signal)).room;
        if (controller.signal.aborted) return;
        rememberRoom(chosen.id);
        dispatch({ kind: 'reset' });
        setRoomId(chosen.id);
        setPhase('ready');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setSetupError(messageOf(cause));
        setPhase('failed');
      }
    })();
  }, []);

  /** Whatever setup pass is still running when the component goes away. */
  useEffect(() => () => setupRef.current?.abort(), []);

  const start = useCallback((): void => {
    if (phase === 'preparing' || phase === 'ready') return;
    prepare(false);
  }, [phase, prepare]);

  const startFreshTable = useCallback((): void => {
    socketRef.current?.dispose();
    socketRef.current = null;
    setRoomId(null);
    setStatus(null);
    setClosed(null);
    rememberRoom(null);
    prepare(true);
  }, [prepare]);

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

  const sit = useCallback((): void => {
    socketRef.current?.sit(READER_SEAT, newRequestId('sit'));
  }, []);

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
    dispatch({ kind: 'submit', pending });
    if (!handle.action(pending)) {
      dispatch({
        kind: 'notice',
        message: 'The decision was not sent: this page is refusing to exceed the socket rate limit.',
      });
    }
  }, []);

  const view = table.view;
  const isMyTurn =
    view !== null &&
    !table.betweenHands &&
    view.viewerSeat !== null &&
    view.toAct === view.viewerSeat &&
    view.legalActions.length > 0;
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
  useEffect(() => {
    if (!isMyTurn || key === '') return;
    if (coachAskedRef.current === key) return;
    askCoach();
  }, [isMyTurn, key, askCoach]);

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
    table,
    turn,
    report,
    coachProblem: table.coachProblem,
    seatNames,
    highlightedCards,
    isMyTurn,
    start,
    startFreshTable,
    sit,
    stand,
    deal,
    act,
    askCoach,
  };
}

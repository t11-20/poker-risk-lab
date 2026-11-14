/**
 * One live table: the authoritative `HandState`, the seating around it, and the queue that makes
 * both safe to touch.
 *
 * EVERY MUTATION GOES THROUGH ONE ASYNC QUEUE PER TABLE (ARCHITECTURE.md section 8). The callers
 * are async, so without it two submissions that both read `actionSequence` 41 could both apply.
 *
 * A SEAT INDEX IS A POSITION, A USER ID IS A PERSON. `this.seats` is who sits here now and
 * `this.hand.state.seats` is who was dealt in. They diverge between hands, so visibility, actions
 * and settlement resolve by user id against the hand's own roster. That is also why a finished hand
 * can be retained for reconnects and `archivedDeal()` without leaking to a newcomer in the chair.
 *
 * `viewFor` (via `redactFor`) is the only way state leaves. The `DeckSecret` is held privately,
 * never persisted or logged, and dropped once the reveal is built. An interrupted hand is lost.
 *
 * The `actionId` memo is checked BEFORE turn and sequence checks, so a retry of an applied action
 * returns the original outcome with `deduplicated: true` instead of `not_your_turn`.
 *
 * The big blind advances by one live player per hand (dead-button rule, engine
 * `advanceBlindRotation`). The old button-first rotation made six players pay the big blind twice
 * in 40 hands (`docs/audit/poker-correctness.md`, P1-1).
 * An arriving player waits for the big blind. The debt is keyed by user id in `blindDebts` and
 * survives standing up. Posting a missed blind would need a dead-blind kind the engine lacks.
 * If fewer than two players could be dealt, the game restarts and all debts are cleared.
 */

import type { AutomaticReason, WsEvent } from '@prl/contracts';
import type { PublicActionEvent } from '@prl/poker-ai';
import type {
  Action,
  BlindPositions,
  BlindRotation,
  Card,
  DeckSecret,
  HandEvent,
  HandResult,
  HandState,
  LoggedAction,
  PlayerView,
  RandomSource,
  SeatIndex,
  SeatStatus,
  Street,
  SubmittedAction,
  TableConfig,
} from '@prl/poker-engine';
import {
  advanceBlindRotation,
  applyAction,
  cardToString,
  startHand as dealHand,
  legalActions,
  nextOccupied,
  redactFor,
  seedBlindRotation,
  timeoutAction,
} from '@prl/poker-engine';
import { DEFAULT_LEARNER_TURN_SECONDS } from '../config.ts';
import { AppError } from '../errors.ts';
import type { ProblemHook } from '../observability/telemetry.ts';
import {
  actionSentence,
  awardSentences,
  forcedBetsSentence,
  NO_CHIPS_CHANGED_HANDS,
  namesFrom,
  showdownSentence,
} from './narration.ts';
import { type Clock, type TurnExpiry, TurnTimer } from './timers.ts';

export type TableEvent = WsEvent['event'];

/** One seated player. Bots are seats like any other; `isBot` says how the seat decides. */
export interface TableSeat {
  readonly seat: SeatIndex;
  readonly userId: string;
  readonly displayName: string;
  /** Chips at the table. Authoritative between hands; during a hand the view is. */
  readonly stack: number;
  readonly isBot: boolean;
  /** The strategy profile id for a bot seat, else null. */
  readonly botProfile: string | null;
  /** True once the player has asked to stand: they fold at their next turn, then leave. */
  readonly leaving: boolean;
}

/** What `submitAction` answers with. Mirrors `WsAck`'s optional members. */
export interface ActionOutcome {
  readonly appliedSequence: number;
  /** True when this `actionId` had already been applied and the original stands. */
  readonly deduplicated: boolean;
}

export type TableChangeReason = 'seating' | 'handStarted' | 'action' | 'handComplete';

/** By user id, never seat index, because these are written to `room_members.stack`. */
export interface SettledStack {
  readonly userId: string;
  readonly stack: number;
}

/** Public events and public action facts only, never state. */
export interface TableNotice {
  readonly reason: TableChangeReason;
  readonly events: readonly TableEvent[];
  /** For the bots' opponent models. No cards: `PublicActionEvent` has no field for one. */
  readonly publicActions: readonly PublicActionEvent[];
  /** The engine's log entries for this change. A `LoggedAction` holds no card. */
  readonly loggedActions: readonly ArchivedAction[];
  /** True on the one notice that carried a hand to completion. Exactly `settledStacks !== null`. */
  readonly handCompleted: boolean;
  /**
   * Every seat's chips as the hand settled, on the one notice that settled it; null otherwise.
   * Captured before leavers are removed. Reading `table.snapshot()` after `handComplete` missed
   * players who stood mid-hand and destroyed or created their chips. Includes seats not dealt in.
   */
  readonly settledStacks: readonly SettledStack[] | null;
  /**
   * The users whose seat this notice released. Every release, immediate or deferred to settlement,
   * travels here so the durable seat is freed on one event. Freeing it at the stand request left
   * mid-hand leavers seated in `room_members` for good.
   */
  readonly departed: readonly string[];
  /** The hand this notice belongs to, or null between hands. */
  readonly handId: string | null;
  /** The current street, or `'complete'`. Public. */
  readonly street: Street | null;
  /** The public board as it now stands. Public the moment each card is dealt. */
  readonly board: readonly Card[];
}

/** One seat as it was dealt in, for the archive only. See `LiveTable.archivedDeal`. */
export interface ArchivedDealSeat {
  readonly seat: SeatIndex;
  readonly userId: string;
  readonly isBot: boolean;
  readonly startingStack: number;
  /** Null for a seat that was not dealt in. */
  readonly holeCards: readonly Card[] | null;
  readonly status: SeatStatus;
}

/** Hole cards are read back only under `user_id = :viewer OR showed_down`. Deck and salts never. */
export interface ArchivedDeal {
  readonly handId: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly buttonSeat: SeatIndex;
  readonly config: TableConfig;
  readonly commitmentRoot: string;
  readonly commitmentContext: string;
  readonly randomSourceKind: HandState['randomSourceKind'];
  readonly seats: readonly ArchivedDealSeat[];
}

export interface ArchivedResultSeat {
  readonly seat: SeatIndex;
  readonly netResult: number;
  readonly status: SeatStatus;
  /** True only for a seat that actually showed. Taken from `HandResult.showdowns`. */
  readonly showedDown: boolean;
}

export interface ArchivedResult {
  readonly handId: string;
  readonly board: readonly Card[];
  readonly result: HandResult;
  readonly seats: readonly ArchivedResultSeat[];
}

export type TableListener = (notice: TableNotice) => void;

export interface TableSnapshot {
  readonly seats: readonly TableSeat[];
  readonly handInProgress: boolean;
  readonly handNumber: number;
  /** Last button seat. Under the dead-button rule this can be an empty seat. */
  readonly buttonSeat: SeatIndex | null;
  /** Seats sitting out until the big blind reaches them. Public, as at a real table. */
  readonly awaitingBigBlind: readonly SeatIndex[];
  /** Absolute server time by which the seat to act must act, or null. */
  readonly deadlineMs: number | null;
}

export interface LiveTableOptions {
  readonly roomId: string;
  readonly config: TableConfig;
  readonly clock: Clock;
  /** `createSecureRandom()` in production. Every hand records which kind dealt it. */
  readonly random: RandomSource;
  readonly nextHandId: () => string;
  /** Hands already played here, so a re-opened table does not collide on `hands_room_hand_number_key`. */
  readonly initialHandNumber?: number;
  /** Blind positions to resume after a restart, so nobody pays a second big blind. */
  readonly initialBlinds?: BlindPositions;
  /** Floor on a lone person's turn clock, in seconds. See `turnSecondsFor`. */
  readonly learnerTurnSeconds?: number;
  /** Non-fatal problems, each with a typed `event` so it is counted separately. Never given a card. */
  readonly onProblem?: ProblemHook;
}

/** How many applied `actionId`s one hand remembers. A legal hand cannot produce this many. */
const MAX_MEMO_ENTRIES = 256;

interface HandMemo {
  readonly handId: string;
  readonly results: Map<string, ActionOutcome>;
}

interface LiveHand {
  state: HandState;
  /** Dropped to null the moment the hand completes. Never persisted, never logged. */
  secret: DeckSecret | null;
  /** Captured at the deal, because the archive wants starting stacks and `state` moves. */
  readonly deal: ArchivedDeal;
  /** Each dealt-in seat's display name, as it was at the deal. See `narration.ts`. */
  readonly names: ReadonlyMap<SeatIndex, string>;
}

/**
 * Keyed by user id and not cleared on standing up, so leaving cannot discharge it (P1-2: four of
 * fifteen seating combinations got a free hand). Cleared only on being dealt in or a game restart.
 * Entries for people who never return die with the room.
 */
interface BlindDebt {
  /** The hand number this table had reached when the obligation was incurred. */
  readonly since: number;
}

/**
 * The engine only knows "automatic". The reason is this class's, and keeping it off `LoggedAction`
 * keeps it off the wire. Without it the review said "time ran out" to someone who pressed Stand up.
 */
export interface ArchivedAction extends LoggedAction {
  /** Non-null exactly when `wasAutomatic`. See `AUTOMATIC_REASONS` in `@prl/contracts`. */
  readonly automaticReason: AutomaticReason | null;
}

interface ApplyOptions {
  readonly actionId: string | null;
  /** Why the server is acting for this seat, or null for a decision its player submitted. */
  readonly automatic: AutomaticReason | null;
  /** Events to publish alongside the engine's own, e.g. `seatTimedOut`. */
  readonly extraEvents?: readonly TableEvent[];
}

/** Filled together for every applied action, so no notice misses one of the three. */
interface Applied {
  readonly events: TableEvent[];
  readonly publicActions: PublicActionEvent[];
  readonly loggedActions: ArchivedAction[];
}

function collector(): Applied {
  return { events: [], publicActions: [], loggedActions: [] };
}

export class LiveTable {
  readonly roomId: string;
  readonly config: TableConfig;

  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly nextHandId: () => string;
  private readonly onProblem: ProblemHook;
  /** The floor a person's turn clock is never allowed below. See `turnSecondsFor`. */
  private readonly learnerTurnSeconds: number;
  private readonly timer: TurnTimer;
  private readonly listeners = new Set<TableListener>();

  private seats: readonly TableSeat[] = [];
  private hand: LiveHand | null = null;
  private handNumber = 0;
  /** The button of the most recent hand, or the seat the first one will be seeded from. */
  private buttonSeat: SeatIndex | null = null;
  /** Where the blinds sat last hand, carried forward. Null until the first hand is dealt. */
  private blinds: BlindPositions | null = null;
  /** Who owes a blind before they may be dealt in. See the file comment. */
  private readonly blindDebts = new Map<string, BlindDebt>();
  private currentMemo: HandMemo | null = null;
  /** Kept so a retry arriving after the hand ended is deduplicated rather than re-applied. */
  private previousMemo: HandMemo | null = null;
  /** Units resets that arrived while their player was in the live hand, applied at settlement. By user id. */
  private readonly pendingRestacks = new Map<string, number>();
  /** The hand whose stacks have already been written back, so settlement happens once. */
  private settledHandId: string | null = null;
  private closed = false;

  /** The serialisation point. See the file header. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: LiveTableOptions) {
    this.roomId = options.roomId;
    this.config = options.config;
    this.clock = options.clock;
    this.random = options.random;
    this.nextHandId = options.nextHandId;
    this.handNumber = Math.max(0, options.initialHandNumber ?? 0);
    if (options.initialBlinds !== undefined) {
      this.blinds = options.initialBlinds;
      this.buttonSeat = options.initialBlinds.buttonSeat;
    }
    this.onProblem = options.onProblem ?? ((): void => undefined);
    this.learnerTurnSeconds = options.learnerTurnSeconds ?? DEFAULT_LEARNER_TURN_SECONDS;
    this.timer = new TurnTimer({
      clock: options.clock,
      onExpiry: (expiry) => {
        // Queued behind whatever mutation is in flight, never applied inline.
        this.enqueue(() => this.applyTimeout(expiry)).catch((error: unknown) => {
          this.onProblem('turn timeout could not be applied', {
            event: 'turn-timeout',
            error: String(error),
          });
        });
      },
    });
  }

  /** The chain swallows rejections the caller still sees, so one `illegal_action` cannot wedge it. */
  private enqueue<T>(work: () => T): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * The redacted view for one user. The only way state leaves this object.
   * The user id goes to `redactFor` untranslated and `this.seats` is not consulted, which is the fix
   * for the seat-reuse leak. Anyone not dealt in gets the spectator view. Null before the first deal.
   */
  viewFor(userId: string): PlayerView | null {
    if (this.hand === null) return null;
    return redactFor(this.hand.state, { viewerPlayerId: userId });
  }

  snapshot(): TableSnapshot {
    // Only while the hand can still move. After settlement the seat holds the final figure, and a
    // retained hand would hide a later `restack`.
    const live = this.handInProgress ? (this.hand?.state ?? null) : null;
    const seats = this.seats.map((seat) => {
      // By id. A retained hand's seat 3 may belong to someone who left.
      const inHand = live?.seats.find((entry) => entry.playerId === seat.userId);
      // Mid-hand the table figure is behind plus committed.
      if (inHand === undefined) return seat;
      return { ...seat, stack: inHand.stack + inHand.committedThisStreet };
    });
    return {
      seats,
      handInProgress: this.handInProgress,
      handNumber: this.handNumber,
      buttonSeat: this.buttonSeat,
      // Derived from `blindDebts`, the single source of truth.
      awaitingBigBlind: this.seats
        .filter((seat) => this.blindDebts.has(seat.userId))
        .map((seat) => seat.seat),
      deadlineMs: this.timer.deadlineMs,
    };
  }

  seatOf(userId: string): SeatIndex | null {
    return this.seats.find((entry) => entry.userId === userId)?.seat ?? null;
  }

  /**
   * Each dealt-in seat's display name as it was at the deal, for the live Coach. From the deal, not
   * the seating, because a chair can change hands. Empty before the first deal.
   */
  dealtNames(): ReadonlyMap<SeatIndex, string> {
    return this.hand?.names ?? new Map();
  }

  /** Keyed by user id, so the obligation survives standing up and changing chairs. */
  owesBlind(userId: string): boolean {
    return this.blindDebts.has(userId);
  }

  isSeatFree(seat: SeatIndex): boolean {
    return !this.seats.some((entry) => entry.seat === seat);
  }

  get seatCount(): number {
    return this.seats.length;
  }

  get handId(): string | null {
    return this.hand?.state.handId ?? null;
  }

  /** True while the current hand can still take actions. */
  get handInProgress(): boolean {
    const street = this.hand?.state.street;
    return street !== undefined && street !== 'complete';
  }

  subscribe(listener: TableListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * This and `archivedResult` are the only methods that return hole cards, and only to the database.
   * The read path (`src/routes/hands.ts`) filters `user_id = :viewer OR showed_down`. No deck or salts.
   */
  archivedDeal(): ArchivedDeal | null {
    return this.hand?.deal ?? null;
  }

  /** Null until the hand is complete. */
  archivedResult(): ArchivedResult | null {
    const live = this.hand;
    if (live === null || live.state.street !== 'complete') return null;
    const result = live.state.result;
    if (result === null) return null;
    const shown = new Set(result.showdowns.map((showdown) => showdown.seat));
    return {
      handId: live.state.handId,
      board: [...live.state.board],
      result,
      seats: live.state.seats.map((seat) => ({
        seat: seat.seat,
        netResult: result.netBySeat[seat.seat] ?? 0,
        status: seat.status,
        // Only seats in `HandResult.showdowns`. This flag opens a seat's cards to the table.
        showedDown: shown.has(seat.seat),
      })),
    };
  }

  /**
   * Enforces only what the table knows. Membership and units are the registry's business.
   * Joining a running rotation incurs a blind debt, dealt in when the big blind reaches the seat.
   */
  sit(request: {
    readonly userId: string;
    readonly displayName: string;
    readonly seat: SeatIndex;
    readonly stack: number;
    readonly isBot?: boolean;
    readonly botProfile?: string | null;
    /**
     * Re-taking a seat exactly as before a restart, so no debt is incurred. Debts are not persisted,
     * so a waiting player skips at most one blind per restart.
     */
    readonly resumingSeat?: boolean;
  }): Promise<TableSeat> {
    return this.enqueue(() => {
      this.assertOpen();
      if (!Number.isInteger(request.seat) || request.seat < 0 || request.seat >= this.config.maxSeats) {
        throw new AppError('invalid_request', {
          logDetail: `seat ${request.seat} is outside 0..${this.config.maxSeats - 1}`,
        });
      }
      if (this.seats.some((entry) => entry.userId === request.userId)) {
        throw new AppError('already_seated', { logDetail: 'that user already holds a seat here' });
      }
      if (this.seats.length >= this.config.maxSeats) {
        throw new AppError('room_full', { logDetail: 'every seat is taken' });
      }
      if (!this.isSeatFree(request.seat)) {
        throw new AppError('seat_taken', { logDetail: `seat ${request.seat} is occupied` });
      }

      const seat: TableSeat = {
        seat: request.seat,
        userId: request.userId,
        displayName: request.displayName,
        stack: request.stack,
        isBot: request.isBot === true,
        botProfile: request.botProfile ?? null,
        leaving: false,
      };
      this.seats = [...this.seats, seat].sort((left, right) => left.seat - right.seat);
      // The first player seeds the button. Afterwards this holds the last hand's button.
      this.buttonSeat ??= seat.seat;
      // Debts start once a rotation exists. `has` first, so a returning debtor keeps the original `since`.
      if (this.blinds !== null && request.resumingSeat !== true && !this.blindDebts.has(seat.userId)) {
        this.blindDebts.set(seat.userId, { since: this.handNumber + 1 });
      }
      this.publish(
        'seating',
        { ...collector(), events: [{ kind: 'playerJoined', displayName: seat.displayName }] },
        null,
      );
      return seat;
    });
  }

  /**
   * A player in the live hand, even folded or all-in, is flagged `leaving`, auto-folds at their turn,
   * and is removed at settlement. Changing a hand outside an engine action is not possible here, and
   * removing them early would drop them from the stack write-back.
   */
  stand(userId: string): Promise<void> {
    return this.enqueue(() => {
      const seat = this.seats.find((entry) => entry.userId === userId);
      if (seat === undefined) throw new AppError('not_seated', { logDetail: 'not seated at this table' });

      if (!this.inTheLiveHand(userId)) {
        this.removeSeats([seat]);
        return;
      }

      this.seats = this.seats.map((entry) => (entry.userId === userId ? { ...entry, leaving: true } : entry));
      const applied = collector();
      this.runAutomaticActions(applied);
      this.afterMutation('action', applied);
    });
  }

  /**
   * The units reset reaching the table. Between hands `TableSeat.stack` is the truth, so writing only
   * `room_members.stack` was settled back over (see `RoomRegistry.restackForUnitsReset`). A player in
   * the live hand is deferred to `settleIfComplete`. Never throws for a closed table.
   */
  restack(userId: string, stack: number): Promise<'applied' | 'deferred' | 'notSeated'> {
    return this.enqueue(() => {
      if (this.closed) return 'notSeated';
      const seat = this.seats.find((entry) => entry.userId === userId);
      if (seat === undefined) return 'notSeated';
      if (this.inTheLiveHand(userId)) {
        this.pendingRestacks.set(userId, stack);
        return 'deferred';
      }
      if (seat.stack === stack) return 'applied';
      this.seats = this.seats.map((entry) => (entry.userId === userId ? { ...entry, stack } : entry));
      this.publish('seating', collector(), null);
      return 'applied';
    });
  }

  startHand(): Promise<{ readonly handId: string }> {
    return this.enqueue(() => {
      this.assertOpen();
      if (this.handInProgress) {
        throw new AppError('illegal_action', { logDetail: 'a hand is already in progress' });
      }
      // Everyone in the blind rotation, including debtors. `rotation.dealtIn` decides who is dealt.
      const entrants = this.seats.filter((seat) => seat.stack > 0 && !seat.leaving);
      if (entrants.length < 2) {
        throw new AppError('illegal_action', {
          logDetail: `a hand needs two seats with chips; this table has ${entrants.length}`,
        });
      }

      const rotation = this.nextRotation(entrants);
      const playable = entrants.filter((seat) => rotation.dealtIn.includes(seat.seat));
      // Being dealt in discharges the debt.
      for (const seat of playable) this.blindDebts.delete(seat.userId);

      const handId = this.nextHandId();
      this.handNumber += 1;

      const dealt = dealHand({
        handId,
        roomId: this.roomId,
        handNumber: this.handNumber,
        config: this.config,
        buttonSeat: rotation.buttonSeat,
        // Handed over, because a dead button or dead small blind is not a seat the engine could derive.
        blinds: { smallBlindSeat: rotation.smallBlindSeat, bigBlindSeat: rotation.bigBlindSeat },
        seats: playable.map((seat) => ({ seat: seat.seat, playerId: seat.userId, stack: seat.stack })),
        random: this.random,
      });

      this.buttonSeat = rotation.buttonSeat;
      this.blinds = rotation.positions;
      this.hand = {
        state: dealt.state,
        secret: dealt.secret,
        deal: dealRecordOf(dealt.state, playable),
        names: new Map(playable.map((seat) => [seat.seat, seat.displayName])),
      };
      this.previousMemo = this.currentMemo;
      this.currentMemo = { handId, results: new Map() };

      const applied = collector();
      applied.events.push(...this.wireEvents(dealt.events));
      // A hand can end before anyone acts (two short all-ins), and a leaver folds first.
      this.runAutomaticActions(applied);
      this.afterMutation('handStarted', applied);
      return { handId };
    });
  }

  /** The memo is checked first. See the file header. */
  submitAction(userId: string, submitted: SubmittedAction): Promise<ActionOutcome> {
    return this.enqueue(() => {
      const memoed = this.lookupMemo(submitted.actionId);
      if (memoed !== null) return memoed;

      const live = this.hand;
      if (live === null || live.state.street === 'complete') {
        throw new AppError('hand_not_active', { logDetail: 'no hand is in progress' });
      }
      if (!this.seats.some((entry) => entry.userId === userId)) {
        throw new AppError('not_seated', { logDetail: 'not seated at this table' });
      }
      // The seat comes from the HAND, found by id, so a chair's new occupant cannot act on old cards.
      const acting = live.state.seats.find((entry) => entry.playerId === userId) ?? null;
      if (acting === null || live.state.toAct !== acting.seat) {
        throw new AppError('not_your_turn', {
          logDetail:
            `${userId} acted out of turn from seat ${String(acting?.seat ?? null)}; ` +
            `waiting on ${String(live.state.toAct)}`,
        });
      }
      if (submitted.expectedSequence !== live.state.actionSequence) {
        throw new AppError('stale_action_sequence', {
          logDetail:
            `seat ${acting.seat} acted on sequence ${submitted.expectedSequence} ` +
            `but the hand is at ${live.state.actionSequence}`,
        });
      }
      const outcome = this.apply(acting.seat, submitted.action, {
        actionId: submitted.actionId,
        automatic: null,
      });
      if (outcome === null) {
        throw new AppError('illegal_action', {
          logDetail: `the engine rejected seat ${acting.seat}'s action`,
        });
      }
      return outcome;
    });
  }

  /** Releases the table. A closed table keeps no timer, no listener and no secret alive. */
  close(): void {
    this.closed = true;
    this.timer.dispose();
    this.listeners.clear();
    if (this.hand !== null) this.hand.secret = null;
    this.hand = null;
    this.currentMemo = null;
    this.previousMemo = null;
  }

  /**
   * The one place `applyAction` is called. The engine re-validates, so a bot bug, a tampered client
   * and a stale button all fail as `illegal_action`. Returns null on refusal so automatic paths log.
   */
  private apply(seat: SeatIndex, action: Action, options: ApplyOptions): ActionOutcome | null {
    const live = this.hand;
    if (live === null) return null;

    const before = live.state;
    const fact = this.publicFactFor(before, seat, action);

    let applied: { readonly state: HandState; readonly events: readonly HandEvent[] };
    try {
      applied = applyAction(before, seat, action, {
        automatic: options.automatic !== null,
        actionId: options.actionId,
      });
    } catch (error) {
      // The engine's message names seats and bet levels. Log only, never the wire.
      this.onProblem('the engine rejected an action', {
        event: 'engine-rejection',
        seat,
        error: String(error),
      });
      return null;
    }

    live.state = applied.state;
    const accumulated = collector();
    accumulated.events.push(...(options.extraEvents ?? []), ...this.wireEvents(applied.events));
    const logged = applied.state.actions.at(-1);
    accumulated.publicActions.push({ ...fact, amountPaid: logged?.amountPaid ?? 0 });
    if (logged !== undefined)
      accumulated.loggedActions.push({ ...logged, automaticReason: options.automatic });

    const outcome: ActionOutcome = { appliedSequence: applied.state.actionSequence, deduplicated: false };
    if (options.actionId !== null) this.recordMemo(options.actionId, outcome);

    this.runAutomaticActions(accumulated);
    this.afterMutation('action', accumulated);
    return outcome;
  }

  /**
   * Folds every seat whose PLAYER has stood up, in turn order, matched by the hand's recorded id.
   * Each fold shrinks the hand, so the seat-count guard bounds the loop.
   */
  private runAutomaticActions(accumulated: Applied): void {
    for (let guard = 0; guard <= this.config.maxSeats; guard += 1) {
      const live = this.hand;
      if (live === null || live.state.street === 'complete') return;
      const toAct = live.state.toAct;
      if (toAct === null) return;
      const dealt = live.state.seats.find((entry) => entry.seat === toAct);
      if (dealt === undefined) return;
      const seat = this.seats.find((entry) => entry.userId === dealt.playerId);
      if (seat === undefined || !seat.leaving) return;

      const before = live.state;
      const fact = this.publicFactFor(before, toAct, { type: 'fold' });
      let applied: { readonly state: HandState; readonly events: readonly HandEvent[] };
      try {
        applied = applyAction(before, toAct, { type: 'fold' }, { automatic: true, actionId: null });
      } catch (error) {
        this.onProblem('could not fold a seat that had left', {
          event: 'departed-seat-fold',
          seat: toAct,
          error: String(error),
        });
        return;
      }
      live.state = applied.state;
      const logged = applied.state.actions.at(-1);
      accumulated.publicActions.push({ ...fact, amountPaid: logged?.amountPaid ?? 0 });
      // `departed`, never `timeout`. No clock was involved.
      if (logged !== undefined) accumulated.loggedActions.push({ ...logged, automaticReason: 'departed' });
      accumulated.events.push(...this.wireEvents(applied.events));
    }
  }

  private applyTimeout(expiry: TurnExpiry): void {
    const live = this.hand;
    if (live === null || live.state.handId !== expiry.handId) return;
    if (live.state.street === 'complete' || live.state.toAct !== expiry.seat) return;

    // Check if free, else fold. NEVER a call. `timeoutAction` is the single definition.
    const action = timeoutAction(live.state, expiry.seat);
    const applied = this.apply(expiry.seat, action, {
      actionId: null,
      automatic: 'timeout',
      extraEvents: [{ kind: 'seatTimedOut', seat: expiry.seat }],
    });
    if (applied === null) {
      this.onProblem('the engine rejected a timeout action', {
        event: 'timeout-rejection',
        seat: expiry.seat,
      });
      // Re-armed, because `TurnTimer.fire` already cleared `armed` and `apply` returned before
      // `afterMutation`. Without this the hand freezes with `deadlineMs: null`.
      this.armTimer();
    }
  }

  private afterMutation(reason: TableChangeReason, applied: Applied): void {
    const settledStacks = this.settleIfComplete();
    this.armTimer();
    // `handStarted` is NEVER overwritten. A hand that ends before anyone acts still needs the
    // archive's `hands.start`, which is gated on that reason. Read `handCompleted` to ask if it ended.
    const published = reason === 'handStarted' || settledStacks === null ? reason : 'handComplete';
    this.publish(published, applied, settledStacks);
  }

  /**
   * Writes a finished hand's stacks back, drops the deck secret (the reveal is already built), and
   * returns the settled stacks exactly once per hand. Once, because `observeHandComplete` refuses
   * double counting. Returned rather than read back, because leavers are removed next.
   */
  private settleIfComplete(): readonly SettledStack[] | null {
    const live = this.hand;
    if (live === null || live.state.street !== 'complete') return null;
    if (this.settledHandId === live.state.handId) return null;
    this.settledHandId = live.state.handId;

    // Keyed by player id, because chips belong to people, not chairs.
    const finalStacks = new Map(live.state.seats.map((seat) => [seat.playerId, seat.stack]));
    this.seats = this.seats.map((seat) => {
      // A reset made during the hand wins over the hand's result. See `restack`.
      const stack = this.pendingRestacks.get(seat.userId) ?? finalStacks.get(seat.userId);
      return stack === undefined ? seat : { ...seat, stack };
    });
    this.pendingRestacks.clear();
    live.secret = null;

    // Read HERE, between the write-back and `removeSeats`, or departing seats vanish from it.
    const settled: readonly SettledStack[] = this.seats.map((seat) => ({
      userId: seat.userId,
      stack: seat.stack,
    }));

    const leaving = this.seats.filter((seat) => seat.leaving);
    if (leaving.length > 0) this.removeSeats(leaving);
    return settled;
  }

  /**
   * How long the seat to act gets, in seconds. At 60 s a learner could not read the Coach and act
   * (a verification pass lost two hands while reading). A seat gets `max(room clock,
   * learnerTurnSeconds)` only when it is a person and nobody else at the table is, so the extra time
   * keeps no one waiting. A bot's timer is only a safety net. The room can still allow up to 300 s.
   * The timeout still folds an abandoned seat. Leaving the first decision untimed was rejected,
   * because that is when a seat is most often abandoned.
   */
  private turnSecondsFor(toAct: SeatIndex): number {
    const configured = this.config.actionTimeoutSeconds;
    // Resolved by person. The hand's seat yields an id, and the id is looked up in the seating.
    const dealt = this.hand?.state.seats.find((seat) => seat.seat === toAct);
    if (dealt === undefined) return configured;
    const actorId = dealt.playerId;
    // Not `=== false`. An unknown seat is not evidence of a bot, and too short a clock is the worse error.
    if (this.seats.find((seat) => seat.userId === actorId)?.isBot === true) return configured;
    // Everyone at the table counts, including players waiting for the big blind.
    const anotherPersonIsWaiting = this.seats.some((seat) => seat.userId !== actorId && !seat.isBot);
    if (anotherPersonIsWaiting) return configured;
    return Math.max(configured, this.learnerTurnSeconds);
  }

  private armTimer(): void {
    const live = this.hand;
    if (live === null || live.state.street === 'complete' || live.state.toAct === null) {
      this.timer.cancel();
      return;
    }
    // Armed for bots too, as a safety net against a policy that threw.
    this.timer.arm({
      handId: live.state.handId,
      seat: live.state.toAct,
      deadlineMs: this.clock.now() + this.turnSecondsFor(live.state.toAct) * 1_000,
    });
  }

  /**
   * `settledStacks` and `departed` travel on the notice because both describe an instant that has
   * passed by the time a listener runs.
   */
  private publish(
    reason: TableChangeReason,
    applied: Applied,
    settledStacks: readonly SettledStack[] | null,
    departed: readonly string[] = [],
  ): void {
    const notice: TableNotice = {
      reason,
      events: applied.events,
      publicActions: applied.publicActions,
      loggedActions: applied.loggedActions,
      // Derived, so a completed hand always has stacks to settle.
      handCompleted: settledStacks !== null,
      settledStacks,
      departed,
      handId: this.handId,
      street: this.hand?.state.street ?? null,
      board: this.hand === null ? [] : [...this.hand.state.board],
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(notice);
      } catch (error) {
        // One throwing subscriber must not stop the table or the others.
        this.onProblem('a table subscriber threw', {
          event: 'subscriber-throw',
          error: String(error),
          reason: notice.reason,
        });
      }
    }
  }

  /** Is this PERSON in the live hand. Someone who sat after the deal leaves and is reset at once. */
  private inTheLiveHand(userId: string): boolean {
    const live = this.hand;
    return (
      live !== null &&
      live.state.street !== 'complete' &&
      live.state.seats.some((entry) => entry.playerId === userId && entry.status !== 'sittingOut')
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new AppError('room_closed', { logDetail: 'this table has been closed' });
  }

  /**
   * Frees chairs. Both callers (`stand` and `settleIfComplete`) go through here, so the `departed`
   * ids are the only release announcement. See `TableNotice.departed`.
   */
  private removeSeats(seats: readonly TableSeat[]): void {
    const removing = new Set(seats.map((seat) => seat.seat));
    this.seats = this.seats.filter((entry) => !removing.has(entry.seat));
    this.publish(
      'seating',
      {
        ...collector(),
        events: seats.map((seat) => ({ kind: 'playerLeft', displayName: seat.displayName })),
      },
      null,
      // By id, because the listener finds a `room_members` row keyed by user.
      seats.map((seat) => seat.userId),
    );
  }

  /**
   * The dead-button rule, plus one table policy. If honouring debts would leave fewer than two in the
   * hand, the game restarts with every debt discharged. Otherwise the table could never deal again.
   */
  private nextRotation(entrants: readonly TableSeat[]): BlindRotation {
    const seats = entrants.map((seat) => seat.seat).sort((left, right) => left - right);
    const previous = this.blinds;
    if (previous !== null) {
      const waiting = entrants.filter((seat) => this.blindDebts.has(seat.userId)).map((seat) => seat.seat);
      // Same call `advanceBlindRotation` makes, computed early to ask if this deals a real hand.
      const bigBlindSeat = nextOccupied(previous.bigBlindSeat, this.config.maxSeats, seats);
      const dealtIn = seats.filter((seat) => seat === bigBlindSeat || !waiting.includes(seat));
      if (dealtIn.length >= 2) {
        return advanceBlindRotation({
          previous,
          maxSeats: this.config.maxSeats,
          entrants: seats,
          awaitingBigBlind: waiting,
        });
      }
    }

    this.blindDebts.clear();
    return seedBlindRotation(this.seedButton(seats), this.config.maxSeats, seats);
  }

  /** The button a fresh rotation starts on: one seat clockwise from the last one. */
  private seedButton(occupied: readonly SeatIndex[]): SeatIndex {
    const first = occupied[0];
    if (first === undefined) {
      throw new AppError('illegal_action', { logDetail: 'no occupied seat to put the button on' });
    }
    if (this.buttonSeat === null) return first;
    return nextOccupied(this.buttonSeat, this.config.maxSeats, occupied);
  }

  private lookupMemo(actionId: string): ActionOutcome | null {
    const current = this.currentMemo?.results.get(actionId);
    if (current !== undefined) return { ...current, deduplicated: true };
    const previous = this.previousMemo?.results.get(actionId);
    if (previous !== undefined) return { ...previous, deduplicated: true };
    return null;
  }

  private recordMemo(actionId: string, outcome: ActionOutcome): void {
    const memo = this.currentMemo;
    if (memo === null) return;
    if (memo.results.size >= MAX_MEMO_ENTRIES) return;
    memo.results.set(actionId, outcome);
  }

  /**
   * Read from the state BEFORE it is applied. `raiseWasAvailable` comes from the engine's legal set,
   * because it is the 3-bet denominator. Safe because `PublicActionEvent` has no card field.
   */
  private publicFactFor(
    state: HandState,
    seat: SeatIndex,
    action: Action,
  ): Omit<PublicActionEvent, 'amountPaid'> {
    const actor = state.seats.find((entry) => entry.seat === seat);
    const committed = actor?.committedThisStreet ?? 0;
    const street = state.street;
    const observable = street === 'showdown' || street === 'complete' ? 'river' : street;
    const legal = legalActions(state, seat);
    return {
      handId: state.handId,
      seat,
      street: observable,
      action: action.type,
      toCall: Math.max(0, state.betLevel - committed),
      // The floor only prevents a divide by zero in `amountPaid / potBefore`.
      potBefore: Math.max(1, totalPotOf(state)),
      facingPreflopRaise: street === 'preflop' && state.betLevel > state.config.bigBlind,
      raiseWasAvailable: legal.some((entry) => entry.type === 'bet' || entry.type === 'raise'),
    };
  }

  /** Nothing hidden survives the mapping. */
  private wireEvents(events: readonly HandEvent[]): TableEvent[] {
    const out: TableEvent[] = [];
    const nameOf = namesFrom(this.hand?.names ?? new Map());
    for (const event of events) {
      switch (event.type) {
        case 'handStarted':
          out.push({ kind: 'handStarted', handId: event.handId, commitmentRoot: event.commitment });
          break;
        case 'forcedBetsPosted': {
          out.push({ kind: 'forcedBets', detail: forcedBetsSentence(event.forcedBets, nameOf) });
          break;
        }
        case 'actionApplied':
          out.push({
            kind: 'action',
            seat: event.action.seat,
            description: actionSentence(event.action, nameOf),
            wasAutomatic: event.action.wasAutomatic,
          });
          break;
        case 'streetAdvanced':
          out.push({
            kind: 'street',
            street: event.street,
            newCards: event.newCards.map((card) => cardToString(card)),
          });
          break;
        case 'handComplete': {
          const shown = event.result.showdowns.map((showdown) => showdownSentence(showdown, nameOf));
          if (shown.length > 0) out.push({ kind: 'showdown', summaries: shown });
          const awards = awardSentences(event.result, nameOf);
          out.push({
            kind: 'handComplete',
            summaries: awards.length > 0 ? awards : [NO_CHIPS_CHANGED_HANDS],
          });
          break;
        }
        // No wire event. One would announce hidden information, and pots are in every view.
        case 'holeCardsDealt':
        case 'potsFormed':
          break;
        default:
          break;
      }
    }
    return out;
  }
}

/**
 * Built at the deal, while starting stacks are current. `userId` is the engine's `playerId`, and the
 * seating is read only for `isBot` by that id, so a hand history never depends on who sits there later.
 */
function dealRecordOf(state: HandState, seats: readonly TableSeat[]): ArchivedDeal {
  const seated = new Map(seats.map((seat) => [seat.userId, seat]));
  return {
    handId: state.handId,
    roomId: state.roomId,
    handNumber: state.handNumber,
    buttonSeat: state.buttonSeat,
    config: state.config,
    commitmentRoot: state.commitment.root,
    commitmentContext: state.commitment.context,
    randomSourceKind: state.randomSourceKind,
    seats: state.seats.map((seat) => ({
      seat: seat.seat,
      userId: seat.playerId,
      isBot: seated.get(seat.playerId)?.isBot ?? false,
      startingStack: seat.stack + seat.committedTotal,
      holeCards: seat.holeCards === null ? null : [...seat.holeCards],
      status: seat.status,
    })),
  };
}

/** Total chips in the middle, including the current street. Local, so the state stays private. */
function totalPotOf(state: HandState): number {
  return state.seats.reduce((sum, seat) => sum + seat.committedThisStreet, state.potFromPreviousStreets);
}

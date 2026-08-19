/**
 * One live table: the authoritative `HandState`, the seating around it, and the queue that
 * makes both safe to touch.
 *
 * ###########################################################################
 * ##  EVERY MUTATION GOES THROUGH ONE ASYNC QUEUE PER TABLE.               ##
 * ##                                                                       ##
 * ##  `sit`, `stand`, `startHand`, `submitAction` and the turn-timer expiry ##
 * ##  are all `enqueue(...)`d, so the engine's reducer is never re-entered  ##
 * ##  concurrently for the same hand. This is THE correctness requirement   ##
 * ##  of this file (ARCHITECTURE.md section 8).                             ##
 * ##                                                                       ##
 * ##  Why it is needed even though `applyAction` is synchronous: the        ##
 * ##  callers are not. Two sockets, a bot's thinking delay and a fired      ##
 * ##  timer are four independent async contexts, and every `await` in a     ##
 * ##  handler is a point at which another of them runs. Without the queue,  ##
 * ##  two submissions that each read `actionSequence` 41 could both pass    ##
 * ##  their own checks and then apply, and the second would land on a state ##
 * ##  its submitter never saw. `expectedSequence` catches that only if the  ##
 * ##  two are ordered; the queue is what orders them.                      ##
 * ###########################################################################
 *
 * ## What leaves this object
 *
 * `viewFor(userId)` returns `redactFor(state, { viewerPlayerId: userId })`, and there is no other
 * way out. No method returns a `HandState`, a `DeckSecret`, a deck, a salt or another seat's
 * cards, and the public action facts emitted for the bots' opponent models (`PublicActionEvent`)
 * have nowhere to put a card — that type has no card field, by construction (see `@prl/poker-ai`'s
 * `opponent-model.ts`, which says so for exactly this reason).
 *
 * ###########################################################################
 * ##  A SEAT INDEX IS A POSITION. A USER ID IS A PERSON. ENTITLEMENT IS     ##
 * ##  DECIDED BY THE PERSON, EVERY TIME.                                    ##
 * ##                                                                        ##
 * ##  This table holds two rosters that can disagree: `this.seats`, which is ##
 * ##  who is sitting here *now*, and `this.hand.state.seats`, which is who   ##
 * ##  was dealt in *then* — pinned by the engine at deal time and never      ##
 * ##  mutated afterwards. Between hands they diverge for real: somebody      ##
 * ##  stands, somebody else takes the chair, and seat 3 is now a different   ##
 * ##  human being than the seat 3 still sitting in the finished hand.        ##
 * ##                                                                        ##
 * ##  So nothing here translates a user id into a seat index and then uses   ##
 * ##  the index to decide what that user may see or do. `viewFor` hands the  ##
 * ##  user id straight to `redactFor`, which resolves it against the hand's  ##
 * ##  own dealt roster; `submitAction` finds the actor's seat in the hand by ##
 * ##  id; settlement pays chips to ids. The lookups that remain by index are ##
 * ##  the ones that are genuinely about the chair (`sit`, `isSeatFree`,      ##
 * ##  the button), and none of them decides entitlement.                     ##
 * ###########################################################################
 *
 * ## How long a finished hand is kept, and why that is safe
 *
 * `this.hand` is NOT cleared when a hand completes. It is kept until the next deal replaces it,
 * because the completed `HandState` is what every terminal frame is built from — the showdown, the
 * awards, the Merkle reveal — and a client that reconnects between hands, or that was mid-reconnect
 * when the river landed, has to be able to ask for it. `archivedDeal()` and `archivedResult()` read
 * it too, after the fact.
 *
 * Retention is what gave the seat-reuse bug something to leak *from*, so it is worth being exact
 * about why it is now inert: a retained hand carries its own roster, `seats[].playerId`, written
 * once by `startHand` and never touched by `applyAction`. Entitlement is resolved against that and
 * only that. A hand can therefore be kept for as long as it is useful without the current seating
 * being able to reach into it — which is a much better property than a shorter retention window,
 * because a window only shrinks the race, and this closes it.
 *
 * ## The deck secret
 *
 * `startHand` hands back a `DeckSecret` — the shuffled deck and the 52 Merkle salts. It is held
 * in a private field, never persisted (there is no column, and
 * `db/migrations/0001_initial.sql` explains at length why there never will be), never logged,
 * and dropped the moment the hand completes and the engine has built the reveal from it. The
 * `HandState` carries the same two secrets and dies with the hand: an interrupted hand is
 * deliberately unrecoverable, which is a much cheaper failure than a schema that could leak the
 * cards nobody was entitled to see.
 *
 * ## Idempotency, exactly
 *
 * A submission is looked up in a per-hand memo of `actionId -> outcome` BEFORE any legality
 * check. For a *new* action the order of checks is then the one the brief specifies: it is that
 * seat's turn, `expectedSequence` matches, then `applyAction`. The memo is hoisted above them
 * deliberately, because a retry of an action that already applied necessarily fails both — the
 * hand has moved on, so the sequence is stale, and it is usually somebody else's turn — so
 * checking them first would answer a dropped-response retry with `not_your_turn` or
 * `stale_action_sequence`, which is precisely the failure `actionId` exists to prevent. A
 * duplicate returns the ORIGINAL outcome with `deduplicated: true`. Nothing is applied twice
 * and nothing about a duplicate is an error.
 *
 * The memo mirrors the partial unique index on `(hand_id, action_id)`: the index is what makes
 * double application impossible across processes; this makes a retry correct and cheap inside
 * one, and it is also what lets the socket answer a retry with the sequence the original was
 * applied at.
 *
 * ###########################################################################
 * ##  THE BIG BLIND ADVANCES BY ONE LIVE PLAYER PER HAND. EVERYTHING ELSE   ##
 * ##  ABOUT THE ROTATION FOLLOWS FROM THAT.                                 ##
 * ##                                                                        ##
 * ##  This table used to advance the BUTTON by one occupied seat and read    ##
 * ##  the blinds off it as button + 1 / button + 2 among whoever happened to ##
 * ##  be seated at that instant. That is correct for one hand and wrong for  ##
 * ##  a sequence of them: seat somebody between the button and the blinds    ##
 * ##  and the assignment shifts backwards onto players who have already      ##
 * ##  paid. Measured over 40 hands with a join/leave schedule, six players   ##
 * ##  paid the big blind twice in a row and one skipped it entirely          ##
 * ##  (`docs/audit/poker-correctness.md`, P1-1). Two consecutive big blinds  ##
 * ##  cost `2 x BB` where the rules charge `BB + SB`.                        ##
 * ##                                                                        ##
 * ##  `nextRotation` now runs the dead-button rule out of the engine's       ##
 * ##  `advanceBlindRotation`: the big blind moves one seat forward in the    ##
 * ##  rotation, the small blind falls where the big blind was, the button    ##
 * ##  falls where the small blind was, and either of the last two is DEAD    ##
 * ##  when nobody in the hand is sitting there. A dead button and a dead     ##
 * ##  small blind are correct outcomes, not errors, and the engine's         ##
 * ##  `startHand` takes both as inputs so neither has to be re-derived.      ##
 * ###########################################################################
 *
 * ## What an arriving player owes, and why "wait for the big blind"
 *
 * Nothing used to track blind obligations, so a player could sit down anywhere and be dealt
 * straight in — including on the button, for free, having paid nothing. Standing up as the blinds
 * approached and sitting back down afterwards was unpunished (P1-2: four of fifteen seating
 * combinations gave the newcomer a completely free hand, twice on the button).
 *
 * The two standard remedies are "post an amount equivalent to the blind you missed" and "wait for
 * the big blind to reach you". This table implements the second, for all entries, and the choice
 * is deliberate rather than expedient:
 *
 *   - It needs no new kind of money. Posting a missed blind means a DEAD big blind — money that
 *     goes to the pot without buying any part of the current bet — which is a forced-bet kind the
 *     engine does not have, a `hand_actions` shape the schema does not have, and a rule the Coach
 *     would then have to teach. Waiting costs a player nothing but time.
 *   - It cannot be gamed. The obligation is keyed by USER ID in `blindDebts` and is NOT cleared by
 *     standing up, so leaving as the blinds approach and returning afterwards leaves the debt
 *     exactly where it was: the player still sits out until the big blind reaches their seat.
 *   - This is play money. Nobody is protected from an unfair edge by being made to pay; the point
 *     of the rule here is that the rotation is honest and the learner sees a real one.
 *
 * The one case where waiting cannot apply is a table that would be left with fewer than two
 * players in the hand. There the game restarts: every obligation is discharged, the rotation is
 * re-seeded, and everyone posts normally — which is what a card room does when a game breaks and
 * re-forms, and is the only alternative to a table that can never deal again.
 */

import type { WsEvent } from '@prl/contracts';
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
import { type Clock, type TurnExpiry, TurnTimer } from './timers.ts';

/** The wire event payload, without the envelope the hub adds. */
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

/** Why the table changed. Used for logging and for deciding whether a bot should look. */
export type TableChangeReason = 'seating' | 'handStarted' | 'action' | 'handComplete';

/**
 * One change, fanned out to whoever is watching.
 *
 * Carries public events and public action facts — never state. A subscriber that wants state
 * calls `viewFor(itsOwnUserId)`, which is the only path there is.
 */
export interface TableNotice {
  readonly reason: TableChangeReason;
  readonly events: readonly TableEvent[];
  /** For the bots' opponent models. No cards: `PublicActionEvent` has no field for one. */
  readonly publicActions: readonly PublicActionEvent[];
  /**
   * The engine's own log entries for the actions applied on this change, for the archive.
   *
   * Safe to hand out: a `LoggedAction` carries a seat, an action and amounts, and no card. It is
   * already in every `PlayerView.actions`, so this is public information in a shape the
   * persistence layer can write directly.
   */
  readonly loggedActions: readonly LoggedAction[];
  /** True on the one notice that carried a hand to completion. */
  readonly handCompleted: boolean;
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

/**
 * Everything the database needs about a deal.
 *
 * `prl.hand_seats.hole_cards` exists, so hole cards *are* persisted — that is what makes a hand
 * review possible — and they are read back only under `user_id = :viewer OR showed_down`. The deck
 * and the salts are a different matter and appear nowhere here.
 */
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

/** Seat-level facts the registry needs in order to build a `RoomSummary`. */
export interface TableSnapshot {
  readonly seats: readonly TableSeat[];
  readonly handInProgress: boolean;
  readonly handNumber: number;
  /**
   * Where the button sat for the most recent hand, or where it will be seeded from.
   *
   * Under the dead-button rule this can name a seat nobody is sitting in: that is what a dead
   * button IS, and reporting the next occupied seat instead would be reporting a lie.
   */
  readonly buttonSeat: SeatIndex | null;
  /**
   * Seats that owe a blind and are therefore not being dealt in yet.
   *
   * Public, because it is not hidden information — everyone at a real table can see who is sitting
   * out waiting for the blind — and because a client that does not render it shows a seated player
   * who mysteriously receives no cards.
   */
  readonly awaitingBigBlind: readonly SeatIndex[];
  /** Absolute server time by which the seat to act must act, or null. */
  readonly deadlineMs: number | null;
}

export interface LiveTableOptions {
  readonly roomId: string;
  readonly config: TableConfig;
  readonly clock: Clock;
  /**
   * The source cards are dealt from: `createSecureRandom()` in production. A table is never
   * handed the deterministic generator, and every hand records which kind it was dealt from.
   */
  readonly random: RandomSource;
  /** Generates `hand_...` ids. Injected so a test can read the ids it asserts on. */
  readonly nextHandId: () => string;
  /**
   * Hands already played in this room, so the next one continues the numbering.
   *
   * `hands_room_hand_number_key` is unique per room, and a table re-opened after a restart starts
   * from zero unless it is told otherwise — which would make the first deal collide.
   */
  readonly initialHandNumber?: number;
  /**
   * The blind positions this room was last playing under, for a table re-opened after a restart.
   *
   * Without it the rotation silently resets to the first seat to sit down, which hands somebody a
   * second big blind across the restart boundary — `prl.hands.button_seat` is persisted precisely
   * so that it does not have to. See `RoomRegistry.open`, which reconstructs this.
   */
  readonly initialBlinds?: BlindPositions;
  /**
   * Floor on a lone person's turn clock, in seconds. Defaults to `DEFAULT_LEARNER_TURN_SECONDS`.
   *
   * Optional because it is a policy about learners rather than a property of the room, and
   * because every existing caller wants the default. Supply it from `AppConfig.learnerTurnSeconds`
   * to make `LEARNER_TURN_SECONDS` effective for a deployment; supply it directly to drive the
   * clock in a test. It applies to exactly one situation — a person at a table where everybody
   * else is a bot — which `turnSecondsFor` sets out at length.
   */
  readonly learnerTurnSeconds?: number;
  /** Non-fatal problems: a subscriber that threw, a rejected timeout. Never given a card. */
  readonly onProblem?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
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
  /**
   * The deal as it was, captured once.
   *
   * Held rather than recomputed because the stacks in `state` move as the hand progresses, and the
   * archive wants the stacks each seat *started* with.
   */
  readonly deal: ArchivedDeal;
}

/**
 * What an arriving player owes before they may be dealt in.
 *
 * Keyed by user id rather than by seat, and deliberately not cleared when they stand up: a debt
 * that lived on the chair would be discharged by the act of leaving it, which is exactly the dodge
 * this exists to close.
 */
interface BlindDebt {
  /** The hand number this table had reached when the obligation was incurred. */
  readonly since: number;
}

interface ApplyOptions {
  readonly actionId: string | null;
  readonly automatic: boolean;
  /** Events to publish alongside the engine's own, e.g. `seatTimedOut`. */
  readonly extraEvents?: readonly TableEvent[];
}

/**
 * What one mutation accumulated, before it is published.
 *
 * One object rather than three parallel arrays, because the three are filled together for every
 * applied action and a caller that forgot one would publish a notice the archive or the opponent
 * models silently missed.
 */
interface Applied {
  readonly events: TableEvent[];
  readonly publicActions: PublicActionEvent[];
  readonly loggedActions: LoggedAction[];
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
  private readonly onProblem: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
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
  /** The hand whose stacks have already been written back, so settlement happens once. */
  private settledHandId: string | null = null;
  private closed = false;

  /** The serialisation point. See the banner at the top of this file. */
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
        // Queued, never applied inline: the timer fires from the event loop and has to take its
        // turn behind whatever mutation is already in flight.
        this.enqueue(() => this.applyTimeout(expiry)).catch((error: unknown) => {
          this.onProblem('turn timeout could not be applied', { error: String(error) });
        });
      },
    });
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  /**
   * Runs `work` after everything already queued for this table.
   *
   * The returned promise rejects to the caller while the chain itself swallows the rejection.
   * Without that split, one `illegal_action` would wedge the table for good — and a table that
   * stops accepting actions after a single rejected one is a far worse failure than the error.
   */
  private enqueue<T>(work: () => T): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // Reads: synchronous, and therefore always of a consistent state
  // -------------------------------------------------------------------------

  /**
   * The redacted view for one user. **The only way state leaves this object.**
   *
   * The user id goes to `redactFor` untranslated — deliberately, and this is the whole fix for the
   * seat-reuse leak. There is no seat lookup here to get wrong, and no seat index in scope for a
   * future edit to reach for: `this.seats` is not consulted at all. Whether the caller is dealt
   * into this hand is a question only the hand can answer, and `redactFor` asks it of the hand's
   * own roster.
   *
   * Somebody who is not in this hand — a spectator, a player who sat down after the deal, or the
   * new occupant of a chair whose previous owner played it — gets the spectator view
   * (`viewerSeat: null`), which shows no hole cards at all except those actually shown down. Null
   * before the first deal.
   */
  viewFor(userId: string): PlayerView | null {
    if (this.hand === null) return null;
    return redactFor(this.hand.state, { viewerPlayerId: userId });
  }

  snapshot(): TableSnapshot {
    const live = this.hand?.state ?? null;
    const seats = this.seats.map((seat) => {
      // By id, not by index. A finished hand outlives its seating, so the seat 3 in a retained
      // hand may belong to somebody who has since left — and reporting their closing stack as the
      // new occupant's would conjure or destroy chips in every member list on the table.
      const inHand = live?.seats.find((entry) => entry.playerId === seat.userId);
      // Mid-hand the chips are split between what is behind and what is already committed. The
      // table figure has to be the sum, or a member list appears to lose chips during a hand.
      if (inHand === undefined) return seat;
      return { ...seat, stack: inHand.stack + inHand.committedThisStreet };
    });
    return {
      seats,
      handInProgress: this.handInProgress,
      handNumber: this.handNumber,
      buttonSeat: this.buttonSeat,
      // Derived from `blindDebts` at read time rather than stored on the seat, so there is one
      // source of truth for the obligation and no second copy to drift out of step with it.
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
   * True while this player still owes a blind and is therefore not being dealt in.
   *
   * By user id, because the obligation belongs to the person: it survives standing up, taking a
   * different chair, and coming back three hands later.
   */
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
   * The current deal, for the persistence layer.
   *
   * ## This and `archivedResult` are the only methods that return hole cards
   *
   * They exist because `prl.hand_seats.hole_cards` exists: a learner reviewing their own hand has
   * to be able to see what they held, and a seat that showed at showdown is public. Both records
   * are for the database and nothing else — no socket frame is built from them, and the read path
   * back out (`src/routes/hands.ts`) carries `user_id = :viewer OR showed_down` in the SQL. The
   * deck, the cursor and the salts appear in neither, because there is no column for them and
   * never will be.
   */
  archivedDeal(): ArchivedDeal | null {
    return this.hand?.deal ?? null;
  }

  /** The completed hand, for the persistence layer. Null until the hand is complete. */
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
        // From `HandResult.showdowns` and nothing else: a seat that folded is not "showing"
        // merely because the hand is over, and this flag is what opens its cards to the table.
        showedDown: shown.has(seat.seat),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Seats a player.
   *
   * Legality that belongs to the *room* — is the caller a member, do they hold enough units — is
   * the registry's business. This enforces only what the table itself knows.
   *
   * Arriving at a table with a rotation already running incurs a blind obligation: the player is
   * seated, and is dealt in on the hand the big blind reaches their seat and not before. See the
   * file comment for why waiting is the remedy chosen over posting.
   */
  sit(request: {
    readonly userId: string;
    readonly displayName: string;
    readonly seat: SeatIndex;
    readonly stack: number;
    readonly isBot?: boolean;
    readonly botProfile?: string | null;
    /**
     * True when this seat is being re-taken exactly as it stood before a restart.
     *
     * Such a player is already in the rotation and owes nothing — they were being dealt in a
     * minute ago. Only the registry's re-open path passes it; a player sitting down of their own
     * accord never does.
     *
     * The honest limit: an obligation that was outstanding when the process died is not persisted
     * (there is no column for it), so a player who was waiting for the big blind is re-seated as
     * though they had already paid. That costs at most one hand's blind, once, per restart.
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
      // The first player to sit seeds the button, so the first hand deals it to the seat after
      // them, exactly as it always has. Afterwards this holds the last hand's button.
      this.buttonSeat ??= seat.seat;
      // A rotation is running as soon as one hand has been dealt, and only then is there anybody
      // who has already paid for this player to jump ahead of. `has` first so that a player who
      // stood up owing a blind and came back keeps the debt they already had, with its original
      // `since` — the whole point is that the round trip changes nothing.
      if (this.blinds !== null && request.resumingSeat !== true && !this.blindDebts.has(seat.userId)) {
        this.blindDebts.set(seat.userId, { since: this.handNumber + 1 });
      }
      this.publish(
        'seating',
        { ...collector(), events: [{ kind: 'playerJoined', displayName: seat.displayName }] },
        false,
      );
      return seat;
    });
  }

  /**
   * Stands a player up.
   *
   * Somebody holding a live hand does not escape their bet: the seat is flagged `leaving`, folds
   * automatically at its next turn (or immediately, if it is already its turn), and is removed
   * from the seating when the hand completes. Pulling them out of the hand outright would mean
   * rewriting a `HandState` behind the engine's back, and this architecture has no such
   * side-channel — every change to a hand is an action the engine validated.
   *
   * A seat that has *already* folded or is all-in waits the same way rather than leaving at once.
   * It has nothing left to decide, but it still has chips in the pot and a settled stack coming,
   * and removing it now would drop it from the write-back in `settleIfComplete` — so its recorded
   * stack would silently keep its pre-hand value and the chips it committed would be conjured out
   * of nothing.
   */
  stand(userId: string): Promise<void> {
    return this.enqueue(() => {
      const seat = this.seats.find((entry) => entry.userId === userId);
      if (seat === undefined) throw new AppError('not_seated', { logDetail: 'not seated at this table' });

      const live = this.hand;
      // "Is this PERSON in the live hand", not "is this chair in it". The two differ for somebody
      // who sat down after the deal: they hold no cards and owe nothing, so they leave at once
      // rather than being held to the end of a hand they were never part of.
      const inTheLiveHand =
        live !== null &&
        live.state.street !== 'complete' &&
        live.state.seats.some((entry) => entry.playerId === userId && entry.status !== 'sittingOut');

      if (!inTheLiveHand) {
        this.removeSeats([seat]);
        return;
      }

      // Flagged by id, like everything else that is about a player rather than a chair. Identical
      // to matching on the index here — a user holds at most one seat — and identical for the same
      // reason the index version was correct right up until it was not.
      this.seats = this.seats.map((entry) => (entry.userId === userId ? { ...entry, leaving: true } : entry));
      const applied = collector();
      this.runAutomaticActions(applied);
      this.afterMutation('action', applied);
    });
  }

  /** Deals the next hand. */
  startHand(): Promise<{ readonly handId: string }> {
    return this.enqueue(() => {
      this.assertOpen();
      if (this.handInProgress) {
        throw new AppError('illegal_action', { logDetail: 'a hand is already in progress' });
      }
      // Everyone in the blind rotation: seated, with chips, not on the way out. Players who owe a
      // blind are IN this list — that is how the rotation reaches them and collects it — but they
      // are not necessarily dealt in, which is what `rotation.dealtIn` decides.
      const entrants = this.seats.filter((seat) => seat.stack > 0 && !seat.leaving);
      if (entrants.length < 2) {
        throw new AppError('illegal_action', {
          logDetail: `a hand needs two seats with chips; this table has ${entrants.length}`,
        });
      }

      const rotation = this.nextRotation(entrants);
      const playable = entrants.filter((seat) => rotation.dealtIn.includes(seat.seat));
      // Being dealt in discharges the obligation: the seat the big blind landed on is paying it
      // right now, and every other dealt-in seat never owed one.
      for (const seat of playable) this.blindDebts.delete(seat.userId);

      const handId = this.nextHandId();
      this.handNumber += 1;

      const dealt = dealHand({
        handId,
        roomId: this.roomId,
        handNumber: this.handNumber,
        config: this.config,
        buttonSeat: rotation.buttonSeat,
        // Handed over rather than derived. A dead button is not a seat the engine could find a
        // player in, and a dead small blind is not a seat it should charge.
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
      };
      this.previousMemo = this.currentMemo;
      this.currentMemo = { handId, results: new Map() };

      const applied = collector();
      applied.events.push(...this.wireEvents(dealt.events));
      // A hand can be over before anybody acts — two seats both all-in for less than the blind —
      // and a seat that stood up between hands folds before the first real decision.
      this.runAutomaticActions(applied);
      this.afterMutation('handStarted', applied);
      return { handId };
    });
  }

  /**
   * Applies one submitted action, or answers a duplicate with the outcome the original had.
   *
   * The order of the checks, and why the memo comes first, is in the file comment.
   */
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
      // The seat comes from the HAND, found by id. Reading it off the current seating instead is
      // how a chair's new occupant would end up acting on the previous occupant's cards; a player
      // who is at the table but was not dealt in has no seat here at all, and is simply not to act.
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
        automatic: false,
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

  // -------------------------------------------------------------------------
  // Applying an action
  // -------------------------------------------------------------------------

  /**
   * The one place `applyAction` is called.
   *
   * The engine re-derives the legal set through `validateAction`, so a bug in a bot policy, a
   * tampered client and a stale button on an honest client all fail the same way: the engine
   * throws, the state is untouched, and the caller is told `illegal_action`. Returns null when
   * the engine refused, so the automatic paths can log rather than throw into the event loop.
   */
  private apply(seat: SeatIndex, action: Action, options: ApplyOptions): ActionOutcome | null {
    const live = this.hand;
    if (live === null) return null;

    const before = live.state;
    const fact = this.publicFactFor(before, seat, action);

    let applied: { readonly state: HandState; readonly events: readonly HandEvent[] };
    try {
      applied = applyAction(before, seat, action, {
        automatic: options.automatic,
        actionId: options.actionId,
      });
    } catch (error) {
      // The engine's message names seats, bet levels and amounts: useful in a log, never on the
      // wire. `logDetail` and `cause` are server-side only — see errors.ts.
      this.onProblem('the engine rejected an action', { seat, error: String(error) });
      return null;
    }

    live.state = applied.state;
    const accumulated = collector();
    accumulated.events.push(...(options.extraEvents ?? []), ...this.wireEvents(applied.events));
    const logged = applied.state.actions.at(-1);
    accumulated.publicActions.push({ ...fact, amountPaid: logged?.amountPaid ?? 0 });
    if (logged !== undefined) accumulated.loggedActions.push(logged);

    const outcome: ActionOutcome = { appliedSequence: applied.state.actionSequence, deduplicated: false };
    if (options.actionId !== null) this.recordMemo(options.actionId, outcome);

    // A seat that has stood up folds as soon as the action reaches it, so a client never sees a
    // table waiting on somebody who has left.
    this.runAutomaticActions(accumulated);
    this.afterMutation('action', accumulated);
    return outcome;
  }

  /**
   * Folds every seat whose PLAYER has stood up but is still holding cards, in turn order.
   *
   * Bounded by the seat count: each iteration applies exactly one fold, and a fold strictly
   * reduces the number of seats still in the hand, so this cannot spin.
   *
   * The `leaving` flag is looked up by the id the hand recorded for the seat, not by the chair.
   * Folding somebody's hand because a *different* person who now holds that chair asked to leave
   * would be the same class of mistake as showing them the cards.
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
        this.onProblem('could not fold a seat that had left', { seat: toAct, error: String(error) });
        return;
      }
      live.state = applied.state;
      const logged = applied.state.actions.at(-1);
      accumulated.publicActions.push({ ...fact, amountPaid: logged?.amountPaid ?? 0 });
      if (logged !== undefined) accumulated.loggedActions.push(logged);
      accumulated.events.push(...this.wireEvents(applied.events));
    }
  }

  /** The timer fired. Check it still describes this hand and this seat, then act. */
  private applyTimeout(expiry: TurnExpiry): void {
    const live = this.hand;
    if (live === null || live.state.handId !== expiry.handId) return;
    if (live.state.street === 'complete' || live.state.toAct !== expiry.seat) return;

    // Check if that is free, otherwise fold — NEVER a call. Silently spending the chips of
    // somebody whose connection dropped would be indefensible, and the engine's `timeoutAction`
    // is the single definition of that rule.
    const action = timeoutAction(live.state, expiry.seat);
    const applied = this.apply(expiry.seat, action, {
      actionId: null,
      automatic: true,
      extraEvents: [{ kind: 'seatTimedOut', seat: expiry.seat }],
    });
    if (applied === null) {
      this.onProblem('the engine rejected a timeout action', { seat: expiry.seat });
    }
  }

  // -------------------------------------------------------------------------
  // After every mutation: settle, arm the timer, publish
  // -------------------------------------------------------------------------

  private afterMutation(reason: TableChangeReason, applied: Applied): void {
    const completed = this.settleIfComplete();
    this.armTimer();
    this.publish(completed ? 'handComplete' : reason, applied, completed);
  }

  /**
   * Writes a finished hand's stacks back to the seating and drops the deck secret.
   *
   * The secret goes here rather than at the next deal because this is the moment it stops being
   * needed: the engine has already built the reveal for the cards that legitimately became
   * public, and everything still sealed must stay sealed forever — including from us.
   *
   * Returns true exactly once per hand, so a subscriber cannot fold the same hand into its
   * counters twice (which `@prl/poker-ai`'s `observeHandComplete` refuses outright, and rightly:
   * double counting corrupts every rate at once while looking completely normal).
   */
  private settleIfComplete(): boolean {
    const live = this.hand;
    if (live === null || live.state.street !== 'complete') return false;
    if (this.settledHandId === live.state.handId) return false;
    this.settledHandId = live.state.handId;

    // Keyed by player id: chips belong to people, not to chairs. A seat that changed hands would
    // otherwise be paid its predecessor's closing stack.
    const finalStacks = new Map(live.state.seats.map((seat) => [seat.playerId, seat.stack]));
    this.seats = this.seats.map((seat) => {
      const stack = finalStacks.get(seat.userId);
      return stack === undefined ? seat : { ...seat, stack };
    });
    live.secret = null;

    const leaving = this.seats.filter((seat) => seat.leaving);
    if (leaving.length > 0) this.removeSeats(leaving);
    return true;
  }

  /**
   * How long the seat currently to act gets, in seconds.
   *
   * ## The problem this solves
   *
   * At `action_timeout_seconds = 60` the product's two headline features were in direct tension:
   * you could read the analysis or you could act, not both. The Coach panel a learner is *meant
   * to read at that moment* runs to thousands of characters plus a five-row EV table and a
   * card-by-card table with one row per unseen card — several minutes of reading — and a
   * browser-level verification pass lost two hands to `seat 0 | fold | was_automatic = t` while
   * the learner was reading it. Nothing was hidden (the countdown is on screen, and folding
   * rather than calling on expiry is the correct rule) and the clock was still shorter than the
   * thing it was asking the learner to read.
   *
   * ## The rule
   *
   * A seat gets the longer of the room's clock and `learnerTurnSeconds` when, and only when, all
   * three of these hold:
   *
   *   1. **the seat is a person.** A bot has nothing to read and acts inside its thinking delay;
   *      for a bot the timer is only a safety net against a policy that threw, and four minutes
   *      is four minutes of a frozen table before that net catches anything;
   *   2. **nobody else at the table is a person.** This is the clause that keeps the extra time
   *      free. The audited spot is a play-money educational table against bots with nothing at
   *      stake, where a longer clock costs exactly nothing because bots do not get bored. Put a
   *      second human in the room and it stops being free: the room's `action_timeout_seconds`
   *      is the pace everybody there agreed to, and one player's reading time is now everybody's
   *      waiting time. That room can still configure up to 300 seconds for itself;
   *   3. **the room's own clock is shorter.** `Math.max`, so a room that deliberately allows
   *      longer keeps what it chose. This raises a clock that is too short; it never lowers one.
   *
   * The timeout mechanism itself is untouched, deliberately. An abandoned seat still folds — a
   * clock that never expires lets one absent player stall a table forever, which is a worse
   * failure than the one being fixed here. `DEFAULT_LEARNER_TURN_SECONDS` in `../config.ts`
   * carries the number and why it is that number.
   *
   * ## The alternative that was rejected
   *
   * Leaving the first decision of a hand untimed. The first decision is precisely when a seat is
   * most likely to have been abandoned — the tab was closed before the hand started — so an
   * untimed first action is the stall above, on the most common path to it.
   */
  private turnSecondsFor(toAct: SeatIndex): number {
    const configured = this.config.actionTimeoutSeconds;
    // Resolved by PERSON, not by chair: the hand's roster is pinned at deal time, so the seat
    // index is looked up in the hand and the id it yields is looked up in the seating. Reading
    // `this.seats[toAct]` directly would ask who is sitting there *now*, which is a different
    // question and the class of bug the banner at the top of this file exists to prevent.
    const dealt = this.hand?.state.seats.find((seat) => seat.seat === toAct);
    if (dealt === undefined) return configured;
    const actorId = dealt.playerId;
    // Not `=== false`: a seat the current seating has lost track of is not evidence of a bot, and
    // the two failure directions are not symmetric. Too long a clock costs a table some waiting;
    // too short a clock folds a hand out from under somebody who was reading.
    if (this.seats.find((seat) => seat.userId === actorId)?.isBot === true) return configured;
    // Everyone at the table, not only those dealt into this hand: a player waiting for the big
    // blind is sitting there watching, and is kept waiting by a long clock exactly as a player in
    // the hand is.
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
    // Armed for bots as well as people. A bot is expected to act well inside its thinking delay,
    // so for a bot the timer is a safety net: a policy that threw would otherwise freeze the
    // table until somebody noticed.
    this.timer.arm({
      handId: live.state.handId,
      seat: live.state.toAct,
      deadlineMs: this.clock.now() + this.turnSecondsFor(live.state.toAct) * 1_000,
    });
  }

  private publish(reason: TableChangeReason, applied: Applied, handCompleted: boolean): void {
    const notice: TableNotice = {
      reason,
      events: applied.events,
      publicActions: applied.publicActions,
      loggedActions: applied.loggedActions,
      handCompleted,
      handId: this.handId,
      street: this.hand?.state.street ?? null,
      board: this.hand === null ? [] : [...this.hand.state.board],
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(notice);
      } catch (error) {
        // A subscriber that throws must not take the table with it, and must not stop the other
        // subscribers from being told.
        this.onProblem('a table subscriber threw', { error: String(error), reason: notice.reason });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new AppError('room_closed', { logDetail: 'this table has been closed' });
  }

  private removeSeats(seats: readonly TableSeat[]): void {
    const removing = new Set(seats.map((seat) => seat.seat));
    this.seats = this.seats.filter((entry) => !removing.has(entry.seat));
    this.publish(
      'seating',
      {
        ...collector(),
        events: seats.map((seat) => ({ kind: 'playerLeft', displayName: seat.displayName })),
      },
      false,
    );
  }

  /**
   * Where the blinds fall for the hand about to be dealt.
   *
   * The dead-button rule, with one table-level policy the engine has no business knowing about:
   * when honouring the outstanding obligations would leave fewer than two players in the hand, the
   * game restarts. Every debt is discharged, the rotation is re-seeded from the last button, and
   * everybody posts normally. The alternative is a table that can never deal again — one player
   * live, one waiting, and no hand to advance the rotation that would end the wait — which is a
   * far worse failure than a player being dealt in a hand or two early at a table of two.
   */
  private nextRotation(entrants: readonly TableSeat[]): BlindRotation {
    const seats = entrants.map((seat) => seat.seat).sort((left, right) => left - right);
    const previous = this.blinds;
    if (previous !== null) {
      const waiting = entrants.filter((seat) => this.blindDebts.has(seat.userId)).map((seat) => seat.seat);
      // The big blind is computed here as well as inside `advanceBlindRotation` so that "would
      // this deal a real hand?" can be answered before committing to it. It is the same call on
      // the same inputs, so the two cannot disagree.
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

    // A fresh game. Nobody has paid anything yet under this rotation, so nobody can be charged
    // twice and nobody owes anything.
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
   * The public facts about an action, read from the state BEFORE it is applied.
   *
   * `raiseWasAvailable` comes off the engine's own legal set rather than being guessed, because
   * it is the denominator of the 3-bet frequency: after a short all-in raising genuinely is not
   * available, and counting that turn as a declined opportunity would understate every seat's
   * aggression. Building this from privileged state is safe precisely because
   * `PublicActionEvent` has nowhere to put a card.
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
      // Blinds are always positive, so the real pot is never 0 here; the floor is only there so
      // that the observer's `amountPaid / potBefore` can never divide by zero.
      potBefore: Math.max(1, totalPotOf(state)),
      facingPreflopRaise: street === 'preflop' && state.betLevel > state.config.bigBlind,
      raiseWasAvailable: legal.some((entry) => entry.type === 'bet' || entry.type === 'raise'),
    };
  }

  /** Turns the engine's events into wire events. Nothing hidden survives the mapping. */
  private wireEvents(events: readonly HandEvent[]): TableEvent[] {
    const out: TableEvent[] = [];
    for (const event of events) {
      switch (event.type) {
        case 'handStarted':
          out.push({ kind: 'handStarted', handId: event.handId, commitmentRoot: event.commitment });
          break;
        case 'forcedBetsPosted': {
          const detail = event.forcedBets
            .map((bet) => `${bet.kind} ${bet.amount} from seat ${bet.seat}${bet.wasShort ? ' (short)' : ''}`)
            .join(', ');
          out.push({ kind: 'forcedBets', detail: detail === '' ? 'no forced bets' : detail });
          break;
        }
        case 'actionApplied':
          out.push({
            kind: 'action',
            seat: event.action.seat,
            description: describeAction(event.action),
            wasAutomatic: event.action.wasAutomatic,
          });
          break;
        case 'streetAdvanced':
          // Board cards are public the moment they are dealt: that is what a street is.
          out.push({
            kind: 'street',
            street: event.street,
            newCards: event.newCards.map((card) => cardToString(card)),
          });
          break;
        case 'handComplete': {
          // Only seats that actually showed appear in `showdowns`, so a hand that ended in a fold
          // produces no card here at all.
          const shown = event.result.showdowns.map(
            (showdown) => `seat ${showdown.seat} shows ${showdown.description}`,
          );
          if (shown.length > 0) out.push({ kind: 'showdown', summaries: shown });
          const awards = event.result.awards.map(
            (award) =>
              `seat ${award.seat} wins ${award.amount} from pot ${award.potIndex}` +
              (award.wasSplit ? ' (split)' : ''),
          );
          out.push({
            kind: 'handComplete',
            summaries: awards.length > 0 ? awards : ['no chips changed hands'],
          });
          break;
        }
        // `holeCardsDealt` and `potsFormed` deliberately have no wire event: the first would be a
        // notification *about* hidden information, and the second is already in every view's
        // `pots`.
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
 * The archive record for a freshly dealt hand.
 *
 * Built from the dealt state, at the one moment the starting stacks are the current ones.
 *
 * The `userId` is `playerId` — the id the engine recorded for that seat when it dealt — and the
 * seating is consulted only for `isBot`, and only by that same id. Reading the id out of the
 * seating by seat index instead would make the archive's notion of who held which cards depend on
 * who is sitting there when the row is written, which is the one thing a hand history must never
 * depend on.
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

/** A public, card-free description of one action, for the action log. */
function describeAction(logged: LoggedAction): string {
  const action = logged.action;
  switch (action.type) {
    case 'fold':
      return 'folds';
    case 'check':
      return 'checks';
    case 'call':
      return `calls ${logged.amountPaid}`;
    case 'bet':
      return `bets to ${action.to}`;
    case 'raise':
      return `raises to ${action.to}`;
    default:
      return 'acts';
  }
}

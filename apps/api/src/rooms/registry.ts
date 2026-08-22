/**
 * `roomId -> live table`, plus the lifecycle around it.
 *
 * ## Why the live table is in memory and the room is in Postgres
 *
 * A room, its members and its finished hands are durable — they are what a learner comes back to.
 * A *hand in progress* is not, and cannot be: the deck and the commitment salts have no column
 * and never will (`db/migrations/0001_initial.sql` is emphatic about it), so a hand cannot be
 * resumed from the database after a restart. That is a deliberate trade — losing an in-flight hand
 * is far cheaper than a schema that can leak the cards nobody was entitled to see — and it means
 * the authoritative live state is this process's memory.
 *
 * The consequence, stated plainly: this design assumes one API process per room. That is what
 * `docs/adr/0001-modular-monolith.md` chose, and the day a second process is introduced, rooms
 * have to be pinned to one of them (or the whole live-table model has to move), because two
 * processes each holding "the" `HandState` for one room would deal two different hands.
 *
 * ## The room record is a cache, and the cache is the live copy
 *
 * `RoomRecord` and the member list are held here so that a state frame — which goes out on every
 * change, to every socket — costs no query. The database row is the durable record; this is the
 * one being played on. Every write goes to both, in that order: persist, then update memory, so a
 * refused write never produces a live table that disagrees with the row behind it.
 *
 * ## The archive is a port, and a failing archive must not stop a hand
 *
 * `HandArchive` is the whole of what this module writes about hands. `postgresArchive` binds it to
 * `src/repositories/hands.ts` (owned by the hand-history work) and `noopArchive` is what the tests
 * and a database-less development run use. Writes are serialised per room on their own promise
 * chain, because `hands.start` must land before the first `appendAction` can reference it.
 *
 * When an archive write fails, play continues and the failure is logged. The hand in memory is the
 * authority, the players are mid-hand, and stopping a hand because a history row could not be
 * written would turn a reporting problem into a gameplay one. The cost is honest and worth naming:
 * a hand can be played that never appears in the history.
 */

import type { RoomMember, RoomSummary } from '@prl/contracts';
import type { BlindPositions, LoggedAction, RandomSource, TableConfig } from '@prl/poker-engine';
import { createSecureRandom, orderFrom } from '@prl/poker-engine';
import { getSql } from '../db.ts';
import { AppError } from '../errors.ts';
import { type AppMetrics, appMetrics } from '../observability/metrics.ts';
import type { ProblemHook } from '../observability/telemetry.ts';
import * as handsRepository from '../repositories/hands.ts';
import { newHandId } from '../repositories/ids.ts';
import * as roomsRepository from '../repositories/rooms.ts';
import type { Db } from '../repositories/sql.ts';
import * as usersRepository from '../repositories/users.ts';
import { type DurableBotSeat, describeRefusal, durableProfile, rehydrateBotSeat } from './bot-profile.ts';
import { BotRunner, type BotSeatSpec } from './bots.ts';
import {
  type ArchivedDeal,
  type ArchivedResult,
  LiveTable,
  type TableListener,
  type TableNotice,
} from './table.ts';
import { type Clock, systemClock } from './timers.ts';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The durable facts about a room, as this process holds them. */
export interface RoomRecord {
  readonly id: string;
  readonly name: string;
  /** Null once the creator erased their account; see `RoomRow.owner_user_id`. */
  readonly ownerUserId: string | null;
  readonly config: TableConfig;
  /** Chips a seat starts with. Also the buy-in checked against a learner's units. */
  readonly startingStack: number;
  readonly createdAt: string;
  closed: boolean;
}

/** A member of a room: seated or waiting, human or bot. */
export interface RoomMemberRecord {
  readonly userId: string;
  readonly displayName: string;
  readonly isBot: boolean;
  /**
   * The strategy profile id for a bot, else null.
   *
   * The same value `room_members.bot_profile` now holds. It used to differ: the column was
   * CHECK-constrained to five scenario range labels, so seven of the twelve Legends were written
   * as `unknown` and only this record knew who was actually sitting there. Migration 0003 made the
   * column carry the profile id, so the durable row and this record agree — which is the whole
   * reason a restart can now put the same opponent back. See `rooms/bot-profile.ts`.
   */
  readonly botProfile: string | null;
  /** Open sockets this member holds. Zero means "not connected", not "not a member". */
  sockets: number;
}

// ---------------------------------------------------------------------------
// The archive port
// ---------------------------------------------------------------------------

export interface ArchivedStacks {
  readonly roomId: string;
  readonly stacks: readonly { readonly userId: string; readonly stack: number }[];
}

/**
 * Everything this module writes about hands and stacks.
 *
 * Deliberately narrow and deliberately a port: the SQL belongs to `src/repositories/*`, and the
 * live table must be usable — and testable — with no database at all.
 */
export interface HandArchive {
  /** The next `hand_number` for a room, so a restart does not collide with played hands. */
  readonly nextHandNumber: (roomId: string) => Promise<number>;
  /**
   * The room's most recent deal, so a re-opened table picks the blind rotation back up rather
   * than restarting it from whoever sits down first.
   */
  readonly lastDealtHand: (roomId: string) => Promise<handsRepository.LastDealtHand | null>;
  /**
   * Closes hands that can never complete, for a room this process is about to take over.
   *
   * A hand interrupted by a restart is unrecoverable by design — the deck and the salts are never
   * persisted — so the row has to be settled by somebody, and nobody was doing it.
   */
  readonly abandonInterruptedHands: (roomId: string) => Promise<readonly handsRepository.AbandonedHand[]>;
  readonly handStarted: (deal: ArchivedDeal) => Promise<void>;
  readonly actionsApplied: (handId: string, actions: readonly LoggedAction[]) => Promise<void>;
  readonly streetAdvanced: (
    handId: string,
    street: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown',
    board: readonly number[],
  ) => Promise<void>;
  readonly handCompleted: (result: ArchivedResult) => Promise<void>;
  readonly stacksSettled: (stacks: ArchivedStacks) => Promise<void>;
  readonly roomStatusChanged: (roomId: string, status: 'open' | 'playing') => Promise<void>;
}

/** Writes nothing. The default for tests and for a development run with no database. */
export const noopArchive: HandArchive = {
  nextHandNumber: async () => 1,
  lastDealtHand: async () => null,
  abandonInterruptedHands: async () => [],
  handStarted: async () => undefined,
  actionsApplied: async () => undefined,
  streetAdvanced: async () => undefined,
  handCompleted: async () => undefined,
  stacksSettled: async () => undefined,
  roomStatusChanged: async () => undefined,
};

/**
 * Binds the archive to `src/repositories/hands.ts` and `src/repositories/rooms.ts`.
 *
 * `sql` is a getter rather than a handle so that registering the routes never touches the
 * database: a missing pool surfaces as a failed write on a live table, logged, rather than as a
 * boot crash in a process that was only ever going to serve content.
 */
export function postgresArchive(sql: () => Db): HandArchive {
  return {
    nextHandNumber: (roomId) => handsRepository.nextHandNumber(sql(), roomId),
    lastDealtHand: (roomId) => handsRepository.lastDealtHand(sql(), roomId),
    abandonInterruptedHands: (roomId) => handsRepository.abandonInterruptedHands(sql(), roomId),
    handStarted: async (deal) => {
      await handsRepository.start(sql(), {
        handId: deal.handId,
        roomId: deal.roomId,
        handNumber: deal.handNumber,
        buttonSeat: deal.buttonSeat,
        config: deal.config,
        commitmentRoot: deal.commitmentRoot,
        commitmentContext: deal.commitmentContext,
        randomSourceKind: deal.randomSourceKind,
        seats: deal.seats.map((seat) => ({
          seat: seat.seat,
          userId: seat.userId,
          isBot: seat.isBot,
          startingStack: seat.startingStack,
          holeCards: seat.holeCards,
          status: seat.status,
        })),
      });
    },
    actionsApplied: async (handId, actions) => {
      for (const action of actions) {
        const sized = action.action.type === 'bet' || action.action.type === 'raise';
        await handsRepository.appendAction(sql(), {
          handId,
          sequence: action.sequence,
          street: action.street,
          seat: action.seat,
          actionType: action.action.type,
          actionTo: sized && 'to' in action.action ? action.action.to : null,
          amountPaid: action.amountPaid,
          betLevelAfter: action.betLevelAfter,
          potAfter: action.potAfter,
          wasAutomatic: action.wasAutomatic,
          actionId: action.actionId,
        });
      }
    },
    streetAdvanced: async (handId, street, board) => {
      await handsRepository.advanceStreet(sql(), handId, street, board);
    },
    handCompleted: async (result) => {
      await handsRepository.complete(sql(), {
        handId: result.handId,
        board: result.board,
        result: result.result,
        seats: result.seats.map((seat) => ({
          seat: seat.seat,
          netResult: seat.netResult,
          status: seat.status,
          showedDown: seat.showedDown,
        })),
      });
    },
    stacksSettled: async ({ roomId, stacks }) => {
      for (const entry of stacks) {
        await roomsRepository.updateMemberStack(sql(), roomId, entry.userId, entry.stack);
      }
    },
    roomStatusChanged: async (roomId, status) => {
      await roomsRepository.setStatus(sql(), roomId, status);
    },
  };
}

// ---------------------------------------------------------------------------
// The room store port
// ---------------------------------------------------------------------------

/** What creating a room needs. Mirrors `createRoomBodySchema` plus the owner. */
export interface CreateRoomSpec {
  readonly name: string;
  readonly ownerUserId: string;
  readonly maxSeats: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante?: number;
  readonly startingStack: number;
  readonly actionTimeoutSeconds?: number;
}

/**
 * Room and member persistence, plus the two user-level facts a table needs.
 *
 * A port rather than a direct dependency for one reason that matters: every test in
 * `test/rooms.test.ts` and `test/ws-router.test.ts` runs against a `Map`-backed fake, so the whole
 * of rooms, seating, the socket protocol and the bots is exercised with no database anywhere. The
 * SQL itself is not duplicated — `postgresRoomStore` is a thin binding over
 * `src/repositories/rooms.ts` and `src/repositories/users.ts`, which own it.
 */
export interface RoomStore {
  readonly create: (spec: CreateRoomSpec) => Promise<{
    readonly room: roomsRepository.RoomRow;
    /** Returned exactly once. Only `sha256(code)` is stored. */
    readonly inviteCode: string;
  }>;
  readonly byId: (roomId: string) => Promise<roomsRepository.RoomRow | null>;
  readonly byInviteCode: (code: string) => Promise<roomsRepository.RoomRow | null>;
  readonly listForUser: (userId: string) => Promise<readonly roomsRepository.RoomRow[]>;
  readonly membersOfRooms: (roomIds: readonly string[]) => Promise<readonly roomsRepository.RoomMemberRow[]>;
  readonly memberOf: (roomId: string, userId: string) => Promise<roomsRepository.RoomMemberRow | null>;
  readonly addMember: (input: {
    readonly roomId: string;
    readonly userId: string;
    readonly stack?: number;
    readonly isBot?: boolean;
    /** All three facts, or none. A partial bot row cannot be rehydrated — see `bot-profile.ts`. */
    readonly bot?: DurableBotSeat | null;
  }) => Promise<roomsRepository.RoomMemberRow>;
  readonly seatMember: (roomId: string, userId: string, seat: number) => Promise<void>;
  readonly unseatMember: (roomId: string, userId: string) => Promise<void>;
  readonly removeMember: (roomId: string, userId: string) => Promise<void>;
  readonly close: (roomId: string, ownerUserId: string) => Promise<boolean>;
  /** Bots get real user rows, so a seat is a seat whoever occupies it. */
  readonly createBotUser: (
    displayName: string,
  ) => Promise<{ readonly id: string; readonly displayName: string }>;
  /** The learner's spendable units, for the buy-in check. */
  readonly readUnits: (userId: string) => Promise<number>;
}

/** What `room_members.bot_profile` accepts: any strategy profile id. See `bot-profile.ts`. */
export type PersistedBotProfile = ReturnType<typeof durableProfile>;

/** Binds the store to the repositories. `sql` is a getter for the reason `postgresArchive` says. */
export function postgresRoomStore(sql: () => Db): RoomStore {
  return {
    create: async (spec) => {
      const created = await roomsRepository.create(sql(), spec);
      return { room: created.room, inviteCode: created.inviteCode };
    },
    byId: (roomId) => roomsRepository.byId(sql(), roomId),
    byInviteCode: (code) => roomsRepository.byInviteCode(sql(), code),
    listForUser: (userId) => roomsRepository.listForUser(sql(), userId),
    membersOfRooms: (roomIds) => roomsRepository.membersOfRooms(sql(), roomIds),
    memberOf: (roomId, userId) => roomsRepository.memberOf(sql(), roomId, userId),
    addMember: (input) => roomsRepository.addMember(sql(), input),
    seatMember: async (roomId, userId, seat) => {
      await roomsRepository.seatMember(sql(), roomId, userId, seat);
    },
    unseatMember: async (roomId, userId) => {
      await roomsRepository.unseatMember(sql(), roomId, userId);
    },
    removeMember: async (roomId, userId) => {
      await roomsRepository.removeMember(sql(), roomId, userId);
    },
    close: (roomId, ownerUserId) => roomsRepository.close(sql(), roomId, { ownerUserId }),
    createBotUser: async (displayName) => {
      const row = await usersRepository.createGuest(sql(), { displayName });
      return { id: row.id, displayName: row.display_name };
    },
    readUnits: async (userId) => (await usersRepository.readUnits(sql(), userId)).units,
  };
}

// ---------------------------------------------------------------------------
// A live room
// ---------------------------------------------------------------------------

/** One room, live: its record, its members, its table and its bots. */
export class LiveRoom {
  readonly record: RoomRecord;
  readonly table: LiveTable;
  readonly bots: BotRunner;
  private readonly members = new Map<string, RoomMemberRecord>();
  private readonly metrics: AppMetrics;
  /** Serialises archive writes, so `hands.start` lands before the first action row. */
  private archiveQueue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(options: {
    readonly record: RoomRecord;
    readonly table: LiveTable;
    readonly bots: BotRunner;
    readonly archive: HandArchive;
    readonly onProblem: ProblemHook;
    readonly metrics: AppMetrics;
  }) {
    this.record = options.record;
    this.table = options.table;
    this.bots = options.bots;
    this.metrics = options.metrics;
    this.unsubscribe = this.table.subscribe((notice) => {
      this.archiveNotice(notice, options.archive, options.onProblem);
    });
  }

  memberList(): readonly RoomMemberRecord[] {
    return [...this.members.values()];
  }

  member(userId: string): RoomMemberRecord | null {
    return this.members.get(userId) ?? null;
  }

  addMember(member: Omit<RoomMemberRecord, 'sockets'>): RoomMemberRecord {
    const existing = this.members.get(member.userId);
    if (existing !== undefined) return existing;
    const record: RoomMemberRecord = { ...member, sockets: 0 };
    this.members.set(member.userId, record);
    return record;
  }

  removeMember(userId: string): void {
    this.members.delete(userId);
  }

  /** Tracks open sockets so `RoomMember.connected` is a fact rather than a guess. */
  noteSocket(userId: string, delta: number): void {
    const member = this.members.get(userId);
    if (member === undefined) return;
    member.sockets = Math.max(0, member.sockets + delta);
  }

  close(): void {
    // A hand still in progress when the room closes can never reach a settled result: the deck
    // and the commitment salts live only in this process's memory (see the file header) and go
    // with it. Counted here rather than inferred from the gap between `handsStarted` and
    // `handsCompleted`, because that gap also contains every hand currently being played.
    if (this.table.snapshot().handInProgress) {
      this.metrics.handsFailed.inc({ reason: 'room_closed' });
    }
    this.record.closed = true;
    this.bots.stop();
    this.table.close();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Turns one table change into archive writes, in order, without ever blocking play.
   *
   * Each notice's writes are appended to this room's chain and awaited by nobody: the table has
   * already moved on and the players are already looking at the new state. A rejected write is
   * logged and the chain continues — see the file comment for why that is the right direction.
   */
  private archiveNotice(notice: TableNotice, archive: HandArchive, onProblem: ProblemHook): void {
    // The hand lifecycle is counted here rather than inside `LiveTable`, because this is the one
    // subscription every notice passes through and because the table is a component the tests
    // construct directly — instrumenting it there would make every one of them a metrics test.
    // Both conditions fire exactly once per hand: `handStarted` is the reason of a single notice,
    // and `handCompleted` is set by `settleIfComplete`, which returns true once per hand by
    // design so that a subscriber cannot double-count.
    if (notice.reason === 'handStarted') this.metrics.handsStarted.inc();
    if (notice.handCompleted) this.metrics.handsCompleted.inc();

    const handId = notice.handId;
    const deal = notice.reason === 'handStarted' ? this.table.archivedDeal() : null;
    const street = notice.events.some((event) => event.kind === 'street') ? notice.street : null;
    const board = notice.board;
    const actions = notice.loggedActions;
    const result = notice.handCompleted ? this.table.archivedResult() : null;
    const settled = notice.handCompleted ? this.table.snapshot().seats : null;
    const roomStatus = notice.reason === 'handStarted' ? 'playing' : notice.handCompleted ? 'open' : null;

    this.archiveQueue = this.archiveQueue
      .then(async () => {
        if (deal !== null) await archive.handStarted(deal);
        if (handId !== null && actions.length > 0) await archive.actionsApplied(handId, actions);
        if (handId !== null && street !== null && street !== 'complete') {
          await archive.streetAdvanced(handId, street, board);
        }
        if (result !== null) await archive.handCompleted(result);
        if (settled !== null) {
          await archive.stacksSettled({
            roomId: this.record.id,
            stacks: settled.map((seat) => ({ userId: seat.userId, stack: seat.stack })),
          });
        }
        // `rooms.status` follows play, so a lobby read from the database agrees with the table.
        if (roomStatus !== null) await archive.roomStatusChanged(this.record.id, roomStatus);
      })
      .catch((error: unknown) => {
        // Not a failed hand — play continued and the players got a result — so this has its own
        // counter rather than `handsFailed`. Incremented here, at the write, because it is the
        // only place that knows an archive write is what failed; the consumer of `onProblem`
        // deliberately does not count `archive-write` again.
        this.metrics.archiveFailures.inc();
        onProblem('a hand could not be archived', {
          event: 'archive-write',
          roomId: this.record.id,
          error: String(error),
        });
      });
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface RoomRegistryOptions {
  readonly clock?: Clock;
  /**
   * How long a lone learner gets to act, in seconds, when every other seat is a bot.
   * Supplied from `AppConfig.learnerTurnSeconds`; omitted, `LiveTable` applies its own default.
   *
   * It is threaded from here rather than read from the environment inside `LiveTable` because the
   * table is a pure-ish component the tests construct directly, and a constant it reads for itself
   * is a constant they cannot vary.
   */
  readonly learnerTurnSeconds?: number;
  /** The dealing source. `createSecureRandom()` unless a test needs otherwise. */
  readonly random?: RandomSource;
  readonly archive?: HandArchive;
  /** Room and member persistence. Defaults to the repositories, bound lazily. */
  readonly store?: RoomStore;
  /** Bots' thinking delay. Legibility only; see `bots.ts`. */
  readonly botThinkingDelayMs?: number;
  readonly nextHandId?: () => string;
  /**
   * Non-fatal problems from this registry, its tables and its bots.
   *
   * `ProblemHook` requires a typed `event` on the detail, which is what lets the consumer in
   * `routes/index.ts` count "a bot could not act" separately from "a hand could not be
   * archived" instead of matching on prose. See `observability/telemetry.ts`.
   */
  readonly onProblem?: ProblemHook;
  /** Defaults to the process-wide metrics. A test that wants isolation passes its own. */
  readonly metrics?: AppMetrics;
}

/** Who is asking. The subset of `ResolvedSession['user']` every room operation needs. */
export interface RoomPrincipal {
  readonly userId: string;
  readonly displayName: string;
}

export interface OpenRoomRequest {
  readonly record: RoomRecord;
  /** Members already known from the database, for a room being re-opened after a restart. */
  readonly members?: readonly Omit<RoomMemberRecord, 'sockets'>[];
}

/**
 * Every live room in this process.
 *
 * One instance, created by the route module and shared with the WebSocket hub, so that both see
 * the same tables. Two registries would be two sets of tables for the same room ids.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, LiveRoom>();
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly learnerTurnSeconds: number | undefined;
  private readonly archive: HandArchive;
  private readonly botThinkingDelayMs: number | undefined;
  private readonly nextHandId: () => string;
  private readonly onProblem: ProblemHook;
  private readonly metrics: AppMetrics;
  readonly store: RoomStore;

  constructor(options: RoomRegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.learnerTurnSeconds = options.learnerTurnSeconds;
    this.random = options.random ?? createSecureRandom();
    this.archive = options.archive ?? noopArchive;
    this.store = options.store ?? postgresRoomStore(getSql);
    this.botThinkingDelayMs = options.botThinkingDelayMs;
    this.nextHandId = options.nextHandId ?? newHandId;
    this.onProblem = options.onProblem ?? ((): void => undefined);
    this.metrics = options.metrics ?? appMetrics();
    // Read at scrape time from the map itself, never mirrored on open and close: a mirror drifts
    // the first time somebody adds a path that removes a room and forgets the decrement, and a
    // gauge that is quietly wrong during an incident is worse than no gauge (see `Gauge.setFrom`).
    //
    // The caveat, stated rather than hidden: a collector is one function, so if a process built
    // several registries against the same metrics the last one would win. A server builds exactly
    // one — `roomRegistry()` is a process-wide singleton — and a test that builds several passes
    // its own `metrics`, which gives each registry its own gauge. Same caveat, same shape, as
    // `getSharedPool` and the origin allowlist.
    this.metrics.roomsLive.setFrom(() => this.rooms.size);
  }

  /** Opens a live table for a room, or returns the one already open. */
  async open(request: OpenRoomRequest): Promise<LiveRoom> {
    const existing = this.rooms.get(request.record.id);
    if (existing !== undefined) return existing;

    // Nothing in this process holds a table for this room yet, so any hand still open in the
    // database belongs to a process that is gone and can never finish it. Closed here, before the
    // table exists, so the reconciliation can never race a hand this process is about to deal.
    //
    // The returned count is not read here on purpose: it is logged and counted against
    // `handsFailed` inside, which is the only place that cannot be forgotten by a future caller.
    await this.reconcileInterruptedHands(request.record.id);

    // Seeded from the database so a room re-opened after a restart cannot collide with a hand
    // number that has already been played (`hands_room_hand_number_key`), and so the blind
    // rotation carries on from where it was rather than restarting under the players.
    let played = 0;
    let blinds: BlindPositions | undefined;
    try {
      played = Math.max(0, (await this.archive.nextHandNumber(request.record.id)) - 1);
      const last = await this.archive.lastDealtHand(request.record.id);
      blinds =
        last === null ? undefined : (blindsFromLastHand(last, request.record.config.maxSeats) ?? undefined);
    } catch (error) {
      // A room that will not open is worse than one that opens with a fresh rotation, so both
      // reads fail soft. The cost of the second one failing is one repeated big blind.
      this.onProblem('could not read the played hand count or the last deal', {
        event: 'room-open-read',
        roomId: request.record.id,
        error: String(error),
      });
    }

    const table = new LiveTable({
      roomId: request.record.id,
      config: request.record.config,
      clock: this.clock,
      random: this.random,
      nextHandId: this.nextHandId,
      initialHandNumber: played,
      ...(blinds === undefined ? {} : { initialBlinds: blinds }),
      ...(this.learnerTurnSeconds === undefined ? {} : { learnerTurnSeconds: this.learnerTurnSeconds }),
      onProblem: this.onProblem,
    });
    const bots = new BotRunner({
      table,
      clock: this.clock,
      ...(this.botThinkingDelayMs === undefined ? {} : { thinkingDelayMs: this.botThinkingDelayMs }),
      onProblem: this.onProblem,
    });
    const room = new LiveRoom({
      record: request.record,
      table,
      bots,
      archive: this.archive,
      onProblem: this.onProblem,
      metrics: this.metrics,
    });
    for (const member of request.members ?? []) room.addMember(member);
    this.rooms.set(request.record.id, room);
    return room;
  }

  get(roomId: string): LiveRoom | null {
    return this.rooms.get(roomId) ?? null;
  }

  /**
   * Closes any hand of this room that can never complete, and reports how many there were.
   *
   * Called from `open`, which is the moment this process takes responsibility for the room and
   * the moment it can be sure nobody here is mid-hand in it. Public so that a startup task can
   * sweep rooms that nobody re-opens — an orphan in a room the learner never revisits stays in
   * their history until somebody closes it, and this is the call that does.
   *
   * A failure is logged and swallowed: a room that would not open because a history row could not
   * be tidied would turn a reporting problem into a gameplay one, which is the same trade
   * `LiveRoom.archiveNotice` makes and for the same reason.
   */
  async reconcileInterruptedHands(roomId: string): Promise<number> {
    if (this.rooms.has(roomId)) return 0;
    try {
      const abandoned = await this.archive.abandonInterruptedHands(roomId);
      if (abandoned.length > 0) {
        // These are hands that were dealt and never settled, which is exactly what
        // `handsFailed` counts — and the count is what every caller used to throw away. Recorded
        // here rather than at the call sites so that a future caller (a startup sweep over rooms
        // nobody re-opens) cannot forget to, and by `abandoned.length` rather than by one,
        // because one reconciliation can close several hands.
        this.metrics.handsFailed.inc({ reason: 'interrupted_by_restart' }, abandoned.length);
        this.onProblem('closed hands that were interrupted and can never complete', {
          event: 'hands-interrupted',
          roomId,
          hands: abandoned.map((hand) => hand.handId),
        });
      }
      return abandoned.length;
    } catch (error) {
      this.onProblem('could not reconcile interrupted hands', {
        event: 'reconcile-read',
        roomId,
        error: String(error),
      });
      return 0;
    }
  }

  /**
   * The room, or the one answer a stranger and a non-member both get.
   *
   * `room_not_found_or_not_permitted` for both cases, deliberately: a distinguishable "that room
   * exists but is not yours" is a free way to confirm a room id.
   */
  require(roomId: string, userId: string): LiveRoom {
    const room = this.rooms.get(roomId);
    if (room === undefined || room.record.closed) {
      throw new AppError('room_not_found_or_not_permitted', { logDetail: `no live room ${roomId}` });
    }
    if (room.member(userId) === null && room.record.ownerUserId !== userId) {
      throw new AppError('room_not_found_or_not_permitted', {
        logDetail: `caller is not a member of ${roomId}`,
      });
    }
    return room;
  }

  /**
   * Opens the live table for a persisted room, loading it if this process has not seen it.
   *
   * Returns null when there is no such room, which every caller turns into
   * `room_not_found_or_not_permitted` — the same answer a non-member gets.
   */
  async ensureOpen(roomId: string): Promise<LiveRoom | null> {
    const live = this.rooms.get(roomId);
    if (live !== undefined) return live;
    const row = await this.store.byId(roomId);
    if (row === null || row.status === 'closed') return null;
    const members = await this.store.membersOfRooms([roomId]);
    const room = await this.open({
      record: recordFromRow(row),
      members: members.map((member) => ({
        userId: member.user_id,
        displayName: member.display_name,
        isBot: member.is_bot,
        botProfile: member.bot_profile,
      })),
    });
    // Seats recorded in the database are re-taken at the live table, so a room re-opened after a
    // restart looks the way the roster says it does — and a bot seat is re-registered with the
    // runner, so it plays instead of sitting there until the turn clock folds it.
    //
    // ## Why this changed
    //
    // This loop used to re-take the seats and register no bots at all, on the stated reasoning
    // that "a seat that cannot act is more honest than one that silently plays a different
    // style". The premise was true and forced: `room_members.bot_profile` could not name seven of
    // the twelve profiles, so there was frequently no style to put back. The conclusion did not
    // follow — the fix for a column that cannot name the opponent is to make it name the opponent
    // (migration 0003), not to stop restoring opponents. Restarting the only API process turned
    // every AI Legends table into a row of timeout-folders, which teaches a learner nothing and
    // silently ruins the session they were in the middle of.
    //
    // ## What is restored, and what honestly is not
    //
    // Restored exactly: the profile, the difficulty, and the decision seed — the three things
    // that decide how the seat plays. `rehydrateBotSeat` reads them from the row and REFUSES
    // rather than substituting when any is missing or unrecognised, so a retired profile id or a
    // pre-0003 row leaves an inert seat and a logged reason. That is the old behaviour, kept for
    // exactly the case it was right about.
    //
    // Not restored: `OpponentModel`. It is built from observed actions and those observations
    // died with the process. A rehydrated bot therefore starts with no read on the table, which
    // is a real difference and is stated here rather than papered over — it is also what a
    // genuinely new opponent would have, so it costs the learner nothing they can be misled by.
    for (const member of members) {
      if (member.seat === null) continue;
      try {
        await room.table.sit({
          userId: member.user_id,
          displayName: member.display_name,
          seat: member.seat,
          stack: member.stack,
          isBot: member.is_bot,
          botProfile: member.bot_profile,
          // These players were in the rotation a moment ago; a restart is not an arrival, and
          // charging them the newcomer's wait would sit the whole table out for an orbit.
          resumingSeat: true,
        });
      } catch (error) {
        this.onProblem('a recorded seat could not be re-taken', {
          event: 'seat-retake',
          roomId,
          seat: member.seat,
          error: String(error),
        });
        continue;
      }
      if (member.is_bot) this.rehydrateBot(room, member.seat, member);
    }
    return room;
  }

  /**
   * Puts one persisted bot seat back on the runner, or says why it will not.
   *
   * Never throws: one unrepairable row must not cost the room its other seats. A refusal is
   * logged with the seat's own reason and the seat stays occupied but inert, which the turn timer
   * resolves by checking or folding it. There is deliberately no nearest-match fallback — seating
   * `patient-technician` where the row asked for a profile this build no longer carries would be
   * inventing an opponent, and the learner would have no way to tell.
   */
  private rehydrateBot(room: LiveRoom, seat: number, member: roomsRepository.RoomMemberRow): void {
    const rehydrated = rehydrateBotSeat({
      botProfile: member.bot_profile,
      botDifficulty: member.bot_difficulty,
      botSeed: member.bot_seed,
    });
    if (!rehydrated.ok) {
      this.onProblem('a bot seat could not be restored and will not act', {
        event: 'bot-rehydrate',
        roomId: room.record.id,
        seat,
        botProfile: member.bot_profile,
        reason: describeRefusal(rehydrated.refusal),
      });
      return;
    }
    room.bots.add({
      userId: member.user_id,
      seat: seat as BotSeatSpec['seat'],
      profileId: rehydrated.seat.profileId,
      difficulty: rehydrated.seat.difficulty,
      seed: rehydrated.seat.seed,
    });
  }

  /**
   * Creates a room: the durable row first, then the live table.
   *
   * That order matters. If the row fails to write there is no table to clean up, whereas a table
   * created first would be a room the owner can play at and nobody can ever find again. The
   * invite code comes back from the store exactly once and is returned to the caller unchanged —
   * it is not stored here, not logged (`logging.ts` censors `/invite/i`), and unrecoverable
   * afterwards.
   */
  async createRoom(
    principal: RoomPrincipal,
    spec: Omit<CreateRoomSpec, 'ownerUserId'>,
  ): Promise<{ readonly room: LiveRoom; readonly inviteCode: string }> {
    const created = await this.store.create({ ...spec, ownerUserId: principal.userId });
    const record = recordFromRow(created.room);
    const room = await this.open({ record });
    // The owner is a member from the start, so the room appears in their list and the membership
    // check that guards every other endpoint has something to find.
    await this.store.addMember({ roomId: record.id, userId: principal.userId });
    room.addMember({
      userId: principal.userId,
      displayName: principal.displayName,
      isBot: false,
      botProfile: null,
    });
    return { room, inviteCode: created.inviteCode };
  }

  /**
   * Joins a room by invite code.
   *
   * Joining twice is not an error: the second call finds the existing membership and answers with
   * the same room. A client that retries a dropped response must not be told `already_seated` for
   * a room it is in.
   */
  async joinByInviteCode(principal: RoomPrincipal, code: string): Promise<LiveRoom> {
    const row = await this.store.byInviteCode(code);
    // One answer for "no such code" and "malformed code". Distinguishing them tells somebody
    // probing codes that they had the format right, which is the only feedback a brute force needs.
    if (row === null) throw new AppError('invite_code_invalid', { logDetail: 'no room for that code' });
    if (row.status === 'closed') throw new AppError('room_closed', { logDetail: `room ${row.id} is closed` });

    const existing = await this.store.memberOf(row.id, principal.userId);
    if (existing === null) {
      await this.store.addMember({ roomId: row.id, userId: principal.userId });
    }
    const room = await this.ensureOpen(row.id);
    if (room === null) {
      throw new AppError('room_not_found_or_not_permitted', { logDetail: `room ${row.id} would not open` });
    }
    room.addMember({
      userId: principal.userId,
      displayName: principal.displayName,
      isBot: false,
      botProfile: null,
    });
    return room;
  }

  /**
   * Takes a seat: units checked, database first, then the live table.
   *
   * The database is the arbiter of "is that seat free", because `room_members_live_seat_key` is
   * the only check that holds when two players tap the same seat in the same instant. The live
   * table is then told, and if *it* refuses — which means the two copies had drifted — the
   * database seat is given back, so a refused sit never leaves a seat allocated to somebody who is
   * not at the table.
   */
  async sitAtTable(roomId: string, principal: RoomPrincipal, seat: number): Promise<void> {
    const room = this.require(roomId, principal.userId);
    const member = await this.store.memberOf(roomId, principal.userId);
    if (member === null) {
      throw new AppError('not_room_member', { logDetail: `not a live member of ${roomId}` });
    }
    const units = await this.store.readUnits(principal.userId);
    // A returning occupant keeps the stack the last settled hand left them. Inventing
    // `startingStack` here is how a winning session vanished on stand/sit.
    const buyIn = member.stack > 0 ? member.stack : room.record.startingStack;
    if (units < buyIn) {
      throw new AppError('insufficient_units', {
        logDetail: `buy-in ${buyIn} exceeds available units`,
      });
    }

    await this.store.seatMember(roomId, principal.userId, seat);
    try {
      await room.table.sit({
        userId: principal.userId,
        displayName: principal.displayName,
        seat,
        stack: buyIn,
      });
    } catch (error) {
      await this.store.unseatMember(roomId, principal.userId).catch(() => undefined);
      throw error;
    }
    room.addMember({
      userId: principal.userId,
      displayName: principal.displayName,
      isBot: false,
      botProfile: null,
    });
  }

  /**
   * Stands up, keeping the membership.
   *
   * The table goes first here, and that is the opposite order to `sitAtTable` for a reason: a
   * player holding a live hand does not leave immediately — they are flagged, they fold at their
   * turn, and the seat is released when the hand completes. Freeing the database seat first would
   * let somebody else take a seat that is still holding cards.
   */
  async standFromTable(roomId: string, userId: string): Promise<void> {
    const room = this.require(roomId, userId);
    await room.table.stand(userId);
    if (room.table.seatOf(userId) === null) await this.store.unseatMember(roomId, userId);
  }

  /** Leaves the room altogether: stand up if seated, then drop the membership. */
  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const room = this.require(roomId, userId);
    if (room.table.seatOf(userId) !== null) await room.table.stand(userId);
    await this.store.unseatMember(roomId, userId);
    await this.store.removeMember(roomId, userId);
    if (room.table.seatOf(userId) === null) room.removeMember(userId);
  }

  /** Seats a bot and registers it with the runner. Both, or neither. */
  async seatBot(
    roomId: string,
    spec: BotSeatSpec & { readonly displayName: string },
  ): Promise<RoomMemberRecord> {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      throw new AppError('room_not_found_or_not_permitted', { logDetail: `no live room ${roomId}` });
    }
    await room.table.sit({
      userId: spec.userId,
      displayName: spec.displayName,
      seat: spec.seat,
      stack: room.record.startingStack,
      isBot: true,
      botProfile: spec.profileId,
    });
    room.bots.add(spec);
    return room.addMember({
      userId: spec.userId,
      displayName: spec.displayName,
      isBot: true,
      botProfile: spec.profileId,
    });
  }

  subscribe(roomId: string, listener: TableListener): () => void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return () => undefined;
    return room.table.subscribe(listener);
  }

  /** Builds the wire summary from memory, with no query. */
  summary(roomId: string): RoomSummary {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      throw new AppError('room_not_found_or_not_permitted', { logDetail: `no live room ${roomId}` });
    }
    return toRoomSummary(room);
  }

  /** Closes one room: its bots, its table, its timers. */
  close(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    room.close();
    this.rooms.delete(roomId);
  }

  /**
   * Closes every room. Called from the server's shutdown path.
   *
   * A closed room must not be able to keep a turn timer or a bot's scheduled decision alive: both
   * hold a reference to the table, so a room that is merely forgotten would keep running.
   */
  closeAll(): void {
    for (const roomId of [...this.rooms.keys()]) this.close(roomId);
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Records that a member's socket opened or closed, for `RoomMember.connected`. */
  noteSocket(roomId: string, userId: string, delta: number): void {
    this.rooms.get(roomId)?.noteSocket(userId, delta);
  }
}

// ---------------------------------------------------------------------------
// The process-wide registry
// ---------------------------------------------------------------------------

/**
 * One registry per process, so the room routes and the WebSocket hub see the same tables.
 *
 * They are separate route modules registered into separate encapsulated scopes, so a Fastify
 * decorator would not reach both without escaping encapsulation. Module scope is the same
 * mechanism `plugins/security.ts` uses for the origin allowlist, with the same caveat, stated
 * plainly: a process that built two apps with different configurations would share one registry.
 * A server builds one. A test that needs its own passes it explicitly — every entry point here
 * takes the registry as an option — and `resetRoomRegistryForTests` drops the shared one.
 */
let shared: RoomRegistry | null = null;

export function roomRegistry(options: RoomRegistryOptions = {}): RoomRegistry {
  shared ??= new RoomRegistry(options);
  return shared;
}

/** Drops the shared registry, closing every live room first. */
export function resetRoomRegistryForTests(): void {
  shared?.closeAll();
  shared = null;
}

/**
 * The wire summary for a live room.
 *
 * Seat, stack and connection state come from the table and the member records rather than from a
 * query, because this is built on every state frame. A member who is not seated reports
 * `seat: null` and the stack the record holds, which is what a lobby renders.
 */
export function toRoomSummary(room: LiveRoom): RoomSummary {
  const snapshot = room.table.snapshot();
  const seatByUser = new Map(snapshot.seats.map((seat) => [seat.userId, seat]));
  // The seats the table is holding out of the deal until they have paid a blind. Read from the one
  // snapshot taken above rather than by asking `table.owesBlind` per member, so every field in this
  // summary describes the same instant — a member list in which one row came from a later read of
  // the table is a table that never existed.
  const awaitingBigBlind = new Set(snapshot.awaitingBigBlind);
  const members: RoomMember[] = room.memberList().map((member) => {
    const seat = seatByUser.get(member.userId);
    return {
      userId: member.userId,
      displayName: member.displayName,
      seat: seat?.seat ?? null,
      stack: seat?.stack ?? 0,
      isBot: member.isBot,
      botProfile: member.botProfile,
      connected: member.isBot || member.sockets > 0,
      // Named field by field, like every other member of this object, because that is what makes
      // the wire shape a deliberate decision rather than whatever the internal record happens to
      // hold (ADR 0003). A member with no seat is not being held out of anything.
      awaitingBigBlind: seat !== undefined && awaitingBigBlind.has(seat.seat),
    };
  });
  return {
    id: room.record.id,
    name: room.record.name,
    ownerUserId: room.record.ownerUserId,
    maxSeats: room.record.config.maxSeats,
    smallBlind: room.record.config.smallBlind,
    bigBlind: room.record.config.bigBlind,
    ante: room.record.config.ante,
    startingStack: room.record.startingStack,
    actionTimeoutSeconds: room.record.config.actionTimeoutSeconds,
    status: room.record.closed ? 'closed' : snapshot.handInProgress ? 'playing' : 'open',
    // Not a variable, and not configurable: `rooms_visibility_invite_only` allows one value, and
    // changing that is a migration and a review (ADR 0010).
    visibility: 'invite_only',
    members,
    createdAt: room.record.createdAt,
  };
}

/** A summary for a room that has no live table — a closed one, or one from another process. */
export function summaryFromRows(
  room: roomsRepository.RoomRow,
  members: readonly roomsRepository.RoomMemberRow[],
): RoomSummary {
  return {
    id: room.id,
    name: room.name,
    ownerUserId: room.owner_user_id,
    maxSeats: room.max_seats,
    smallBlind: room.small_blind,
    bigBlind: room.big_blind,
    ante: room.ante,
    startingStack: room.starting_stack,
    actionTimeoutSeconds: room.action_timeout_seconds,
    status: room.status,
    visibility: 'invite_only',
    members: members.map((member) => ({
      userId: member.user_id,
      displayName: member.display_name,
      seat: member.seat,
      stack: member.stack,
      isBot: member.is_bot,
      botProfile: member.bot_profile,
      // A room with no live table in this process has nobody connected to it, by definition.
      connected: member.is_bot,
      // Nor anybody waiting for a blind: the obligation lives on the live table and is not
      // persisted, so there is no such thing as one for a room nothing is playing. Stated rather
      // than left off — the field is required precisely so that a mapping which forgot about it
      // cannot compile.
      awaitingBigBlind: false,
    })),
    createdAt: room.created_at.toISOString(),
  };
}

/**
 * The blind positions a re-opened table carries on from, reconstructed from the last deal.
 *
 * Only `button_seat` is persisted, so the other two positions are recovered the way the rules
 * define them for a hand with a live button: the small blind is the first seat clockwise from the
 * button that was dealt in, and the big blind is the next one. `orderFrom` is used rather than
 * `assignBlinds` precisely because the button may be a DEAD seat — nobody was playing from it, and
 * `assignBlinds` refuses that case, which is exactly the hand a reconstruction has to survive.
 *
 * The limit is stated in `repositories/hands.ts`: a hand whose SMALL blind was dead cannot be
 * reconstructed exactly, because its small blind seat is not in `dealtSeats` at all and the walk
 * lands on the big blind instead. That costs one player one repeated big blind, once, across a
 * single restart. Making it exact is a migration adding the two seat columns.
 *
 * Returns null for a hand with fewer than two dealt seats, which cannot have happened and which a
 * corrupt row could still claim.
 */
export function blindsFromLastHand(
  hand: handsRepository.LastDealtHand,
  maxSeats: number,
): BlindPositions | null {
  const dealt = [...hand.dealtSeats].sort((left, right) => left - right);
  if (dealt.length < 2) return null;
  if (dealt.length === 2) {
    // Heads-up the button posted the small blind, so both positions are the button's seat and the
    // big blind is the other one. Derived rather than walked, because `orderFrom` heads-up would
    // put the big blind on the button itself at the end of its lap.
    const other = dealt.find((seat) => seat !== hand.buttonSeat);
    if (other === undefined) return null;
    return { buttonSeat: hand.buttonSeat, smallBlindSeat: hand.buttonSeat, bigBlindSeat: other };
  }
  const order = orderFrom(hand.buttonSeat, maxSeats, dealt);
  const smallBlindSeat = order[0];
  const bigBlindSeat = order[1];
  if (smallBlindSeat === undefined || bigBlindSeat === undefined) return null;
  return { buttonSeat: hand.buttonSeat, smallBlindSeat, bigBlindSeat };
}

/** The `TableConfig` for a persisted room row. */
export function configFromRow(room: roomsRepository.RoomRow): TableConfig {
  return {
    smallBlind: room.small_blind,
    bigBlind: room.big_blind,
    ante: room.ante,
    maxSeats: room.max_seats,
    actionTimeoutSeconds: room.action_timeout_seconds,
  };
}

/** The record for a persisted room row. */
export function recordFromRow(room: roomsRepository.RoomRow): RoomRecord {
  return {
    id: room.id,
    name: room.name,
    ownerUserId: room.owner_user_id,
    config: configFromRow(room),
    startingStack: room.starting_stack,
    createdAt: room.created_at.toISOString(),
    closed: room.status === 'closed',
  };
}

/** The persistable profile name for a bot seat. Re-exported so routes need one import. */
export { durableProfile };

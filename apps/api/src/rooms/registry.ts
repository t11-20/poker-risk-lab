/**
 * `roomId -> live table`, plus the lifecycle around it.
 * A hand in progress lives only in this process's memory (the deck and salts have no column), so one
 * API process must serve each room (ADR 0001). Opening a room takes a lease (`rooms/ownership.ts`): a
 * room held elsewhere is refused as `room_owned_elsewhere`, and a fenced room is closed and dropped at
 * once. `ownership: null` enforces none of this, for tests.
 * The room record and members are cached here so a state frame costs no query. Writes persist first,
 * then update memory. Archive writes are serialised per room, and a failed one is logged while play
 * continues, so a hand can be missing from the history.
 */

import type { RoomMember, RoomSummary } from '@prl/contracts';
import type { BlindPositions, RandomSource, TableConfig } from '@prl/poker-engine';
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
import type { SeatEntitlement } from './entitlement.ts';
import { LEASE_HEARTBEAT_INTERVAL_MS, LEASE_SELF_EVICT_AFTER_MS, type RoomOwnership } from './ownership.ts';
import {
  type ArchivedAction,
  type ArchivedDeal,
  type ArchivedResult,
  LiveTable,
  type TableListener,
  type TableNotice,
} from './table.ts';
import { type Clock, type ScheduledTask, systemClock } from './timers.ts';

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
  /** The strategy profile id for a bot, else null. Matches `room_members.bot_profile`. */
  readonly botProfile: string | null;
  /** Open sockets this member holds. Zero means "not connected", not "not a member". */
  sockets: number;
}

export interface ArchivedStacks {
  readonly roomId: string;
  readonly stacks: readonly { readonly userId: string; readonly stack: number }[];
}

/** A port, so the live table runs with no database. The SQL belongs to `src/repositories/*`. */
export interface HandArchive {
  /** The next `hand_number` for a room, so a restart does not collide with played hands. */
  readonly nextHandNumber: (roomId: string) => Promise<number>;
  /** The room's most recent deal, so a re-opened table resumes the blind rotation. */
  readonly lastDealtHand: (roomId: string) => Promise<handsRepository.LastDealtHand | null>;
  /** Closes hands a restart interrupted. They can never complete, as the deck is never persisted. */
  readonly abandonInterruptedHands: (roomId: string) => Promise<readonly handsRepository.AbandonedHand[]>;
  readonly handStarted: (deal: ArchivedDeal) => Promise<void>;
  readonly actionsApplied: (handId: string, actions: readonly ArchivedAction[]) => Promise<void>;
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

/** `sql` is a getter so registering routes never touches the database. A missing pool fails writes. */
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
          automaticReason: action.automaticReason,
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

/** A port so the rooms and socket tests run on a `Map`-backed fake. */
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
    /** All three facts, or none. A partial bot row cannot be rehydrated. See `bot-profile.ts`. */
    readonly bot?: DurableBotSeat | null;
  }) => Promise<roomsRepository.RoomMemberRow>;
  /** Resolves to the id of the membership that took the seat, which `recordFirstSit` is given. */
  readonly seatMember: (roomId: string, userId: string, seat: number) => Promise<string>;
  /** Called only after the live table accepted the seat, for the membership `seatMember` seated. */
  readonly recordFirstSit: (memberId: string) => Promise<boolean>;
  readonly unseatMember: (roomId: string, userId: string) => Promise<void>;
  readonly removeMember: (roomId: string, userId: string) => Promise<void>;
  readonly close: (roomId: string, ownerUserId: string) => Promise<boolean>;
  /** `close`, refused when another person is a member at the moment of closing. See `retire`. */
  readonly closePracticeTable: (roomId: string, ownerUserId: string) => Promise<boolean>;
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
    seatMember: async (roomId, userId, seat) =>
      (await roomsRepository.seatMember(sql(), roomId, userId, seat)).id,
    recordFirstSit: (memberId) => roomsRepository.recordFirstSit(sql(), memberId),
    unseatMember: async (roomId, userId) => {
      await roomsRepository.unseatMember(sql(), roomId, userId);
    },
    removeMember: async (roomId, userId) => {
      await roomsRepository.removeMember(sql(), roomId, userId);
    },
    close: (roomId, ownerUserId) => roomsRepository.close(sql(), roomId, { ownerUserId }),
    closePracticeTable: (roomId, ownerUserId) =>
      roomsRepository.closePracticeTable(sql(), roomId, ownerUserId),
    createBotUser: async (displayName) => {
      const row = await usersRepository.createGuest(sql(), { displayName });
      return { id: row.id, displayName: row.display_name };
    },
    readUnits: async (userId) => (await usersRepository.readUnits(sql(), userId)).units,
  };
}

/** One room, live: its record, its members, its table and its bots. */
export class LiveRoom {
  readonly record: RoomRecord;
  readonly table: LiveTable;
  readonly bots: BotRunner;
  private readonly members = new Map<string, RoomMemberRecord>();
  private readonly metrics: AppMetrics;
  /** Serialises archive writes, so `hands.start` lands before the first action row. */
  private archiveQueue: Promise<void> = Promise.resolve();
  /**
   * Serialises the durable work a released seat causes. Separate from `archiveQueue` because a seat
   * release is not reporting, and `standFromTable` awaits it so its response describes a freed seat.
   */
  private releaseQueue: Promise<void> = Promise.resolve();
  /**
   * Members who asked to leave the ROOM and still hold a seat in a live hand. The membership is
   * dropped when the table releases the chair, so a mid-hand leaver does not stay a live member.
   */
  private readonly pendingRoomExit = new Set<string>();
  private readonly releaseSeat: ((userId: string) => Promise<void>) | null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: {
    readonly record: RoomRecord;
    readonly table: LiveTable;
    readonly bots: BotRunner;
    readonly archive: HandArchive;
    readonly onProblem: ProblemHook;
    readonly metrics: AppMetrics;
    /**
     * Frees the durable seat of a player the table just released. `RoomRegistry.buildRoom` binds it to
     * `store.unseatMember`. Omitted, a release is in memory only, for table-only tests.
     */
    readonly releaseSeat?: (userId: string) => Promise<void>;
  }) {
    this.record = options.record;
    this.table = options.table;
    this.bots = options.bots;
    this.metrics = options.metrics;
    this.releaseSeat = options.releaseSeat ?? null;
    this.unsubscribe = this.table.subscribe((notice) => {
      this.archiveNotice(notice, options.archive, options.onProblem);
      // Both reactions hang off the same notice, so every seat release is handled once, here.
      this.releaseDeparted(notice, options.onProblem);
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

  /**
   * Starts a member's exit from the room, finishing it now if there is nothing to wait for.
   * Call this BEFORE `table.stand`, always. `stand` may release the chair synchronously, and that
   * notice completes the exit only if the room was already marked.
   */
  beginRoomExit(userId: string): void {
    if (this.table.seatOf(userId) === null) {
      this.removeMember(userId);
      return;
    }
    this.pendingRoomExit.add(userId);
  }

  /** Resolves once every announced seat release is written. A seat still in a live hand is not waited for. */
  settleSeatReleases(): Promise<void> {
    return this.releaseQueue;
  }

  /**
   * Never rejects. For a caller writing a stack outside this chain (a units reset) that a queued
   * `stacksSettled` must not overwrite.
   */
  archiveSettled(): Promise<void> {
    return this.archiveQueue;
  }

  /** One reaction for both departure kinds. The seat row is always freed, the membership on a room exit. */
  private releaseDeparted(notice: TableNotice, onProblem: ProblemHook): void {
    if (notice.departed.length === 0) return;
    const departed = [...notice.departed];
    // Synchronous on purpose. The durable removal already happened in `leaveRoom`, and a microtask
    // delay would let a same-turn request still be served to an ex-member.
    for (const userId of departed) {
      if (this.pendingRoomExit.delete(userId)) this.removeMember(userId);
    }
    if (this.releaseSeat === null) return;
    const releaseSeat = this.releaseSeat;
    this.releaseQueue = this.releaseQueue
      .then(async () => {
        // Per seat, so one failure cannot strand the other chairs freed by the same notice.
        const stuck: string[] = [];
        let lastError: unknown = null;
        for (const userId of departed) {
          try {
            await releaseSeat(userId);
          } catch (error) {
            stuck.push(userId);
            lastError = error;
          }
        }
        if (stuck.length === 0) return;

        // Counted at the source, by chairs (`seat-release` is `counted-at-source`). Its own counter,
        // not `archiveFailures`, so a stuck chair does not page the history runbook.
        this.metrics.seatReleaseFailures.inc({}, stuck.length);
        // Logged and swallowed so the chain keeps working. Nothing retries, so the chair is refused
        // `seat_taken` until a restart, which is why this is alertable.
        onProblem('a seat could not be released after its player left', {
          event: 'seat-release',
          roomId: this.record.id,
          users: stuck,
          error: String(lastError),
        });
      })
      .catch(() => {
        // A backstop against `onProblem` or the counter throwing, so the chain never stays rejected.
      });
  }

  noteSocket(userId: string, delta: number): void {
    const member = this.members.get(userId);
    if (member === undefined) return;
    member.sockets = Math.max(0, member.sockets + delta);
  }

  close(): void {
    // A hand in progress at close can never settle. Counted here, because the started/completed
    // gap also contains every hand being played.
    if (this.table.snapshot().handInProgress) {
      this.metrics.handsFailed.inc({ reason: 'room_closed' });
    }
    this.record.closed = true;
    this.bots.stop();
    this.table.close();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Appends this notice's archive writes to the room's chain. Nobody awaits it, and a failure is logged. */
  private archiveNotice(notice: TableNotice, archive: HandArchive, onProblem: ProblemHook): void {
    // Counted here, not in `LiveTable`, so table tests are not metrics tests. Each fires once per
    // hand, and a hand that ends before anyone acts sets both on one notice.
    if (notice.reason === 'handStarted') this.metrics.handsStarted.inc();
    if (notice.handCompleted) this.metrics.handsCompleted.inc();

    const handId = notice.handId;
    const deal = notice.reason === 'handStarted' ? this.table.archivedDeal() : null;
    const street = notice.events.some((event) => event.kind === 'street') ? notice.street : null;
    const board = notice.board;
    const actions = notice.loggedActions;
    const result = notice.handCompleted ? this.table.archivedResult() : null;
    // From the NOTICE, never the snapshot, which has already dropped mid-hand leavers.
    const settled = notice.settledStacks;
    // Completion wins when a hand starts and ends on one notice, so the lobby does not say `playing`.
    const roomStatus = notice.handCompleted ? 'open' : notice.reason === 'handStarted' ? 'playing' : null;

    this.archiveQueue = this.archiveQueue
      .then(async () => {
        if (deal !== null) await archive.handStarted(deal);
        if (handId !== null && actions.length > 0) await archive.actionsApplied(handId, actions);
        if (handId !== null && street !== null && street !== 'complete') {
          await archive.streetAdvanced(handId, street, board);
        }
        if (result !== null) await archive.handCompleted(result);
        if (settled !== null) {
          await archive.stacksSettled({ roomId: this.record.id, stacks: settled });
        }
        if (roomStatus !== null) await archive.roomStatusChanged(this.record.id, roomStatus);
      })
      .catch((error: unknown) => {
        // Not a failed hand, so its own counter, counted here. The `onProblem` consumer does not count it.
        this.metrics.archiveFailures.inc();
        onProblem('a hand could not be archived', {
          event: 'archive-write',
          roomId: this.record.id,
          error: String(error),
        });
      });
  }
}

export interface RoomRegistryOptions {
  readonly clock?: Clock;
  /**
   * How long a lone learner gets to act, in seconds, from `AppConfig.learnerTurnSeconds`. Threaded in
   * so tests can vary it. Omitted, `LiveTable` applies its own default.
   */
  readonly learnerTurnSeconds?: number;
  /** The dealing source. `createSecureRandom()` unless a test needs otherwise. */
  readonly random?: RandomSource;
  readonly archive?: HandArchive;
  /** Room and member persistence. Defaults to the repositories, bound lazily. */
  readonly store?: RoomStore;
  /** Bots' thinking delay. Legibility only. */
  readonly botThinkingDelayMs?: number;
  readonly nextHandId?: () => string;
  /** Non-fatal problems from this registry, its tables and its bots, each with a typed `event`. */
  readonly onProblem?: ProblemHook;
  /** Defaults to the process-wide metrics. A test that wants isolation passes its own. */
  readonly metrics?: AppMetrics;
  /**
   * The room lease, or `null` for a registry that does not enforce one.
   * Null by default so the `Map`-backed tests and a database-less dev run need no Postgres. Production
   * passes `postgresRoomOwnership(getSql)` in `routes/index.ts`.
   */
  readonly ownership?: RoomOwnership | null;
  /**
   * Who may take a seat, or `null` (the `PRL_ENROLMENT_REQUIRED=off` default) for no gate. Bound
   * exactly when config says `enforced`.
   */
  readonly entitlement?: SeatEntitlement | null;
}

/** Why a room was taken away from this process. Both are `prl_room_fencings_total{reason=...}`. */
export type EvictionReason = 'fenced' | 'lease_expired';

/** A lease this registry believes it holds, and the last moment it had proof. */
interface HeldLease {
  readonly fence: number;
  /** `clock.now()` at the last acquisition or successful renewal. See `LEASE_SELF_EVICT_AFTER_MS`. */
  confirmedAt: number;
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
  /** Re-read the row under the lease and refuse a closed room. Set by `ensureOpen`; see `buildOwnedRoom`. */
  readonly recheckClosed?: boolean;
}

/** Every live room in this process. One instance, shared by the routes and the WebSocket hub. */
export class RoomRegistry {
  private readonly rooms = new Map<string, LiveRoom>();

  /** Builds in flight, so concurrent first-touches share one. Removed on settle, including rejection. */
  private readonly opening = new Map<string, Promise<LiveRoom>>();
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly learnerTurnSeconds: number | undefined;
  private readonly archive: HandArchive;
  private readonly botThinkingDelayMs: number | undefined;
  private readonly nextHandId: () => string;
  private readonly onProblem: ProblemHook;
  private readonly metrics: AppMetrics;
  readonly store: RoomStore;

  /** The lease, or null for a registry that does not enforce one. See `RoomRegistryOptions`. */
  private readonly ownership: RoomOwnership | null;
  /** Who may sit, or null for a deployment that does not gate seating. See `rooms/entitlement.ts`. */
  private readonly entitlement: SeatEntitlement | null;
  /** One entry per room this process believes it owns. Keyed the same way `rooms` is. */
  private readonly leases = new Map<string, HeldLease>();
  /** The renewal timer, armed only while at least one lease is held. */
  private heartbeatTask: ScheduledTask | null = null;
  /** Every release started, chained so `shutdown()` can await them rather than leave leases for a TTL. */
  private releaseQueue: Promise<void> = Promise.resolve();
  /** Who wants to know that a room was taken away. `ws/hub.ts` registers one, to close sockets. */
  private readonly evictionListeners = new Set<(roomId: string, reason: EvictionReason) => void>();
  /** Who wants to know that a practice table was retired. `ws/hub.ts` registers one, to close sockets. */
  private readonly retirementListeners = new Set<(roomId: string) => void>();
  /** The tail of each learner's queue of "replace my practice table". See `replacePracticeTable`. */
  private readonly practiceTableTurns = new Map<string, Promise<void>>();

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
    this.ownership = options.ownership ?? null;
    this.entitlement = options.entitlement ?? null;
    // Read at scrape time, never mirrored, so the gauge cannot drift. One registry per process; a
    // test that builds several passes its own `metrics`.
    this.metrics.roomsLive.setFrom(() => this.rooms.size);
  }

  /**
   * Opens a live table for a room, or returns the one already open.
   * The build is a check-then-act across several `await`s, and a page load races `GET /rooms/:id`
   * against the socket `hello`. Two builds mean a silent table (the socket subscribed to the replaced
   * one), a lockout (`addMember` on the orphan) and a leak, so the build is published in `opening`
   * before its first `await` and every other caller waits on it.
   */
  open(request: OpenRoomRequest): Promise<LiveRoom> {
    const existing = this.rooms.get(request.record.id);
    if (existing !== undefined) return Promise.resolve(existing);

    const inFlight = this.opening.get(request.record.id);
    if (inFlight !== undefined) return inFlight;

    // No `await` before the `set`: `buildRoom` runs synchronously up to its first `await`.
    const build = this.buildRoom(request).finally(() => {
      this.opening.delete(request.record.id);
    });
    this.opening.set(request.record.id, build);
    return build;
  }

  private async buildRoom(request: OpenRoomRequest): Promise<LiveRoom> {
    // THE LEASE IS TAKEN FIRST. NOTHING ABOVE THIS LINE, EVER.
    // `reconcileInterruptedHands` closes open hand rows, which would destroy a hand another process
    // is still playing. It fails closed. If the lease cannot be read, the room does not open.
    await this.acquireLease(request.record.id);
    try {
      return await this.buildOwnedRoom(request);
    } catch (error) {
      // Released rather than left to expire, or a transient failure locks the room for a TTL.
      this.releaseLeaseSoon(request.record.id);
      throw error;
    }
  }

  private async buildOwnedRoom(request: OpenRoomRequest): Promise<LiveRoom> {
    // Re-read under the lease, because the read that decided to open may be stale: a retire can close
    // the row mid-open. A later closer waits on `opening` (see `retire`). `createRoom` just wrote the
    // row, so it skips this.
    if (request.recheckClosed === true && (await this.store.byId(request.record.id))?.status === 'closed') {
      throw new AppError('room_closed', {
        logDetail: `room ${request.record.id} closed while it was opening`,
      });
    }
    // Any open hand in the database belongs to a dead process. Closed before the table exists, so
    // it cannot race this process's deal. Counted inside.
    await this.reconcileInterruptedHands(request.record.id);

    // Seeded from the database so hand numbers do not collide and the blind rotation resumes.
    let played = 0;
    let blinds: BlindPositions | undefined;
    try {
      played = Math.max(0, (await this.archive.nextHandNumber(request.record.id)) - 1);
      const last = await this.archive.lastDealtHand(request.record.id);
      blinds =
        last === null ? undefined : (blindsFromLastHand(last, request.record.config.maxSeats) ?? undefined);
    } catch (error) {
      // Fail soft. The cost is one repeated big blind.
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
      // Announced when the table frees the chair, not when the player asked, so they cannot drift.
      releaseSeat: (userId) => this.store.unseatMember(request.record.id, userId),
    });
    for (const member of request.members ?? []) room.addMember(member);
    this.rooms.set(request.record.id, room);
    return room;
  }

  get(roomId: string): LiveRoom | null {
    return this.rooms.get(roomId) ?? null;
  }

  /**
   * Closes any hand of this room that can never complete, and reports how many. Public for a startup
   * sweep of rooms nobody re-opens. Failures are logged and swallowed, as in `archiveNotice`.
   */
  async reconcileInterruptedHands(roomId: string): Promise<number> {
    if (this.rooms.has(roomId)) return 0;
    try {
      const abandoned = await this.archive.abandonInterruptedHands(roomId);
      if (abandoned.length > 0) {
        // Counted here so no caller can forget, by `abandoned.length` because one call can close several.
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

  /** Strangers and non-members get the same answer, so a room id cannot be confirmed. */
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

  /** Opens the live table for a persisted room. Null when there is no such room. */
  async ensureOpen(roomId: string): Promise<LiveRoom | null> {
    const live = this.rooms.get(roomId);
    if (live !== undefined) return live;
    const row = await this.store.byId(roomId);
    if (row === null || row.status === 'closed') return null;
    const members = await this.store.membersOfRooms([roomId]);
    let room: LiveRoom;
    try {
      room = await this.open({
        record: recordFromRow(row),
        recheckClosed: true,
        members: members.map((member) => ({
          userId: member.user_id,
          displayName: member.display_name,
          isBot: member.is_bot,
          botProfile: member.bot_profile,
        })),
      });
    } catch (error) {
      // Closed between the read above and the build's own read. See `buildOwnedRoom`.
      if (error instanceof AppError && error.code === 'room_closed') return null;
      throw error;
    }
    // Recorded seats are re-taken, and bot seats re-registered so they play rather than time out.
    // `rehydrateBotSeat` refuses rather than substitutes; `OpponentModel` is not restored.
    // This is a call site of `table.sit`, so it is gated too. A bot (`is_bot` from the durable row) is
    // never asked, as it cannot hold an enrolment. A learner no longer entitled does not get the chair
    // back, or a revocation would wait for a restart, and the seat is freed in the database or
    // `room_members_live_seat_key` refuses the next sitter `seat_taken`; membership and stack stay. A
    // failed entitlement read leaves the seat unrestored (fail closed, via the catch below).
    // The refusal is not `seat-retake`, which means a seat that owes an action.
    for (const member of members) {
      if (member.seat === null) continue;
      try {
        if (!member.is_bot && !(await this.entitledToResumeSeat(member.user_id))) {
          this.metrics.seatEntitlementRefusals.inc({ reason: 'seat_not_restored' });
          // Fail-soft. The refusal stands whether or not this write lands.
          const freed = await this.store
            .unseatMember(roomId, member.user_id)
            .then(() => true)
            .catch((error: unknown) => {
              // Counted here because `seat-release` is `counted-at-source`. Same counter and runbook
              // as a stuck chair, since the consequence is the same.
              this.metrics.seatReleaseFailures.inc({}, 1);
              this.onProblem('a seat left empty by an expired enrolment could not be freed', {
                event: 'seat-release',
                roomId,
                seat: member.seat,
                error: String(error),
              });
              return false;
            });
          this.onProblem('a recorded seat was not restored: its holder is no longer entitled to sit', {
            event: 'seat-entitlement',
            roomId,
            seat: member.seat,
            userId: member.user_id,
            freed,
          });
          continue;
        }
        await room.table.sit({
          userId: member.user_id,
          displayName: member.display_name,
          seat: member.seat,
          stack: member.stack,
          isBot: member.is_bot,
          botProfile: member.bot_profile,
          // A restart is not an arrival, so no blind wait.
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
   * Never throws, so one bad row cannot cost the room its other seats. A refused seat stays inert and
   * the turn timer folds it. No nearest-match fallback.
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
   * The durable row first, then the live table, so a failed write leaves nothing to clean up. The
   * invite code is returned once and never stored or logged (`logging.ts` censors `/invite/i`).
   */
  async createRoom(
    principal: RoomPrincipal,
    spec: Omit<CreateRoomSpec, 'ownerUserId'>,
  ): Promise<{ readonly room: LiveRoom; readonly inviteCode: string }> {
    const created = await this.store.create({ ...spec, ownerUserId: principal.userId });
    const record = recordFromRow(created.room);
    const room = await this.open({ record });
    await this.store.addMember({ roomId: record.id, userId: principal.userId });
    room.addMember({
      userId: principal.userId,
      displayName: principal.displayName,
      isBot: false,
      botProfile: null,
    });
    return { room, inviteCode: created.inviteCode };
  }

  /** Joining twice is not an error, so a retried request is answered with the same room. */
  async joinByInviteCode(principal: RoomPrincipal, code: string): Promise<LiveRoom> {
    const row = await this.store.byInviteCode(code);
    // One answer for "no such code" and "malformed code", so a brute force learns nothing.
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
   * `room_members_live_seat_key` arbitrates a race for one seat. If the live table refuses, the
   * database seat is given back.
   * Both transports (`POST /rooms/:roomId/sit` and the socket `sit` frame) take a new seat here, so the
   * entitlement check lives here; `ensureOpen` re-seats under its own gate.
   * `require` stays first so a stranger cannot learn a room exists from `enrolment_required`. The
   * entitlement check then runs before any durable write or units read.
   */
  async sitAtTable(roomId: string, principal: RoomPrincipal, seat: number): Promise<void> {
    const room = this.require(roomId, principal.userId);
    await this.requireEntitledToSit(principal.userId, roomId, seat);
    const member = await this.store.memberOf(roomId, principal.userId);
    if (member === null) {
      throw new AppError('not_room_member', { logDetail: `not a live member of ${roomId}` });
    }
    // A returning occupant keeps the stack the last settled hand left them.
    const buyIn = member.stack > 0 ? member.stack : room.record.startingStack;
    // Only a rebuy (stack 0) is drawn against units. A membership holding chips sits with its own.
    if (member.stack === 0 && (await this.store.readUnits(principal.userId)) < buyIn) {
      throw new AppError('insufficient_units', {
        logDetail: `buy-in ${buyIn} exceeds available units`,
      });
    }

    // Read before the awaits below, so a leave from another tab during them shows after the live sit.
    const liveMember = room.member(principal.userId);
    const memberId = await this.store.seatMember(roomId, principal.userId, seat);
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
    // A leave from another tab during the live sit already wrote `left_at`, and `addMember` would
    // put the learner back. So the sit is undone and refused. A changed record is a leave too, since a
    // rejoin made a new membership. A null `liveMember` (owner not on the roster) is still added.
    if (room.member(principal.userId) !== liveMember) {
      await room.table.stand(principal.userId);
      await room.settleSeatReleases();
      throw new AppError('not_room_member', { logDetail: `left ${roomId} while taking a seat` });
    }
    room.addMember({
      userId: principal.userId,
      displayName: principal.displayName,
      isBot: false,
      botProfile: null,
    });
    // After the live sit, which can still refuse, and by `memberId`, since a rejoin makes a new
    // membership. See `rooms.recordFirstSit`.
    await this.recordFirstSit(roomId, principal.userId, memberId);
  }

  /**
   * Does not fail a sit that already happened. A missed record errs safe, because units read low and
   * never high. Reported, so a gap here is not quiet.
   */
  private async recordFirstSit(roomId: string, userId: string, memberId: string): Promise<void> {
    try {
      await this.store.recordFirstSit(memberId);
    } catch (error) {
      this.onProblem('a first sit could not be recorded', {
        event: 'first-sit-record',
        roomId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Returns at once when `entitlement` is null (`PRL_ENROLMENT_REQUIRED` off).
   * `logDetail` cannot name the reason, as `entitledToSit` is a boolean. An operator runs
   * `pnpm run enrolments show --user <id>`.
   */
  private async requireEntitledToSit(userId: string, roomId: string, seat: number): Promise<void> {
    if (this.entitlement === null) return;
    if (await this.entitlement.entitledToSit(userId)) return;
    this.metrics.seatEntitlementRefusals.inc({ reason: 'not_entitled' });
    throw new AppError('enrolment_required', {
      logDetail: `no live enrolment entitles this account to seat ${seat} at ${roomId}`,
    });
  }

  /** No query when seating is not gated. Not `async`, because biome wants the promise returned directly. */
  private entitledToResumeSeat(userId: string): Promise<boolean> {
    if (this.entitlement === null) return Promise.resolve(true);
    return this.entitlement.entitledToSit(userId);
  }

  /**
   * Stands up, keeping the membership. The table goes first (unlike `sitAtTable`), because a player
   * in a live hand keeps the chair until the hand settles. The table announces the release and
   * `LiveRoom.releaseDeparted` writes it. Awaiting the chain covers the immediate case only.
   */
  async standFromTable(roomId: string, userId: string): Promise<void> {
    const room = this.require(roomId, userId);
    await room.table.stand(userId);
    await room.settleSeatReleases();
  }

  /**
   * Leaves the room altogether: stand up if seated, then drop the membership.
   * `beginRoomExit` comes FIRST, before `stand`. See `LiveRoom.beginRoomExit`.
   */
  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const room = this.require(roomId, userId);
    room.beginRoomExit(userId);
    if (room.table.seatOf(userId) !== null) await room.table.stand(userId);
    await this.store.unseatMember(roomId, userId);
    await this.store.removeMember(roomId, userId);
    await room.settleSeatReleases();
  }

  /**
   * Closes the learner's previous practice tables, so starting a new one does not mint a stack: every
   * created room gives its owner a membership with `starting_stack`, and units sum live memberships.
   * A practice table is one this learner OWNS, open, where every other member is a bot (at least
   * one) and the bots fill every seat but one, so a room another person joined never matches (matching
   * on `name` would). A hand in progress is played out, not failed, or closing would page
   * `HandsFailing` and let a learner void a losing hand: the reader is stood up, the bots finish, and
   * the table closes on the settling notice. The row and `record.closed` are set at once, so
   * `ensureOpen` and `require()` refuse the room meanwhile. Returns the ids it closed.
   */
  async retirePracticeTables(userId: string): Promise<readonly string[]> {
    const owned = (await this.store.listForUser(userId)).filter(
      (row) => row.owner_user_id === userId && row.status !== 'closed',
    );
    if (owned.length === 0) return [];
    const roster = await this.store.membersOfRooms(owned.map((row) => row.id));
    const retired: string[] = [];
    for (const row of owned) {
      const members = roster.filter((member) => member.room_id === row.id);
      const bots = members.filter((member) => member.is_bot).length;
      const anotherPerson = members.some((member) => !member.is_bot && member.user_id !== userId);
      if (anotherPerson || bots === 0 || row.max_seats !== bots + 1) continue;
      if (await this.retire(row.id, userId)) retired.push(row.id);
    }
    return retired;
  }

  /**
   * Retires the learner's practice tables and then runs `create`, one learner's calls at a time, or
   * two tabs each retire the old match and both new rooms stay open. `create` must build the room AND
   * its bots, as a half-built table is not yet a practice table.
   * In-process is enough under `replicas: 1`. A failed turn does not block the next.
   */
  replacePracticeTable<T>(userId: string, create: () => Promise<T>): Promise<T> {
    const before = this.practiceTableTurns.get(userId) ?? Promise.resolve();
    const turn = before.then(async () => {
      await this.retirePracticeTables(userId);
      return create();
    });
    const settled = turn.then(
      () => undefined,
      () => undefined,
    );
    this.practiceTableTurns.set(userId, settled);
    void settled.then(() => {
      if (this.practiceTableTurns.get(userId) === settled) this.practiceTableTurns.delete(userId);
    });
    return turn;
  }

  /** One practice table, closed durably and then live. See `retirePracticeTables`. */
  private async retire(roomId: string, ownerUserId: string): Promise<boolean> {
    // A build in flight would publish its room after the lookup below and outlive the close.
    await this.opening.get(roomId)?.catch(() => undefined);
    // Not `store.close`: a friend may have joined since the roster read. `closePracticeTable`
    // re-checks under the room-row lock a join takes. Refused means not retired.
    if (!(await this.store.closePracticeTable(roomId, ownerUserId))) return false;
    // Again after the close, for a build that read the row before the close committed.
    await this.opening.get(roomId)?.catch(() => undefined);
    const live = this.rooms.get(roomId);
    if (live === undefined) return true;
    live.record.closed = true;
    if (live.table.handInProgress) {
      // Subscribed BEFORE the stand: in heads-up the reader's fold inside `stand` settles the hand.
      const stop = live.table.subscribe((notice) => {
        if (!notice.handCompleted) return;
        stop();
        // After every subscriber has seen the notice, never from inside the table's queue.
        queueMicrotask(() => this.close(roomId));
      });
      try {
        if (live.table.seatOf(ownerUserId) !== null) await live.table.stand(ownerUserId);
      } catch (error) {
        // `stand` runs behind queued work, so a queued bot fold can settle the hand first and make it
        // throw `not_seated`. That outcome is fine, and the subscription above closes the table.
        if (!(error instanceof AppError && error.code === 'not_seated')) throw error;
      }
    } else {
      this.close(roomId);
    }
    this.notifyRetired(roomId);
    return true;
  }

  private notifyRetired(roomId: string): void {
    for (const listener of [...this.retirementListeners]) {
      try {
        listener(roomId);
      } catch {
        // The room is closed. A throwing listener is the listener's bug.
      }
    }
  }

  /**
   * Puts a learner's chips back to the starting stack at every live table they are seated at, since
   * the table deals from memory and the next settlement would write its stack back over the row.
   * The caller writes the durable reset after this resolves. Draining each archive chain first means
   * no queued settlement can overwrite it. A learner in a live hand is restacked at settlement,
   * because reset is never refused (`docs/PRODUCT-GUARDRAILS.md` §1).
   */
  async restackForUnitsReset(userId: string): Promise<void> {
    for (const room of [...this.rooms.values()]) {
      if (room.record.closed || room.table.seatOf(userId) === null) continue;
      await room.table.restack(userId, room.record.startingStack);
      await room.archiveSettled();
    }
  }

  /**
   * Seats a bot and registers it with the runner. Both, or neither. `memberId` is what the caller's
   * `store.seatMember` returned for this bot's durable seat; its first sit is recorded on that row.
   */
  async seatBot(
    roomId: string,
    spec: BotSeatSpec & { readonly displayName: string },
    memberId: string,
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
    const member = room.addMember({
      userId: spec.userId,
      displayName: spec.displayName,
      isBot: true,
      botProfile: spec.profileId,
    });
    await this.recordFirstSit(roomId, spec.userId, memberId);
    return member;
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

  /** Closes one room: its bots, its table, its timers, and the lease it was holding. */
  close(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    room.close();
    this.rooms.delete(roomId);
    // Started here and awaited by `shutdown()`. `close` has synchronous callers, and the release lets
    // the next process take the room without waiting out the TTL.
    this.releaseLeaseSoon(roomId);
  }

  /** Closes every room, so no turn timer or bot decision keeps a forgotten table alive. */
  closeAll(): void {
    for (const roomId of [...this.rooms.keys()]) this.close(roomId);
    // A build in flight holds a lease but is not in `this.rooms` yet. Without this the replacement
    // process is refused that room for `LEASE_TTL_MS`.
    for (const roomId of [...this.leases.keys()]) this.releaseLeaseSoon(roomId);
    this.heartbeatTask?.cancel();
    this.heartbeatTask = null;
  }

  /**
   * `closeAll()`, plus waiting for every lease to be given back, so a deploy does not leave rooms
   * unopenable for `LEASE_TTL_MS`.
   * In-flight builds are awaited first, or a SIGTERM mid-build leaves the lease held and later
   * publishes a live room into a shut-down registry. Each await is a query, bounded by `db.ts`.
   * `allSettled`, because a failed build already released its lease. Never rejects.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.opening.values()]);
    this.closeAll();
    await this.releaseQueue;
  }

  get size(): number {
    return this.rooms.size;
  }

  get enforcesOwnership(): boolean {
    return this.ownership !== null;
  }

  get enforcesEntitlement(): boolean {
    return this.entitlement !== null;
  }

  /** The lease this process holds for a room, or null. A moved fence means the room changed hands. */
  leaseFor(roomId: string): { readonly fence: number } | null {
    const lease = this.leases.get(roomId);
    return lease === undefined ? null : { fence: lease.fence };
  }

  /**
   * The registry knows nothing about sockets, so `ws/hub.ts` registers a listener that closes a
   * fenced room's sockets with `WS_CLOSE.serverShuttingDown`. A throwing listener cannot stop the eviction.
   */
  onEviction(listener: (roomId: string, reason: EvictionReason) => void): () => void {
    this.evictionListeners.add(listener);
    return () => {
      this.evictionListeners.delete(listener);
    };
  }

  /**
   * Separate from `onEviction`, because nothing was taken from this process and `EvictionReason` is a
   * fencing metric label. The hub closes the retired table's sockets.
   */
  onRetirement(listener: (roomId: string) => void): () => void {
    this.retirementListeners.add(listener);
    return () => {
      this.retirementListeners.delete(listener);
    };
  }

  /**
   * Takes the lease for a room, or refuses to serve it with `room_owned_elsewhere` and a counter (not
   * `seat_taken`, not a 500). The holder is read for the log line only and cannot change the answer.
   */
  private async acquireLease(roomId: string): Promise<void> {
    const ownership = this.ownership;
    if (ownership === null) return;
    const lease = await ownership.acquire(roomId);
    if (lease === null) {
      this.metrics.roomOwnershipRefusals.inc();
      const holder = await ownership.holderOf(roomId).catch(() => null);
      this.onProblem('another API process holds this room, so this one will not serve it', {
        event: 'room-lease-refused',
        roomId,
        ownerId: ownership.ownerId,
        holderId: holder?.ownerId ?? 'unknown',
        holderFence: holder?.fence ?? null,
        holderHeartbeatAgeMs: holder?.heartbeatAgeMs ?? null,
      });
      throw new AppError('room_owned_elsewhere', {
        logDetail: `room ${roomId} is leased to another API process`,
      });
    }
    this.leases.set(roomId, { fence: lease.fence, confirmedAt: this.clock.now() });
    this.armHeartbeat();
  }

  /**
   * Renews every lease this process holds, and evicts every room it turns out not to.
   * A renewal that comes back WITHOUT a room is a fencing. One that THROWS says nothing about
   * ownership, so it evicts only once the last confirmed renewal is older than
   * `LEASE_SELF_EVICT_AFTER_MS`. See `ownership.ts` for the numbers.
   * The verdict applies only to leases whose fence matches `asked`. A room opened, or closed and
   * re-opened, during the round trip was not in the question; judging it anyway would close a fresh
   * table as `fenced`, or drop a lease entry so the room is dealt at with nothing renewing it.
   * Fences, not a clock, because the tests' manual clock never advances.
   */
  async heartbeatLeases(): Promise<void> {
    const ownership = this.ownership;
    if (ownership === null || this.leases.size === 0) return;
    const asked = new Map([...this.leases].map(([roomId, lease]) => [roomId, lease.fence]));
    const roomIds = [...asked.keys()];
    let renewed: readonly string[] | null = null;
    let failure: unknown = null;
    try {
      renewed = await ownership.heartbeat(roomIds);
    } catch (error) {
      // Not reported on its own, to keep the log readable. An eviction reports it if it costs a lease.
      failure = error;
    }
    const now = this.clock.now();
    const held = renewed === null ? null : new Set(renewed);
    for (const [roomId, lease] of [...this.leases]) {
      if (asked.get(roomId) !== lease.fence) continue;
      if (held !== null) {
        if (held.has(roomId)) {
          lease.confirmedAt = now;
          continue;
        }
        this.evict(roomId, 'fenced', null);
        continue;
      }
      if (now - lease.confirmedAt >= LEASE_SELF_EVICT_AFTER_MS) {
        this.evict(roomId, 'lease_expired', failure);
      }
    }
  }

  /**
   * Stops serving a room this process no longer owns.
   * The room is dropped and the table closed FIRST, before any logging or listener, so a throw
   * cannot leave this process serving it. A `fenced` lease is not released, since the row is
   * someone else's. A `lease_expired` one is released best effort.
   */
  private evict(roomId: string, reason: EvictionReason, cause: unknown): void {
    const lease = this.leases.get(roomId);
    this.leases.delete(roomId);
    const room = this.rooms.get(roomId);
    if (room !== undefined) {
      room.close();
      this.rooms.delete(roomId);
    }
    this.metrics.roomFencings.inc({ reason });
    for (const listener of [...this.evictionListeners]) {
      try {
        listener(roomId, reason);
      } catch {
        // Swallowed on purpose. The eviction already happened, and the sockets' own heartbeat closes them.
      }
    }
    // Through `report`, because `heartbeatLeases` is called as `void ...finally(...)`, so a throwing
    // logger here would be an unhandled rejection that kills the process mid-fencing.
    this.report(
      reason === 'fenced'
        ? 'another API process took this room; it has been closed here'
        : 'this process could not renew the lease on a room and has stopped serving it',
      {
        event: 'room-fenced',
        roomId,
        reason,
        fence: lease?.fence ?? null,
        ownerId: this.ownership?.ownerId ?? null,
        wasLive: room !== undefined,
        ...(cause === null ? {} : { error: String(cause) }),
      },
    );
    // The fence is passed explicitly, because the map entry was deleted at the top.
    if (reason === 'lease_expired') this.releaseLeaseSoon(roomId, lease?.fence ?? null);
  }

  /**
   * `onProblem` for paths where the safety action already happened (an eviction, a lease release).
   * It is not a blanket replacement. Elsewhere a throwing hook is a fault the caller should see, and
   * `buildRoom` relies on that.
   */
  private report(...args: Parameters<ProblemHook>): void {
    try {
      this.onProblem(...args);
    } catch {
      // There is nowhere left to report a reporting failure to.
    }
  }

  /**
   * Queues the release of one lease, so `shutdown()` can wait for every one of them.
   * A QUEUED RELEASE IS A STATEMENT ABOUT ONE GENERATION OF ONE LEASE. The chain can drain long
   * after a slow-database outage, when this process has already re-acquired the room at a new
   * fence. Owner scoping cannot tell those apart: the stale release would delete the new row and the
   * next beat evict the room as `fenced`. So the fence is read here and carried.
   * A room with no entry in `this.leases` is not released.
   */
  private releaseLeaseSoon(roomId: string, fence: number | null = null): void {
    const ownership = this.ownership;
    if (ownership === null) return;
    const generation = fence ?? this.leases.get(roomId)?.fence ?? null;
    this.leases.delete(roomId);
    if (generation === null) return;
    this.releaseQueue = this.releaseQueue
      .then(async () => {
        // Also skipped if the room is back in `this.leases`, because the fence restarts at 1 after a
        // delete and a stale generation 1 can match a fresh one. Still open is a DELETE stalled past
        // `LEASE_TTL_MS` while a neighbour took and released the room. Closing that would mean not
        // deleting, which costs every deploy a TTL of refusals (`db/migrations/0005`).
        if (this.leases.has(roomId)) return;
        await ownership.release(roomId, generation);
      })
      .catch((error: unknown) => {
        // Logged and swallowed so the chain and `shutdown()` never reject. One room stays unopenable
        // until its lease expires. Through `report`, because this catch IS `releaseQueue`.
        this.report('a room lease could not be released; it will expire on its own', {
          event: 'room-lease-release',
          roomId,
          ownerId: ownership.ownerId,
          error: String(error),
        });
      });
  }

  /**
   * Re-armed from inside the tick, not an interval, so a slow beat cannot overlap the next. Stops when
   * the last room goes.
   */
  private armHeartbeat(): void {
    if (this.ownership === null || this.heartbeatTask !== null) return;
    this.heartbeatTask = this.clock.schedule(LEASE_HEARTBEAT_INTERVAL_MS, () => {
      this.heartbeatTask = null;
      void this.heartbeatLeases().finally(() => {
        if (this.leases.size > 0) this.armHeartbeat();
      });
    });
  }

  noteSocket(roomId: string, userId: string, delta: number): void {
    this.rooms.get(roomId)?.noteSocket(userId, delta);
  }
}

/**
 * One registry per process, so the room routes and the WebSocket hub see the same tables. Module
 * scope because they are separate Fastify scopes. Tests pass their own or call `resetRoomRegistryForTests`.
 */
let shared: RoomRegistry | null = null;

export function roomRegistry(options: RoomRegistryOptions = {}): RoomRegistry {
  shared ??= new RoomRegistry(options);
  return shared;
}

export function resetRoomRegistryForTests(): void {
  shared?.closeAll();
  shared = null;
}

/** Built from memory on every state frame, with no query. */
export function toRoomSummary(room: LiveRoom): RoomSummary {
  const snapshot = room.table.snapshot();
  const seatByUser = new Map(snapshot.seats.map((seat) => [seat.userId, seat]));
  // From the one snapshot above, so every field describes the same instant.
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
      // Named field by field so the wire shape is deliberate (ADR 0003).
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
    // `rooms_visibility_invite_only` allows one value. Changing it is a migration (ADR 0010).
    visibility: 'invite_only',
    members,
    createdAt: room.record.createdAt,
  };
}

/** A summary for a room with no live table here, either closed or served by another process. */
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
      connected: member.is_bot,
      // Debts are not persisted, so a room with no live table has none.
      awaitingBigBlind: false,
    })),
    createdAt: room.created_at.toISOString(),
  };
}

/**
 * The blind positions a re-opened table carries on from. Only `button_seat` is persisted, so the
 * blinds are walked with `orderFrom`, which accepts a dead button where `assignBlinds` refuses it.
 * A hand whose small blind was dead is reconstructed one seat off, costing one repeated big blind
 * per restart (see `repositories/hands.ts`). Null for fewer than two dealt seats.
 */
export function blindsFromLastHand(
  hand: handsRepository.LastDealtHand,
  maxSeats: number,
): BlindPositions | null {
  const dealt = [...hand.dealtSeats].sort((left, right) => left - right);
  if (dealt.length < 2) return null;
  if (dealt.length === 2) {
    // Heads-up the button posts the small blind. `orderFrom` would lap back onto the button.
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

export function configFromRow(room: roomsRepository.RoomRow): TableConfig {
  return {
    smallBlind: room.small_blind,
    bigBlind: room.big_blind,
    ante: room.ante,
    maxSeats: room.max_seats,
    actionTimeoutSeconds: room.action_timeout_seconds,
  };
}

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

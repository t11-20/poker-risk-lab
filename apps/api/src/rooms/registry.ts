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
 * ## That assumption is now ENFORCED, and this is where it is enforced
 *
 * It used to be documented and nothing more. This header said it, `docker-compose.staging.yml` said
 * it beside `deploy.replicas: 1`, and not one line of code refused a second process — so an
 * operator scaling for capacity, or any rolling deploy where the new container serves before the
 * old one drains, produced two decks and two pots for one room, and whichever settlement landed
 * second destroyed the chips the other one paid out. Silently. Nothing raised anything.
 *
 * So opening a room now takes a LEASE on it (`rooms/ownership.ts`, `prl.room_ownership`), and:
 *
 *   * a room a live process already holds is refused, as a typed `room_owned_elsewhere`, counted;
 *   * every lease this process holds is renewed on a timer, and a renewal that updates no row
 *     means we have been fenced — the room is closed, its sockets are disconnected and it is
 *     dropped from this registry, at once, because continuing to serve a room we no longer own is
 *     the exact corruption the lease exists to prevent;
 *   * closing a room, and shutting down, release the lease, so the next process gets the room
 *     immediately rather than waiting out a TTL.
 *
 * A registry built with `ownership: null` enforces none of that and behaves exactly as this file
 * did before — which is what every test that drives rooms with a `Map`-backed store relies on, and
 * what `RoomRegistryOptions.ownership` sets out in full.
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
import type { SeatEntitlement } from './entitlement.ts';
import { LEASE_HEARTBEAT_INTERVAL_MS, LEASE_SELF_EVICT_AFTER_MS, type RoomOwnership } from './ownership.ts';
import {
  type ArchivedDeal,
  type ArchivedResult,
  LiveTable,
  type TableListener,
  type TableNotice,
} from './table.ts';
import { type Clock, type ScheduledTask, systemClock } from './timers.ts';

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
  /**
   * Serialises the durable work a released seat causes, so a caller can await it.
   *
   * Separate from `archiveQueue` deliberately: an archive write that fails must not stop a hand
   * (see the file header), but a seat release is not reporting — it is what makes the chair
   * usable again — and `standFromTable` awaits this chain so that the response it returns
   * describes a seat that really has been freed.
   */
  private releaseQueue: Promise<void> = Promise.resolve();
  /**
   * Members who asked to leave the ROOM, not merely the chair, and are still holding a seat.
   *
   * Recorded here rather than acted on at once because a player in a live hand does not leave
   * when they ask to: they fold at their turn and the chair is freed when the hand settles, which
   * can be several minutes of play later. `leaveRoom` used to drop the in-memory membership only
   * `if (seatOf(userId) === null)` at the instant of the request, and nothing re-ran it — so a
   * mid-hand leaver was durably gone (`left_at` set, seat null) and still a live member for the
   * rest of the process's life: `registry.require()` kept granting them the room summary, socket
   * attach and spectator views, and `RoomSummary.members` kept listing them.
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
     * Frees the durable seat of a player the table has just released.
     *
     * A port rather than the `RoomStore` itself, because a `LiveRoom` is constructed directly by
     * tests that have no store at all, and because this is the only durable write a room makes
     * on its own initiative. `RoomRegistry.buildRoom` binds it to `store.unseatMember`; omitted,
     * a released seat is released in memory only — which is exactly what a table-only test wants.
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
      // Both reactions hang off the SAME notice, and that is the design: settlement announces
      // who left, and everything that must happen when a seat is released happens once, here.
      // Four separate patches at four call sites is what produced the four defects this replaced.
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
   *
   * **Call this BEFORE `table.stand`, always.** `stand` releases the chair synchronously for a
   * player who is not in the live hand, and the notice that does it is what completes the exit;
   * marking afterwards would let that notice fire against an unmarked room and leave an ex-member
   * live for the process's lifetime. Calling it first is correct in all three cases:
   *
   *   - not seated at all: there is no departure notice coming, so the exit completes here;
   *   - seated, not in the hand: `stand` frees the chair at once and the notice completes it;
   *   - seated and in the hand: the chair is freed when the hand settles, and so is the exit.
   */
  beginRoomExit(userId: string): void {
    if (this.table.seatOf(userId) === null) {
      this.removeMember(userId);
      return;
    }
    this.pendingRoomExit.add(userId);
  }

  /**
   * Resolves once every seat release this room has queued has been written.
   *
   * What it does NOT wait for is a release that has not been announced yet — a player still
   * holding a live hand. That is the point: their chair is theirs until the hand settles, and the
   * caller is told about the release that happened, not promised one that has not.
   */
  settleSeatReleases(): Promise<void> {
    return this.releaseQueue;
  }

  /**
   * Turns "the table released these seats" into the durable and in-memory tidying that owes it.
   *
   * One reaction, on one event, for both kinds of departure — the immediate one and the one that
   * waits out a hand — which is what makes the two indistinguishable to everything downstream.
   * The seat row is freed for every departure; the membership is dropped only for somebody who
   * asked to leave the room rather than merely the chair.
   */
  private releaseDeparted(notice: TableNotice, onProblem: ProblemHook): void {
    if (notice.departed.length === 0) return;
    const departed = [...notice.departed];
    // Synchronously, and this is NOT the file's "persist, then update memory" rule being broken:
    // the durable removal already happened, back in `leaveRoom`, at the moment the member asked
    // to go. What is left is memory catching up with a row that is already written, and deferring
    // that by even a microtask would let a request arriving on the same turn of the event loop as
    // the settlement still find an ex-member and be served.
    for (const userId of departed) {
      if (this.pendingRoomExit.delete(userId)) this.removeMember(userId);
    }
    if (this.releaseSeat === null) return;
    const releaseSeat = this.releaseSeat;
    this.releaseQueue = this.releaseQueue
      .then(async () => {
        // Per seat, not per pass. One settlement can free several chairs at once — two players
        // who both stood up mid-hand leave on the same notice — and a single `await` over the
        // whole list would let the first failure strand every chair behind it, silently. That is
        // the same shape as the defect this whole mechanism exists to close: work that must
        // happen, skipped because something unrelated went wrong first.
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

        // Counted here, at the source, for the reason `classifyProblem` gives: `seat-release` is
        // `counted-at-source`, so the consumer in `routes/index.ts` deliberately does not count it
        // again. By the number of CHAIRS, not by one — three stuck chairs and one failed pass are
        // different sizes of incident, and only this loop knows which it was.
        //
        // Its own counter rather than `archiveFailures`, which is where this reported before
        // `seat-release` existed: `ArchiveFailing` is zero-tolerance and its runbook is about
        // losing hand history, so a stuck chair paging it sends somebody to the wrong subsystem.
        // See `AppMetrics.seatReleaseFailures`.
        this.metrics.seatReleaseFailures.inc({}, stuck.length);
        // Logged and swallowed, like an archive write: a failed release must not wedge the chain
        // for every later departure. The cost is honest and is why this is alertable at all — the
        // row stays seated, the summary (built from the live table) says the chair is free, and
        // nothing retries, so the next learner to tap it is refused `seat_taken` until a restart.
        onProblem('a seat could not be released after its player left', {
          event: 'seat-release',
          roomId: this.record.id,
          users: stuck,
          error: String(lastError),
        });
      })
      .catch(() => {
        // A backstop, not the handler: every `releaseSeat` rejection is caught per seat above, so
        // the only way here is `onProblem` or the counter throwing. Nothing is swallowed silently
        // that this class could have reported — what it prevents is an unhandled rejection, and a
        // chain that stays rejected and skips every departure after this one.
      });
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
    // and `handCompleted` is set by `settleIfComplete`, which settles once per hand by design so
    // that a subscriber cannot double-count. The two are INDEPENDENT — a hand that is over before
    // anybody acts sets both on one notice — and the table no longer overwrites the reason with
    // `handComplete`, which is what used to make `handsCompleted` climb while `handsStarted` did
    // not, and falsify this paragraph's own claim that each fires exactly once per hand.
    if (notice.reason === 'handStarted') this.metrics.handsStarted.inc();
    if (notice.handCompleted) this.metrics.handsCompleted.inc();

    const handId = notice.handId;
    const deal = notice.reason === 'handStarted' ? this.table.archivedDeal() : null;
    const street = notice.events.some((event) => event.kind === 'street') ? notice.street : null;
    const board = notice.board;
    const actions = notice.loggedActions;
    const result = notice.handCompleted ? this.table.archivedResult() : null;
    // From the NOTICE, never from `this.table.snapshot().seats`. The snapshot is a later read, and
    // by the time it happens `settleIfComplete` has already removed the seats that stood up
    // mid-hand — so a departing winner was archived as though the hand had not paid them and the
    // chips they won were destroyed. See `TableNotice.settledStacks`.
    const settled = notice.settledStacks;
    // Completion wins when a hand starts and ends on one notice: the room is open at the end of
    // it, and writing `playing` because the deal was also on this notice would leave the lobby
    // advertising a hand that is already over.
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
  /**
   * The room lease, or `null` for a registry that does not enforce one.
   *
   * ## Why the default is null, and why that is not a hole
   *
   * `store` defaults to the real Postgres store because every caller of it already needs a
   * database. This does not, and cannot: `test/rooms.test.ts` and `test/ws-router.test.ts` drive
   * the whole of rooms, seating, the socket protocol and the bots against a `Map`-backed store with
   * no Postgres anywhere, and a default that reached for `getSql()` would turn every one of those
   * into a database test. A development run with no database is the same case.
   *
   * So the default is the historical behaviour — no lease, no refusal, no heartbeat — and the
   * production wiring in `routes/index.ts` passes `postgresRoomOwnership(getSql)` explicitly, the
   * same way it passes `postgresArchive(getSql)` and for the same reason. That file's header
   * already records what happened the last time a registry was left on a permissive default: the
   * archive wrote nothing and `GET /hands` was empty forever. The equivalent mistake here is worse
   * and quieter, so `test/wiring.test.ts` asserts that the assembled app's registry enforces a
   * lease, rather than trusting the call site to keep saying so.
   *
   * A registry with `ownership: null` is not "unsafe by default" in any deployment: it is one
   * process with no database, which cannot have a second process contending for a room it is not
   * persisting anyway.
   */
  readonly ownership?: RoomOwnership | null;
  /**
   * Who may take a seat, or `null` for a deployment that does not gate seating.
   *
   * Null is the shipped default (`PRL_ENROLMENT_REQUIRED=off`) and the historical behaviour: any
   * member of a room may sit at it. `routes/index.ts` passes `postgresSeatEntitlement(getSql)`
   * when the config says `enforced`, and `test/wiring.test.ts` asserts that correspondence in both
   * directions rather than trusting the call site to keep saying so — the same guard, for the same
   * reason, as `ownership` above.
   *
   * See `rooms/entitlement.ts` for why the decision arrives as a port rather than as a `getSql()`
   * inside this file.
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
}

/**
 * Every live room in this process.
 *
 * One instance, created by the route module and shared with the WebSocket hub, so that both see
 * the same tables. Two registries would be two sets of tables for the same room ids.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, LiveRoom>();

  /**
   * Builds in flight, keyed by room id, so two concurrent first-touches share one build.
   *
   * Empty except during an open. An entry is removed when the build settles — including when
   * it rejects, so a database blip during one open does not make the room unopenable.
   */
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
  /**
   * Every release this registry has started, chained so `shutdown()` can wait for all of them.
   *
   * A chain rather than a set of loose promises for the reason `LiveRoom.releaseQueue` is one: the
   * caller that matters — the shutdown path — has to be able to await "every release has been
   * written", and a fire-and-forget release that nobody can wait for turns a graceful shutdown into
   * a lease-TTL-long refusal for every room this process was serving.
   */
  private releaseQueue: Promise<void> = Promise.resolve();
  /** Who wants to know that a room was taken away. `ws/hub.ts` registers one, to close sockets. */
  private readonly evictionListeners = new Set<(roomId: string, reason: EvictionReason) => void>();

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

  /**
   * Opens a live table for a room, or returns the one already open.
   *
   * ## Why there is an in-flight map and not just the `rooms` lookup
   *
   * The body below is a check-then-act across four `await`s: it reads `this.rooms`, then
   * reconciles interrupted hands, then reads the hand count and the last deal, and only at the
   * very end does it `this.rooms.set`. Two callers that both arrive while the room is cold both
   * pass the lookup, both build a `LiveTable`, and the second `set` silently replaces the first.
   *
   * That is not a theoretical window. Both public entry points — `openRoomFor` in
   * `routes/rooms.ts` and `reopenFor` in `ws/router.ts` — await a database round trip before
   * calling this, and `ensureOpen` adds two more in front, so the window is several
   * Postgres round trips wide and opens on exactly the sequence a page load performs: a
   * `GET /rooms/:id` racing the WebSocket `hello`, or two tabs of one session.
   *
   * Three things went wrong when it lost, all reproduced:
   *
   *   1. **A permanently silent table.** `ensureSubscription` in `ws/router.ts` caches one
   *      table subscription per room id and never re-checks it. Attached to the room that was
   *      replaced, it listens to a table nobody mutates: `startHand` answers `ack` and then no
   *      `state` and no `event` frame ever arrives. The socket stays healthy — pongs answered,
   *      acks returned — so neither the client's handshake grace nor its ping watchdog fires and
   *      it never reconnects. Nothing repairs it until every socket in the room has closed.
   *   2. **A permanent lockout.** `joinByInviteCode` calls `addMember` on the room this returns.
   *      If that is the orphan, the learner is a durable member who is absent from the mapped
   *      room's member map, and `require()` — which never re-reads the database — answers
   *      `room_not_found_or_not_permitted` for every later request, having just told the client
   *      it joined.
   *   3. **A leak.** The orphan's `LiveTable`, `TurnTimer`, `BotRunner` subscription and archive
   *      listener are unreachable from `this.rooms`, so `closeAll()` cannot close them.
   *
   * The file header says one API process per room is a correctness constraint because two
   * processes holding "the" `HandState` deal two different hands. This produced that condition
   * inside one process.
   *
   * So a build in flight is published before its first `await`, and every other caller waits on
   * it. The entry is removed when it settles, including on rejection, so a failed open does not
   * poison the next attempt.
   *
   * `request.members` is applied only by the caller that actually builds the room, which is the
   * same rule the `existing !== undefined` early return has always had.
   */
  open(request: OpenRoomRequest): Promise<LiveRoom> {
    const existing = this.rooms.get(request.record.id);
    if (existing !== undefined) return Promise.resolve(existing);

    const inFlight = this.opening.get(request.record.id);
    if (inFlight !== undefined) return inFlight;

    // No `await` between here and the `set`, which is what makes this a lock rather than a
    // slightly narrower race: `buildRoom` runs synchronously up to its own first `await`, so no
    // other caller can be scheduled until the entry is published.
    const build = this.buildRoom(request).finally(() => {
      this.opening.delete(request.record.id);
    });
    this.opening.set(request.record.id, build);
    return build;
  }

  private async buildRoom(request: OpenRoomRequest): Promise<LiveRoom> {
    // ########################################################################
    // ## THE LEASE IS TAKEN FIRST. NOTHING ABOVE THIS LINE, EVER.           ##
    // ########################################################################
    //
    // Not merely "before the table is built" — before `reconcileInterruptedHands`, which is the
    // reason this is a hard rule rather than a tidy one. That call runs
    // `hands.abandonInterruptedHands`, which settles every open hand row for the room on the stated
    // grounds that "a hand interrupted by a restart is unrecoverable by design, so the row has to be
    // settled by somebody". That reasoning is true for a room NOBODY is serving and false for a room
    // another process is serving right now: its hand is not interrupted, it is in progress, in that
    // process's memory, and closing the row underneath it destroys the record of a hand people are
    // still playing. Reconciling before acquiring would make a refused open destructive.
    //
    // A failure here is deliberately FAIL-CLOSED: if the lease cannot be read, the room does not
    // open. Every other path into this method has already reached Postgres — `ensureOpen` reads the
    // room row and the roster first — so a database this cannot ask is a database that has already
    // failed the open; and the one thing that must not happen is serving a room whose ownership is
    // unknown.
    await this.acquireLease(request.record.id);
    try {
      return await this.buildOwnedRoom(request);
    } catch (error) {
      // The lease was taken and there is no room to hold it. Released rather than left to expire,
      // because a build that failed on a transient read would otherwise make the room unopenable —
      // by anybody, including this process on the very next request — for a whole lease TTL.
      this.releaseLeaseSoon(request.record.id);
      throw error;
    }
  }

  private async buildOwnedRoom(request: OpenRoomRequest): Promise<LiveRoom> {
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
      // The one durable write a room makes on its own initiative, and the reason a mid-hand stand
      // no longer strands `room_members.seat`: the release is announced by the table when the
      // chair is actually freed, not when the player asked, so the two cannot drift apart.
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
    //
    // ## Restoring a chair is a way to end up seated, so it is gated too
    //
    // This loop is the third and last call site of `table.sit` (the others are `sitAtTable` and
    // `seatBot`), and it is the one that seats somebody with nobody asking. `PRL_ENROLMENT_REQUIRED`
    // therefore applies here as well, and the decision is explicit rather than inherited:
    //
    //   * **A bot is never asked.** A bot has a user row and can never have an enrolment, so
    //     checking one would empty every Legends table on the first restart. `is_bot` is the whole
    //     of the exemption and it is read from the durable row, not inferred.
    //   * **A learner who is no longer entitled does NOT get the chair back.** Their access
    //     expired, or was withdrawn, while they were sitting in it. Giving it back would mean a
    //     revocation quietly stops applying to the one person it was aimed at, for as long as
    //     nobody restarts the process — and then applies, months later, at a deploy nobody
    //     connected to it. The seat is left free, the learner keeps their membership and can watch,
    //     and their next `sit` gets the honest refusal with the sentence that tells them what to do.
    //
    //     "Left free" has to be made true in the DATABASE as well, and that is what the
    //     `unseatMember` below is. `room_members_live_seat_key` is UNIQUE `(room_id, seat) WHERE
    //     left_at IS NULL`, so a row that still names seat 3 holds seat 3 whether or not anybody
    //     is in it: the live table would report the chair empty, the next learner to tap it would
    //     be refused by that index with `seat_taken`, and it would stay that way for the life of
    //     the room. That is the exact phantom-chair state `standFromTable` records having produced
    //     once already — "the room summary showed the seat free, the next client to tap it was
    //     refused for the rest of the process's life" — reached here instead. The write only nulls
    //     `seat`; the membership and the STACK stay, so nothing the learner won is lost and a
    //     re-entitled learner still buys in at what they had.
    //   * **A read that FAILS leaves the seat unrestored too**, because it goes through the catch
    //     below. That is fail-closed, and consistent with `buildRoom`, which refuses to open a room
    //     whose lease it cannot read. This path has already made two successful queries to get here
    //     (`store.byId` and `store.membersOfRooms`), so a database that cannot answer this one has
    //     failed the open rather than merely this seat.
    //
    // The refusal is NOT reported as `seat-retake`. See `classifyProblem` in
    // `observability/telemetry.ts`: that event is an actor failure, meaning a seat that owes an
    // action and will not produce one, and this seat owes nothing because nobody is in it.
    for (const member of members) {
      if (member.seat === null) continue;
      try {
        if (!member.is_bot && !(await this.entitledToResumeSeat(member.user_id))) {
          this.metrics.seatEntitlementRefusals.inc({ reason: 'seat_not_restored' });
          // Fail-soft, and deliberately: a chair that could not be freed is a chair nobody else
          // can take, which is a worse table than the one this open would otherwise refuse to
          // produce at all. The refusal above already stands whether or not this write lands.
          const freed = await this.store
            .unseatMember(roomId, member.user_id)
            .then(() => true)
            .catch((error: unknown) => {
              // Counted here because `seat-release` is `counted-at-source` in `classifyProblem`,
              // and the source is this line: a log event whose counter never moves is a series an
              // alert cannot see. The consequence is the one `seatReleaseFailures` names exactly —
              // a chair the summary shows free that the next client is refused `seat_taken` for —
              // so it is the same counter and the same runbook, not a new one.
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
   *
   * ## THIS IS THE ONE PLACE A PERSON TAKES A SEAT
   *
   * ############################################################################
   * ## BOTH TRANSPORTS ARRIVE HERE. `POST /rooms/:roomId/sit` AND THE SOCKET   ##
   * ## `sit` FRAME CALL THIS METHOD AND NOTHING ELSE, WHICH IS WHY THE         ##
   * ## ENTITLEMENT CHECK IS HERE AND NOT IN EITHER OF THEM.                    ##
   * ############################################################################
   *
   * A guard on the REST route with the socket left open is worse than no guard: it reads as
   * enforced, every test of it passes, and the whole product is reachable through the frame
   * nobody guarded. `routes/rooms.ts` already says the two transports "run the same method" so
   * they cannot drift; this is what that property is for. `test/rooms.test.ts` drives the REST
   * route and `test/ws-router.test.ts` drives a real `sit` frame, and both are asserted rather
   * than argued from this comment.
   *
   * ## Why the entitlement check is before every other check but `require`
   *
   * `require` stays first, and must: it is what makes "no such room" and "not your room"
   * indistinguishable, and answering `enrolment_required` to a stranger who guessed a room id
   * would confirm the room exists. After that, this runs BEFORE the durable membership read, the
   * units read and `seatMember`, so a learner who may not sit never causes a durable write that
   * has to be given back, and never has their units read to answer a question their units do not
   * decide.
   *
   * `insufficient_units` is a nearby refusal and a deliberately different one: units are a thing
   * the learner can fix themselves (`POST /me/units/reset`), and an enrolment is not.
   */
  async sitAtTable(roomId: string, principal: RoomPrincipal, seat: number): Promise<void> {
    const room = this.require(roomId, principal.userId);
    await this.requireEntitledToSit(principal.userId, roomId, seat);
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
   * Refuses a seat to somebody this deployment does not consider entitled to one.
   *
   * Returns without asking anything when `entitlement` is null, which is `PRL_ENROLMENT_REQUIRED`
   * unset or `off` — the shipped default, and every deployment that predates the switch.
   *
   * The `logDetail` names the room and the seat and NOT the reason the person is not entitled,
   * because this call cannot know it: `SeatEntitlement.entitledToSit` answers a boolean on purpose
   * (see its comment). An operator asking "why was this learner refused?" runs
   * `pnpm run enrolments show --user <id>`, which is the tool that can answer it, against a
   * database the request path is not allowed to write.
   */
  private async requireEntitledToSit(userId: string, roomId: string, seat: number): Promise<void> {
    if (this.entitlement === null) return;
    if (await this.entitlement.entitledToSit(userId)) return;
    this.metrics.seatEntitlementRefusals.inc({ reason: 'not_entitled' });
    throw new AppError('enrolment_required', {
      logDetail: `no live enrolment entitles this account to seat ${seat} at ${roomId}`,
    });
  }

  /**
   * Whether a durably recorded seat may be given back to the person the row names.
   *
   * `true` with no query at all when this deployment does not gate seating, which keeps a room
   * re-open on an open public instance exactly as cheap as it was — no extra round trip per seated
   * member, per restart, per room.
   *
   * Not `async`: the null branch has nothing to await, and returning the port's promise directly is
   * the shape `biome` insists on for a method whose only asynchrony is its callee's.
   */
  private entitledToResumeSeat(userId: string): Promise<boolean> {
    if (this.entitlement === null) return Promise.resolve(true);
    return this.entitlement.entitledToSit(userId);
  }

  /**
   * Stands up, keeping the membership.
   *
   * The table goes first here, and that is the opposite order to `sitAtTable` for a reason: a
   * player holding a live hand does not leave immediately — they are flagged, they fold at their
   * turn, and the seat is released when the hand completes. Freeing the database seat first would
   * let somebody else take a seat that is still holding cards.
   *
   * ## Why there is no `if (seatOf(userId) === null)` here any more
   *
   * There used to be, guarding the `unseatMember` call, and it was false for exactly the case
   * that mattered: a player holding a live hand is flagged `leaving` and STAYS seated, so the
   * durable seat was never released. `settleIfComplete` freed the live chair when the hand ended,
   * on a path with no store and no listener, and nothing re-ran this. The room summary (built
   * from the live table) then showed the seat free, the next client to tap it was refused by
   * `room_members_live_seat_key` with `seat_taken` — for the rest of the process's life — and a
   * restart re-seated a player who had left, with the stale stack that came with them.
   *
   * The release is now announced by the table on the notice that actually frees the chair, and
   * `LiveRoom.releaseDeparted` does the write. This call awaits the chain only so that the
   * synchronous case — a player who was not in the live hand — has been written by the time the
   * caller answers. A player still in a hand has nothing queued yet, and correctly does not wait.
   */
  async standFromTable(roomId: string, userId: string): Promise<void> {
    const room = this.require(roomId, userId);
    await room.table.stand(userId);
    await room.settleSeatReleases();
  }

  /**
   * Leaves the room altogether: stand up if seated, then drop the membership.
   *
   * `beginRoomExit` comes FIRST, before `stand`, and that order is load-bearing — `stand` can
   * free the chair synchronously, and the notice that does it is what completes the exit. See
   * `LiveRoom.beginRoomExit`, which also explains why an unseated member is dropped immediately.
   *
   * The durable writes are unconditional, as they always were. What used to be conditional — and
   * on a condition evaluated at the wrong instant — was the in-memory membership: dropped only
   * `if (seatOf(userId) === null)` at the moment of the request, which is false for anybody
   * holding a live hand, and never re-run. A mid-hand leaver was therefore durably gone and still
   * a live member, so `require()` kept letting them read the room and `RoomSummary.members` kept
   * listing them.
   */
  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const room = this.require(roomId, userId);
    room.beginRoomExit(userId);
    if (room.table.seatOf(userId) !== null) await room.table.stand(userId);
    await this.store.unseatMember(roomId, userId);
    await this.store.removeMember(roomId, userId);
    await room.settleSeatReleases();
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

  /** Closes one room: its bots, its table, its timers, and the lease it was holding. */
  close(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    room.close();
    this.rooms.delete(roomId);
    // Started here and awaited by `shutdown()`, never by this method: `close` is called from a
    // Fastify `onClose` hook, from `closeAll`, and from a route — all of which are synchronous
    // about it — and making it async would change three signatures to await a write whose failure
    // costs one room one lease TTL. What the release buys is that the NEXT process gets the room at
    // once instead of waiting the TTL out, which is the whole difference between a seamless deploy
    // and a thirty-second refusal.
    this.releaseLeaseSoon(roomId);
  }

  /**
   * Closes every room. Called from the server's shutdown path.
   *
   * A closed room must not be able to keep a turn timer or a bot's scheduled decision alive: both
   * hold a reference to the table, so a room that is merely forgotten would keep running.
   */
  closeAll(): void {
    for (const roomId of [...this.rooms.keys()]) this.close(roomId);
    // A room whose build is still in flight holds a lease and is NOT in `this.rooms` yet — the
    // lease is taken first, deliberately, and `buildOwnedRoom` is several awaits long after it. So
    // the loop above cannot see it, and without this line the entry is simply dropped when the
    // process goes: the row stays, and the replacement process is refused that room for a whole
    // `LEASE_TTL_MS`. `shutdown()` avoids reaching this by waiting for the build; this is the
    // backstop for the callers that cannot wait, and for a build that never settles.
    for (const roomId of [...this.leases.keys()]) this.releaseLeaseSoon(roomId);
    this.heartbeatTask?.cancel();
    this.heartbeatTask = null;
  }

  /**
   * `closeAll()`, plus waiting for every lease to have actually been given back.
   *
   * This is what a graceful shutdown wants and what `closeAll` cannot be. Every room this process
   * was serving is unopenable by the replacement process until its lease is released or expires, so
   * a deploy that exits without waiting for these deletes makes every live table refuse to open for
   * up to `LEASE_TTL_MS` — which is precisely the overlap window this whole mechanism exists to
   * make safe, turned into an outage instead.
   *
   * ## Why the in-flight builds are waited for first
   *
   * `closeAll` can only close what is in `this.rooms`, and an open in flight is not: the lease is
   * taken before `reconcileInterruptedHands` (which is a hard rule, argued in `buildRoom`) and the
   * room is published several awaits later. A SIGTERM that lands in that gap used to produce two
   * things at once, both reproduced — the lease was never released, so the replacement refused that
   * room for a full TTL on a deploy that was otherwise seamless; and the build then published a
   * `LiveRoom` with its table, bots and turn timer into a registry that had already shut down, with
   * nothing left able to close them. Waiting is bounded: every await in a build is a query, and
   * `db.ts` bounds every query at `DATABASE_STATEMENT_TIMEOUT_MS + 2,000` ms.
   *
   * `allSettled` and not `all`, because a build that FAILED has already released its own lease in
   * `buildRoom`'s catch, and a rejection here must not skip the close below.
   *
   * Never rejects. A release that fails is reported through `onProblem` inside the chain and the
   * lease expires on its own; a shutdown path that could throw here would be a deploy that hangs.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.opening.values()]);
    this.closeAll();
    await this.releaseQueue;
  }

  get size(): number {
    return this.rooms.size;
  }

  // -----------------------------------------------------------------------
  // The lease
  // -----------------------------------------------------------------------

  /**
   * True when this registry refuses a room another live process holds.
   *
   * Exists so `test/wiring.test.ts` can assert that the ASSEMBLED app enforces it. The wiring is
   * one line in `routes/index.ts` and losing it would be invisible — every test still passes, every
   * room still opens, and the guard is simply gone.
   */
  get enforcesOwnership(): boolean {
    return this.ownership !== null;
  }

  /**
   * True when this registry refuses a seat to somebody who holds no live enrolment.
   *
   * The same accessor, for the same reason, as `enforcesOwnership`: `test/wiring.test.ts` asserts
   * that the ASSEMBLED app's registry agrees with `PRL_ENROLMENT_REQUIRED` in both directions, and
   * losing the one line in `routes/index.ts` that binds it would be invisible everywhere else —
   * every test green, every room opening, every learner seated, and the whole switch inert.
   */
  get enforcesEntitlement(): boolean {
    return this.entitlement !== null;
  }

  /**
   * The lease this process holds for a room, or null. For tests and for the runbook's own checks.
   *
   * The fence is the interesting field: it increments on every acquisition, so a room whose fence
   * has moved since this process took it has changed hands.
   */
  leaseFor(roomId: string): { readonly fence: number } | null {
    const lease = this.leases.get(roomId);
    return lease === undefined ? null : { fence: lease.fence };
  }

  /**
   * Registers a listener for "this room was taken away from us", and returns its unsubscribe.
   *
   * The registry knows nothing about sockets, and must not: a `LiveRoom` is constructed directly by
   * tests that have no hub at all. But a fenced room whose sockets stay open is a client still
   * being sent state frames from a table this process is no longer allowed to own, so somebody has
   * to close them — `ws/hub.ts` registers the listener that does, with
   * `WS_CLOSE.serverShuttingDown`, which is the code the web client reconnects from with backoff.
   *
   * A listener that throws must not stop the eviction: the eviction is the safety property and the
   * notification is a consequence of it.
   */
  onEviction(listener: (roomId: string, reason: EvictionReason) => void): () => void {
    this.evictionListeners.add(listener);
    return () => {
      this.evictionListeners.delete(listener);
    };
  }

  /**
   * Takes the lease for a room, or refuses to serve it.
   *
   * A refusal is a typed `room_owned_elsewhere` and a counter, deliberately not `seat_taken` (an
   * ordinary race between two learners, which must never page anybody) and deliberately not a 500
   * (nothing broke; the guard worked). The holder is read back for the LOG LINE only — an operator
   * needs "which process, and how stale is it" first, and none of it reaches the client, which is
   * told a code and a request id like every other failure.
   *
   * The holder read is `catch`-guarded because it is diagnostics: failing to describe the holder
   * must not change the answer, which is already decided.
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
   *
   * Public so that a test can run exactly one beat rather than waiting out an interval, and so that
   * the eviction path can be exercised without a real timer. Production arms it on the clock;
   * nothing else calls it.
   *
   * ## The distinction the whole method turns on
   *
   * A renewal that comes back WITHOUT a room is a fencing: the statement ran, the row exists, and
   * its `owner_id` is not ours. A renewal that THROWS says nothing at all about ownership — the
   * database was unreachable, or the query was abandoned by its deadline — and treating that as a
   * fencing would close every live table in the process on a network blip. So the two are handled
   * differently, and the second one is bounded by time rather than by a single failure: once our
   * last CONFIRMED renewal is older than `LEASE_SELF_EVICT_AFTER_MS` we stop serving the room
   * whatever the reason, because past that point another process is about to become entitled to it
   * and we cannot prove we still hold it. `ownership.ts` has the argument for the three numbers and
   * for why this threshold is strictly below the TTL.
   *
   * ## Why the verdict is applied to `asked` and not to `this.leases`
   *
   * A beat is a database round trip, and `acquireLease` runs on the request path throughout it. So
   * `this.leases` at the bottom of this method is not the map that was read at the top: any room
   * opened while the statement was out there has been added to it, and that room was never in the
   * `roomIds` the statement carried — so it cannot be in the answer either. Judging the current map
   * against an answer to an older question read every one of those rooms as FENCED.
   *
   * `asked` holds the FENCE each room had when the statement left, not merely which rooms there
   * were, because there are two ways a lease entry can be one this beat has nothing to say about.
   * The common one is a room opened mid-beat. The other is a room that was closed and re-opened
   * inside one beat: `close` releases the row and the re-open inserts it again, so a statement that
   * executed in the gap between those two legitimately does not return it — and the entry it would
   * be judging is a NEW acquisition at a NEW fence, which `acquire` increments on every acquisition
   * for exactly this kind of question. Comparing the fence answers both with one test, and does it
   * without consulting a clock: the tests here drive a manual clock that never advances, so any
   * rule of the form "confirmed since the beat started" would be true of everything.
   *
   * Both halves of what that produced were reproduced against this class with a beat held open
   * across an `open()`:
   *
   *   * if the eviction landed AFTER the build published the room, a table a learner had just
   *     opened was closed under them, their sockets were closed with `serverShuttingDown`, and
   *     `prl_api_room_fencings_total{reason="fenced"}` — a zero-tolerance series — rose for an
   *     incident that had not happened;
   *   * if it landed BEFORE the build's `this.rooms.set` (the build is several awaits long), the
   *     eviction deleted a lease entry the room did not have yet and the room was then published
   *     with NO entry in `this.leases`. Nothing renews a room that is not in that map, so its
   *     `heartbeat_at` goes stale, this process never self-evicts because it holds no lease to
   *     time out, and after `LEASE_TTL_MS` another process is entitled to take a room this one is
   *     still dealing at. That is precisely the two-processes-one-room state the lease exists to
   *     make impossible, reached through the guard instead of around it.
   *
   * A lease this beat has nothing to say about needs no verdict from it: `acquireLease` has just
   * stamped its `confirmedAt`, and the next beat asks about it.
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
      // Not reported on its own: a beat that fails once is an ordinary transient, this runs every
      // few seconds, and a line per failure would fill the log during exactly the incident an
      // operator is trying to read it in. The failure that MATTERS — one that lasted long enough to
      // cost a lease — is reported by the eviction below, and carries this error with it.
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
   * Stops serving a room this process no longer owns. The whole point of the mechanism.
   *
   * Order matters and is the reverse of what reads naturally. The room is dropped from `rooms` and
   * the table is closed FIRST, synchronously, before anything is logged or any listener is called:
   * a listener that throws, or a `onProblem` consumer that does, must not be able to leave this
   * process still serving the room. `LiveRoom.close()` stops the bots and the turn timer and closes
   * the table, so no further hand can be dealt at it, and the eviction listeners then close the
   * sockets that were watching.
   *
   * The lease is NOT released for a `fenced` eviction, and cannot be: `release` is owner-scoped, the
   * row belongs to somebody else now, and the delete would match nothing. For `lease_expired` the
   * row may still be ours — we simply could not reach it — so the release is attempted, best effort:
   * if it lands, the room becomes openable at once instead of after the TTL.
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
        // Swallowed on purpose, and not counted: the eviction has already happened, which is the
        // property that matters. A hub that threw while closing sockets is a hub bug, and the
        // sockets it failed to close are closed by their own heartbeat within two intervals.
      }
    }
    // Guarded for the same reason the listener loop above is, and the omission was the same
    // omission: the eviction has already happened, and nothing after this point may be able to
    // undo it. A throwing hook here is not hypothetical — the production one is `app.log.warn`,
    // and `test/room-ownership.test.ts` already provokes a build failure with "the log serialiser
    // threw" — and its consequence was worse here than in the build. `heartbeatLeases` is called
    // as `void this.heartbeatLeases().finally(...)`, so a rejection out of it is an UNHANDLED
    // rejection, which Node's default handling turns into a dead process: a logger fault during a
    // fencing took the API down, in the middle of the incident the fencing was reporting. It also
    // skipped the release below.
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
    // The generation is passed explicitly because this method deleted the map entry at the top, so
    // `releaseLeaseSoon` can no longer read it — and a release with no generation is one that says
    // nothing about which acquisition it is giving back.
    if (reason === 'lease_expired') this.releaseLeaseSoon(roomId, lease?.fence ?? null);
  }

  /**
   * `onProblem`, for the handful of places where the report must not be able to undo the action.
   *
   * NOT a blanket replacement, and deliberately not: everywhere else, a hook that throws is a fault
   * the caller should see, and `buildRoom` relies on exactly that to prove it gives a lease back
   * when a build fails. This is for the paths where the safety property has ALREADY been achieved
   * by the time the line is written — an eviction, a lease release — and where a throw would either
   * skip the cleanup after it or escape into a promise nobody is awaiting.
   */
  private report(...args: Parameters<ProblemHook>): void {
    try {
      this.onProblem(...args);
    } catch {
      // There is nowhere left to report a reporting failure to. Swallowed rather than counted, for
      // the reason the eviction listener loop gives: the thing that mattered has already happened.
    }
  }

  /**
   * Queues the release of one lease, so `shutdown()` can wait for every one of them.
   *
   * Owner-scoped in the repository, which is what makes it safe to call for a room we may already
   * have lost: the delete matches nothing and answers false.
   *
   * ## Why the fence is read HERE and carried into the chain
   *
   * ############################################################################
   * ## A QUEUED RELEASE IS A STATEMENT ABOUT ONE GENERATION OF ONE LEASE.     ##
   * ############################################################################
   *
   * The queue is serial and the release runs an unbounded time after this call — however long
   * every release ahead of it takes. On the path that queues the most of them at once (a database
   * slow enough that every beat is abandoned at its deadline, so every room is evicted
   * `lease_expired`) each of those is a query that runs to its own 7,000 ms deadline before it
   * fails, so the chain outlives the outage; the database recovers, the learners reconnect, and
   * the rooms are re-acquired by THIS process at a new fence while the chain is still draining.
   *
   * Owner scoping cannot see that, because this process is the owner both times. Reproduced
   * against this class with the release chain held open across an eviction and a re-open: the
   * stale release deleted the row the re-open had just taken, the next beat found no row for a
   * room this process was serving, and it evicted the room as `fenced` — a table closed under a
   * learner and `prl_api_room_fencings_total{reason="fenced"}` raised for an incident that had not
   * happened. Between the delete and that beat the room had no lease row at all while this process
   * was dealing at it, which is the state the whole table exists to refuse.
   *
   * A room with no entry in `this.leases` is not released, and that is the point rather than an
   * omission: without a generation there is nothing this call can say that is true a second later.
   * Every caller that holds a lease has an entry — `close()` and `closeAll()` run over rooms this
   * process opened, `buildRoom`'s catch runs after `acquireLease` set one, and `evict` reads the
   * entry before it deletes it and passes what it read.
   */
  private releaseLeaseSoon(roomId: string, fence: number | null = null): void {
    const ownership = this.ownership;
    if (ownership === null) return;
    const generation = fence ?? this.leases.get(roomId)?.fence ?? null;
    this.leases.delete(roomId);
    if (generation === null) return;
    this.releaseQueue = this.releaseQueue
      .then(async () => {
        // The second half of the same guard, and it is needed because the fence is NOT monotonic
        // across a release: `release` DELETES the row, so the next `acquire` is an INSERT and
        // starts again at 1 — `test/room-ownership-database.test.ts` asserts exactly that ("a
        // released lease leaves no row, so the next holder starts again"). So a stale release for
        // generation 1 can match a fresh generation 1, if the row went in between by some other
        // hand: a rolling-deploy neighbour that took the room after the TTL and released it, and
        // then this process re-opened it. The fence cannot see that; this can. If the room is back
        // in `this.leases` we are serving it again, and a release is simply wrong.
        //
        // What the pair does NOT close, stated rather than implied: a release this check has
        // already waved through, whose DELETE then executes at Postgres AFTER the row was removed
        // by somebody else and re-inserted here at a reused fence. Reaching it needs a dispatched
        // statement to sit unexecuted for longer than `LEASE_TTL_MS` — long enough for a
        // neighbouring process to take the room on expiry and give it back — while the re-open's
        // INSERT, issued later, executes first. A database in that state has already failed the
        // re-open. Closing it properly means a generation that survives a delete, which means not
        // deleting; and releasing by expiry instead of by delete costs every deploy a whole TTL of
        // refusals, which is the trade `db/migrations/0005` argues at length and gets right.
        if (this.leases.has(roomId)) return;
        await ownership.release(roomId, generation);
      })
      .catch((error: unknown) => {
        // Logged and swallowed, like an archive write and for the same reason: a failed release
        // must not wedge the chain for every later room, and it must not fail a shutdown. The cost
        // is bounded and worth naming — that one room is unopenable until its lease expires.
        //
        // Through `report`, because the swallowing is the point: this catch IS `releaseQueue`, and
        // `shutdown()` awaits it and promises never to reject. A hook that threw in here put the
        // rejection straight back into the chain, so a failing release plus a failing logger made
        // the Fastify `onClose` hook reject — a deploy that fails on the way out, which is the one
        // thing this path is written to prevent.
        this.report('a room lease could not be released; it will expire on its own', {
          event: 'room-lease-release',
          roomId,
          ownerId: ownership.ownerId,
          error: String(error),
        });
      });
  }

  /**
   * Arms the renewal timer, once, for as long as there is at least one lease to renew.
   *
   * Re-armed from inside the tick rather than run as an interval, for the reason `timers.ts` gives
   * for the turn clock: an interval fires again while the previous beat is still in flight, and a
   * beat is a database round trip that can take as long as its deadline. Two overlapping beats
   * would race each other to write `confirmedAt`, and a slow database would accumulate them.
   *
   * It stops when the last room goes, so an idle process schedules nothing at all.
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

/**
 * `prl.rooms` and `prl.room_members` — private tables and who is sitting at them.
 *
 * ## Two rules this file exists to keep
 *
 * **One live member per seat, one live membership per user.** Both are partial unique indexes
 * in migration 0002, and both are races rather than validation problems: two players tapping
 * "sit in seat 3" at the same instant pass every application-level check, because the check
 * and the write are two statements. So the writes below are shaped so the database is the
 * thing that says no, and the violation is translated into `seat_taken` / `already_seated`
 * (see `sql.ts`) rather than escaping as a 500. Two seated players in seat 3 is not a display
 * bug — the engine would deal to a seat list containing the same index twice.
 *
 * **The invite code is never stored.** `create` mints one, stores `sha256(code)`, and returns
 * the plaintext exactly once. A database read cannot join a stranger's table, and an owner who
 * loses the code creates another room. `visibility` is `'invite_only'` and the CHECK allows no
 * other value, so there is no listing anybody can enumerate either.
 *
 * ## Why the failure diagnostics run as a second query
 *
 * `addMember` and `seatMember` do their work in one statement whose WHERE clause carries every
 * precondition — open room, room not full, seat inside `max_seats`. That makes the happy path
 * atomic, and it makes "nothing matched" ambiguous: the room might be closed, or full, or not
 * exist, or the learner might already be in it. Rather than split the write into a
 * check-then-write with a race in the middle, the rare no-match path runs a small diagnostic
 * read to decide which of those it was. Correct answer, correct error code, and the race window
 * stays closed.
 */

import { AppError } from '../errors.ts';
import { type DurableBotSeat, durableProfile, durableSeed, isDifficulty } from '../rooms/bot-profile.ts';
import { hashInviteCode, sha256, timingSafeEquals } from './hashing.ts';
import { generateInviteCode, newRoomId, newRoomMemberId } from './ids.ts';
import { type Db, insideSavepoint, isUniqueViolation, violationError } from './sql.ts';

/** Table-configuration bounds, copied from the `rooms_*` CHECK constraints in migration 0001. */
const NAME_MIN = 2;
const NAME_MAX = 48;
const SEATS_MIN = 2;
const SEATS_MAX = 6;
const TIMEOUT_MIN = 5;
const TIMEOUT_MAX = 300;
/** `room_members_seat_range`: seats are 0-based and never above 5, whatever `max_seats` says. */
const SEAT_MAX = 5;

/**
 * Attempts at a unique invite code before giving up.
 *
 * `rooms_invite_code_hash_key` is unique because "a collision must make the code generator
 * retry, never pick a winner" — resolving it by returning the other room would hand a stranger
 * a private table. At 79 bits of entropy a collision will not happen; three attempts is here so
 * that if it somehow does, the answer is a retry and not a 500, and if it happens three times
 * the generator is broken and the loud failure is correct.
 */
const INVITE_CODE_ATTEMPTS = 3;

export type RoomStatus = 'open' | 'playing' | 'closed';

/**
 * The room columns every read here projects.
 *
 * `invite_code_hash` is deliberately absent. Nothing outside `byInviteCodeHash` needs it, and a
 * digest that never leaves the query cannot be logged by a caller that dumped a row.
 */
export interface RoomRow {
  readonly id: string;
  readonly name: string;
  readonly owner_user_id: string;
  readonly max_seats: number;
  readonly small_blind: number;
  readonly big_blind: number;
  readonly ante: number;
  readonly starting_stack: number;
  readonly action_timeout_seconds: number;
  readonly visibility: 'invite_only';
  readonly status: RoomStatus;
  readonly closed_at: Date | null;
  readonly created_at: Date;
}

/** A membership row, joined to the learner's display name for the roster views. */
export interface RoomMemberRow {
  readonly id: string;
  readonly room_id: string;
  readonly user_id: string;
  readonly display_name: string;
  readonly seat: number | null;
  readonly stack: number;
  readonly is_bot: boolean;
  /**
   * The `@prl/poker-ai` strategy profile id playing this seat, `'unknown'` for a row written
   * before migration 0003, and null for a human. NOT an `OpponentProfile`: that five-value type is
   * the Scenario Lab's range vocabulary, and reusing it here is what cost seven of the twelve
   * Legends their identity across a restart.
   */
  readonly bot_profile: string | null;
  /** `'educational' | 'realistic' | 'expert'`. Null only on a pre-0003 bot row. */
  readonly bot_difficulty: string | null;
  /** The resolved uint32 decision seed. Null only on a pre-0003 bot row. */
  readonly bot_seed: number | null;
  readonly joined_at: Date;
  readonly left_at: Date | null;
}

/**
 * `RoomMemberRow` as Postgres hands it over.
 *
 * `bot_seed` is `bigint`, and postgres.js returns every int8 as a STRING — deliberately, because
 * an int8 does not fit a JavaScript number in general. This one always does (it is a uint32, and
 * the column has a CHECK saying so), but the driver cannot know that, so the conversion is done
 * here rather than by typing the column as something narrower than its domain. `int` would have
 * been the narrower type and it is signed: half the seed space would not fit.
 */
interface RoomMemberRowRaw extends Omit<RoomMemberRow, 'bot_seed'> {
  readonly bot_seed: string | null;
}

function toMemberRow(raw: RoomMemberRowRaw): RoomMemberRow {
  return { ...raw, bot_seed: raw.bot_seed === null ? null : Number(raw.bot_seed) };
}

// ---------------------------------------------------------------------------
// Creating a room
// ---------------------------------------------------------------------------

export interface CreateRoomInput {
  readonly name: string;
  readonly ownerUserId: string;
  readonly maxSeats: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante?: number;
  readonly startingStack: number;
  readonly actionTimeoutSeconds?: number;
}

export interface CreatedRoom {
  readonly room: RoomRow;
  /**
   * The plaintext invite code. Returned once, never stored, unrecoverable afterwards. Goes
   * straight into `CreateRoomResponse.inviteCode` and nowhere else — `logging.ts` censors
   * `inviteCode` and anything matching `/invite/i` precisely so this cannot end up in a log.
   */
  readonly inviteCode: string;
}

/** What `validateRoomConfig` returns: the trimmed name and the two fields it defaulted. */
export interface ValidatedRoomConfig {
  readonly name: string;
  readonly ante: number;
  readonly actionTimeoutSeconds: number;
}

/**
 * Validates a table configuration against the schema's own arithmetic.
 *
 * Every rule here is a CHECK constraint in migration 0001, and every one of them is reachable
 * from a request that `createRoomBodySchema` accepts — the schema bounds each field
 * independently and cannot express a relationship between two of them. Concretely, the schema
 * happily accepts `smallBlind: 5, bigBlind: 5` (the CHECK wants `big_blind > small_blind`),
 * `ante: 500, bigBlind: 2` (`ante <= big_blind`), `startingStack: 2, bigBlind: 50`
 * (`starting_stack >= big_blind * 2`) and `name: "x"` (the CHECK wants 2 characters, the schema
 * allows 1). Without this function each of those is a check violation, which means a 500 for
 * what is plainly a bad request.
 *
 * Exported so the rejections can be tested without a database, and so a route that wants to refuse
 * a bad configuration before it mints an invite code has somewhere to ask.
 */
export function validateRoomConfig(input: CreateRoomInput): ValidatedRoomConfig {
  const fields: Record<string, string> = {};
  const name = input.name.trim();
  const nameLength = [...name].length;
  if (nameLength < NAME_MIN || nameLength > NAME_MAX) {
    fields['name'] = `must be ${NAME_MIN} to ${NAME_MAX} characters`;
  }
  if (!Number.isInteger(input.maxSeats) || input.maxSeats < SEATS_MIN || input.maxSeats > SEATS_MAX) {
    fields['maxSeats'] = `must be ${SEATS_MIN} to ${SEATS_MAX}`;
  }
  if (!Number.isInteger(input.smallBlind) || input.smallBlind < 1) {
    fields['smallBlind'] = 'must be at least 1';
  }
  if (!Number.isInteger(input.bigBlind) || input.bigBlind <= input.smallBlind) {
    fields['bigBlind'] = 'must be greater than the small blind';
  }
  const ante = input.ante ?? 0;
  if (!Number.isInteger(ante) || ante < 0 || ante > input.bigBlind) {
    fields['ante'] = 'must be between 0 and the big blind';
  }
  if (!Number.isInteger(input.startingStack) || input.startingStack < input.bigBlind * 2) {
    // Named in full because the reason is a teaching one: a stack that cannot cover two big
    // blinds produces a table where the first forced bet is already all-in.
    fields['startingStack'] = 'must be at least twice the big blind';
  }
  const timeout = input.actionTimeoutSeconds ?? 30;
  if (!Number.isInteger(timeout) || timeout < TIMEOUT_MIN || timeout > TIMEOUT_MAX) {
    fields['actionTimeoutSeconds'] = `must be ${TIMEOUT_MIN} to ${TIMEOUT_MAX} seconds`;
  }
  if (Object.keys(fields).length > 0) {
    throw new AppError('invalid_request', {
      fields,
      logDetail: `rejected a table configuration: ${Object.keys(fields).join(', ')}`,
    });
  }
  return { name, ante, actionTimeoutSeconds: timeout };
}

/**
 * Creates a room and returns its one-time invite code.
 *
 * ## The retry loop needs a savepoint, and that is not a detail
 *
 * A failed statement inside a Postgres transaction aborts the whole transaction: every later
 * statement answers `25P02 current transaction is aborted`. So a naive retry after a unique
 * violation only works when `sql` is the pool — and fails, differently and confusingly, the day
 * somebody puts `rooms.create` inside `withTransaction` alongside seating the owner and the bots.
 *
 * `insideSavepoint` wraps each attempt in `tx.savepoint(...)` when the handle is a transaction, so
 * a collision rolls back to the savepoint and the next attempt starts from a usable transaction.
 * Outside a transaction there is nothing to protect and the statement runs directly.
 *
 * The loop exists for `rooms_invite_code_hash_key` and nothing else: any other violation is
 * rethrown on the first attempt, so a genuine problem is not retried three times before being
 * reported.
 */
export async function create(sql: Db, input: CreateRoomInput): Promise<CreatedRoom> {
  const { name, ante, actionTimeoutSeconds } = validateRoomConfig(input);

  for (let attempt = 1; attempt <= INVITE_CODE_ATTEMPTS; attempt += 1) {
    const inviteCode = generateInviteCode();
    try {
      const room = await insideSavepoint(sql, async (handle) => {
        const rows = await handle<RoomRow[]>`
          insert into prl.rooms (
            id, name, owner_user_id, invite_code_hash, max_seats,
            small_blind, big_blind, ante, starting_stack, action_timeout_seconds,
            visibility, status
          )
          values (
            ${newRoomId()}, ${name}, ${input.ownerUserId}, ${sha256(inviteCode)}, ${input.maxSeats},
            ${input.smallBlind}, ${input.bigBlind}, ${ante}, ${input.startingStack},
            ${actionTimeoutSeconds}, 'invite_only', 'open'
          )
          returning id, name, owner_user_id, max_seats, small_blind, big_blind, ante, starting_stack,
                    action_timeout_seconds, visibility, status, closed_at, created_at
        `;
        const inserted = rows[0];
        if (inserted === undefined) {
          throw new AppError('internal_error', { logDetail: 'room insert returned no row' });
        }
        return inserted;
      });
      return { room, inviteCode };
    } catch (error) {
      if (isUniqueViolation(error, 'rooms_invite_code_hash_key') && attempt < INVITE_CODE_ATTEMPTS) continue;
      const mapped = violationError(error, 'creating a room');
      if (mapped !== null) throw mapped;
      throw error;
    }
  }
  // Unreachable in practice: three independent 79-bit collisions. Reported rather than
  // swallowed, because if it ever happens the random source is broken and that is worth a page.
  throw new AppError('internal_error', {
    logDetail: `invite code generation collided ${INVITE_CODE_ATTEMPTS} times; check the random source`,
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One room by id, or null. Says nothing about whether the caller may see it. */
export async function byId(sql: Db, roomId: string): Promise<RoomRow | null> {
  const rows = await sql<RoomRow[]>`
    select id, name, owner_user_id, max_seats, small_blind, big_blind, ante, starting_stack,
           action_timeout_seconds, visibility, status, closed_at, created_at
      from prl.rooms
     where id = ${roomId}
  `;
  return rows[0] ?? null;
}

/**
 * One room by the digest of its invite code.
 *
 * Named for the digest because that is genuinely what it takes: `rooms_invite_code_hash_key` is
 * the index, and the plaintext has no column. `byInviteCode` below is the one to reach for from
 * a route — it hashes first, so a plaintext code cannot reach a query parameter by accident.
 *
 * The `timingSafeEquals` re-check is the same belt-and-braces measure as in
 * `sessions.findValidByToken`, for the same reason: the index has already established equality,
 * and this is what makes a future widening of the predicate fail closed instead of silently.
 */
export async function byInviteCodeHash(sql: Db, inviteCodeHash: Uint8Array): Promise<RoomRow | null> {
  const rows = await sql<(RoomRow & { readonly invite_code_hash: Buffer })[]>`
    select id, name, owner_user_id, invite_code_hash, max_seats, small_blind, big_blind, ante,
           starting_stack, action_timeout_seconds, visibility, status, closed_at, created_at
      from prl.rooms
     where invite_code_hash = ${inviteCodeHash}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  if (!timingSafeEquals(row.invite_code_hash, inviteCodeHash)) return null;
  // Rebuilt field by field rather than by rest-destructuring the digest away. Explicit is worth
  // six lines here: it makes it impossible for a column added to the select above to start
  // travelling outwards unnoticed, and the digest genuinely does not leave this function.
  return {
    id: row.id,
    name: row.name,
    owner_user_id: row.owner_user_id,
    max_seats: row.max_seats,
    small_blind: row.small_blind,
    big_blind: row.big_blind,
    ante: row.ante,
    starting_stack: row.starting_stack,
    action_timeout_seconds: row.action_timeout_seconds,
    visibility: row.visibility,
    status: row.status,
    closed_at: row.closed_at,
    created_at: row.created_at,
  };
}

/**
 * One room by the invite code a person typed.
 *
 * Returns null for a code that cannot be one at all (empty, absurdly long) as well as for a
 * code no room matches. The caller answers `invite_code_invalid` either way — distinguishing
 * "malformed" from "no such room" would tell somebody probing codes that they had the format
 * right, which is the only feedback a brute-force needs.
 */
export function byInviteCode(sql: Db, code: string): Promise<RoomRow | null> {
  const digest = hashInviteCode(code);
  // Not `async`: there is nothing to await here, and the linter is right to say so. The promise is
  // the one `byInviteCodeHash` returns, or an already-resolved null for a code that cannot be one.
  return digest === null ? Promise.resolve(null) : byInviteCodeHash(sql, digest);
}

export interface ListRoomsOptions {
  /** Closed rooms are excluded by default: the room list is where a learner goes to play. */
  readonly includeClosed?: boolean;
  readonly limit?: number;
}

/**
 * Rooms the learner owns or is currently sitting at.
 *
 * Owner-or-member rather than member alone, because an owner who stood up still needs the room
 * in their list to be able to close it. `exists` rather than a join, so a learner who is both
 * owner and member does not appear twice and no `distinct` is needed to hide it.
 *
 * Members are not included: `RoomSummary.members` is filled by `membersOfRooms` below, in one
 * further query for the whole page rather than one per room.
 */
export async function listForUser(
  sql: Db,
  userId: string,
  options: ListRoomsOptions = {},
): Promise<readonly RoomRow[]> {
  const includeClosed = options.includeClosed ?? false;
  const limit = options.limit ?? 50;
  const rows = await sql<RoomRow[]>`
    select r.id, r.name, r.owner_user_id, r.max_seats, r.small_blind, r.big_blind, r.ante,
           r.starting_stack, r.action_timeout_seconds, r.visibility, r.status, r.closed_at, r.created_at
      from prl.rooms r
     where (
             r.owner_user_id = ${userId}
             or exists (
               select 1 from prl.room_members m
                where m.room_id = r.id and m.user_id = ${userId} and m.left_at is null
             )
           )
       and (${includeClosed}::boolean or r.status <> 'closed')
     order by r.created_at desc, r.id desc
     limit ${limit}
  `;
  return rows;
}

export interface MembersOptions {
  /** Departed members are excluded by default. Include them for a history view. */
  readonly includeDeparted?: boolean;
}

/** The roster of one room, seated members first and then by join order. */
export function membersOf(
  sql: Db,
  roomId: string,
  options: MembersOptions = {},
): Promise<readonly RoomMemberRow[]> {
  return membersOfRooms(sql, [roomId], options);
}

/**
 * The rosters of several rooms in one query.
 *
 * `= any(${ids}::text[])` rather than a generated `in (...)` list: it is one parameter whatever
 * the page size, it cannot be built wrongly, and — the practical part — an empty array is legal
 * and matches nothing, whereas `in ()` is a syntax error that only shows up when a learner
 * happens to be in no rooms.
 *
 * `nulls last` on the seat is what puts seated members before those waiting, which is the order
 * a table renders in.
 */
export async function membersOfRooms(
  sql: Db,
  roomIds: readonly string[],
  options: MembersOptions = {},
): Promise<readonly RoomMemberRow[]> {
  if (roomIds.length === 0) return [];
  const includeDeparted = options.includeDeparted ?? false;
  const rows = await sql<RoomMemberRowRaw[]>`
    select m.id, m.room_id, m.user_id, u.display_name, m.seat, m.stack, m.is_bot, m.bot_profile,
           m.bot_difficulty, m.bot_seed, m.joined_at, m.left_at
      from prl.room_members m
      join prl.users u on u.id = m.user_id
     where m.room_id = any(${[...roomIds]}::text[])
       and (${includeDeparted}::boolean or m.left_at is null)
     order by m.room_id, m.seat asc nulls last, m.joined_at
  `;
  return rows.map(toMemberRow);
}

/** One learner's live membership of one room, or null. The authorisation primitive. */
export async function memberOf(sql: Db, roomId: string, userId: string): Promise<RoomMemberRow | null> {
  const rows = await sql<RoomMemberRowRaw[]>`
    select m.id, m.room_id, m.user_id, u.display_name, m.seat, m.stack, m.is_bot, m.bot_profile,
           m.bot_difficulty, m.bot_seed, m.joined_at, m.left_at
      from prl.room_members m
      join prl.users u on u.id = m.user_id
     where m.room_id = ${roomId} and m.user_id = ${userId} and m.left_at is null
  `;
  const raw = rows[0];
  return raw === undefined ? null : toMemberRow(raw);
}

// ---------------------------------------------------------------------------
// Membership writes
// ---------------------------------------------------------------------------

export interface AddMemberInput {
  readonly roomId: string;
  readonly userId: string;
  /** Chips in front of them. Defaults to the room's `starting_stack`. */
  readonly stack?: number;
  readonly isBot?: boolean;
  /**
   * The whole of what a bot seat is: which strategy, how hard, and the decision seed.
   *
   * Required when `isBot`, forbidden otherwise — `room_members_bot_profile_iff_bot` and
   * `room_members_bot_config_requires_bot`. All three together, because a profile id on its own
   * does not reproduce an opponent and a row that carries only part of the answer is a seat that
   * cannot be rehydrated. See `rooms/bot-profile.ts`.
   */
  readonly bot?: DurableBotSeat | null;
}

/**
 * Joins a learner (or seats a bot) at a room, without taking a seat.
 *
 * A new member has `seat = NULL`, which means waiting rather than seated. `NULLS DISTINCT` in
 * `room_members_live_seat_key` is what lets several of those coexist; taking a seat is
 * `seatMember`, a separate decision with a separate failure.
 *
 * Bots get real user rows, so a seat is a seat whoever occupies it: the same membership, hand
 * seat and action shapes apply, and no query needs a special case for "this seat has no user".
 *
 * ## The one statement, and what its WHERE clause is doing
 *
 * `insert ... select ... from prl.rooms where <preconditions>` inserts zero rows when the room
 * is missing, closed, or already at `max_seats` live members. Doing it that way rather than
 * "read the room, count the members, then insert" matters at a full table: two joins that both
 * read `5 of 6` would both insert, and the sixth seat would be occupied twice.
 */
export async function addMember(sql: Db, input: AddMemberInput): Promise<RoomMemberRow> {
  const isBot = input.isBot ?? false;
  const bot = normaliseBotSeat(isBot, input.bot ?? null);
  const stack = input.stack ?? null;
  if (stack !== null && (!Number.isInteger(stack) || stack < 0)) {
    throw new AppError('invalid_request', {
      fields: { stack: 'must be a whole number of units, and not negative' },
      logDetail: `rejected a starting stack of ${String(stack)}`,
    });
  }

  try {
    const rows = await sql<{ id: string }[]>`
      insert into prl.room_members
             (id, room_id, user_id, seat, stack, is_bot, bot_profile, bot_difficulty, bot_seed)
      select ${newRoomMemberId()}, r.id, ${input.userId}, null,
             coalesce(${stack}::int, r.starting_stack), ${isBot},
             ${bot === null ? null : bot.profileId},
             ${bot === null ? null : bot.difficulty},
             ${bot === null ? null : String(bot.seed)}::bigint
        from prl.rooms r
       where r.id = ${input.roomId}
         and r.status <> 'closed'
         and (
               select count(*) from prl.room_members m
                where m.room_id = r.id and m.left_at is null
             ) < r.max_seats
      returning id
    `;
    if (rows.length > 0) {
      const member = await memberOf(sql, input.roomId, input.userId);
      if (member !== null) return member;
      throw new AppError('internal_error', { logDetail: 'member insert succeeded but read back nothing' });
    }
  } catch (error) {
    const mapped = violationError(error, 'joining a room');
    if (mapped !== null) throw mapped;
    throw error;
  }
  // Nothing matched. Work out which precondition it was, in the order that matters.
  throw await diagnoseMembershipFailure(sql, input.roomId, input.userId, 'room_full');
}

/**
 * Takes a seat.
 *
 * Seat legality is split between three places on purpose. `room_members_seat_range` (0..5) is a
 * CHECK, so it is enforced everywhere; `seat < max_seats` is per-room and a CHECK cannot see
 * across tables, so it is in this statement's WHERE clause where it is evaluated against the
 * room row the UPDATE joins; and "is that seat free" is `room_members_live_seat_key`, because
 * no amount of application locking substitutes for the database refusing.
 *
 * Throws `seat_taken` (translated from the unique violation) when somebody else got there
 * first — including when they got there in the microsecond between this caller's check and this
 * caller's write, which is the case the index exists for.
 */
export async function seatMember(
  sql: Db,
  roomId: string,
  userId: string,
  seat: number,
): Promise<RoomMemberRow> {
  if (!Number.isInteger(seat) || seat < 0 || seat > SEAT_MAX) {
    throw new AppError('invalid_request', {
      fields: { seat: `must be 0 to ${SEAT_MAX}` },
      logDetail: `rejected seat index ${String(seat)}`,
    });
  }
  try {
    const rows = await sql<{ id: string }[]>`
      update prl.room_members m
         set seat = ${seat}
        from prl.rooms r
       where r.id = m.room_id
         and m.room_id = ${roomId}
         and m.user_id = ${userId}
         and m.left_at is null
         and r.status <> 'closed'
         and ${seat}::int < r.max_seats
      returning m.id
    `;
    if (rows.length > 0) {
      const member = await memberOf(sql, roomId, userId);
      if (member !== null) return member;
      throw new AppError('internal_error', { logDetail: 'seat update succeeded but read back nothing' });
    }
  } catch (error) {
    const mapped = violationError(error, 'taking a seat');
    if (mapped !== null) throw mapped;
    throw error;
  }
  throw await diagnoseMembershipFailure(sql, roomId, userId, 'invalid_request');
}

/** Stands up without leaving the table. Frees the seat for somebody else immediately. */
export async function unseatMember(sql: Db, roomId: string, userId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update prl.room_members
       set seat = null
     where room_id = ${roomId} and user_id = ${userId} and left_at is null and seat is not null
    returning id
  `;
  return rows.length > 0;
}

/**
 * Leaves the table.
 *
 * `left_at = now()` rather than a DELETE, and the grant matrix agrees — there is no DELETE on
 * `prl.room_members` at all. The row is the record of who sat where, and because both unique
 * indexes are partial on `left_at IS NULL`, setting it frees the seat and the membership slot in
 * the same statement without erasing the history. The seat number is deliberately left in place
 * for the same reason.
 */
export async function removeMember(sql: Db, roomId: string, userId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update prl.room_members
       set left_at = now()
     where room_id = ${roomId} and user_id = ${userId} and left_at is null
    returning id
  `;
  return rows.length > 0;
}

/**
 * Sets a live member's stack to an absolute value.
 *
 * Absolute, not a delta, because this is the settlement path: the engine has computed what every
 * seat now has, and writing "what it is" cannot drift the way a sequence of increments can. For
 * the relative case — a buy-in, a rebuy — use `users.adjustUnits`, which guards the subtraction
 * inside its own WHERE clause.
 */
export async function updateMemberStack(
  sql: Db,
  roomId: string,
  userId: string,
  stack: number,
): Promise<boolean> {
  if (!Number.isInteger(stack) || stack < 0) {
    throw new AppError('invalid_request', {
      fields: { stack: 'must be a whole number of units, and not negative' },
      logDetail: `rejected a stack of ${String(stack)}`,
    });
  }
  try {
    const rows = await sql<{ id: string }[]>`
      update prl.room_members
         set stack = ${stack}
       where room_id = ${roomId} and user_id = ${userId} and left_at is null
      returning id
    `;
    return rows.length > 0;
  } catch (error) {
    const mapped = violationError(error, 'updating a seat stack');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Room status
// ---------------------------------------------------------------------------

/**
 * Moves a room between `open` and `playing`.
 *
 * `closed` is not reachable from here: `rooms_closed_at_matches_status` pairs the status with
 * `closed_at`, so closing is `close()` and only `close()`. Splitting them means no caller can
 * leave a room claiming to be closed with no time of closing, or the reverse.
 */
export async function setStatus(sql: Db, roomId: string, status: 'open' | 'playing'): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update prl.rooms
       set status = ${status}
     where id = ${roomId} and status <> 'closed' and status <> ${status}
    returning id
  `;
  return rows.length > 0;
}

export interface CloseRoomOptions {
  /**
   * When given, the room is only closed if this learner owns it. Passing it makes the
   * authorisation part of the same statement as the write, so a room cannot be closed by
   * someone who stopped being the owner between the check and the update.
   */
  readonly ownerUserId?: string;
}

/**
 * Closes a room.
 *
 * `status` and `closed_at` move together, which `rooms_closed_at_matches_status` requires.
 * Memberships are left exactly as they are: the roster of a closed table is history, the hands
 * played there still reference it, and there is no DELETE on `prl.rooms` at all — closing is a
 * status change, not a removal.
 *
 * Returns false when the room does not exist, is already closed, or is not owned by
 * `ownerUserId`. The three are not distinguished, because "that room exists but is not yours" is
 * exactly the answer `room_not_found_or_not_permitted` exists to avoid giving.
 */
export async function close(sql: Db, roomId: string, options: CloseRoomOptions = {}): Promise<boolean> {
  const owner = options.ownerUserId ?? null;
  const rows = await sql<{ id: string }[]>`
    update prl.rooms
       set status = 'closed', closed_at = now()
     where id = ${roomId}
       and status <> 'closed'
       and (${owner}::text is null or owner_user_id = ${owner})
    returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Refuses a bot seat that could not be put back after a restart, at the moment it is written.
 *
 * This is the forward half of migration 0003. The column CHECKs cannot express "a NEW bot row
 * must carry all three fields" without also rejecting the pre-0003 rows that legitimately carry
 * none, so the requirement lives here — one write path, one refusal, before anything reaches the
 * table. `durableProfile` and `durableSeed` throw on their own for a value the schema would
 * reject anyway, so an unknown profile id fails here rather than as a constraint violation.
 */
function normaliseBotSeat(isBot: boolean, bot: DurableBotSeat | null): DurableBotSeat | null {
  if (!isBot) {
    if (bot !== null) {
      throw new AppError('invalid_request', {
        fields: { bot: 'only applies to a bot seat' },
        logDetail: 'a human seat was given a bot configuration',
      });
    }
    return null;
  }
  if (bot === null) {
    throw new AppError('invalid_request', {
      fields: { bot: 'a bot seat needs a profile, a difficulty and a seed' },
      logDetail: 'a bot seat was created without a strategy configuration',
    });
  }
  if (!isDifficulty(bot.difficulty)) {
    throw new AppError('invalid_request', {
      fields: { bot: 'difficulty must be educational, realistic or expert' },
      logDetail: `a bot seat was created with difficulty "${bot.difficulty}"`,
    });
  }
  return {
    profileId: durableProfile(bot.profileId),
    difficulty: bot.difficulty,
    seed: durableSeed(bot.seed),
  };
}

/**
 * Works out why a membership write matched nothing, and returns the error to throw.
 *
 * The order is the point. "Does the room exist" first, because every other answer would
 * otherwise confirm a room id to somebody who guessed it. Then closed, then already-a-member,
 * then the caller's own fallback — `room_full` for a join, `invalid_request` for a seat outside
 * this room's `max_seats`.
 *
 * Returns rather than throws so the call site reads `throw await diagnose...`, which keeps it
 * obvious that the function always ends in a throw. A `Promise<never>` helper would hide that.
 */
async function diagnoseMembershipFailure(
  sql: Db,
  roomId: string,
  userId: string,
  fallback: 'room_full' | 'invalid_request',
): Promise<AppError> {
  const room = await byId(sql, roomId);
  if (room === null) {
    return new AppError('room_not_found_or_not_permitted', { logDetail: `no room ${roomId}` });
  }
  if (room.status === 'closed') {
    return new AppError('room_closed', { logDetail: `room ${roomId} is closed` });
  }
  const member = await memberOf(sql, roomId, userId);
  if (fallback === 'room_full') {
    if (member !== null) {
      return new AppError('already_seated', { logDetail: `already a live member of ${roomId}` });
    }
    return new AppError('room_full', { logDetail: `room ${roomId} has no free seats` });
  }
  if (member === null) {
    return new AppError('not_room_member', { logDetail: `not a live member of ${roomId}` });
  }
  return new AppError('invalid_request', {
    fields: { seat: `must be 0 to ${room.max_seats - 1} at this table` },
    logDetail: `seat outside max_seats ${room.max_seats} for room ${roomId}`,
  });
}

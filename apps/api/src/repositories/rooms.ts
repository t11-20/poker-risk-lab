/**
 * `prl.rooms` and `prl.room_members`.
 *
 * One live member per seat and one live membership per user are partial unique indexes (migration
 * 0002). The writes let the database refuse, and `sql.ts` maps the violation to `seat_taken` /
 * `already_seated`. The invite code is never stored, only `sha256(code)`, and `visibility` admits
 * only `'invite_only'`, so nothing can be enumerated.
 *
 * Writes carry their preconditions in one statement's WHERE clause, and the rare no-match path runs
 * a diagnostic read to choose the error. A WHERE predicate on the row being written is re-checked by
 * EvalPlanQual. A `count(*)` over other rows is not, which is why `addMember` locks the room first.
 */

import { AppError } from '../errors.ts';
import { type DurableBotSeat, durableProfile, durableSeed, isDifficulty } from '../rooms/bot-profile.ts';
import { hashInviteCode, sha256, timingSafeEquals } from './hashing.ts';
import { generateInviteCode, newRoomId, newRoomMemberId } from './ids.ts';
import { type Db, insideSavepoint, isUniqueViolation, violationError } from './sql.ts';

/** Copied from the `rooms_*` CHECK constraints in migration 0001. */
const NAME_MIN = 2;
const NAME_MAX = 48;
const SEATS_MIN = 2;
const SEATS_MAX = 6;
const TIMEOUT_MIN = 5;
const TIMEOUT_MAX = 300;
/** `room_members_seat_range`: 0-based and never above 5, whatever `max_seats` says. */
const SEAT_MAX = 5;

/**
 * A collision must retry, never return the other room. At 79 bits three collisions mean a broken
 * generator, and the loud failure is correct.
 */
const INVITE_CODE_ATTEMPTS = 3;

export type RoomStatus = 'open' | 'playing' | 'closed';

/** `invite_code_hash` is deliberately absent, so a caller that logs a row cannot log the digest. */
export interface RoomRow {
  readonly id: string;
  readonly name: string;
  /**
   * Null once the creator has erased their account (migration 0004, `ON DELETE SET NULL`, so other
   * learners' hands survive). An ownerless room is always closed.
   */
  readonly owner_user_id: string | null;
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

export interface RoomMemberRow {
  readonly id: string;
  readonly room_id: string;
  readonly user_id: string;
  readonly display_name: string;
  readonly seat: number | null;
  readonly stack: number;
  readonly is_bot: boolean;
  /**
   * The `@prl/poker-ai` strategy profile id, `'unknown'` before migration 0003, null for a human. Not
   * an `OpponentProfile`, which would lose seven of the twelve Legends their identity across a restart.
   */
  readonly bot_profile: string | null;
  /** Null only on a pre-0003 bot row, like `bot_seed`. */
  readonly bot_difficulty: string | null;
  readonly bot_seed: number | null;
  readonly joined_at: Date;
  readonly left_at: Date | null;
}

/**
 * postgres.js returns `bigint` as a string. `bot_seed` is a CHECKed uint32, so it converts safely,
 * and a signed `int` column could not hold half the seed space.
 */
interface RoomMemberRowRaw extends Omit<RoomMemberRow, 'bot_seed'> {
  readonly bot_seed: string | null;
}

function toMemberRow(raw: RoomMemberRowRaw): RoomMemberRow {
  return { ...raw, bot_seed: raw.bot_seed === null ? null : Number(raw.bot_seed) };
}

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
  /** Returned once and never stored. `logging.ts` censors `/invite/i`. */
  readonly inviteCode: string;
}

export interface ValidatedRoomConfig {
  readonly name: string;
  readonly ante: number;
  readonly actionTimeoutSeconds: number;
}

/**
 * Mirrors the CHECK constraints in migration 0001. `createRoomBodySchema` bounds fields one at a
 * time and accepts cross-field violations (`bigBlind <= smallBlind`, `ante > bigBlind`, a stack
 * under two big blinds), which would otherwise surface as a 500.
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
    // Under two big blinds, the first forced bet is already all-in.
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
 * Each attempt runs in `insideSavepoint`, because a failed statement aborts a Postgres transaction
 * (25P02) and a retry inside `withTransaction` would otherwise fail. Only
 * `rooms_invite_code_hash_key` is retried.
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
  throw new AppError('internal_error', {
    logDetail: `invite code generation collided ${INVITE_CODE_ATTEMPTS} times; check the random source`,
  });
}

/** Says nothing about whether the caller may see it. */
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
 * Routes should call `byInviteCode`, which hashes first. The `timingSafeEquals` re-check makes a
 * future widening of the predicate fail closed, as in `sessions.findValidByToken`.
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
  // Field by field, so a column added to the select cannot travel outwards unnoticed.
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
 * Null for a malformed code and for an unknown one alike, so a brute-force learns nothing about the
 * format from `invite_code_invalid`.
 */
export function byInviteCode(sql: Db, code: string): Promise<RoomRow | null> {
  const digest = hashInviteCode(code);
  return digest === null ? Promise.resolve(null) : byInviteCodeHash(sql, digest);
}

export interface ListRoomsOptions {
  readonly includeClosed?: boolean;
  readonly limit?: number;
}

/**
 * Rooms the learner owns or is sitting at. Owners are included so one who stood up can still close
 * the room. `exists` avoids duplicate rows for an owner who is also a member.
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
  readonly includeDeparted?: boolean;
}

export function membersOf(
  sql: Db,
  roomId: string,
  options: MembersOptions = {},
): Promise<readonly RoomMemberRow[]> {
  return membersOfRooms(sql, [roomId], options);
}

/** `= any(...::text[])` is one parameter, and unlike `in ()` an empty array is legal. */
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

/**
 * Null once the membership has left. Without `left_at is null`, a leave during `seatMember` would
 * hand back the departed row as seated and let the learner back into the room.
 */
async function liveMemberById(sql: Db, memberId: string): Promise<RoomMemberRow | null> {
  const rows = await sql<RoomMemberRowRaw[]>`
    select m.id, m.room_id, m.user_id, u.display_name, m.seat, m.stack, m.is_bot, m.bot_profile,
           m.bot_difficulty, m.bot_seed, m.joined_at, m.left_at
      from prl.room_members m
      join prl.users u on u.id = m.user_id
     where m.id = ${memberId} and m.left_at is null
  `;
  const raw = rows[0];
  return raw === undefined ? null : toMemberRow(raw);
}

/** The authorisation primitive. */
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

export interface AddMemberInput {
  readonly roomId: string;
  readonly userId: string;
  /** Defaults to the room's `starting_stack`. */
  readonly stack?: number;
  readonly isBot?: boolean;
  /**
   * Required when `isBot`, forbidden otherwise. All three fields together, because a partial row
   * cannot be rehydrated after a restart. See `rooms/bot-profile.ts`.
   */
  readonly bot?: DurableBotSeat | null;
}

/**
 * Joins a learner (or seats a bot) at a room, without taking a seat. A new member has `seat = NULL`.
 * Bots get real user rows, so no query special-cases them.
 *
 * The `count(*)` in the WHERE clause locks nothing. The `for update` on the room row is what makes
 * the capacity check atomic. Do not drop it. Without it, two joins of a two-seat room holding one
 * member both count 1 and both insert. With it, the loser blocks, and its insert
 * takes a new READ COMMITTED snapshot that sees the winner. A REPEATABLE READ caller would defeat
 * this, and `withTransaction` uses the cluster default.
 *
 * - `for update`, not `for share`, because two share locks coexist.
 * - Lock and insert must share a transaction, and `rooms/registry.ts` passes the pool, hence
 *   `inOneTransaction`.
 * - No CHECK can express "at most `max_seats` live rows", and there is no member row to lock yet.
 *
 * Joins of the same room serialise, and wait behind `setStatus`/`close` of that room.
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
    const member = await inOneTransaction(sql, async (tx) => {
      // A missing room takes the same no-match path as a full one and is diagnosed below.
      const locked = await tx<{ id: string }[]>`
        select r.id from prl.rooms r where r.id = ${input.roomId} for update
      `;
      if (locked.length === 0) return null;

      const rows = await tx<{ id: string }[]>`
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
      if (rows.length === 0) return null;
      // On `tx`, because the new row is not yet visible to other connections.
      const inserted = await memberOf(tx, input.roomId, input.userId);
      if (inserted === null) {
        throw new AppError('internal_error', { logDetail: 'member insert succeeded but read back nothing' });
      }
      return inserted;
    });
    if (member !== null) return member;
  } catch (error) {
    const mapped = violationError(error, 'joining a room');
    if (mapped !== null) throw mapped;
    throw error;
  }
  throw await diagnoseMembershipFailure(sql, input.roomId, input.userId, 'room_full');
}

/**
 * Takes a seat. The 0..5 range is a CHECK, `seat < max_seats` is in the WHERE clause against the
 * joined room row, and seat uniqueness is `room_members_live_seat_key`, mapped to `seat_taken`.
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
    const seated = rows[0];
    if (seated !== undefined) {
      // By id, because a leave and rejoin in between would return the new membership.
      const member = await liveMemberById(sql, seated.id);
      if (member !== null) return member;
      // It left in between. Refuse the sit rather than diagnose, because after a rejoin the
      // diagnosis would find a live member. The departed row's seat holds nothing, since both
      // unique indexes are partial on `left_at is null`.
      throw new AppError('not_room_member', { logDetail: `left ${roomId} while taking a seat` });
    }
  } catch (error) {
    const mapped = violationError(error, 'taking a seat');
    if (mapped !== null) throw mapped;
    throw error;
  }
  throw await diagnoseMembershipFailure(sql, roomId, userId, 'invalid_request');
}

/**
 * Sets `room_members.first_seated_at`, which `users.readUnits` counts a membership by. Never
 * cleared. Returns false when the membership has left.
 *
 * Separate from `seatMember` because the live table can still refuse a seat the database granted,
 * and the fact must only be written once the live table accepts. Found by id because a leave and
 * rejoin in the gap would otherwise mark the new, never-seated membership. It does not require a
 * seat, because a stand before this lands still followed a genuine sit.
 */
export async function recordFirstSit(sql: Db, memberId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update prl.room_members
       set first_seated_at = coalesce(first_seated_at, now())
     where id = ${memberId} and left_at is null
    returning id
  `;
  return rows.length > 0;
}

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
 * Sets `left_at` and never deletes, and the grants allow no DELETE. Both unique indexes are partial
 * on `left_at IS NULL`, so this frees the seat and the slot while keeping the history.
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
 * Absolute, because this is settlement and a sequence of deltas can drift. For a relative change,
 * use `users.adjustUnits`.
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

/** `closed` is only reachable through `close()`, which sets `closed_at` with it. */
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
  /** Puts the ownership check in the same statement as the write. */
  readonly ownerUserId?: string;
}

/**
 * Closes a room and leaves memberships as history. Returns false for missing, closed or not owned,
 * without saying which, so `room_not_found_or_not_permitted` reveals nothing.
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

/**
 * Closes a practice table unless another person is a member, in one transaction, so a join between
 * reading the roster and closing cannot be closed under its maker.
 *
 * A single `update ... where not exists` is not enough, because `addMember` only locks the room row
 * and EvalPlanQual never fires. So this takes the same `for update` lock, then decides in a new
 * statement whose snapshot sees every committed join. Bots and `max_seats` do not change after a
 * room is built, so only "another person" is re-checked.
 */
export function closePracticeTable(sql: Db, roomId: string, ownerUserId: string): Promise<boolean> {
  return inOneTransaction(sql, async (tx) => {
    const locked = await tx<{ id: string }[]>`
      select r.id from prl.rooms r where r.id = ${roomId} for update
    `;
    if (locked.length === 0) return false;
    const rows = await tx<{ id: string }[]>`
      update prl.rooms r
         set status = 'closed', closed_at = now()
       where r.id = ${roomId}
         and r.status <> 'closed'
         and r.owner_user_id = ${ownerUserId}
         and not exists (
               select 1 from prl.room_members m
                where m.room_id = r.id
                  and m.left_at is null
                  and not m.is_bot
                  and m.user_id <> ${ownerUserId}
             )
      returning r.id
    `;
    return rows.length > 0;
  });
}

/**
 * Runs `fn` in the caller's transaction, or a new one when given the pool, because a row lock must
 * share a transaction with the write it guards. `TransactionSql` declares `savepoint` and `Sql` does
 * not. Boxed because postgres.js types `begin` as `UnwrapPromiseArray<T>`.
 */
async function inOneTransaction<T>(handle: Db, fn: (handle: Db) => Promise<T>): Promise<T> {
  if ('savepoint' in handle) return fn(handle);
  const boxed = await handle.begin(async (tx) => ({ value: await fn(tx) }));
  return boxed.value;
}

/**
 * Refuses a bot seat that could not be restored after a restart. The column CHECKs cannot require
 * all three fields on new rows without rejecting pre-0003 rows, so the rule lives here.
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
 * Chooses the error for a membership write that matched nothing. Existence is checked first, so no
 * other answer confirms a guessed room id.
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

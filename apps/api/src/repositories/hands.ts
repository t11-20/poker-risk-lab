/**
 * `prl.hands`, `prl.hand_seats`, `prl.hand_actions`.
 *
 * The deck and the commitment salts are never written here, and there is no column for either. Only
 * the Merkle root is persisted. `assertRevealIsSafe` refuses a whole-deck reveal before SQL, matching
 * the CHECK constraints in migration 0001. The accepted consequence is that an interrupted hand
 * cannot be resumed after a restart.
 *
 * Writes take engine `Card` integers and format them with `cardToString`. Reads return the `"Ah"`
 * notation, which is what the columns hold and what the wire carries.
 */

import type { AutomaticReason } from '@prl/contracts';
import type {
  ActionType,
  BettingStreet,
  Card,
  DeckReveal,
  HandResult,
  SeatStatus,
  Street,
  TableConfig,
} from '@prl/poker-engine';
import { COMMITMENT_VERSION, cardToString } from '@prl/poker-engine';
import { AppError } from '../errors.ts';
import { newHandActionId, newHandSeatId } from './ids.ts';
import { type Db, jsonbText, violationError } from './sql.ts';

/** 5 board cards + 2 hole cards x 6 seats, from migration 0001. There are no burn cards. */
export const MAX_PUBLIC_REVEALED_CARDS = 17;

/** `prl.is_card_notation_array`'s per-element rule. */
const CARD_NOTATION = /^[2-9TJQKA][cdhs]$/;

/** `MAX_PAGE_SIZE` matches the ceiling `handListQuerySchema` enforces. */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export type RandomSourceKind = 'csprng' | 'deterministic-test-only' | 'fixed-deck-scenario';

export interface HandRow {
  readonly id: string;
  readonly room_id: string;
  readonly hand_number: number;
  readonly button_seat: number;
  readonly config: unknown;
  readonly commitment_root: string;
  readonly commitment_context: string;
  readonly random_source_kind: RandomSourceKind;
  readonly board: unknown;
  readonly street: Street;
  readonly result: unknown;
  readonly reveal: unknown;
  readonly started_at: Date;
  readonly completed_at: Date | null;
}

/** `holeCards` is null whenever the viewer is not entitled to it, because the SQL never selected it. */
export interface HandSeatView {
  readonly seat: number;
  readonly userId: string | null;
  readonly displayName: string | null;
  readonly isBot: boolean;
  readonly startingStack: number;
  readonly netResult: number | null;
  readonly status: SeatStatus;
  readonly showedDown: boolean;
  readonly holeCards: readonly string[] | null;
}

export interface HandActionRow {
  readonly sequence: number;
  readonly street: BettingStreet;
  readonly seat: number;
  readonly action_type: ActionType;
  readonly action_to: number | null;
  readonly amount_paid: number;
  readonly bet_level_after: number;
  readonly pot_after: number;
  readonly was_automatic: boolean;
  /** Null on a person's decision, and on an automatic row written before migration 0009. */
  readonly automatic_reason: AutomaticReason | null;
}

export interface HandListItem {
  readonly id: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly board: readonly string[];
  /** Null while the hand is unsettled. */
  readonly heroNet: number | null;
  readonly endedByFold: boolean;
  readonly potTotal: number;
}

export interface StartHandSeatInput {
  readonly seat: number;
  /** Null only for a seat whose account was deleted; live hands always have one. */
  readonly userId: string | null;
  readonly isBot: boolean;
  readonly startingStack: number;
  /** Null for a seat sitting out. An empty array would mean a seat dealt nothing. */
  readonly holeCards: readonly Card[] | null;
  readonly status: SeatStatus;
}

export interface StartHandInput {
  /** Minted by the caller before the engine ran: `handId` is inside the commitment context. */
  readonly handId: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly buttonSeat: number;
  /** Snapshotted per hand, so a later change to the room's settings does not rewrite history. */
  readonly config: TableConfig;
  readonly commitmentRoot: string;
  readonly commitmentContext: string;
  readonly randomSourceKind: RandomSourceKind;
  readonly seats: readonly StartHandSeatInput[];
}

/**
 * Writes the hand and its seats. Call this inside `withTransaction`, so a partial set of seats can
 * never be committed. The board and street are literals because no legal hand starts later.
 */
export async function start(sql: Db, input: StartHandInput): Promise<HandRow> {
  if (input.seats.length === 0) {
    throw new AppError('internal_error', { logDetail: 'refusing to start a hand with no seats' });
  }
  try {
    const rows = await sql<HandRow[]>`
      insert into prl.hands (
        id, room_id, hand_number, button_seat, config,
        commitment_root, commitment_context, random_source_kind,
        board, street
      )
      values (
        ${input.handId}, ${input.roomId}, ${input.handNumber}, ${input.buttonSeat},
        ${jsonbText(input.config, 'config')}::text::jsonb,
        ${input.commitmentRoot}, ${input.commitmentContext}, ${input.randomSourceKind},
        '[]'::jsonb, 'preflop'
      )
      returning id, room_id, hand_number, button_seat, config, commitment_root, commitment_context,
                random_source_kind, board, street, result, reveal, started_at, completed_at
    `;
    const hand = rows[0];
    if (hand === undefined) {
      throw new AppError('internal_error', { logDetail: 'hand insert returned no row' });
    }

    for (const seat of input.seats) {
      await sql`
        insert into prl.hand_seats (
          id, hand_id, seat, user_id, is_bot, starting_stack, hole_cards, net_result, status, showed_down
        )
        values (
          ${newHandSeatId()}, ${input.handId}, ${seat.seat}, ${seat.userId}, ${seat.isBot},
          ${seat.startingStack}, ${notationJsonOrNull(seat.holeCards)}::text::jsonb, null, ${seat.status}, false
        )
      `;
    }
    return hand;
  } catch (error) {
    const mapped = violationError(error, 'starting a hand');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

/**
 * `max(hand_number) + 1` is safe because `hands_room_hand_number_key` is unique. A racing deal fails
 * on the index, and `sql.ts` maps it to `stale_action_sequence`.
 */
export async function nextHandNumber(sql: Db, roomId: string): Promise<number> {
  const rows = await sql<{ next: number }[]>`
    select coalesce(max(hand_number), 0)::int + 1 as next from prl.hands where room_id = ${roomId}
  `;
  return rows[0]?.next ?? 1;
}

/** Served by the partial `hands_live_by_room_idx`. The ordering is deterministic if a bug left two. */
export async function activeHandIdForRoom(sql: Db, roomId: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    select id from prl.hands
     where room_id = ${roomId} and completed_at is null
     order by hand_number desc
     limit 1
  `;
  return rows[0]?.id ?? null;
}

export interface LastDealtHand {
  readonly handId: string;
  readonly handNumber: number;
  readonly buttonSeat: number;
  readonly dealtSeats: readonly number[];
}

/**
 * The most recent hand a room dealt, for restoring the blind rotation after a restart.
 *
 * Only the button is persisted. The blinds are reconstructed as the first and second dealt seats
 * clockwise from it, which is exact except after a dead small blind, where one player pays the big
 * blind twice across that restart (`docs/audit/poker-correctness.md`, P2). Exact needs
 * `small_blind_seat` and `big_blind_seat` columns. An interrupted hand still counts, because it was
 * dealt.
 */
export async function lastDealtHand(sql: Db, roomId: string): Promise<LastDealtHand | null> {
  const rows = await sql<{ id: string; hand_number: number; button_seat: number }[]>`
    select id, hand_number, button_seat
      from prl.hands
     where room_id = ${roomId}
     order by hand_number desc
     limit 1
  `;
  const hand = rows[0];
  if (hand === undefined) return null;
  // `sittingOut` is a seat never dealt cards. A dead button seat has no row at all.
  const seats = await sql<{ seat: number }[]>`
    select seat from prl.hand_seats
     where hand_id = ${hand.id} and status <> 'sittingOut'
     order by seat
  `;
  return {
    handId: hand.id,
    handNumber: hand.hand_number,
    buttonSeat: hand.button_seat,
    dealtSeats: seats.map((row) => row.seat),
  };
}

export interface AbandonedHand {
  readonly handId: string;
  readonly roomId: string;
  readonly handNumber: number;
}

/**
 * Closes hands that can never complete, so they stop showing in history as nulls
 * (`docs/audit/poker-correctness.md`, P2).
 *
 * Net is zero because stacks are written to `prl.room_members.stack` only when a hand completes, so
 * an interrupted hand never moved a durable chip. The constraints require a `result` on a completed
 * hand, so it gets an empty `HandResult` with a reveal of no cards and an `abandoned` marker.
 *
 * Scoped to one room. The registry calls it while re-opening a room this process holds no live table
 * for, and a sweep across rooms could abandon another process's live hand.
 */
export async function abandonInterruptedHands(
  sql: Db,
  roomId: string,
  reason = 'interrupted-by-restart',
): Promise<readonly AbandonedHand[]> {
  const abandoned = await sql<{ id: string; room_id: string; hand_number: number }[]>`
    update prl.hands
       set street = 'complete',
           completed_at = now(),
           result = jsonb_build_object(
             'showdowns', '[]'::jsonb,
             'pots', '[]'::jsonb,
             'awards', '[]'::jsonb,
             'netBySeat', '{}'::jsonb,
             'endedByFold', true,
             'abandoned', true,
             'abandonedReason', ${reason}::text,
             'reveal', jsonb_build_object(
               'commitment', jsonb_build_object(
                 'algorithm', 'sha256',
                 'version', ${COMMITMENT_VERSION}::text,
                 'root', commitment_root,
                 'context', commitment_context
               ),
               'cards', '[]'::jsonb,
               'complete', false
             )
           ),
           reveal = jsonb_build_object(
             'commitment', jsonb_build_object(
               'algorithm', 'sha256',
               'version', ${COMMITMENT_VERSION}::text,
               'root', commitment_root,
               'context', commitment_context
             ),
             'cards', '[]'::jsonb,
             'complete', false
           )
     where room_id = ${roomId} and completed_at is null
    returning id, room_id, hand_number
  `;
  for (const hand of abandoned) {
    // Only unsettled seats, so a recorded net is never overwritten.
    await sql`
      update prl.hand_seats
         set net_result = 0
       where hand_id = ${hand.id} and net_result is null
    `;
  }
  return abandoned.map((hand) => ({
    handId: hand.id,
    roomId: hand.room_id,
    handNumber: hand.hand_number,
  }));
}

export interface AppendActionInput {
  readonly handId: string;
  readonly sequence: number;
  readonly street: BettingStreet;
  readonly seat: number;
  readonly actionType: ActionType;
  /**
   * "Raise to" means the seat's total commitment for the street after the action, not the increment.
   * Present only for `bet` and `raise` (`hand_actions_sizing_iff_bet_or_raise`).
   */
  readonly actionTo: number | null;
  readonly amountPaid: number;
  readonly betLevelAfter: number;
  readonly potAfter: number;
  readonly wasAutomatic: boolean;
  /** Separate from `wasAutomatic` so rows before migration 0009 keep their meaning. */
  readonly automaticReason: AutomaticReason | null;
  /**
   * The client's id for this decision, stable across retries. Null for an automatic action, which
   * keeps it outside the partial unique index.
   */
  readonly actionId: string | null;
}

export interface AppendActionResult {
  readonly applied: boolean;
  readonly id: string | null;
}

/**
 * Appends one action, at most once per client `actionId`.
 *
 * A duplicated raise spends a stack twice, and a check-then-insert cannot prevent it across pooled
 * connections. `on conflict ... do nothing` makes the second insert write nothing and return
 * `applied: false`, which `WsActionAckMessage.deduplicated` reports.
 *
 * The conflict target is named so `hand_actions_hand_sequence_key` still escapes and `sql.ts` maps it
 * to `stale_action_sequence`. A bare target would report a stale action as a harmless duplicate. The
 * `where` clause lets Postgres infer the partial index.
 */
export async function appendAction(sql: Db, input: AppendActionInput): Promise<AppendActionResult> {
  const isSized = input.actionType === 'bet' || input.actionType === 'raise';
  if (isSized !== (input.actionTo !== null)) {
    // `hand_actions_sizing_iff_bet_or_raise` would refuse this too, with a less readable error.
    throw new AppError('internal_error', {
      logDetail: `action ${input.actionType} carried actionTo=${String(input.actionTo)}`,
    });
  }
  const id = newHandActionId();
  try {
    const rows = await sql<{ id: string }[]>`
      insert into prl.hand_actions (
        id, hand_id, sequence, street, seat, action_type, action_to,
        amount_paid, bet_level_after, pot_after, was_automatic, automatic_reason, action_id
      )
      values (
        ${id}, ${input.handId}, ${input.sequence}, ${input.street}, ${input.seat},
        ${input.actionType}, ${input.actionTo}, ${input.amountPaid}, ${input.betLevelAfter},
        ${input.potAfter}, ${input.wasAutomatic}, ${input.automaticReason}, ${input.actionId}
      )
      on conflict (hand_id, action_id) where action_id is not null do nothing
      returning id
    `;
    const row = rows[0];
    return row === undefined ? { applied: false, id: null } : { applied: true, id: row.id };
  } catch (error) {
    const mapped = violationError(error, 'appending an action');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

export async function actionsOf(sql: Db, handId: string): Promise<readonly HandActionRow[]> {
  const rows = await sql<HandActionRow[]>`
    select sequence, street, seat, action_type, action_to, amount_paid, bet_level_after,
           pot_after, was_automatic, automatic_reason
      from prl.hand_actions
     where hand_id = ${handId}
     order by sequence
  `;
  return rows;
}

/**
 * `'complete'` is excluded because the constraints tie it to `completed_at` and `result`, which only
 * `complete()` sets together.
 */
export async function advanceStreet(
  sql: Db,
  handId: string,
  street: Exclude<Street, 'complete'>,
  board: readonly Card[],
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update prl.hands
       set street = ${street}, board = ${notationJson(board)}::text::jsonb
     where id = ${handId} and completed_at is null
    returning id
  `;
  return rows.length > 0;
}

export interface CompleteSeatInput {
  readonly seat: number;
  /** Chips won minus chips committed. May be negative. */
  readonly netResult: number;
  readonly status: SeatStatus;
  /** Opens `hole_cards` to the whole table, so it is set from `HandResult.showdowns` only. */
  readonly showedDown: boolean;
}

export interface CompleteHandInput {
  readonly handId: string;
  readonly board: readonly Card[];
  readonly result: HandResult;
  readonly seats: readonly CompleteSeatInput[];
}

/**
 * Settles a hand. Call this inside `withTransaction`, so a completed hand never has unsettled seats.
 * The reveal is stored in `prl.hands.reveal` and inside `result`, and both pass the same guard.
 */
export async function complete(sql: Db, input: CompleteHandInput): Promise<HandRow> {
  assertRevealIsSafe(input.result.reveal);
  try {
    const rows = await sql<HandRow[]>`
      update prl.hands
         set street = 'complete',
             completed_at = now(),
             board = ${notationJson(input.board)}::text::jsonb,
             result = ${jsonbText(input.result, 'result')}::text::jsonb,
             reveal = ${jsonbText(input.result.reveal, 'reveal')}::text::jsonb
       where id = ${input.handId} and completed_at is null
      returning id, room_id, hand_number, button_seat, config, commitment_root, commitment_context,
                random_source_kind, board, street, result, reveal, started_at, completed_at
    `;
    const hand = rows[0];
    if (hand === undefined) {
      throw new AppError('hand_not_active', {
        logDetail: `hand ${input.handId} was not open for settlement`,
      });
    }
    for (const seat of input.seats) {
      await sql`
        update prl.hand_seats
           set net_result = ${seat.netResult}, status = ${seat.status}, showed_down = ${seat.showedDown}
         where hand_id = ${input.handId} and seat = ${seat.seat}
      `;
    }
    return hand;
  } catch (error) {
    const mapped = violationError(error, 'settling a hand');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

/**
 * Refuses a reveal that would dump the deck, including folded hole cards. Mirrors the two CHECK
 * constraints on `prl.hands`. `complete` is set by `revealPositions()` for all 52 positions, and the
 * count is the ceiling, so a reveal cannot pass by lying about one. `internal_error`, because only a
 * settlement bug reaches this.
 */
export function assertRevealIsSafe(reveal: DeckReveal): void {
  if (reveal.complete) {
    throw new AppError('internal_error', {
      logDetail: 'refusing to persist a complete deck reveal against a hand',
    });
  }
  if (reveal.cards.length > MAX_PUBLIC_REVEALED_CARDS) {
    throw new AppError('internal_error', {
      logDetail:
        `refusing to persist a reveal of ${reveal.cards.length} cards; ` +
        `at most ${MAX_PUBLIC_REVEALED_CARDS} can legitimately be public`,
    });
  }
}

/**
 * One hand, if the viewer had a seat in it or is a member of its room. Otherwise null, so the caller
 * answers `hand_not_found` and cannot confirm which ids exist. Membership ignores `left_at` on
 * purpose, and `room_members_user_id_idx` is non-partial so this stays an index scan.
 */
export async function byId(sql: Db, handId: string, viewerUserId: string): Promise<HandRow | null> {
  const rows = await sql<HandRow[]>`
    select h.id, h.room_id, h.hand_number, h.button_seat, h.config, h.commitment_root,
           h.commitment_context, h.random_source_kind, h.board, h.street, h.result, h.reveal,
           h.started_at, h.completed_at
      from prl.hands h
     where h.id = ${handId}
       and (
             exists (
               select 1 from prl.hand_seats s where s.hand_id = h.id and s.user_id = ${viewerUserId}
             )
             or exists (
               select 1 from prl.room_members m where m.room_id = h.room_id and m.user_id = ${viewerUserId}
             )
           )
  `;
  return rows[0] ?? null;
}

/**
 * The seats of a hand, with hole cards for the viewer's own seat and for seats that showed down.
 *
 * The hole-card rule is the `case` in this SQL, and nothing else here selects `hole_cards`. Filtered
 * in SQL, the cards never reach the process, so a caller cannot leak what it was never given.
 *
 * - `s.user_id is not null` states that a seat whose account was deleted never matches a viewer.
 * - `${viewerUserId}::text` lets a null viewer bind, and match no seat.
 * - `showed_down` first, because shown cards are public to the table.
 */
export async function seatsOf(
  sql: Db,
  handId: string,
  viewerUserId: string | null,
): Promise<readonly HandSeatView[]> {
  const rows = await sql<
    {
      seat: number;
      user_id: string | null;
      display_name: string | null;
      is_bot: boolean;
      starting_stack: number;
      net_result: number | null;
      status: SeatStatus;
      showed_down: boolean;
      hole_cards: unknown;
    }[]
  >`
    select s.seat,
           s.user_id,
           u.display_name,
           s.is_bot,
           s.starting_stack,
           s.net_result,
           s.status,
           s.showed_down,
           case
             when s.showed_down then s.hole_cards
             when s.user_id is not null and s.user_id = ${viewerUserId}::text then s.hole_cards
             else null
           end as hole_cards
      from prl.hand_seats s
      left join prl.users u on u.id = s.user_id
     where s.hand_id = ${handId}
     order by s.seat
  `;
  return rows.map((row) => ({
    seat: row.seat,
    userId: row.user_id,
    displayName: row.display_name,
    isBot: row.is_bot,
    startingStack: row.starting_stack,
    netResult: row.net_result,
    status: row.status,
    showedDown: row.showed_down,
    holeCards: holeCardsFrom(row.hole_cards),
  }));
}

export interface ListHandsInput {
  readonly userId: string;
  readonly roomId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListHandsResult {
  readonly hands: readonly HandListItem[];
  readonly nextCursor: string | null;
}

/**
 * The learner's own hand history, newest first, keyset paginated on `(started_at, id)`.
 *
 * Keyset keeps page cost constant and stops a new hand shifting later pages. `id` breaks ties on
 * `started_at`. `pot_total` and `ended_by_fold` are extracted in SQL so the list does not ship each
 * full `HandResult`. The sum is cast to `int` because postgres.js returns `bigint` as a string.
 */
export async function listForUser(sql: Db, input: ListHandsInput): Promise<ListHandsResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = input.cursor === undefined ? null : decodeHandCursor(input.cursor);
  const roomId = input.roomId ?? null;
  const rows = await sql<
    {
      id: string;
      room_id: string;
      hand_number: number;
      started_at: Date;
      completed_at: Date | null;
      board: unknown;
      hero_net: number | null;
      ended_by_fold: boolean;
      pot_total: number;
    }[]
  >`
    select h.id,
           h.room_id,
           h.hand_number,
           h.started_at,
           h.completed_at,
           h.board,
           s.net_result as hero_net,
           coalesce((h.result -> 'endedByFold')::boolean, false) as ended_by_fold,
           -- Every step here is guarded by a jsonb_typeof, and not out of politeness: a
           -- set-returning function handed a scalar raises "cannot extract elements from a
           -- scalar", so an unexpected result shape on one old row would fail the whole history
           -- page rather than just that row's pot size.
           coalesce(
             (select sum(
                       case when jsonb_typeof(pot -> 'amount') = 'number'
                            then (pot ->> 'amount')::int
                            else 0
                       end
                     )::int
                from jsonb_array_elements(
                       case when jsonb_typeof(h.result -> 'pots') = 'array'
                            then h.result -> 'pots'
                            else '[]'::jsonb
                       end
                     ) as pots(pot)),
             0
           ) as pot_total
      from prl.hand_seats s
      join prl.hands h on h.id = s.hand_id
     where s.user_id = ${input.userId}
       and (${roomId}::text is null or h.room_id = ${roomId})
       and (
             ${cursor === null}::boolean
             or (h.started_at, h.id) < (${cursor?.startedAt ?? null}::timestamptz, ${cursor?.id ?? ''}::text)
           )
     order by h.started_at desc, h.id desc
     limit ${limit + 1}
  `;

  // The extra row only signals a next page.
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeHandCursor(last.started_at, last.id) : null;

  return {
    hands: page.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      handNumber: row.hand_number,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      board: cardNotationArray(row.board),
      heroNet: row.hero_net,
      endedByFold: row.ended_by_fold,
      potTotal: row.pot_total,
    })),
    nextCursor,
  };
}

interface HandCursor {
  readonly startedAt: Date;
  readonly id: string;
}

/**
 * `<epoch milliseconds>:<hand id>`. Unsigned, because the query re-checks the viewer on every page.
 * Must fit `handListQuerySchema`'s `^[A-Za-z0-9_:.-]{1,128}$`.
 */
export function encodeHandCursor(startedAt: Date, id: string): string {
  return `${startedAt.getTime()}:${id}`;
}

/**
 * Strict, so a malformed cursor is `invalid_request` rather than a silent first page. The digits-only
 * pattern runs before `Number` because `Number('')` is 0, which turned `":hand_abc"` into the whole
 * history. It also refuses `" 12"`, `"0x10"` and `"1e3"`.
 */
export function decodeHandCursor(cursor: string): HandCursor {
  const match = /^(\d{1,15}):([a-z0-9][a-z0-9_-]{0,63})$/.exec(cursor);
  const millis = match === null ? Number.NaN : Number(match[1]);
  const id = match?.[2];
  if (id === undefined || !Number.isSafeInteger(millis)) {
    throw new AppError('invalid_request', {
      fields: { cursor: 'is not a cursor from a previous page' },
      logDetail: 'rejected a malformed hand-history cursor',
    });
  }
  return { startedAt: new Date(millis), id };
}

/** `cardToString` rejects a non-card. */
function notationJson(cards: readonly Card[]): string {
  return jsonbText(
    cards.map((card) => cardToString(card)),
    'cards',
  );
}

function notationJsonOrNull(cards: readonly Card[] | null): string | null {
  return cards === null ? null : notationJson(cards);
}

/**
 * A jsonb card array, validated on the way out rather than asserted, because an old row or a
 * restored dump may predate the constraint. Exported because the jsonb columns are typed `unknown`.
 */
export function cardNotationArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  // `Array.isArray` narrows to `any[]`, so re-bind before reading.
  const entries: readonly unknown[] = value;
  const cards: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && CARD_NOTATION.test(entry)) cards.push(entry);
  }
  return cards;
}

/**
 * Null stays null, because "redacted" and "dealt nothing" differ. Anything but exactly two valid
 * cards becomes null, so a UI never renders a partial holding.
 */
function holeCardsFrom(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  const cards = cardNotationArray(value);
  return cards.length === 2 ? cards : null;
}

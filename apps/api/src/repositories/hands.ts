/**
 * `prl.hands`, `prl.hand_seats`, `prl.hand_actions` — what was dealt, who did what, who won.
 *
 * ############################################################################
 * ## THE DECK AND THE COMMITMENT SALTS ARE NEVER WRITTEN HERE               ##
 * ############################################################################
 *
 * There is no column for either, and this file is the only place that could try. `start`
 * receives the board and the hole cards and nothing else; it never sees `HandState.deck`,
 * `deckCursor` or `deckSalts`, because those are the hand's secrets and they die with the
 * process. The one thing that *is* persisted before the hand is the Merkle root, which is a
 * commitment: it proves the deck order was fixed before the first action without revealing a
 * single card.
 *
 * `complete` is where that promise could be broken, so it is checked rather than trusted. A
 * `DeckReveal` with `complete: true`, or one carrying more than the 17 cards that can
 * legitimately become public (5 board + 2 hole cards for each of at most 6 seats), is refused
 * before it reaches SQL — see `assertRevealIsSafe`. Migration 0001 has the same two rules as
 * CHECK constraints; having them in both places means neither a bug here nor a hand-written
 * `UPDATE` can persist a whole-deck dump, and the failure happens at the boundary with a
 * readable log line rather than as an opaque constraint violation.
 *
 * The accepted consequence, stated in the migration and repeated here so nobody treats it as a
 * bug to fix: an interrupted hand cannot be resumed from the database after a restart. Losing
 * an in-flight hand is far cheaper than a schema that can leak cards nobody was entitled to see.
 *
 * ## Hole cards leave through exactly one projection
 *
 * `seatsOf` takes a viewer and the SQL decides, per row, whether `hole_cards` comes back at all.
 * Nothing else in this file selects that column. See the long comment on `seatsOf`.
 *
 * ## Cards cross this boundary in two different shapes, on purpose
 *
 * Writes take the engine's integer `Card` values and format them with `cardToString`, so there
 * is exactly one place a card is turned into the `"Ah"` notation the columns hold and
 * `prl.is_card_notation_array` validates. Reads return the notation, because that is what the
 * column contains and also exactly what `HandSummary.board` and `HandReviewSeat.holeCards` put
 * on the wire — parsing to integers and formatting again would be work in service of nothing.
 */

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
import { cardToString } from '@prl/poker-engine';
import { AppError } from '../errors.ts';
import { newHandActionId, newHandSeatId } from './ids.ts';
import { type Db, jsonbText, violationError } from './sql.ts';

/**
 * The most cards a hand's reveal may prove, from migration 0001:
 *
 *     5 board cards + 2 hole cards x 6 seats = 17
 *
 * There are no burn cards — the machine advances the board straight off the deck cursor — so
 * nothing else can legitimately be in there.
 */
export const MAX_PUBLIC_REVEALED_CARDS = 17;

/** `prl.is_card_notation_array`'s per-element rule, so a read can check what it got. */
const CARD_NOTATION = /^[2-9TJQKA][cdhs]$/;

/** Default page size for hand history, and the ceiling `handListQuerySchema` also enforces. */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export type RandomSourceKind = 'csprng' | 'deterministic-test-only' | 'fixed-deck-scenario';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

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

/**
 * One seat of one hand, as `seatsOf` returns it.
 *
 * `holeCards` is `null` whenever the viewer is not entitled to it. That is not a convention the
 * caller has to honour — it is what the query returned, and the column was never read for the
 * rows it does not apply to.
 */
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
}

/** A row of the hand-history list, with the viewer's own net and the pot size already summed. */
export interface HandListItem {
  readonly id: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly board: readonly string[];
  /** The viewer's net for this hand, or null while the hand is unsettled. */
  readonly heroNet: number | null;
  readonly endedByFold: boolean;
  readonly potTotal: number;
}

// ---------------------------------------------------------------------------
// Starting a hand
// ---------------------------------------------------------------------------

export interface StartHandSeatInput {
  readonly seat: number;
  /** Null only for a seat whose account was deleted; live hands always have one. */
  readonly userId: string | null;
  readonly isBot: boolean;
  readonly startingStack: number;
  /**
   * The two cards dealt to this seat, as engine integers. Null for a seat sitting out, which is
   * why the column is nullable: a seat that was never dealt in has no cards, and a placeholder
   * empty array would be a seat that was dealt nothing.
   */
  readonly holeCards: readonly Card[] | null;
  readonly status: SeatStatus;
}

export interface StartHandInput {
  /** Minted by the caller before the engine ran: `handId` is inside the commitment context. */
  readonly handId: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly buttonSeat: number;
  /** Snapshotted per hand. The room's settings may change; a played hand must not. */
  readonly config: TableConfig;
  readonly commitmentRoot: string;
  readonly commitmentContext: string;
  readonly randomSourceKind: RandomSourceKind;
  readonly seats: readonly StartHandSeatInput[];
}

/**
 * Writes the hand and its seats.
 *
 * **Call this inside `withTransaction`.** A hand row with no seats is a hand nobody was dealt
 * into, and a partial set of seats is worse — the engine's view and the database's would
 * disagree about who is in the hand. Taking `Db` rather than opening its own transaction is what
 * lets the caller put the deal, the room status change and the first broadcast in one unit.
 *
 * The board starts empty and the street starts `preflop`, both as literals rather than
 * parameters: there is no legal way to start a hand at the turn, and a caller that wanted to
 * would be describing a hand the engine never dealt.
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

    // One statement per seat rather than a multi-row VALUES list. Six inserts inside a
    // transaction that is already open cost six pipelined round trips, and in exchange every
    // insert is a plain parameterised template that reads exactly like the others in this file —
    // no driver helper deciding the column order, no array-of-arrays to line up with it.
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
 * The next hand number for a room.
 *
 * `max(hand_number) + 1` is safe *because* `hands_room_hand_number_key` is unique: a concurrent
 * second deal that computed the same number fails on the index instead of creating a duplicate,
 * and `sql.ts` maps that violation to `stale_action_sequence`. Without the index this would be a
 * classic read-modify-write race; with it, the racy read is fine because the write is the
 * arbiter.
 */
export async function nextHandNumber(sql: Db, roomId: string): Promise<number> {
  const rows = await sql<{ next: number }[]>`
    select coalesce(max(hand_number), 0)::int + 1 as next from prl.hands where room_id = ${roomId}
  `;
  return rows[0]?.next ?? 1;
}

/**
 * The id of the room's hand in progress, or null.
 *
 * Served by `hands_live_by_room_idx`, which is partial on `completed_at IS NULL` so it stays
 * tiny however long the history grows. There is at most one such hand; `limit 1` is belt and
 * braces, and an ordering by `hand_number desc` makes which one deterministic if a bug ever left
 * two behind.
 */
export async function activeHandIdForRoom(sql: Db, roomId: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    select id from prl.hands
     where room_id = ${roomId} and completed_at is null
     order by hand_number desc
     limit 1
  `;
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface AppendActionInput {
  readonly handId: string;
  readonly sequence: number;
  readonly street: BettingStreet;
  readonly seat: number;
  readonly actionType: ActionType;
  /**
   * "Raise to" semantics: the seat's TOTAL commitment for the street after the action, not the
   * increment. Must be present for `bet` and `raise` and absent otherwise —
   * `hand_actions_sizing_iff_bet_or_raise`.
   */
  readonly actionTo: number | null;
  readonly amountPaid: number;
  readonly betLevelAfter: number;
  readonly potAfter: number;
  /** True when the server acted for a player whose timer expired. */
  readonly wasAutomatic: boolean;
  /**
   * The client's own id for this decision, stable across retries, or null for a server-generated
   * automatic action. Null is what puts the row outside the partial unique index, which is
   * correct: there may be many automatic actions in one hand and none of them is a retry.
   */
  readonly actionId: string | null;
}

export interface AppendActionResult {
  /** False when this exact `actionId` was already recorded for this hand. */
  readonly applied: boolean;
  /** The row id, present only when this call wrote it. */
  readonly id: string | null;
}

/**
 * Appends one action, at most once per client `actionId`.
 *
 * ############################################################################
 * ## THIS IS THE IDEMPOTENCY GUARANTEE, AND IT IS ONE STATEMENT             ##
 * ############################################################################
 *
 * A duplicated "raise to 400" is not a duplicated row. It is chips leaving a player's stack
 * twice. No application-level check-then-insert can prevent it, because the check and the insert
 * are two statements and the race lives between them — two requests carrying the same
 * `actionId` on two different pooled connections can both pass every check.
 *
 * `on conflict (hand_id, action_id) where action_id is not null do nothing` closes that in one
 * statement: whichever insert arrives second writes nothing and returns no rows, and this
 * function reports `applied: false` so the caller answers with the current state rather than
 * applying the action again. `WsActionAckMessage.deduplicated` exists for exactly this answer.
 *
 * ## Why the conflict target is named rather than left bare
 *
 * `on conflict do nothing` with no target swallows *every* unique violation on the table,
 * including `hand_actions_hand_sequence_key`. That one means something entirely different — two
 * actions claimed the same sequence, so one of them was decided against a view of the hand that
 * no longer exists — and reporting it as a harmless duplicate would apply an action to a spot the
 * player never saw. Naming the target lets that violation escape, where `sql.ts` turns it into
 * `stale_action_sequence`. The `where` clause is required for Postgres to infer a partial index.
 */
export async function appendAction(sql: Db, input: AppendActionInput): Promise<AppendActionResult> {
  const isSized = input.actionType === 'bet' || input.actionType === 'raise';
  if (isSized !== (input.actionTo !== null)) {
    // `hand_actions_sizing_iff_bet_or_raise` would refuse this anyway; refusing here names the
    // problem instead of surfacing a constraint name, and cannot be mistaken for a race.
    throw new AppError('internal_error', {
      logDetail: `action ${input.actionType} carried actionTo=${String(input.actionTo)}`,
    });
  }
  const id = newHandActionId();
  try {
    const rows = await sql<{ id: string }[]>`
      insert into prl.hand_actions (
        id, hand_id, sequence, street, seat, action_type, action_to,
        amount_paid, bet_level_after, pot_after, was_automatic, action_id
      )
      values (
        ${id}, ${input.handId}, ${input.sequence}, ${input.street}, ${input.seat},
        ${input.actionType}, ${input.actionTo}, ${input.amountPaid}, ${input.betLevelAfter},
        ${input.potAfter}, ${input.wasAutomatic}, ${input.actionId}
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

/** Every action of a hand, in order. The replay. */
export async function actionsOf(sql: Db, handId: string): Promise<readonly HandActionRow[]> {
  const rows = await sql<HandActionRow[]>`
    select sequence, street, seat, action_type, action_to, amount_paid, bet_level_after,
           pot_after, was_automatic
      from prl.hand_actions
     where hand_id = ${handId}
     order by sequence
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Advancing and settling
// ---------------------------------------------------------------------------

/**
 * Records a street change and the board as it now stands.
 *
 * `'complete'` is deliberately not accepted. `hands_completed_iff_street_complete` pairs that
 * street with `completed_at`, and `hands_result_iff_completed` pairs `completed_at` with the
 * result — so finishing a hand is one statement that sets all three, which is `complete()`.
 * Allowing `'complete'` here would let a hand sit in the table looking finished to one query and
 * live to another.
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
  /** Chips won minus chips committed, for this seat in this hand. May be negative. */
  readonly netResult: number;
  readonly status: SeatStatus;
  /**
   * True only for a seat that actually showed at showdown. This flag is what opens `hole_cards`
   * to every player at the table, so it is set from `HandResult.showdowns` and from nothing else
   * — a seat that folded is not "showing" merely because the hand is over.
   */
  readonly showedDown: boolean;
}

export interface CompleteHandInput {
  readonly handId: string;
  readonly board: readonly Card[];
  readonly result: HandResult;
  readonly seats: readonly CompleteSeatInput[];
}

/**
 * Settles a hand: the result, the reveal, the final board, and every seat's net.
 *
 * **Call this inside `withTransaction`.** A hand marked complete whose seats still have
 * `net_result IS NULL` is a hand that finished without paying anybody.
 *
 * The reveal is written twice, once as `prl.hands.reveal` and once inside `result`, because that
 * is what the schema describes and both copies have their own pair of CHECK constraints. Both
 * copies go through the same guard first.
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
      // Already settled, or no such hand. Either way the caller is acting on a hand that is not
      // in progress, which is precisely what `hand_not_active` says.
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
 * Refuses a reveal that would expose more than the hand made public.
 *
 * Two checks, matching the two CHECK constraints on `prl.hands`, and both are about the same
 * attack: a reveal that carries every leaf — every card *and* every salt — is a dump of the whole
 * deck, including the hole cards of everyone who folded. Whether a player folded a bluff or a
 * monster is the information the game is played over, and the commitment scheme exists so that
 * publishing a proof does not publish that.
 *
 * `complete` is the flag `revealPositions()` sets when it revealed all 52 positions, and the
 * count is the arithmetic ceiling on what can legitimately be public. Checking both means a
 * reveal cannot get through by lying about one of them.
 *
 * Raised as `internal_error`: reaching this is a bug in the settlement path, not something a
 * client did, so the client learns nothing and the log gets the whole story.
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One hand, if the viewer is entitled to it.
 *
 * The entitlement is in the WHERE clause, not in the caller. A hand is visible to somebody who
 * had a seat in it, or who is a member of its room — that second arm is what lets a player who
 * sat down after hand 3 still review hand 3 at their own table. Everyone else gets null, and the
 * caller answers `hand_not_found`: an id that exists but is not yours must be indistinguishable
 * from an id that does not exist, or the endpoint becomes a way to confirm which hand ids are
 * real.
 *
 * Membership is checked without the `left_at IS NULL` predicate on purpose. Somebody who has left
 * the table keeps access to the history of the hands they were there for, and
 * `room_members_user_id_idx` is deliberately non-partial so this stays an index scan.
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
 * ############################################################################
 * ## THE HOLE-CARD RULE IS THIS `CASE`, AND IT IS IN THE SQL                ##
 * ############################################################################
 *
 * `prl.hand_seats.hole_cards` has a column comment that says it "MUST only ever be SELECTed for
 * the owning user, or for any user once showed_down is true", and that there is no way to express
 * that as a constraint. This projection is where it is expressed:
 *
 * ```sql
 * case
 *   when s.showed_down then s.hole_cards
 *   when s.user_id is not null and s.user_id = $viewer then s.hole_cards
 *   else null
 * end as hole_cards
 * ```
 *
 * The rule lives in the query and not in a `.map()` afterwards, and the difference is not
 * stylistic. A repository that selected every seat's cards and trusted the caller to filter has
 * already lost: the cards are in the process, in the driver's row buffer, in whatever the caller
 * logs when debugging, and in the response the day somebody adds a field to the serialiser. One
 * forgotten `.filter()` in one route is a total loss of hidden information for every hand ever
 * played. Filtered in SQL, the bytes never leave Postgres, and a caller *cannot* leak what it was
 * never given.
 *
 * Three details that are load-bearing:
 *
 * - `s.user_id is not null` before the comparison. It is redundant to Postgres — `NULL = 'usr_x'`
 *   is NULL, which is not true, so a detached seat never matches — but it states the intent, and
 *   the intent is the thing a future edit could break. A seat whose account was deleted has
 *   `user_id IS NULL`, and a viewer must never inherit its cards.
 * - `${viewerUserId}::text`. Without the cast Postgres cannot infer the type of a parameter that
 *   appears only in a comparison, and passing null for an unauthenticated viewer would error.
 *   With it, a null viewer matches no seat and sees only what showed down.
 * - `showed_down` is checked first and on its own. Once a seat has shown at showdown its cards
 *   are public to the table, which is the whole reason
 *   `hand_seats_showdown_requires_hole_cards` exists — a seat cannot claim to have shown cards
 *   it has no record of holding.
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
  /** Narrows to one table. Omit for every hand the learner has played. */
  readonly roomId?: string;
  readonly limit?: number;
  /** Opaque, from a previous page's `nextCursor`. */
  readonly cursor?: string;
}

export interface ListHandsResult {
  readonly hands: readonly HandListItem[];
  /** Null when this was the last page. */
  readonly nextCursor: string | null;
}

/**
 * The learner's own hand history, newest first, cursor paginated.
 *
 * ## Keyset, not OFFSET
 *
 * `offset n` re-reads and discards n rows on every page, so page 40 costs forty times page 1, and
 * a hand dealt while the learner is reading shifts every subsequent page by one — which shows up
 * as a duplicated or skipped hand. The cursor here is `(started_at, id)`, compared as a row:
 * `(h.started_at, h.id) < ($ts, $id)`. Constant cost per page, and a hand arriving mid-read
 * cannot move anything already seen.
 *
 * `id` is in the key because `started_at` is not unique — two rooms can deal at the same
 * millisecond — and a keyset on a non-unique column silently drops the rows that tie with the
 * page boundary.
 *
 * ## What is computed in SQL and why
 *
 * `pot_total` and `ended_by_fold` come out of the `result` jsonb here rather than by shipping the
 * whole document to the caller. A settled `HandResult` carries every showdown, every pot layer,
 * every award and a full `DeckReveal` with its proofs; sending all of that so a list view can
 * render one number would be kilobytes per row, on a page of fifty.
 *
 * The sum is cast to `int` because `sum()` over `int` is `bigint`, which postgres.js returns as a
 * *string* to protect precision — a `potTotal` that is sometimes `90` and sometimes `"90"` is a
 * bug waiting in the JSON response.
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

  // One extra row is fetched to learn whether there is a next page, then dropped. The
  // alternative — a `count(*)` over the whole history — is a second query that reads everything
  // to answer a question worth one row.
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

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

interface HandCursor {
  readonly startedAt: Date;
  readonly id: string;
}

/**
 * `<epoch milliseconds>:<hand id>`.
 *
 * Not base64 and not signed, because there is nothing in it to hide or protect: both halves come
 * from a row the caller was just shown, and the query re-checks `s.user_id = $viewer` on every
 * page, so a forged cursor can only ever move somebody around inside their own history. What the
 * format does have to be is inside `handListQuerySchema`'s `^[A-Za-z0-9_:.-]{1,128}$` — digits, a
 * colon, and an id of lowercase letters, digits and underscore all qualify.
 */
export function encodeHandCursor(startedAt: Date, id: string): string {
  return `${startedAt.getTime()}:${id}`;
}

/**
 * Parses a cursor, or rejects it.
 *
 * Strict rather than forgiving. A cursor that half-parses would silently return the first page
 * again, which reads as "pagination is broken" and is very hard to reproduce; `invalid_request`
 * with the field named is a bug report that fixes itself.
 *
 * The timestamp half is matched against a digits-only pattern *before* `Number` sees it, and that
 * is not belt and braces — it is the fix for a bug this function had. `Number('')` is `0`, not
 * `NaN`, so a cursor of `":hand_abc"` with no timestamp at all passed an `Number.isSafeInteger`
 * check and silently became "everything since the epoch", which is the whole history. The same
 * trap catches `" 12"`, `"0x10"` and `"1e3"`, all of which `Number` happily accepts.
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

// ---------------------------------------------------------------------------
// Card notation at the boundary
// ---------------------------------------------------------------------------

/** Engine integers to the JSON array the columns hold. `cardToString` rejects a non-card. */
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
 * A jsonb card array, validated on the way out.
 *
 * Exported because `HandRow.board`, `HandRow.result` and `HandRow.reveal` are typed `unknown` — the
 * driver hands back parsed jsonb and there is nothing at the type level to say what it parsed — so
 * every caller that wants the board needs this, and reinventing it per caller is how one of them
 * ends up trusting the column.
 *
 * `prl.is_card_notation_array` already guarantees the shape, so this could be a type assertion —
 * and is not, deliberately. `unknown` to a concrete type is exactly the boundary where an
 * assertion is a promise nobody checks: a row written before a constraint existed, a restored
 * dump, a future migration that relaxes something, and suddenly `board.map(...)` is operating on
 * whatever is there. Filtering costs one pass over at most five elements and the type is then
 * true rather than asserted.
 */
export function cardNotationArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  // Re-bound as `readonly unknown[]`, because `Array.isArray` narrows to `any[]` and letting
  // `any` out of this function would defeat the point of validating at all.
  const entries: readonly unknown[] = value;
  const cards: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && CARD_NOTATION.test(entry)) cards.push(entry);
  }
  return cards;
}

/**
 * Hole cards, or null.
 *
 * Null in, null out — that is the redacted case from `seatsOf`, and it must stay null rather than
 * becoming an empty array, because "you may not see these" and "this seat was dealt nothing" are
 * different facts. Anything that is not exactly two valid cards also becomes null: a partial
 * holding is not something to hand to a UI that will happily render one card.
 */
function holeCardsFrom(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  const cards = cardNotationArray(value);
  return cards.length === 2 ? cards : null;
}

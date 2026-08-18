/**
 * Hand history and hand review: `GET /hands` and `GET /hands/:handId`.
 *
 * Two reads, both scoped to the caller by a SQL predicate rather than by a check afterwards.
 * `prl.hand_seats` is the join that decides what "my hands" means — a hand is the caller's when
 * they held a seat in it — and every query below starts from that table with
 * `s.user_id = <caller>` in the `where` clause. A filter applied after the rows are fetched is one
 * `return` away from being skipped; a filter in the predicate cannot be.
 *
 * ## The two answers a stranger gets are the same answer
 *
 * `GET /hands/:handId` matches the hand and the caller's seat in one statement. No row means
 * `hand_not_found`, whether the hand does not exist, belongs to somebody else, or was never
 * dealt. A distinguishable "it exists but you may not see it" would confirm a hand id for anyone
 * who cared to try, and hand ids appear in URLs that get shared.
 *
 * ## Hole cards are filtered in the SQL, and again in the review builder
 *
 * The column comment on `prl.hand_seats.hole_cards` requires every read path to carry
 * `user_id = :viewer OR showed_down`. The seat query below does exactly that, so the rows this
 * process holds never contain a card the caller may not see. `buildHandReview` then applies the
 * same rule a second time while constructing the response. Two layers, deliberately redundant:
 * the first is a SQL predicate somebody could edit while refactoring, and the second is a
 * property of the type that reaches the wire.
 *
 * ## Ordering is a server parameter, because only the server can honour it
 *
 * `GET /hands?sort=` takes one of the five names in `HAND_SORTS` and applies it in SQL over the
 * caller's whole history before the page is cut. That is not a convenience: the hand-history
 * screen offers "biggest gain first", and a client holding six rows cannot produce that ordering
 * — it can only reorder the six it has, under a heading that then means something else. The
 * screen used to send `sort=` into a closed schema and get `invalid_request`, then stopped
 * sending it and left the control offering four orderings nothing performed.
 *
 * The five clauses live in `HAND_ORDERINGS` and are written out in full. Nothing a caller sends
 * reaches SQL as text; `sort` selects a member of a table whose keys are the contract's own enum.
 *
 * ## Why the review is rate limited as an expensive route
 *
 * Nothing derived is stored (decision 7 in `db/migrations/0001_initial.sql`), so every read
 * recomputes the analysis: a six-handed preflop decision costs a bounded Monte Carlo run. Under
 * the global limit a single session could ask for three hundred of those a minute. `GET /hands`
 * is a cheap list and keeps the global limit; `GET /hands/:handId` takes
 * `app.expensiveRateLimit`, the same bucket the equity endpoints use, because it does the same
 * kind of work.
 *
 * ## Where the queries live, and the duplication that is deliberately still here
 *
 * As local functions in this file, taking the `Db` handle first, exactly as `src/repositories/*`
 * does.
 *
 * `src/repositories/hands.ts` HAS since grown equivalents — `byId`, `seatsOf`, `actionsOf`,
 * `listForUser`, `encodeHandCursor`, `decodeHandCursor` — written independently of these. They are
 * not interchangeable, and until somebody decides which behaviour is wanted they must not be
 * swapped in blindly, because the two versions disagree twice and in opposite directions:
 *
 * 1. **Who may read a hand.** `findOwnHand` below requires the caller to have *held a seat*.
 *    `repositories/hands.ts :: byId` also admits any *member of the room*, so that somebody who
 *    sat down after hand 3 can review hand 3. Both are defensible and the second is strictly
 *    wider, so adopting it is a deliberate widening of an authorisation boundary — a product
 *    decision, not a refactor. Hole cards stay filtered either way.
 * 2. **Pagination.** The cursor here carries `started_at` to microseconds, on purpose (see
 *    `STARTED_AT_KEY_PATTERN`). `encodeHandCursor` truncates to milliseconds via `getTime()`,
 *    which compares as *earlier* than the row it names and so returns that row again on the next
 *    page. This version is the correct one.
 *
 * The hole-card rule is identical in both (`user_id = :viewer OR showed_down`, in the SQL), so
 * neither choice affects what cards leave the database. Whoever unifies them owns picking one
 * answer for (1) and keeping (2).
 */

import type { HandListResponse, HandReviewResponse, HandSort } from '@prl/contracts';
import { DEFAULT_HAND_SORT, HAND_SORTS, PATTERNS } from '@prl/contracts';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireSession } from '../auth/session.ts';
import { getSql } from '../db.ts';
import { AppError } from '../errors.ts';
import type { Db } from '../repositories/sql.ts';
import type { HandActionRow, HandRow, HandSeatRow } from '../review/build-review.ts';
import { buildHandReview, toHandSummary } from '../review/build-review.ts';

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** Rows per page when the caller does not ask. `handListQuerySchema` caps the ask at 50. */
const DEFAULT_PAGE_SIZE = 20;

/**
 * The shape of the sort key the list query renders.
 *
 * `started_at` is a `timestamptz` with microsecond resolution, and the cursor has to carry all of
 * it. A key truncated to milliseconds compares as *earlier* than the row it names, so that row
 * comes back a second time on the next page — a duplicate rather than a gap, but wrong either
 * way. The key is therefore rendered by Postgres with `to_char(... 'US' ...)` (see `listHands`)
 * and compared back as a `timestamptz` bind parameter, which keeps the value exactly as stored
 * and keeps the comparison usable by an index.
 */
const STARTED_AT_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** The contract's own id rule, reused rather than copied, so the two cannot drift. */
const ID_PATTERN = new RegExp(PATTERNS.ID);

/** `YYYY-MM-DDTHH:MM:SS.ffffffZ` is exactly 27 characters, which is what makes the cursor parseable. */
const STARTED_AT_KEY_LENGTH = 27;

/** The sort key of an ordering that has one, as it appears in a cursor. `null` is a real value. */
const SORT_VALUE_PATTERN = /^(?:null|-?\d{1,15})$/;

export interface HandCursor {
  readonly handId: string;
  readonly startedAtKey: string;
  /**
   * The ordering this cursor was issued for, when that ordering needs more than a timestamp.
   *
   * Absent for `recent` and `oldest`, whose whole sort key IS `(started_at, id)` — so the
   * two-part cursor this endpoint has always issued keeps working unchanged, which is the
   * reason the extension is a suffix rather than a new format.
   */
  readonly sort?: HandSort;
  /**
   * The value of that ordering's leading column on the row this cursor names.
   *
   * `null` is a value and not a missing one: an unsettled hand has no net and no pot, and it
   * sorts into the block at the end of every ordering that names one. A cursor sitting in that
   * block has to say so, or the next page starts from the wrong place.
   */
  readonly sortValue?: number | null;
}

/**
 * `<handId>:<startedAtKey>`, plus `:<sort>:<value>` for an ordering that needs one.
 *
 * The id goes first because it is the half that cannot contain a colon (`PATTERNS.ID` has no
 * `:`), while the timestamp has two. So the separator is the first colon, unambiguously — the
 * other way round would need a rule about which colon counts. The timestamp is a fixed 27
 * characters, so whatever follows it is unambiguous too.
 *
 * The ordering's NAME is in the cursor, not just its value. A cursor minted for `net-high` and
 * replayed against `net-low` would otherwise be accepted and would silently return a page from
 * the middle of a different sequence; naming it makes that a `400` instead.
 *
 * Exported, with `decodeCursor`, so `test/hands.test.ts` can prove the round trip and the
 * rejections without a database. Neither is part of the HTTP contract: to a client the cursor is
 * an opaque string it hands back unchanged.
 */
export function encodeCursor(cursor: HandCursor): string {
  const base = `${cursor.handId}:${cursor.startedAtKey}`;
  if (cursor.sort === undefined) return base;
  return `${base}:${cursor.sort}:${cursor.sortValue === null || cursor.sortValue === undefined ? 'null' : String(cursor.sortValue)}`;
}

/** The one refusal this module gives for anything about a cursor that does not add up. */
function rejectCursor(detail: string): never {
  throw new AppError('invalid_request', {
    fields: { 'query.cursor': 'is not a cursor this endpoint issued' },
    logDetail: `hand list cursor rejected: ${detail}`,
  });
}

/**
 * Parses a cursor, or rejects it as `invalid_request`.
 *
 * Strictly checked even though every part becomes a bind parameter and could not be SQL whatever
 * it contained. A cursor is an opaque token this server minted; one that does not look like one
 * has been edited, and answering a tampered cursor with a page of somebody's history — or with a
 * confusing empty page — is worse than saying no.
 */
export function decodeCursor(raw: string): HandCursor {
  const separator = raw.indexOf(':');
  if (separator === -1) rejectCursor('no separator');
  const handId = raw.slice(0, separator);
  const rest = raw.slice(separator + 1);
  const startedAtKey = rest.slice(0, STARTED_AT_KEY_LENGTH);
  if (!ID_PATTERN.test(handId) || !STARTED_AT_KEY_PATTERN.test(startedAtKey)) {
    rejectCursor('id or timestamp did not parse');
  }

  const suffix = rest.slice(STARTED_AT_KEY_LENGTH);
  if (suffix === '') return { handId, startedAtKey };
  if (!suffix.startsWith(':')) rejectCursor('trailing characters after the timestamp');

  const [sortName, sortValue, ...extra] = suffix.slice(1).split(':');
  if (extra.length > 0 || sortName === undefined || sortValue === undefined) {
    rejectCursor('sort suffix is not <sort>:<value>');
  }
  const sort = HAND_SORTS.find((candidate) => candidate === sortName);
  if (sort === undefined) rejectCursor(`unknown ordering "${sortName}"`);
  if (!SORT_VALUE_PATTERN.test(sortValue)) rejectCursor('sort value is not a number or null');
  return { handId, startedAtKey, sort, sortValue: sortValue === 'null' ? null : Number(sortValue) };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * A row of the caller's own hand history.
 *
 * Columns are listed rather than `select *`: a column added by a later migration must not start
 * crossing this boundary because somebody widened a table. Note what is absent —
 * `hand_seats.hole_cards` is never projected here at all. A list of forty hands has no use for a
 * card, and a query that does not select one cannot leak one.
 */
interface HandListRow {
  readonly id: string;
  readonly room_id: string;
  readonly hand_number: number;
  readonly board: unknown;
  readonly result: unknown;
  readonly street: string;
  readonly started_at: Date | string;
  readonly completed_at: Date | string | null;
  readonly started_at_key: string;
  readonly hero_net: number | null;
  readonly max_pot_after: number | null;
}

interface HandListQuery {
  readonly userId: string;
  readonly roomId: string | null;
  readonly cursor: HandCursor | null;
  readonly sort: HandSort;
  /** How many rows to return. One more than this is fetched, to learn whether a page follows. */
  readonly limit: number;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * One ordering: the `order by` it renders, the keyset predicate that resumes it, and how to read
 * the key off a row so the next cursor can name it.
 *
 * ## No column name and no direction is ever interpolated
 *
 * Each clause is written out in full inside a `sql` template, and the table below is annotated
 * `Readonly<Record<HandSort, HandOrdering>>` — so an ordering the contract names without a clause
 * here does not compile, and there is no code path that turns a caller's string into SQL. The
 * caller's `sort` only ever selects a member of this table; `handListQuerySchema` has already
 * rejected anything that is not one of the five names.
 *
 * ## Why the tiebreak follows the primary direction
 *
 * Every clause ends `started_at, id` in the SAME direction as its leading column, and that is
 * load-bearing rather than tidy. The keyset predicate is a single row comparison — `(net,
 * started_at, id) < (…)` — and a row comparison applies ONE direction to the whole tuple. An
 * ordering that sorted net ascending and time descending could not be resumed by any row
 * comparison, so the page after the cursor would quietly not be the page after the cursor.
 *
 * ## Nulls
 *
 * `nulls last` in every ordering that names a nullable column. An unsettled hand has no net and
 * a hand with no recorded action has no pot; sorting either as zero would state a result it does
 * not have. A cursor that lands inside that trailing block carries `sortValue: null` and resumes
 * with the timestamp tiebreak alone, which is the only order that exists in there.
 */
/**
 * What a `sql` template evaluates to, and therefore what may be embedded in another one.
 *
 * Named through `ReturnType` rather than imported: the driver's fragment type is an internal
 * name, and writing it out here would pin this file to a shape the package is free to rename.
 */
type SqlFragment = ReturnType<Db>;

interface HandOrdering {
  /** True when a cursor for this ordering must carry a sort value beyond the timestamp. */
  readonly keyed: boolean;
  /** The ordering's leading value on a row, for minting the next cursor. */
  readonly keyOf: (row: HandListRow) => number | null;
  readonly orderBy: (sql: Db) => SqlFragment;
  /** `and <predicate>`: the rows strictly after this cursor in this ordering. */
  readonly after: (sql: Db, cursor: HandCursor) => SqlFragment;
}

const HAND_ORDERINGS: Readonly<Record<HandSort, HandOrdering>> = {
  recent: {
    keyed: false,
    keyOf: () => null,
    orderBy: (sql) => sql`order by h.started_at desc, h.id desc`,
    after: (sql, c) => sql`and (h.started_at, h.id) < (${c.startedAtKey}::timestamptz, ${c.handId}::text)`,
  },
  oldest: {
    keyed: false,
    keyOf: () => null,
    orderBy: (sql) => sql`order by h.started_at asc, h.id asc`,
    after: (sql, c) => sql`and (h.started_at, h.id) > (${c.startedAtKey}::timestamptz, ${c.handId}::text)`,
  },
  'net-high': {
    keyed: true,
    keyOf: (row) => row.hero_net,
    orderBy: (sql) => sql`order by s.net_result desc nulls last, h.started_at desc, h.id desc`,
    after: (sql, c) =>
      c.sortValue === null || c.sortValue === undefined
        ? sql`and s.net_result is null
              and (h.started_at, h.id) < (${c.startedAtKey}::timestamptz, ${c.handId}::text)`
        : sql`and (s.net_result is null
                   or (s.net_result, h.started_at, h.id)
                      < (${c.sortValue}::int, ${c.startedAtKey}::timestamptz, ${c.handId}::text))`,
  },
  'net-low': {
    keyed: true,
    keyOf: (row) => row.hero_net,
    orderBy: (sql) => sql`order by s.net_result asc nulls last, h.started_at asc, h.id asc`,
    after: (sql, c) =>
      c.sortValue === null || c.sortValue === undefined
        ? sql`and s.net_result is null
              and (h.started_at, h.id) > (${c.startedAtKey}::timestamptz, ${c.handId}::text)`
        : sql`and (s.net_result is null
                   or (s.net_result, h.started_at, h.id)
                      > (${c.sortValue}::int, ${c.startedAtKey}::timestamptz, ${c.handId}::text))`,
  },
  'pot-high': {
    keyed: true,
    keyOf: (row) => row.max_pot_after,
    orderBy: (sql) => sql`order by p.max_pot_after desc nulls last, h.started_at desc, h.id desc`,
    after: (sql, c) =>
      c.sortValue === null || c.sortValue === undefined
        ? sql`and p.max_pot_after is null
              and (h.started_at, h.id) < (${c.startedAtKey}::timestamptz, ${c.handId}::text)`
        : sql`and (p.max_pot_after is null
                   or (p.max_pot_after, h.started_at, h.id)
                      < (${c.sortValue}::int, ${c.startedAtKey}::timestamptz, ${c.handId}::text))`,
  },
};

/**
 * The caller's hands, in the ordering they asked for.
 *
 * Keyset pagination rather than `offset`: an offset re-counts the rows it skips on every page,
 * and it silently shifts when a new hand is dealt mid-scroll, which shows one hand twice and
 * hides another. The `id` tiebreak makes every ordering total, so the comparison has a single
 * unambiguous answer even for two hands dealt in the same microsecond.
 *
 * The ordering is applied by the database over the caller's WHOLE history and the page is then
 * cut from it — the only order in which "the biggest pot you have ever played" means that rather
 * than "the biggest pot on this screen". A client cannot reproduce it: it holds one page.
 *
 * `roomId` stays expressed as `<param> is null or <predicate>` rather than being assembled
 * conditionally, so the filter costs one statement text however it is called. The cursor and the
 * ordering DO vary the statement, because a keyset predicate has no null-safe form that keeps a
 * single text — five statement texts is the price of five real orderings, and every value in
 * them is still a bind parameter.
 *
 * `s.user_id is not null` is redundant against the equality above it and is there for the
 * planner: `hand_seats_user_id_idx` is partial on exactly that predicate.
 *
 * `max_pot_after` moved from a scalar subquery in the select list into a `left join lateral`,
 * because `pot-high` has to compare it in the `where` clause as well as return it, and a column
 * that exists in one place cannot be two different expressions.
 *
 * The `to_char` mask quotes `"T"` and `"Z"` because `to_char` would otherwise read those letters
 * as field patterns of their own. `US` is microseconds, zero-padded to six digits.
 */
async function listHands(sql: Db, query: HandListQuery): Promise<HandListRow[]> {
  const ordering = HAND_ORDERINGS[query.sort];
  const after = query.cursor === null ? sql`` : ordering.after(sql, query.cursor);
  const rows = await sql<HandListRow[]>`
    select h.id,
           h.room_id,
           h.hand_number,
           h.board,
           h.result,
           h.street,
           h.started_at,
           h.completed_at,
           to_char(h.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started_at_key,
           s.net_result as hero_net,
           p.max_pot_after
      from prl.hand_seats s
      join prl.hands h on h.id = s.hand_id
      left join lateral (
             select max(a.pot_after) as max_pot_after
               from prl.hand_actions a
              where a.hand_id = h.id
           ) p on true
     where s.user_id = ${query.userId}
       and s.user_id is not null
       and (${query.roomId}::text is null or h.room_id = ${query.roomId}::text)
       ${after}
     ${ordering.orderBy(sql)}
     limit ${query.limit + 1}
  `;
  return [...rows];
}

/** `HandRow` plus the pot aggregate the summary needs. */
interface HandReviewRow extends HandRow {
  readonly max_pot_after: number | null;
}

/**
 * The hand, if it is the caller's.
 *
 * The `exists` clause is the authorisation, and it is part of the same statement as the lookup so
 * there is no window between deciding and reading. Zero rows is the only outcome a stranger ever
 * sees, and the handler turns it into `hand_not_found`.
 */
async function findOwnHand(sql: Db, handId: string, userId: string): Promise<HandReviewRow | null> {
  const rows = await sql<HandReviewRow[]>`
    select h.id,
           h.room_id,
           h.hand_number,
           h.button_seat,
           h.config,
           h.commitment_root,
           h.commitment_context,
           h.board,
           h.street,
           h.result,
           h.reveal,
           h.started_at,
           h.completed_at,
           (select max(a.pot_after) from prl.hand_actions a where a.hand_id = h.id) as max_pot_after
      from prl.hands h
     where h.id = ${handId}
       and exists (
             select 1
               from prl.hand_seats s
              where s.hand_id = h.id
                and s.user_id = ${userId}
           )
  `;
  return rows[0] ?? null;
}

/**
 * Every seat in the hand, with hole cards filtered in the projection itself.
 *
 * `case when s.user_id = <caller> or s.showed_down then s.hole_cards else null end` is the rule
 * from the column comment in `db/migrations/0001_initial.sql`, written where it cannot be
 * forgotten by a later caller: the cards a stranger may not see are not in the result set at all,
 * so they are never in this process's memory, never in a heap dump and never one serialisation
 * bug away from a response body.
 *
 * A NULL `user_id` — a seat whose account was deleted — compares as NULL, so the `case` falls
 * through to NULL unless the seat showed down. That is the correct answer: a detached seat is not
 * the caller's seat.
 */
async function seatsOfHand(sql: Db, handId: string, userId: string): Promise<HandSeatRow[]> {
  const rows = await sql<HandSeatRow[]>`
    select s.seat,
           s.user_id,
           s.is_bot,
           s.starting_stack,
           s.net_result,
           s.status,
           s.showed_down,
           case when s.user_id = ${userId} or s.showed_down then s.hole_cards else null end as hole_cards,
           u.display_name
      from prl.hand_seats s
      left join prl.users u on u.id = s.user_id
     where s.hand_id = ${handId}
     order by s.seat
  `;
  return [...rows];
}

/** The action log, in sequence order. This is what the replay in `build-review.ts` walks. */
async function actionsOfHand(sql: Db, handId: string): Promise<HandActionRow[]> {
  const rows = await sql<HandActionRow[]>`
    select a.sequence,
           a.street,
           a.seat,
           a.action_type,
           a.action_to,
           a.amount_paid,
           a.bet_level_after,
           a.pot_after,
           a.was_automatic
      from prl.hand_actions a
     where a.hand_id = ${handId}
     order by a.sequence
  `;
  return [...rows];
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

interface ListQueryString {
  readonly roomId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: HandSort;
}

interface HandIdParams {
  readonly handId: string;
}

/**
 * The caller's identity, or a refusal.
 *
 * `requireSession` reads `request.session`, which `sessionPlugin` decorates. If that plugin were
 * never registered the property would be absent rather than null, and `requireSession` would hand
 * back `undefined` — so the wiring is checked here instead of trusted. It is a mis-wired server,
 * not a bad request, hence `internal_error` and a loud log line.
 */
function callerId(request: FastifyRequest): string {
  if (!request.server.hasRequestDecorator('session')) {
    throw new AppError('internal_error', {
      logDetail: 'sessionPlugin is not registered, so /hands cannot identify the caller',
    });
  }
  return requireSession(request).user.id;
}

/**
 * One page, plus the cursor for the next one if there is one.
 *
 * `limit + 1` rows were fetched, so "is there another page" is answered by counting rather than by
 * a second query — and the extra row is dropped rather than returned, which is why `nextCursor`
 * names the last row of *this* page.
 */
function buildListResponse(rows: readonly HandListRow[], limit: number, sort: HandSort): HandListResponse {
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  const ordering = HAND_ORDERINGS[sort];
  return {
    // `HandListRow` satisfies `HandSummaryRow` structurally, so the same mapping the review header
    // uses serves the list too. No placeholder values, and no second copy of the mapping.
    hands: page.map((row) =>
      toHandSummary({ hand: row, heroNet: row.hero_net, maxPotAfter: row.max_pot_after }),
    ),
    // The cursor names the last row of THIS page, in the ordering that produced it, so the next
    // request resumes the same sequence rather than restarting a different one.
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({
            handId: last.id,
            startedAtKey: last.started_at_key,
            ...(ordering.keyed ? { sort, sortValue: ordering.keyOf(last) } : {}),
          })
        : null,
  };
}

/**
 * The cursor for this request, checked against the ordering it is being replayed into.
 *
 * A cursor is a position in ONE sequence. Handing a `net-high` cursor to `net-low` would resume
 * from a value that means something else there, and the resulting page would be a plausible-
 * looking slice of nothing in particular. Saying no is the only answer that is not misleading,
 * and no client of this API produces the combination: the hand-history page drops the cursor
 * whenever the reader picks a different ordering.
 */
function cursorFor(raw: string | undefined, sort: HandSort): HandCursor | null {
  if (raw === undefined) return null;
  const cursor = decodeCursor(raw);
  const expected = HAND_ORDERINGS[sort].keyed ? sort : undefined;
  if (cursor.sort !== expected) {
    throw new AppError('invalid_request', {
      fields: { 'query.cursor': `was issued for a different ordering than sort=${sort}` },
      logDetail: `cursor ordering ${String(cursor.sort)} does not match sort ${sort}`,
    });
  }
  return cursor;
}

/**
 * Registers both routes.
 *
 * Paths are written without `API_PREFIX`; `registerRoutes` supplies it.
 *
 * Not an `async` function even though the type is `FastifyPluginAsync`: there is nothing to await
 * here, and an `async` function with no `await` is a lint error for good reason — it usually means
 * a missing one. Returning an already-resolved promise says the same thing to Fastify.
 */
const handsRoutes: FastifyPluginAsync = (app: FastifyInstance) => {
  app.get<{ Querystring: ListQueryString }>(
    '/hands',
    { schema: { querystring: { $ref: 'prl:handListQuery#' } } },
    async (request) => {
      const userId = callerId(request);
      const limit = request.query.limit ?? DEFAULT_PAGE_SIZE;
      const sort = request.query.sort ?? DEFAULT_HAND_SORT;
      const rows = await listHands(getSql(), {
        userId,
        roomId: request.query.roomId ?? null,
        cursor: cursorFor(request.query.cursor, sort),
        sort,
        limit,
      });
      return buildListResponse(rows, limit, sort);
    },
  );

  app.get<{ Params: HandIdParams }>(
    '/hands/:handId',
    {
      schema: { params: { $ref: 'prl:handIdParams#' } },
      config: app.expensiveRateLimit,
    },
    async (request): Promise<HandReviewResponse> => {
      const userId = callerId(request);
      const sql = getSql();
      const hand = await findOwnHand(sql, request.params.handId, userId);
      if (hand === null) {
        throw new AppError('hand_not_found', {
          // The client is told only the code. Which of the two it was stays here.
          logDetail: 'hand does not exist, or the caller held no seat in it',
        });
      }

      // Two reads in parallel rather than in one transaction. The only way they could disagree is a
      // hand still in progress gaining an action between them, and the consequence of that is one
      // extra decision in the log — not a wrong number, because the replay checks itself against
      // the persisted pot before it analyses anything. A REPEATABLE READ transaction would close
      // even that, at the cost of a BEGIN/COMMIT on every review.
      const [seats, actions] = await Promise.all([
        seatsOfHand(sql, hand.id, userId),
        actionsOfHand(sql, hand.id),
      ]);

      return buildHandReview(
        { hand, seats, actions, viewerUserId: userId, maxPotAfter: hand.max_pot_after },
        {
          // Half the request budget. A review can then never be the reason a request times out,
          // and shortening `REQUEST_TIMEOUT_MS` tightens this automatically rather than leaving a
          // second number to remember.
          budgetMs: Math.floor(app.appConfig.requestTimeoutMs / 2),
          onAnalysisSkipped: (detail) => {
            // Server-side only: the response says `analysis: null` and nothing about why.
            request.log.debug({ handId: hand.id, ...detail }, 'hand review skipped one analysis');
          },
        },
      );
    },
  );

  return Promise.resolve();
};

export default handsRoutes;

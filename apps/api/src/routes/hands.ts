/**
 * `GET /hands` and `GET /hands/:handId`, scoped to the caller by `s.user_id = <caller>` in the SQL.
 *
 * A missing hand and somebody else's hand both answer `hand_not_found`, so a hand id cannot be confirmed.
 * Hole cards follow `user_id = :viewer OR showed_down` in the SQL, and `buildHandReview` applies it again.
 * `sort` selects a clause from `HAND_ORDERINGS` and is applied over the whole history in SQL.
 * The review recomputes analysis on every read (nothing derived is stored), so it takes
 * `app.expensiveRateLimit`. Rows are read on this thread and only `CoachTask`s go to the pool,
 * because a worker never holds a database handle. One review measured 156 ms on the event
 * loop, and action p99 went from 29 ms to 948 ms with reviews in the load test.
 *
 * `repositories/hands.ts` has similar queries that are NOT interchangeable. Its `byId` admits any
 * room member (a wider authorisation boundary), and its `encodeHandCursor` truncates to milliseconds,
 * which repeats a row on the next page. Unifying them is a product decision.
 */

import type { HandComparison, HandListResponse, HandReviewResponse, HandSort } from '@prl/contracts';
import { DEFAULT_HAND_SORT, HAND_SORTS, PATTERNS } from '@prl/contracts';
import { resolveNamingMode } from '@prl/poker-ai';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireSession } from '../auth/session.ts';
import { getSql } from '../db.ts';
import { AppError } from '../errors.ts';
import {
  bindCalculationPoolMetrics,
  observeAnalysis,
  workerTaskOutcomeFor,
} from '../observability/telemetry.ts';
import type { Db } from '../repositories/sql.ts';
import { buildLegendComparison } from '../review/build-comparison.ts';
import type { HandActionRow, HandRow, HandSeatRow, ReviewAnalyser } from '../review/build-review.ts';
import { buildHandReviewOn, toHandSummary } from '../review/build-review.ts';
import { closeSharedPool, getSharedPool, type PoolWarning, peekSharedPool } from '../workers/pool.ts';

/** `handListQuerySchema` caps the ask at 50. */
const DEFAULT_PAGE_SIZE = 20;

/**
 * Microsecond `started_at`, rendered by Postgres with `to_char(... 'US' ...)`. A millisecond key
 * compares earlier than its row and returns that row again on the next page.
 */
const STARTED_AT_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID_PATTERN = new RegExp(PATTERNS.ID);

/** `YYYY-MM-DDTHH:MM:SS.ffffffZ` is exactly 27 characters. */
const STARTED_AT_KEY_LENGTH = 27;

/** `null` is a real value. */
const SORT_VALUE_PATTERN = /^(?:null|-?\d{1,15})$/;

export interface HandCursor {
  readonly handId: string;
  readonly startedAtKey: string;
  /** Absent for `recent` and `oldest`, so the original two-part cursor still parses. */
  readonly sort?: HandSort;
  /** `null` means the row sits in the trailing block of unsettled hands, which the next page must know. */
  readonly sortValue?: number | null;
}

/**
 * `<handId>:<startedAtKey>`, plus `:<sort>:<value>` for a keyed ordering.
 * The id goes first because `PATTERNS.ID` has no colon. The timestamp is a fixed 27 characters.
 * The ordering's name is included so a cursor replayed into another ordering is a 400.
 * To a client the cursor is opaque.
 */
export function encodeCursor(cursor: HandCursor): string {
  const base = `${cursor.handId}:${cursor.startedAtKey}`;
  if (cursor.sort === undefined) return base;
  return `${base}:${cursor.sort}:${cursor.sortValue === null || cursor.sortValue === undefined ? 'null' : String(cursor.sortValue)}`;
}

function rejectCursor(detail: string): never {
  throw new AppError('invalid_request', {
    fields: { 'query.cursor': 'is not a cursor this endpoint issued' },
    logDetail: `hand list cursor rejected: ${detail}`,
  });
}

/** Strict, because a cursor that does not look minted has been edited, and refusing beats a wrong page. */
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

/** Columns listed, never `select *`. `hole_cards` is never projected, so a list cannot leak one. */
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
  /** One more row is fetched to learn whether a page follows. */
  readonly limit: number;
}

/**
 * No column name or direction is interpolated. Every clause is written out, and the `Record<HandSort, ...>`
 * type makes a missing ordering a compile error.
 * The tiebreak `started_at, id` follows the leading direction because a keyset row comparison applies
 * one direction to the whole tuple. `nulls last` keeps unsettled hands from sorting as zero.
 * `SqlFragment` goes through `ReturnType` because the driver's fragment type is internal.
 */
type SqlFragment = ReturnType<Db>;

interface HandOrdering {
  readonly keyed: boolean;
  readonly keyOf: (row: HandListRow) => number | null;
  readonly orderBy: (sql: Db) => SqlFragment;
  /** `and <predicate>` for rows strictly after the cursor. */
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
 * Keyset pagination, because `offset` shifts when a hand is dealt mid-scroll. The `id` tiebreak
 * makes every ordering total.
 * `roomId` uses `<param> is null or ...` so it does not vary the statement text.
 * `s.user_id is not null` lets the planner use the partial `hand_seats_user_id_idx`.
 * `max_pot_after` is a lateral join because `pot-high` filters on it as well as returning it.
 * The `to_char` mask quotes `"T"` and `"Z"` so they are not read as patterns. `US` is microseconds.
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

interface HandReviewRow extends HandRow {
  readonly max_pot_after: number | null;
}

/** The `exists` clause is the authorisation, in the same statement as the lookup. */
async function findOwnHand(sql: Db, handId: string, userId: string): Promise<HandReviewRow | null> {
  const rows = await sql<HandReviewRow[]>`
    select h.id,
           h.room_id,
           h.hand_number,
           h.button_seat,
           h.config,
           h.commitment_root,
           h.commitment_context,
           h.random_source_kind,
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
 * Hole cards are filtered in the projection (rule from `db/migrations/0001_initial.sql`), so hidden
 * cards never enter this process. A deleted account's NULL `user_id` falls through to NULL.
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

/** Sequence order, which the replay in `build-review.ts` walks. */
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
           a.was_automatic,
           a.automatic_reason
      from prl.hand_actions a
     where a.hand_id = ${handId}
     order by a.sequence
  `;
  return [...rows];
}

interface ListQueryString {
  readonly roomId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: HandSort;
}

interface HandIdParams {
  readonly handId: string;
}

/** Without `sessionPlugin` the property is absent, not null. A mis-wired server is `internal_error`. */
function callerId(request: FastifyRequest): string {
  if (!request.server.hasRequestDecorator('session')) {
    throw new AppError('internal_error', {
      logDetail: 'sessionPlugin is not registered, so /hands cannot identify the caller',
    });
  }
  return requireSession(request).user.id;
}

/** `limit + 1` rows were fetched. The extra row is dropped, so `nextCursor` names this page's last row. */
function buildListResponse(rows: readonly HandListRow[], limit: number, sort: HandSort): HandListResponse {
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  const ordering = HAND_ORDERINGS[sort];
  return {
    hands: page.map((row) =>
      toHandSummary({ hand: row, heroNet: row.hero_net, maxPotAfter: row.max_pot_after }),
    ),
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

/** A cursor belongs to one ordering. The web page drops the cursor whenever the ordering changes. */
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

/** Paths omit `API_PREFIX`. `registerRoutes` adds it. */
const handsRoutes: FastifyPluginAsync = (app: FastifyInstance) => {
  const config = app.appConfig;
  const metrics = app.appMetrics;
  /**
   * The shared pool `routes/calc.ts` also takes. `getSharedPool` memoises, so registering here as well
   * gives a deployment without the calculator routes threads, gauges and shutdown.
   */
  const poolHooks = {
    onWarn: (warning: PoolWarning) => {
      app.log.warn({ poolEvent: warning.event, poolDetail: warning.detail }, 'calculation pool');
      metrics.workerTasks.inc({ outcome: workerTaskOutcomeFor(warning.event) });
    },
  };
  bindCalculationPoolMetrics(peekSharedPool, metrics);
  app.addHook('onClose', async () => {
    await closeSharedPool();
  });

  /**
   * The pool is looked up per call because `closeSharedPool()` drops the memo, and a captured instance
   * would refuse every task after another app closes.
   * Each task runs under the pool's `coachTimeoutMs`. `budgetMs` below bounds the whole request.
   * Recorded as `kind="coach"` because it is the same task type as `POST /math/coach`.
   */
  const analyseOnThread: ReviewAnalyser = (task) =>
    observeAnalysis('coach', () => getSharedPool(config, poolHooks).runCoach(task), metrics);

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
          logDetail: 'hand does not exist, or the caller held no seat in it',
        });
      }

      // Parallel, not transactional. A live hand gaining an action between them adds one decision,
      // and the replay checks itself against the persisted pot.
      const [seats, actions] = await Promise.all([
        seatsOfHand(sql, hand.id, userId),
        actionsOfHand(sql, hand.id),
      ]);

      return await buildHandReviewOn(
        { hand, seats, actions, viewerUserId: userId, maxPotAfter: hand.max_pot_after },
        {
          // Half the request budget, so a review never causes a request timeout.
          budgetMs: Math.floor(config.requestTimeoutMs / 2),
          onAnalysisSkipped: (detail) => {
            // Server-side only. Pool refusals land here too and cost one decision its figure.
            request.log.debug({ handId: hand.id, ...detail }, 'hand review skipped one analysis');
          },
        },
        analyseOnThread,
      );
    },
  );

  /**
   * `GET /legends/hands/:handId/comparison`. Registered here so it reuses `findOwnHand` and
   * `seatsOfHand` instead of a second copy of the hole-card predicate. Same seat-holder rule and
   * same `hand_not_found`. It evaluates the actions not taken too, so it takes the expensive bucket.
   */
  app.get<{ Params: HandIdParams }>(
    '/legends/hands/:handId/comparison',
    {
      schema: { params: { $ref: 'prl:handIdParams#' } },
      config: app.expensiveRateLimit,
    },
    async (request): Promise<HandComparison> => {
      const userId = callerId(request);
      const sql = getSql();
      const hand = await findOwnHand(sql, request.params.handId, userId);
      if (hand === null) {
        throw new AppError('hand_not_found', {
          logDetail: 'hand does not exist, or the caller held no seat in it',
        });
      }

      const [seats, actions, botProfiles] = await Promise.all([
        seatsOfHand(sql, hand.id, userId),
        actionsOfHand(sql, hand.id),
        botProfilesOfRoom(sql, hand.room_id),
      ]);

      const outcome = await buildLegendComparison({
        hand,
        seats,
        actions,
        viewerUserId: userId,
        botProfiles,
        namingMode: resolveNamingMode(),
        budgetMs: Math.floor(config.requestTimeoutMs / 2),
        analyse: analyseOnThread,
        onAnalysisSkipped: (detail) => {
          request.log.debug({ handId: hand.id, ...detail }, 'hand comparison skipped one analysis');
        },
      });

      if (!outcome.ok) {
        // Each refusal is a real state of the hand and is never replaced with a sample.
        request.log.info(
          { handId: hand.id, refusal: outcome.refusal, detail: outcome.detail },
          'hand comparison refused',
        );
        throw new AppError('hand_not_comparable', {
          fields: { hand: outcome.refusal },
          logDetail: outcome.detail,
        });
      }
      return outcome.comparison;
    },
  );

  return Promise.resolve();
};

/**
 * `hand_seats` does not record which model a bot was, so it is joined from the roster. Departed
 * members are kept so finished hands still name their opponents.
 */
async function botProfilesOfRoom(sql: Db, roomId: string): Promise<ReadonlyMap<string, string>> {
  const rows = await sql<{ user_id: string; bot_profile: string | null }[]>`
    select m.user_id, m.bot_profile
      from prl.room_members m
     where m.room_id = ${roomId} and m.is_bot = true and m.bot_profile is not null
  `;
  const profiles = new Map<string, string>();
  for (const row of rows) {
    // `'unknown'` predates migration 0003 and names no model, so the seat stays unnamed.
    if (row.bot_profile !== null && row.bot_profile !== 'unknown') profiles.set(row.user_id, row.bot_profile);
  }
  return profiles;
}

export default handsRoutes;

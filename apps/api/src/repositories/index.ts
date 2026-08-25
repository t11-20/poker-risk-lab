/**
 * `src/repositories` — every SQL statement in this application, and nothing else.
 *
 * ## What a repository is here
 *
 * A module of plain async functions, each taking a `Db` handle as its **first argument**. No
 * classes, no ambient connection, no `getSql()` inside a function body. That one convention is
 * what makes any of them compose:
 *
 * ```ts
 * await withTransaction(async (tx) => {
 *   const hand = await hands.start(tx, { ... });
 *   await rooms.setStatus(tx, roomId, 'playing');
 *   await audit.record(tx, { event: 'hand.dealt', userId });
 *   return hand;
 * });
 * ```
 *
 * The same functions work against the pool when a route needs one statement and against a
 * transaction when it needs three to land together. A repository that reached for the pool itself
 * could not be in that block at all.
 *
 * ## Namespace exports, not a flat surface
 *
 * `import { hands, rooms } from '../repositories/index.ts'` and then `hands.byId(...)`. Flat
 * re-exports would collide immediately — `create`, `byId` and `listForUser` are the right names in
 * three or four of these modules each — and renaming them to `createRoom`, `createSession`,
 * `createGuest` would put the module name inside every function name for no gain. A caller reading
 * `sessions.create(tx, ...)` knows precisely which table is being written.
 *
 * ## The rules every module in here follows
 *
 * 1. **Parameterised SQL only.** Every value is a `${}` interpolation, which postgres.js sends as a
 *    separate protocol field. No string concatenation, no `.unsafe()`, not once — the only
 *    sanctioned `.unsafe()` in the repository is the migration runner executing a whole `.sql` file
 *    that contains no user input.
 * 2. **Secrets arrive in the clear and leave as digests.** `sessions.create` hashes the token it
 *    just minted; `rooms.byInviteCode` hashes the code it was handed. A plaintext credential never
 *    reaches a query parameter, and there is one place to look to confirm it.
 * 3. **Authorisation is in the WHERE clause.** `hands.byId` takes a viewer and returns null unless
 *    that viewer had a seat or is a room member; `hands.seatsOf` decides per row whether hole cards
 *    come back at all. A repository that returns everything and trusts the caller to filter has
 *    already leaked.
 * 4. **A race is answered by the database, then translated.** Partial unique indexes decide who got
 *    seat 3 and whether an `actionId` was already applied; `sql.ts` turns those violations into
 *    `seat_taken`, `already_seated`, `stale_action_sequence`. Nothing here does check-then-write.
 * 5. **A constraint nobody has reasoned about becomes a 500.** `violationError` returns null for an
 *    unmapped constraint and the error keeps its identity all the way to the handler, where it is
 *    logged in full. A plausible-looking 4xx would hide the bug.
 *
 * ## Where the SQL is not
 *
 * Route modules, the WebSocket hub and the bots contain no SQL. If a feature needs a query that is
 * not here, it goes here — that is the only way the guarantees above stay checkable by reading one
 * directory.
 */

export * as audit from './audit.ts';
export * as enrolments from './enrolments.ts';
export * as hands from './hands.ts';
export * as hashing from './hashing.ts';
export * as ids from './ids.ts';
export * as progress from './progress.ts';
export * as rooms from './rooms.ts';
export * as sessions from './sessions.ts';
/**
 * The driver seam, re-exported flat.
 *
 * `Db` is a type every caller needs in order to write a function that takes a handle, and the
 * violation helpers are what a route reaches for when it wants to catch one specific race — the
 * invite-code retry in `rooms.create` is the pattern. Everything else about the driver stays inside
 * the modules.
 */
export {
  type Db,
  insideSavepoint,
  isCheckViolation,
  isUniqueViolation,
  jsonbText,
  SQL_STATE,
  type SqlViolation,
  sqlViolation,
  violationCode,
  violationError,
} from './sql.ts';
export * as users from './users.ts';

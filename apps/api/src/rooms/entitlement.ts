/**
 * "May this person take a seat?" — the port, and the one binding of it that asks the database.
 *
 * ## Why this is a port at all
 *
 * The same reason `RoomStore`, `HandArchive` and `RoomOwnership` are: `test/rooms.test.ts` and
 * `test/ws-router.test.ts` drive the whole of rooms, seating, the socket protocol and the bots
 * against a `Map`-backed store with no Postgres anywhere, and a registry that reached for
 * `getSql()` to decide who may sit would turn every one of those into a database test. So the
 * decision arrives as an injected object, `null` means "this deployment does not gate seating",
 * and `routes/index.ts` passes the real one exactly the way it passes `postgresRoomOwnership`.
 *
 * ## Why the default is null and what that costs
 *
 * `PRL_ENROLMENT_REQUIRED` defaults to `off` because an open public instance is a legitimate
 * deployment and every deployment that exists today is one. A registry built with no entitlement
 * behaves precisely as this code did before the option existed — which is what makes the switch a
 * switch rather than a migration.
 *
 * The failure mode a permissive default invites is written into `RoomRegistryOptions.ownership`:
 * a default silently taken by production and nobody notices for months. It is closed the same way
 * here. `test/wiring.test.ts` asserts that the assembled app's registry is bound to an entitlement
 * exactly when the config says `enforced`, so the wiring cannot rot into a green test suite over
 * an ungated deployment.
 *
 * ## Why it reads and never writes, and why that is enforced by a GRANT
 *
 * `prl_app` — the role the request path connects as — holds `SELECT` and nothing else on
 * `prl.cohorts` and `prl.enrolments` (`db/migrations/0006_cohort_enrolments.sql`). So enforcement
 * is a READ: this file can ask who is entitled and cannot enrol, extend, or un-revoke anybody, and
 * that is true of anything an injection reaching the request path could make it do. The writes are
 * `apps/api/scripts/enrolments.mjs`, which connects as the migrating identity and is not reachable
 * from any HTTP handler. Do not widen that grant to make anything here more convenient.
 *
 * ## Why it is one statement
 *
 * `entitlementFor` is served by `enrolments_live_user_idx`, `(user_id) WHERE revoked_at IS NULL`,
 * so the scan starts from the handful of rows that can still entitle THIS person rather than from
 * a table that grows by one row per grant forever. It is on the seating path, which a learner
 * waits on, and the seating path already makes three round trips (`memberOf`, `readUnits`,
 * `seatMember`). A fourth of the same shape is the budget this may spend; a join across the cohort
 * roster is not.
 */

import * as enrolmentsRepository from '../repositories/enrolments.ts';
import type { Db } from '../repositories/sql.ts';

/**
 * What the registry asks before it lets somebody sit.
 *
 * An object with one method rather than a bare function so that a future setting — "warn but
 * allow", say — has somewhere to put a second method without changing every call site's type, and
 * so a test double reads as what it is at the point it is constructed.
 */
export interface SeatEntitlement {
  /**
   * True when this account holds an enrolment that entitles it RIGHT NOW.
   *
   * False covers every way of not being entitled and does not distinguish them — never enrolled,
   * revoked, expired, not started yet, or enrolled in a cohort that has ended. The caller must not
   * try to tell them apart from this, and the refusal it produces deliberately does not either:
   * "your place was withdrawn" and "your place has not started yet" are facts about a person that
   * a table refusal is the wrong place to disclose, and the operator tool (`enrolments show`) is
   * the right one. What the learner is told is the one thing they can act on — ask whoever enrols
   * their class.
   */
  readonly entitledToSit: (userId: string) => Promise<boolean>;
}

/**
 * The real one: `enrolments.entitlementFor`, on the request-path handle.
 *
 * `sql` is a getter for the reason `postgresArchive` and `postgresRoomOwnership` take one —
 * building the registry must not touch the pool, so that registering routes is still something a
 * process with no database can do.
 *
 * Nothing is caught here. A database that cannot answer "is this person entitled" must not produce
 * a seat, and it must not produce `enrolment_required` either — that code is a permanent refusal
 * and the client is told never to retry it (`wsCloseForError` maps 4xx to a permanent close). So
 * the driver's error propagates, becomes `internal_error` on both transports, and closes a socket
 * 4503, which is the retryable branch. Fail closed on the seat, and honest about which direction
 * the failure was in.
 */
export function postgresSeatEntitlement(sql: () => Db): SeatEntitlement {
  return {
    entitledToSit: async (userId) => (await enrolmentsRepository.entitlementFor(sql(), userId)) !== null,
  };
}

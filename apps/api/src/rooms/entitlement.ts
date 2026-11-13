/**
 * "May this person take a seat?" as an injected port, so rooms tests run with no Postgres.
 * `null` means this deployment does not gate seating (the `PRL_ENROLMENT_REQUIRED=off` default);
 * `test/wiring.test.ts` asserts the app binds one exactly when config says `enforced`.
 * `prl_app` holds SELECT only on `prl.cohorts` and `prl.enrolments`, so this path can read and never
 * enrol. Writes go through `scripts/enrolments.mjs`. Do not widen that grant.
 * `entitlementFor` is one statement on `enrolments_live_user_idx`, because it sits on the seating path.
 */

import * as enrolmentsRepository from '../repositories/enrolments.ts';
import type { Db } from '../repositories/sql.ts';

export interface SeatEntitlement {
  /**
   * True when this account holds an enrolment that entitles it right now.
   * False does not say why (revoked, expired, not started, cohort ended), and neither does the
   * refusal: those are facts about a person, and `enrolments show` is where an operator reads them.
   */
  readonly entitledToSit: (userId: string) => Promise<boolean>;
}

/**
 * `sql` is a getter so building the registry does not touch the pool.
 * Nothing is caught. A database error must not become `enrolment_required`, which is a permanent
 * 4xx refusal. It propagates as `internal_error` and closes the socket 4503, which is retryable.
 */
export function postgresSeatEntitlement(sql: () => Db): SeatEntitlement {
  return {
    entitledToSit: async (userId) => (await enrolmentsRepository.entitlementFor(sql(), userId)) !== null,
  };
}

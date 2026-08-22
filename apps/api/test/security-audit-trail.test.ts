/**
 * The security events this service claims to record are actually written.
 *
 * ## Why this file exists
 *
 * `prl.audit_log` shipped with a complete, tested writer (`repositories/audit.ts`) and **zero
 * production call sites**. The events its own doc comment gave as examples — a guest created, a
 * session revoked — had never once been recorded. Nothing failed, no test went red, and an
 * operator querying the table during an incident would have read the empty result as "it never
 * happened" rather than "nothing records it". That is the worst shape a control can have.
 *
 * Call sites now exist. This file is what stops the same thing happening in the other direction:
 * a call site that is present in the source and does not reach the table, because the write is
 * deliberately fire-and-forget and therefore cannot fail loudly.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes. Removing the `recordSecurityAudit` call from `POST /auth/guest` makes the first case time
 * out and fail with "no audit row appeared" — checked by doing it, not by assuming.
 *
 * ## Why it polls
 *
 * `recordSecurityAudit` is fire-and-forget on purpose: the callers are a socket handler that has
 * already closed the socket and request paths that must not wait on a database round trip for a
 * record nobody is blocking on. So the row lands *after* the response. Polling to a bounded
 * deadline is the honest way to assert on that; a fixed sleep would be slower and flakier, and
 * awaiting the write would test a different implementation from the one that ships.
 *
 * ## Why the assertions are about ABSENCE as much as presence
 *
 * Two of the three cases below check that something was NOT recorded — no display name, and no
 * user id on an erasure. An audit log that records too much is a privacy defect wearing the
 * clothes of diligence, and it is the failure mode that gets added later by somebody being
 * helpful.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ACCOUNT_DELETE_CONFIRMATION } from '@prl/contracts';
import { buildApp, registerRoutes } from '../src/app.ts';
import { closeDatabase, configureDatabase, getSql, isDatabaseConfigured } from '../src/db.ts';
import { resetAppMetricsForTests } from '../src/observability/metrics.ts';
import authRoutes from '../src/routes/auth.ts';
import { DB_SKIP_REASON, testConfig } from './helpers/hands-app.ts';

/**
 * How long a fire-and-forget write may take before the test calls it missing.
 *
 * Five seconds is plenty for a single INSERT on an idle pool. This suite shares the process-wide
 * database client with every other API test, and under `pnpm run test` that pool is busy: a
 * 5s deadline on this case timed out once after 811 other tests, then the same file passed in
 * 317ms on its own. Fifteen seconds still fails a write that never happens; it just does not
 * confuse pool wait with a missing call site.
 */
const AUDIT_DEADLINE_MS = 15_000;
const AUDIT_POLL_MS = 50;

/**
 * A CSRF token and the cookie it is paired with.
 *
 * Every mutating route requires both, and getting one without the other is the mistake that
 * makes a test look like a CSRF failure when it is really a missing setup step. Mirrors
 * `csrfPair` in `auth.test.ts` rather than importing it — that one is a closure over that file's
 * fake store, and copying twelve lines is cheaper than exporting a test helper from a test.
 */
async function csrfPair(
  target: Awaited<ReturnType<typeof buildApp>>,
): Promise<{ token: string; cookie: string }> {
  const response = await target.inject({ method: 'GET', url: '/api/v1/auth/session' });
  assert.equal(response.statusCode, 200, response.body);
  const token = (JSON.parse(response.body) as { csrfToken: string | null }).csrfToken;
  assert.ok(token !== null, 'the session read must always mint a CSRF token');
  const secret = response.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined, 'the session read must set the paired CSRF cookie');
  return { token, cookie: `prl_csrf=${secret.value}` };
}

/** Joins `set-cookie` values into a request `cookie` header. */
function jarFrom(raw: string | string[] | undefined): string {
  if (raw === undefined) return '';
  return (Array.isArray(raw) ? raw : [raw]).map((entry) => entry.split(';')[0]).join('; ');
}

interface AuditRow {
  readonly event: string;
  readonly user_id: string | null;
  readonly detail: Record<string, unknown> | null;
}

/**
 * Waits for one audit row matching `event`, created at or after `since`.
 *
 * The `since` bound matters: this suite runs against a shared development database that may hold
 * rows from a previous run, and a test that would pass on somebody else's leftovers is not a
 * test. Returns null on the deadline so the caller can produce a message naming what it wanted.
 */
async function waitForAuditRow(event: string, since: Date): Promise<AuditRow | null> {
  const sql = getSql();
  const deadline = Date.now() + AUDIT_DEADLINE_MS;
  while (Date.now() < deadline) {
    const rows = await sql<AuditRow[]>`
      select event, user_id, detail
        from prl.audit_log
       where event = ${event}
         and created_at >= ${since}
       order by created_at desc
       limit 1`;
    const row = rows[0];
    if (row !== undefined) return row;
    await new Promise((resolve) => setTimeout(resolve, AUDIT_POLL_MS));
  }
  return null;
}

describe('the security audit trail is actually written', { skip: DB_SKIP_REASON }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    resetAppMetricsForTests();
    const config = testConfig();
    if (!isDatabaseConfigured()) configureDatabase(config);
    app = await buildApp({ config });
    await registerRoutes(app, [authRoutes]);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await closeDatabase(1_000);
    resetAppMetricsForTests();
  });

  it('records a guest account creation, and does NOT record the name the learner typed', async () => {
    const since = new Date();
    const csrf = await csrfPair(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token, origin: 'http://localhost:3000' },
      // A distinctive name, so that if it ever did reach the log this assertion would find it
      // rather than pass on a coincidence.
      payload: { displayName: 'Audit Probe' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const userId = (JSON.parse(created.body) as { user: { id: string } }).user.id;

    const row = await waitForAuditRow('auth.guest.created', since);
    assert.ok(row !== null, 'no audit row appeared for auth.guest.created within the deadline');
    assert.equal(row.user_id, userId, 'the row must name the account that was created');

    const serialised = JSON.stringify(row.detail ?? {});
    assert.ok(
      !serialised.includes('Audit Probe'),
      `the display name must never reach the audit log, found: ${serialised}`,
    );
  });

  it('records a deliberate sign-out, and does not record one that had nothing to end', async () => {
    const since = new Date();
    const csrf = await csrfPair(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token, origin: 'http://localhost:3000' },
      payload: {},
    });
    assert.equal(created.statusCode, 201, created.body);
    const jar = `${csrf.cookie}; ${jarFrom(created.headers['set-cookie'])}`;

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: jar, 'x-csrf-token': csrf.token, origin: 'http://localhost:3000' },
    });
    assert.equal(out.statusCode, 204, out.body);

    const row = await waitForAuditRow('auth.session.revoked', since);
    assert.ok(row !== null, 'no audit row appeared for auth.session.revoked within the deadline');

    // The other half: a sign-out by a caller with no session is idempotent by design, and
    // recording it would fill the log with the retries and lost cookies it exists to make
    // legible. Counting before and after is what makes this an assertion rather than a hope.
    const sql = getSql();
    const before = await sql<{ count: string }[]>`
      select count(*)::text as count from prl.audit_log where event = 'auth.session.revoked'`;
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      // The CSRF pair only — no session cookie, so there is nothing to revoke.
      headers: { origin: 'http://localhost:3000', 'x-csrf-token': csrf.token, cookie: csrf.cookie },
    });
    assert.equal(anonymous.statusCode, 204, anonymous.body);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = await sql<{ count: string }[]>`
      select count(*)::text as count from prl.audit_log where event = 'auth.session.revoked'`;
    assert.equal(
      after[0]?.count,
      before[0]?.count,
      'a logout with no session to end must not be recorded as a revocation',
    );
  });

  it('records an erasure WITHOUT naming who asked for it', async () => {
    const since = new Date();
    const csrf = await csrfPair(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token, origin: 'http://localhost:3000' },
      payload: {},
    });
    assert.equal(created.statusCode, 201, created.body);
    const jar = `${csrf.cookie}; ${jarFrom(created.headers['set-cookie'])}`;
    const body = JSON.parse(created.body) as { user: { id: string } };

    const erased = await app.inject({
      method: 'POST',
      url: '/api/v1/me/delete',
      headers: { cookie: jar, 'x-csrf-token': csrf.token, origin: 'http://localhost:3000' },
      // The exported constant, never a literal: a route whose confirmation phrase changed
      // would otherwise leave this test silently exercising the refusal path and calling it a pass.
      payload: { confirm: ACCOUNT_DELETE_CONFIRMATION },
    });
    // The confirmation phrase is the route's own contract; if it has changed, this assertion says
    // so rather than silently exercising the refusal path and calling it a pass.
    assert.equal(erased.statusCode, 200, `erasure did not succeed: ${erased.body}`);

    const row = await waitForAuditRow('auth.account.deleted', since);
    assert.ok(row !== null, 'no audit row appeared for auth.account.deleted within the deadline');
    assert.equal(
      row.user_id,
      null,
      'an erasure must be recorded detached: the log records that it happened, never who asked',
    );

    // And the account really is gone — otherwise this would be an audit trail for something that
    // did not occur, which is worse than no audit trail.
    const sql = getSql();
    const remaining = await sql<{ id: string }[]>`select id from prl.users where id = ${body.user.id}`;
    assert.equal(remaining.length, 0, 'the erased account must not still exist');
  });
});

/**
 * The security events this service claims to record reach `prl.audit_log`. The write is
 * fire-and-forget, so a missing write cannot fail loudly anywhere else.
 * Absence is asserted too (no display name, no user id on an erasure), because over-recording is a
 * privacy defect.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ACCOUNT_DELETE_CONFIRMATION } from '@prl/contracts';
import { buildApp, registerRoutes } from '../src/app.ts';
import { closeDatabase, configureDatabase, getSql, isDatabaseConfigured } from '../src/db.ts';
import { resetAppMetricsForTests } from '../src/observability/metrics.ts';
import {
  awaitPendingAuditWrites,
  failedAuditWrites,
  recordSecurityAudit,
} from '../src/observability/telemetry.ts';
import authRoutes from '../src/routes/auth.ts';
import { DB_SKIP_REASON, testConfig } from './helpers/hands-app.ts';

/**
 * A busy shared pool has taken over 5 s for one INSERT. The `it` timeout must exceed this, because
 * `node --test` defaults to 5 s.
 */
const AUDIT_DEADLINE_MS = 15_000;
const AUDIT_POLL_MS = 50;
const AUDIT_TEST_TIMEOUT_MS = AUDIT_DEADLINE_MS + 5_000;

/** Mirrors `csrfPair` in `auth.test.ts`, which closes over that file's fake store. */
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
 * Sampled before the request, because a refused fire-and-forget write is already counted by the
 * time the wait starts.
 */
interface AuditWatch {
  readonly since: Date;
  readonly failedBefore: number;
}

function watchAudit(): AuditWatch {
  return { since: new Date(), failedBefore: failedAuditWrites() };
}

/** `since` excludes rows a previous run left in the shared database. */
async function waitForAuditRow(event: string, watch: AuditWatch): Promise<AuditRow> {
  const sql = getSql();
  const { since, failedBefore } = watch;
  // The poll stays as a backstop, because a settled write is not yet visible on every pool connection.
  await awaitPendingAuditWrites();
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
    // A refused write will never arrive, so stop waiting.
    if (failedAuditWrites() > failedBefore) break;
    await new Promise((resolve) => setTimeout(resolve, AUDIT_POLL_MS));
  }

  // Name the cause, because a refused write and a slow one want opposite responses.
  // `awaitPendingAuditWrites` has settled earlier writes, so a new failure is this event's write.
  const failed = failedAuditWrites() - failedBefore;
  throw new Error(
    failed > 0
      ? `no audit row for "${event}": ${failed} audit write(s) were REFUSED by the database and ` +
          'swallowed by recordSecurityAudit. This is not a slow test — waiting longer cannot help. ' +
          'Look for the "a security event could not be written to the audit log" report.'
      : `no audit row for "${event}" within ${AUDIT_DEADLINE_MS} ms, and no audit write failed. ` +
          'The write settled and the row is not visible to this pooled connection, so the row was ' +
          'either never started (the route did not record the event — a real defect) or is still ' +
          'landing under load (raise AUDIT_DEADLINE_MS).',
  );
}

describe('the security audit trail is actually written', {
  skip: DB_SKIP_REASON,
  timeout: AUDIT_TEST_TIMEOUT_MS,
}, () => {
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
    const watch = watchAudit();
    const csrf = await csrfPair(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token, origin: 'http://localhost:3000' },
      // Distinctive, so a leak into the log cannot pass on a coincidence.
      payload: { displayName: 'Audit Probe' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const userId = (JSON.parse(created.body) as { user: { id: string } }).user.id;

    const row = await waitForAuditRow('auth.guest.created', watch);
    assert.equal(row.user_id, userId, 'the row must name the account that was created');

    const serialised = JSON.stringify(row.detail ?? {});
    assert.ok(
      !serialised.includes('Audit Probe'),
      `the display name must never reach the audit log, found: ${serialised}`,
    );
  });

  it('records a deliberate sign-out, and does not record one that had nothing to end', async () => {
    const watch = watchAudit();
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

    // A revocation recorded against nobody cannot answer whose session ended.
    const row = await waitForAuditRow('auth.session.revoked', watch);
    assert.equal(
      row.user_id,
      (JSON.parse(created.body) as { user: { id: string } }).user.id,
      'the revocation must name the account whose session ended',
    );

    // A sign-out with no session is idempotent and must not be recorded.
    const sql = getSql();
    const before = await sql<{ count: string }[]>`
      select count(*)::text as count from prl.audit_log where event = 'auth.session.revoked'`;
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
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
    const watch = watchAudit();
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
      // The exported constant, so a changed phrase cannot silently exercise the refusal path.
      payload: { confirm: ACCOUNT_DELETE_CONFIRMATION },
    });
    assert.equal(erased.statusCode, 200, `erasure did not succeed: ${erased.body}`);

    const row = await waitForAuditRow('auth.account.deleted', watch);
    assert.equal(
      row.user_id,
      null,
      'an erasure must be recorded detached: the log records that it happened, never who asked',
    );

    const sql = getSql();
    const remaining = await sql<{ id: string }[]>`select id from prl.users where id = ${body.user.id}`;
    assert.equal(remaining.length, 0, 'the erased account must not still exist');
  });
  /**
   * `audit_log_event_shape` refuses an event with spaces and capitals, which gives a real refusal
   * without a mock, swallowed exactly as a pool timeout would be.
   */
  it('NEGATIVE CONTROL — a refused write is diagnosed as refused, not as a slow one', async () => {
    const failures: string[] = [];
    const watch = watchAudit();

    recordSecurityAudit(
      { event: 'NOT A REAL EVENT' as Parameters<typeof recordSecurityAudit>[0]['event'] },
      (message) => failures.push(message),
    );
    await awaitPendingAuditWrites();

    assert.deepEqual(
      failures,
      ['a security event could not be written to the audit log'],
      'the refusal must reach onFailure; if it does not, the write was never attempted',
    );
    assert.equal(
      failedAuditWrites() - watch.failedBefore,
      1,
      'the counter the diagnosis reads did not move, so the message cannot tell the two cases apart',
    );

    // Asserted on the text, because the message is the fix.
    await assert.rejects(
      () => waitForAuditRow('NOT A REAL EVENT', watch),
      /REFUSED by the database/u,
      'the timeout still reports a clock rather than the cause',
    );
  });
});

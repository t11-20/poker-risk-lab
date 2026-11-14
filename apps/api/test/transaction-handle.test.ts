/**
 * What each repository does with a pool handle where it needs a transaction. The pool here points at
 * a port nothing listens on, so a guard that lets the pool through fails on connecting and can never
 * write to a real database. The transaction cases need one, and roll back.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql, type TransactionSql } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import * as enrolments from '../src/repositories/enrolments.ts';
import { insideSavepoint } from '../src/repositories/sql.ts';
import * as users from '../src/repositories/users.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

function clientFor(url: string): Sql {
  return createDatabaseClient(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
      SESSION_COOKIE_SECRET: TEST_SECRET,
      DATABASE_POOL_MAX: '2',
    }),
  );
}

/** Port 1 needs root to bind, so nothing answers and nothing can be written. */
const unreachable = clientFor('postgres://prl@127.0.0.1:1/never_connected');

let client: Sql | null = null;
const skipReason: string | false = databaseSkip('a real transaction handle');
if (TEST_DATABASE_URL !== undefined) client = clientFor(TEST_DATABASE_URL);

after(async () => {
  await unreachable.end({ timeout: 1 });
  if (client !== null) await client.end({ timeout: 5 });
});

const ROLLBACK = new Error('rollback: this transaction was only ever a test');

async function inRollback(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const handle = client;
  if (handle === null) throw new Error('inRollback called without a database');
  try {
    await handle.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

async function refusesPool(run: () => Promise<unknown>, logDetail: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    assert.equal(error.code, 'internal_error');
    assert.equal(error.logDetail, logDetail);
    return true;
  });
}

const AUDIT_ENTRY =
  'was given a pool handle; it must run inside a transaction so that the enrolment row and its ' +
  'audit entry cannot land separately';

describe('a repository that needs a transaction refuses the pool, before any statement', () => {
  it('users.deleteAccount and users.deleteAbandonedGuest', async () => {
    await refusesPool(
      () => users.deleteAccount(unreachable, 'usr_nobody'),
      'deleteAccount was given a pool handle; it must run inside withTransaction',
    );
    await refusesPool(
      () => users.deleteAbandonedGuest(unreachable, 'usr_nobody', 60),
      'deleteAbandonedGuest was given a pool handle; it must run inside a transaction',
    );
  });

  it('enrolments.createCohort, grant and revoke', async () => {
    await refusesPool(
      () => enrolments.createCohort(unreachable, { key: 'k', name: 'n', startsAt: new Date() }),
      `createCohort ${AUDIT_ENTRY}`,
    );
    await refusesPool(
      () => enrolments.grant(unreachable, { cohortId: 'c', userId: 'u', grantedBy: 'g', reference: 'r' }),
      `grant ${AUDIT_ENTRY}`,
    );
    await refusesPool(
      () => enrolments.revoke(unreachable, { cohortId: 'c', userId: 'u', revokedBy: 'r', reason: 'r' }),
      `revoke ${AUDIT_ENTRY}`,
    );
  });

  it('insideSavepoint hands the pool straight to the callback', async () => {
    let seen: unknown = null;
    assert.equal(
      await insideSavepoint(unreachable, (handle) => {
        seen = handle;
        return Promise.resolve('ran');
      }),
      'ran',
    );
    assert.equal(seen, unreachable);
  });
});

describe('insideSavepoint in a transaction', { skip: skipReason }, () => {
  it('runs the callback in a savepoint, so a failed statement leaves the transaction usable', async () => {
    await inRollback(async (tx) => {
      let seen: unknown = null;
      await assert.rejects(
        insideSavepoint(tx, async (handle) => {
          seen = handle;
          await handle`select 1 / 0`;
        }),
        /division by zero/u,
      );
      assert.notEqual(seen, tx, 'the callback gets the savepoint handle, not the transaction');
      const [row] = await tx<{ ok: number }[]>`select 1 as ok`;
      assert.equal(row?.ok, 1);
    });
  });
});

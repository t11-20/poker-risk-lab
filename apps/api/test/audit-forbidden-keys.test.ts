/**
 * `AUDIT_FORBIDDEN_KEYS` in `repositories/audit.ts` must be at least as strict as the database's
 * `?|` CHECKs. Looser fails a live write, and stricter is the point of lower-casing because `?|` is
 * byte-exact. It reads `pg_get_constraintdef`, the constraint actually enforced after every
 * migration, not the migration files.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql } from '../src/db.ts';
import { isForbiddenAuditKey } from '../src/repositories/audit.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const SKIP = databaseSkip('the audit forbidden-key CHECK is read from the live database');

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

let client: Sql | null = null;
const sql = (): Sql => {
  client ??= createDatabaseClient(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL as string,
      PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
      SESSION_COOKIE_SECRET: TEST_SECRET,
      DATABASE_POOL_MAX: '2',
    }),
  );
  return client;
};

after(async () => {
  await client?.end({ timeout: 5 });
});

function keysIn(definition: string): string[] {
  const array = /array\[([\s\S]*?)\]/iu.exec(definition);
  if (array === null) return [];
  return [...(array[1] ?? '').matchAll(/'([^']+)'/gu)].map((match) => match[1] ?? '');
}

/**
 * Unioned over every `?|` CHECK, because 0007 added `audit_log_detail_has_no_card_keys` beside
 * 0001's constraint instead of dropping and rewriting it.
 */
async function forbiddenKeys(): Promise<string[]> {
  const rows = await sql()<{ conname: string; definition: string }[]>`
    select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
     where conrelid = 'prl.audit_log'::regclass
       and contype = 'c'`;
  const named = rows.filter((row) => row.definition.includes('?|'));
  assert.ok(
    named.length >= 2,
    `only ${named.length} key-refusing CHECK(s) on prl.audit_log; 0001 and 0007 each add one, so ` +
      'a lower count means one was dropped or this database is behind its migrations',
  );
  return [...new Set(named.flatMap((row) => keysIn(row.definition)))];
}

describe('the audit log forbids the same keys in both layers', { skip: SKIP }, () => {
  it('reads a real constraint with a real list, so a clean result is not an empty scan', async () => {
    const keys = await forbiddenKeys();
    assert.ok(
      keys.length >= 30,
      `parsed ${keys.length} forbidden key(s) out of the constraint. Either the CHECK was rewritten ` +
        'in a shape this parser does not read — in which case teach it the new shape rather than ' +
        'deleting the check — or the list really shrank.',
    );
  });

  it('every key the database refuses is refused by the app layer first (REGRESSION)', async () => {
    const keys = await forbiddenKeys();
    const missed = keys.filter((key) => !isForbiddenAuditKey(key));
    assert.deepEqual(
      missed,
      [],
      `${missed.length} key(s) the database refuses reach it through the app layer: ` +
        `${missed.join(', ')}. A write carrying one fails as a constraint violation in front of a ` +
        'learner instead of being dropped before it is sent.',
    );
  });

  it('covers the card spellings this codebase actually uses (REGRESSION)', () => {
    // `hole_cards` and the engine's secret field names, which 0001's list did not cover.
    for (const key of [
      'hole_cards',
      'holeCards',
      'holeCardPositions',
      'deckSalts',
      'deckCursor',
      'boardPositions',
      'reveal',
      'cards',
    ]) {
      assert.ok(isForbiddenAuditKey(key), `the app layer would let "${key}" into the audit log`);
    }
  });

  it('the case-insensitive half still works, since the database half cannot be', () => {
    assert.ok(isForbiddenAuditKey('UserAgent'));
    assert.ok(isForbiddenAuditKey('HOLE_CARDS'));
    assert.ok(isForbiddenAuditKey('DeckSalts'));
  });

  it('NEGATIVE CONTROL — it does not refuse the keys the audit log legitimately carries', () => {
    // The distinct detail keys in use on the development database (49 rows).
    for (const key of [
      'by',
      'cohortId',
      'cohortKey',
      'enrolmentId',
      'expiresAt',
      'handId',
      'issuer',
      'kind',
      'maxSeats',
      'reason',
      'reference',
      'refusal',
      'roomId',
      'startsAt',
      'supersededId',
      'visibility',
    ]) {
      assert.equal(isForbiddenAuditKey(key), false, `"${key}" is written by a real call site today`);
    }
  });

  it('is covered by TWO app-layer mechanisms, and the check spans both', () => {
    // `isSensitiveKey` already catches `hole_cards` through `deck|salt|hole_?card`, so the control
    // breaks `cards`, `board` and `reveal`, which only the audit set carries.
    assert.ok(isForbiddenAuditKey('hole_cards'), 'the pattern half stopped covering the card names');
    for (const key of ['cards', 'board', 'reveal']) {
      assert.ok(isForbiddenAuditKey(key), `"${key}" is carried by the audit set alone and is gone`);
    }
  });

  it('NEGATIVE CONTROL — the parser refuses a constraint it cannot read', () => {
    assert.deepEqual(keysIn('CHECK (detail IS NULL)'), []);
    assert.deepEqual(keysIn(''), []);
    assert.deepEqual(keysIn("CHECK (NOT (detail ?| array['a', 'b']))"), ['a', 'b']);
  });
});

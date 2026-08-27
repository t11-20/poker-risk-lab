/**
 * The audit log's two forbidden-key lists must not drift, and until today nothing held them.
 *
 * `apps/api/src/repositories/audit.ts` carries `AUDIT_FORBIDDEN_KEYS`, a lower-cased copy of the
 * array inside `audit_log_detail_has_no_forbidden_keys`, and its comment said the copy existed
 * "so that a key added to the CHECK and not added here fails a test instead of failing a live audit
 * write". **There was no such test.** Nothing in the repository compared the two, so the sentence
 * described a guarantee that did not exist — the same shape as the several other claims this branch
 * found asserted only in prose.
 *
 * ## Why it reads the database and not the migration
 *
 * A parser over `db/migrations/0001_initial.sql` would have to know that `0007` redefines the
 * constraint, and the next one after that, and would be asserting against the file rather than
 * against what is enforced. `pg_get_constraintdef` is the effective answer: it is what PostgreSQL
 * will actually apply to the next INSERT, after every migration that has run. That also makes the
 * check immune to a migration that lands in the tree but not in the database, which is a state this
 * repository can reach — `migrate.mjs` is roll-forward only and a deployment can be behind.
 *
 * ## The direction that matters
 *
 * The app layer must be at least as strict as the database. Stricter is fine and is the point of
 * the lower-casing: `?|` is byte-exact, so `UserAgent` satisfies PostgreSQL and is still the thing
 * the product promised not to store. Looser is a key that reaches a live write and fails it with a
 * constraint violation in front of a learner, which is why this asserts one direction and not
 * equality.
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

/** The literal keys inside the CHECK's `array[...]`, exactly as PostgreSQL holds them. */
function keysIn(definition: string): string[] {
  const array = /array\[([\s\S]*?)\]/iu.exec(definition);
  if (array === null) return [];
  // `?? ''` for `noUncheckedIndexedAccess`: a capture group is `string | undefined` to the compiler
  // even where the pattern cannot match without it.
  return [...(array[1] ?? '').matchAll(/'([^']+)'/gu)].map((match) => match[1] ?? '');
}

/**
 * Every key refused by ANY `?|` CHECK on `prl.audit_log`, unioned.
 *
 * There are two constraints, not one: 0007 added `audit_log_detail_has_no_card_keys` BESIDE 0001's
 * rather than rewriting it, because a rewrite means a DROP, and roll-forward-only means a drop that
 * half-succeeds cannot be undone by anything but a restore — `migrate.mjs` refuses one without an
 * irreversibility marker, and it was right to. A test that read only the original name would have
 * gone quiet about the newer list, which is the failure mode this whole file exists to prevent.
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
    // The measurement that produced migration 0007: the 0001 list was written in the spelling the
    // API used at the time, and `hole_cards` — the column name in `prl.hand_seats` — passed it, as
    // did the four fields `poker-engine` calls the hand's secrets.
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
    // `?|` is byte-exact, so this is the layer that catches a spelling PostgreSQL would accept.
    assert.ok(isForbiddenAuditKey('UserAgent'));
    assert.ok(isForbiddenAuditKey('HOLE_CARDS'));
    assert.ok(isForbiddenAuditKey('DeckSalts'));
  });

  it('NEGATIVE CONTROL — it does not refuse the keys the audit log legitimately carries', () => {
    // The other direction, and the reason this is not simply "refuse everything": these are the
    // distinct detail keys in use on the development database, 49 rows with a detail object.
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
    // Worth knowing when this fails. `isForbiddenAuditKey` is
    // `isSensitiveKey(key) || AUDIT_FORBIDDEN_KEYS.has(key.toLowerCase())`, and `isSensitiveKey` is
    // `logging.ts`'s project-wide substring pattern — which since 2026-08-27 contains
    // `deck|salt|hole_?card`. So removing `hole_cards` from the audit set changes NOTHING: the
    // pattern still catches it. Measured, when this control was first written the wrong way round.
    //
    // Keys like `cards`, `board` and `reveal` are carried by the audit set ALONE, which is what
    // makes them the honest thing to break in a control — and what makes the set still worth
    // having beside the pattern.
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

/**
 * Every repository write to a `jsonb` column, read back with `jsonb_typeof`. A parameter the server
 * does not parse arrives as a jsonb string, so each column is asserted to hold the object or array the
 * caller passed, and each nullable column to hold SQL NULL rather than JSON `null`. Every case runs in
 * a rolled-back transaction, so nothing is committed to the development database.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ErrorCode } from '@prl/contracts';
import { COMMITMENT_VERSION, type HandResult, parseCard } from '@prl/poker-engine';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql, type TransactionSql } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import * as audit from '../src/repositories/audit.ts';
import * as hands from '../src/repositories/hands.ts';
import { generateId } from '../src/repositories/ids.ts';
import * as progress from '../src/repositories/progress.ts';
import * as rooms from '../src/repositories/rooms.ts';
import * as users from '../src/repositories/users.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';
const ROOT = 'a'.repeat(64);
/** Built at run time because `security:hygiene` refuses a literal control character in source. */
const NUL = String.fromCodePoint(0);

let client: Sql | null = null;
let skipReason: string | false = databaseSkip('the jsonb parameter casts');

if (TEST_DATABASE_URL !== undefined) {
  try {
    const probe = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL,
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: TEST_SECRET,
        DATABASE_POOL_MAX: '2',
      }),
    );
    await probe`select 1 from prl.users limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `prl schema is not reachable (${error instanceof Error ? error.name : 'error'}): run pnpm db:migrate`;
  }
}

if (skipReason !== false) {
  console.info(`[jsonb-parameters-database.test.ts] skipping: ${skipReason}`);
}

after(async () => {
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

/** In a savepoint, because a failed statement would abort the transaction for every later assertion. */
async function rejectsWithField(
  tx: TransactionSql,
  code: ErrorCode,
  fields: Readonly<Record<string, string>>,
  run: (handle: TransactionSql) => Promise<unknown>,
): Promise<void> {
  await assert.rejects(
    tx.savepoint(async (savepoint) => {
      await run(savepoint);
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
      assert.equal(error.code, code);
      assert.deepEqual(error.fields, fields);
      return true;
    },
  );
}

async function dealtHand(tx: TransactionSql) {
  const hero = await users.createGuest(tx, { displayName: 'Hero' });
  const villain = await users.createGuest(tx, { displayName: 'Villain' });
  const { room } = await rooms.create(tx, {
    name: 'Kitchen table',
    ownerUserId: hero.id,
    maxSeats: 6,
    smallBlind: 1,
    bigBlind: 2,
    startingStack: 200,
  });
  await rooms.addMember(tx, { roomId: room.id, userId: hero.id });
  await rooms.seatMember(tx, room.id, hero.id, 0);
  await rooms.addMember(tx, { roomId: room.id, userId: villain.id });
  await rooms.seatMember(tx, room.id, villain.id, 1);

  const handId = generateId('hand');
  await hands.start(tx, {
    handId,
    roomId: room.id,
    handNumber: await hands.nextHandNumber(tx, room.id),
    buttonSeat: 0,
    config: { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
    commitmentRoot: ROOT,
    commitmentContext: `prl-deck-v2|${handId}`,
    randomSourceKind: 'csprng',
    seats: [
      {
        seat: 0,
        userId: hero.id,
        isBot: false,
        startingStack: 200,
        holeCards: [parseCard('Ah'), parseCard('Kh')],
        status: 'active',
      },
      {
        seat: 1,
        userId: villain.id,
        isBot: false,
        startingStack: 200,
        holeCards: null,
        status: 'sittingOut',
      },
    ],
  });
  return { handId, roomId: room.id, heroId: hero.id };
}

interface TypeRow {
  readonly kind: string | null;
  readonly is_sql_null: boolean;
}

describe('jsonb parameters reach the column as parsed JSON', { skip: skipReason }, () => {
  it('hands.start stores the config as an object and hole cards as an array or SQL NULL', async () => {
    await inRollback(async (tx) => {
      const { handId } = await dealtHand(tx);
      const [hand] = await tx<TypeRow[]>`
        select jsonb_typeof(config) as kind, config is null as is_sql_null from prl.hands where id = ${handId}
      `;
      assert.deepEqual({ ...hand }, { kind: 'object', is_sql_null: false });

      const seats = await tx<(TypeRow & { seat: number })[]>`
        select seat, jsonb_typeof(hole_cards) as kind, hole_cards is null as is_sql_null
          from prl.hand_seats where hand_id = ${handId} order by seat
      `;
      assert.deepEqual(
        seats.map((row) => ({ ...row })),
        [
          { seat: 0, kind: 'array', is_sql_null: false },
          { seat: 1, kind: null, is_sql_null: true },
        ],
      );
      const [cards] = await tx<{ cards: unknown }[]>`
        select hole_cards as cards from prl.hand_seats where hand_id = ${handId} and seat = 0
      `;
      assert.deepEqual(cards?.cards, ['Ah', 'Kh']);
    });
  });

  it('hands.advanceStreet stores the board as an array', async () => {
    await inRollback(async (tx) => {
      const { handId } = await dealtHand(tx);
      await hands.advanceStreet(tx, handId, 'flop', [parseCard('Qh'), parseCard('7h'), parseCard('2c')]);
      const [hand] = await tx<{ kind: string; board: unknown }[]>`
        select jsonb_typeof(board) as kind, board from prl.hands where id = ${handId}
      `;
      assert.equal(hand?.kind, 'array');
      assert.deepEqual(hand?.board, ['Qh', '7h', '2c']);
    });
  });

  it('hands.complete stores the board, the result and the reveal as parsed JSON', async () => {
    await inRollback(async (tx) => {
      const { handId } = await dealtHand(tx);
      const result: HandResult = {
        showdowns: [],
        pots: [{ amount: 4, eligibleSeats: [0], capPerSeat: 2, index: 0 }],
        awards: [],
        netBySeat: { 0: 0, 1: 0 },
        endedByFold: true,
        reveal: {
          commitment: {
            algorithm: 'sha256',
            version: COMMITMENT_VERSION,
            root: ROOT,
            context: `prl-deck-v2|${handId}`,
          },
          cards: [],
          complete: false,
        },
      };
      await hands.complete(tx, {
        handId,
        board: [parseCard('Qh'), parseCard('7h'), parseCard('2c')],
        result,
        seats: [
          { seat: 0, netResult: 0, status: 'active', showedDown: false },
          { seat: 1, netResult: 0, status: 'sittingOut', showedDown: false },
        ],
      });
      const [hand] = await tx<{ board: string; result: string; reveal: string; pots: string }[]>`
        select jsonb_typeof(board) as board, jsonb_typeof(result) as result,
               jsonb_typeof(reveal) as reveal, jsonb_typeof(result -> 'pots') as pots
          from prl.hands where id = ${handId}
      `;
      assert.deepEqual({ ...hand }, { board: 'array', result: 'object', reveal: 'object', pots: 'array' });
    });
  });

  it('audit.record stores the detail as an object, and no detail as SQL NULL', async () => {
    await inRollback(async (tx) => {
      const user = await users.createGuest(tx, { displayName: 'Learner' });
      await audit.record(tx, { event: 'test.jsonb.detail', userId: user.id, detail: { route: '/x' } });
      await audit.record(tx, { event: 'test.jsonb.none', userId: user.id });
      const rows = await tx<(TypeRow & { event: string })[]>`
        select event, jsonb_typeof(detail) as kind, detail is null as is_sql_null
          from prl.audit_log where user_id = ${user.id} order by event
      `;
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [
          { event: 'test.jsonb.detail', kind: 'object', is_sql_null: false },
          { event: 'test.jsonb.none', kind: null, is_sql_null: true },
        ],
      );
    });
  });

  it('progress attempts store the quiz answer and the scenario action as objects', async () => {
    await inRollback(async (tx) => {
      const user = await users.createGuest(tx, { displayName: 'Learner' });
      await progress.recordQuizAttempt(tx, {
        userId: user.id,
        quizId: 'foundations',
        questionId: 'q-outs',
        answer: { kind: 'choice', index: 2 },
        wasCorrect: true,
      });
      await progress.recordScenarioAttempt(tx, {
        userId: user.id,
        scenarioId: 'turn-semi-bluff',
        action: 'raise',
        to: 120,
        matchedExpected: true,
      });
      const [quiz] = await tx<{ kind: string; answer: unknown }[]>`
        select jsonb_typeof(answer) as kind, answer from prl.quiz_attempts where user_id = ${user.id}
      `;
      assert.deepEqual({ ...quiz }, { kind: 'object', answer: { kind: 'choice', index: 2 } });
      const [scenario] = await tx<{ kind: string; action: unknown }[]>`
        select jsonb_typeof(chosen_action) as kind, chosen_action as action
          from prl.scenario_attempts where user_id = ${user.id}
      `;
      assert.deepEqual({ ...scenario }, { kind: 'object', action: { type: 'raise', to: 120 } });
    });
  });

  it('refuses a NUL, an unserialisable value and a non-object answer, naming the field', async () => {
    await inRollback(async (tx) => {
      const user = await users.createGuest(tx, { displayName: 'Learner' });
      const quiz = (answer: unknown) => (handle: TransactionSql) =>
        progress.recordQuizAttempt(handle, {
          userId: user.id,
          quizId: 'foundations',
          questionId: 'q-outs',
          answer,
          wasCorrect: true,
        });
      await rejectsWithField(
        tx,
        'invalid_request',
        { answer: 'must not contain a NUL character' },
        quiz({ note: `a${NUL}b` }),
      );
      await rejectsWithField(
        tx,
        'invalid_request',
        { answer: 'must not contain a NUL character' },
        quiz([`a${NUL}b`]),
      );
      await rejectsWithField(
        tx,
        'invalid_request',
        { answer: 'is not serialisable as JSON' },
        quiz(undefined),
      );
      await rejectsWithField(tx, 'invalid_request', { answer: 'must be an object' }, quiz([1, 2, 3]));
      await rejectsWithField(tx, 'invalid_request', { answer: 'must be an object' }, quiz(null));

      const { handId, roomId } = await dealtHand(tx);
      await rejectsWithField(
        tx,
        'invalid_request',
        { config: 'must not contain a NUL character' },
        (handle) =>
          hands.start(handle, {
            handId: generateId('hand'),
            roomId,
            handNumber: 2,
            buttonSeat: 0,
            config: { label: `a${NUL}b` } as unknown as Parameters<typeof hands.start>[1]['config'],
            commitmentRoot: ROOT,
            commitmentContext: `prl-deck-v2|${handId}`,
            randomSourceKind: 'csprng',
            seats: [
              { seat: 0, userId: null, isBot: true, startingStack: 200, holeCards: null, status: 'active' },
            ],
          }),
      );
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int as n from prl.quiz_attempts where user_id = ${user.id}
      `;
      assert.equal(count?.n, 0, 'a refused value never reaches the database');
    });
  });
});

/**
 * `POST /content/quizzes/:id/attempt` has to say whether it kept the answer.
 *
 * ## The defect
 *
 * A signed-out learner is this product's DEFAULT state — nothing creates a session until somebody
 * opens a table — and this route answers them 200 and stores nothing. That is deliberate and
 * right: the app is guest-first, and refusing the call would make the client's success path depend
 * on whether somebody happens to be signed in.
 *
 * What was wrong is that the 200 was indistinguishable from a member's. `QuizAttemptResponse`
 * carried `correct`, `explanation`, `expected` and `optionNotes` and no signal at all about
 * attribution, so the quiz panel told every anonymous learner:
 *
 *   > …and the one it recorded as a question you have answered.
 *
 * while `prl.quiz_attempts` held nothing of theirs and `GET /me/progress` answered them
 * `401 not_authenticated`. The product's own honesty rule, broken by the product, in its teaching
 * surface. `recorded` is the fix, and the client half is `apps/web/src/lib/quiz-attempts.ts`.
 *
 * ## What is asserted, and why it is asserted this way
 *
 * The load-bearing test is not "an anonymous reply says `recorded: false`" on its own — a route
 * that hard-coded `false` would pass that. It is that the two replies are IDENTICAL in every other
 * field and differ in exactly this one, which is the same statement as "no other field could have
 * carried this", made executable. Both halves are then checked against the table itself: the
 * signed-in claim against a row that exists, the anonymous claim against a table that did not
 * grow.
 *
 * The anonymous half needs no database and always runs. The signed-in half writes a row and is
 * skipped, with a printed reason, when `DATABASE_URL` is absent — see `test/helpers/database.ts`
 * for why a skip here is never silent.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { content } from '@prl/content';
import type { QuizQuestion } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import { buildApp, registerRoutes } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase, type DatabaseHandle, getSql } from '../src/db.ts';
import { newUserId } from '../src/repositories/ids.ts';
import contentRoutes from '../src/routes/content.ts';
import progressRoutes from '../src/routes/progress.ts';
import { closeSharedPool } from '../src/workers/pool.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const databaseTest = { skip: databaseSkip('the recorded-attempt row this route writes') };

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

function stubDatabase(): DatabaseHandle {
  return { ping: async () => ({ ok: true }), close: async () => undefined };
}

/**
 * Fills the seam `sessionPlugin` normally fills, so "signed in" is a property of the request
 * rather than of the auth module — which is what keeps this file testing the content route.
 */
function withSignedInCaller(app: FastifyInstance, userId: string): void {
  app.decorateRequest('session', null);
  app.decorateRequest('sessionRejection', null);
  app.addHook('preHandler', (request, _reply, done) => {
    request.session = {
      sessionId: 'ses_y2quizrecording00000000',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: { id: userId, kind: 'guest', displayName: 'Test Learner', createdAt: new Date().toISOString() },
    };
    done();
  });
}

async function contentApp(options: { readonly userId?: string } = {}): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), database: stubDatabase() });
  app.get('/api/v1/test-csrf', async (_request, reply) => ({ token: reply.generateCsrf() }));
  if (options.userId !== undefined) withSignedInCaller(app, options.userId);
  await registerRoutes(app, [contentRoutes, progressRoutes]);
  return app;
}

interface Csrf {
  readonly token: string;
  readonly cookie: string;
}

async function csrfPair(app: FastifyInstance): Promise<Csrf> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/test-csrf' });
  assert.equal(response.statusCode, 200);
  const body: unknown = response.json();
  assert.ok(typeof body === 'object' && body !== null && 'token' in body);
  const secret = response.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined);
  return { token: String((body as { readonly token: unknown }).token), cookie: `prl_csrf=${secret.value}` };
}

interface Answered {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function attempt(
  app: FastifyInstance,
  quizId: string,
  payload: Record<string, unknown>,
  csrf: Csrf,
): Promise<Answered> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/content/quizzes/${quizId}/attempt`,
    payload,
    headers: { 'x-csrf-token': csrf.token, cookie: csrf.cookie },
  });
  const parsed: unknown = response.body === '' ? {} : JSON.parse(response.body);
  assert.ok(typeof parsed === 'object' && parsed !== null);
  return { status: response.statusCode, body: { ...parsed } };
}

/** The first question of a given kind in the shipped bundle, so this drives real content. */
function firstQuestion<K extends QuizQuestion['kind']>(
  kind: K,
): { readonly quizId: string; readonly question: Extract<QuizQuestion, { kind: K }> } {
  for (const quiz of content().quizzes) {
    for (const question of quiz.questions) {
      if (question.kind === kind) {
        return { quizId: quiz.id, question: question as Extract<QuizQuestion, { kind: K }> };
      }
    }
  }
  throw new Error(`the content bundle carries no ${kind} question`);
}

// ---------------------------------------------------------------------------
// The anonymous caller, which is the default one
// ---------------------------------------------------------------------------

describe('an answer from a caller with no session', () => {
  it('is graded, answered 200, and says plainly that it was not recorded', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      const { quizId, question } = firstQuestion('multipleChoice');
      const response = await attempt(
        app,
        quizId,
        { questionId: question.id, answer: { kind: 'choice', index: question.correctIndex } },
        csrf,
      );

      assert.equal(response.status, 200, 'a guest is graded, not refused: the app is guest-first');
      assert.equal(response.body['correct'], true, 'the grading is real, whoever asked for it');
      assert.equal(
        response.body['recorded'],
        false,
        'nothing was stored, and the reply has to say so — this is the field whose absence let the ' +
          'quiz panel claim a row that does not exist',
      );
      // A boolean rather than merely falsy: `undefined` is what the old contract effectively sent,
      // and a client reading `!response.recorded` could not tell "not stored" from "old server".
      assert.equal(typeof response.body['recorded'], 'boolean');
    } finally {
      await app.close();
    }
  });

  it('says the same for a numeric question, where the reply also carries the computed figure', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      const { quizId, question } = firstQuestion('numeric');
      const response = await attempt(
        app,
        quizId,
        { questionId: question.id, answer: { kind: 'number', value: 0 } },
        csrf,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body['recorded'], false);
      // The graded half is untouched by the recording half: a signed-out learner still gets the
      // server's own figure, which is what the panel shows them.
      assert.ok(typeof response.body['expected'] === 'object' && response.body['expected'] !== null);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The signed-in caller, and the difference between the two replies
// ---------------------------------------------------------------------------

describe('the same answer from a caller with a session', () => {
  let configured = false;

  function database(): void {
    if (configured) return;
    configureDatabase(testConfig());
    configured = true;
  }

  after(async () => {
    await closeSharedPool();
    if (configured) await closeDatabase(1_000);
  });

  it(
    'writes a row, says recorded, and differs from the guest reply in that field alone',
    databaseTest,
    async () => {
      database();
      const sql = getSql();
      const userId = newUserId();
      await sql`insert into prl.users (id, kind, display_name) values (${userId}, 'guest', 'Test Learner')`;

      const { quizId, question } = firstQuestion('multipleChoice');
      const body = { questionId: question.id, answer: { kind: 'choice', index: question.correctIndex } };

      // The whole table, before either call. `prl.quiz_attempts` is append-only and shared with the
      // dev seed, so the assertion below is about what THIS run added rather than about a count.
      const before = await sql<{ count: string }[]>`select count(*)::text as count from prl.quiz_attempts`;
      const startingRows = Number(before[0]?.count ?? '-1');
      assert.ok(startingRows >= 0, 'could not read prl.quiz_attempts');

      const guestApp = await contentApp();
      const memberApp = await contentApp({ userId });
      try {
        const guest = await attempt(guestApp, quizId, body, await csrfPair(guestApp));
        const member = await attempt(memberApp, quizId, body, await csrfPair(memberApp));

        assert.equal(guest.status, 200);
        assert.equal(member.status, 200);
        assert.equal(member.body['recorded'], true);
        assert.equal(guest.body['recorded'], false);

        // The point of the field, stated as an assertion: everything the learner is shown is the
        // same, and the only thing that differs is whether it was kept. No other field carried it,
        // and none could have.
        const withoutRecorded = (answered: Answered): Record<string, unknown> => {
          const { recorded: _recorded, ...rest } = answered.body;
          return rest;
        };
        assert.deepEqual(
          withoutRecorded(guest),
          withoutRecorded(member),
          'the graded half must be identical, or "recorded" is not the only difference and the ' +
            'client could have inferred attribution from something else',
        );
        assert.deepEqual(
          Object.keys(member.body)
            .sort()
            .filter((key) => !Object.keys(withoutRecorded(guest)).includes(key)),
          ['recorded'],
        );

        // The claim, checked against the table it is a claim about.
        const rows = await sql<{ question_id: string; was_correct: boolean }[]>`
        select question_id, was_correct from prl.quiz_attempts where user_id = ${userId}
      `;
        assert.equal(rows.length, 1, '`recorded: true` must mean exactly one row exists');
        assert.equal(rows[0]?.question_id, question.id);
        assert.equal(rows[0]?.was_correct, true);

        const after_ = await sql<{ count: string }[]>`select count(*)::text as count from prl.quiz_attempts`;
        assert.equal(
          Number(after_[0]?.count ?? '-1'),
          startingRows + 1,
          'the guest call must have added nothing: two answers went in, one row came out',
        );
      } finally {
        await guestApp.close();
        await memberApp.close();
        await sql`delete from prl.quiz_attempts where user_id = ${userId}`.catch(() => undefined);
        await sql`delete from prl.users where id = ${userId}`.catch(() => undefined);
      }
    },
  );
});

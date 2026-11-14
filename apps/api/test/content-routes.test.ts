/**
 * The content routes. A response carrying one learner's progress must never be cacheable, and the
 * shared resources get a strong ETag. Numeric answers are graded against a value recomputed from
 * `@prl/poker-math` (ADR 0006), and response key sets are exact so no score can be added.
 * `request.session` is set from a hook, the seam the auth plugin fills. Signed-in paths need a database.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { content, scenarioById, scenarios } from '@prl/content';
import type { QuizQuestion } from '@prl/contracts';
import { potOdds, ruleOf24 } from '@prl/poker-math';
import type { FastifyInstance } from 'fastify';
import { buildApp, registerRoutes } from '../src/app.ts';
import { DEFAULT_WORK_LIMITS } from '../src/calc/parse.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase, type DatabaseHandle, getSql } from '../src/db.ts';
import { isAppError } from '../src/errors.ts';
import { newLessonProgressId, newUserId } from '../src/repositories/ids.ts';
import contentRoutes, { consistencyOf, expectedValueFor } from '../src/routes/content.ts';
import progressRoutes from '../src/routes/progress.ts';
import { closeSharedPool, WorkerPool } from '../src/workers/pool.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const databaseTest = { skip: databaseSkip('the signed-in content paths that write rows') };

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

/** Decorating `session` is how `routes/progress.ts` tells "signed out" from "no auth module". */
function withSignedInCaller(app: FastifyInstance, userId: string): void {
  app.decorateRequest('session', null);
  app.decorateRequest('sessionRejection', null);
  app.addHook('preHandler', (request, _reply, done) => {
    request.session = {
      sessionId: 'ses_contentroutestest000000',
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
  const payload: { readonly token?: unknown } = body;
  const secret = response.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined);
  return { token: String(payload.token), cookie: `prl_csrf=${secret.value}` };
}

interface Fetched {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

async function get(
  app: FastifyInstance,
  url: string,
  headers: Record<string, string> = {},
): Promise<Fetched> {
  const response = await app.inject({ method: 'GET', url, headers });
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    flat[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  const raw = response.body;
  const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
  assert.ok(typeof parsed === 'object' && parsed !== null, `not an object: ${raw.slice(0, 120)}`);
  return { status: response.statusCode, headers: flat, raw, body: { ...parsed } };
}

async function post(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown>,
  csrf: Csrf,
): Promise<Fetched> {
  const response = await app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'x-csrf-token': csrf.token, cookie: csrf.cookie },
  });
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    flat[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  const parsed: unknown = response.body === '' ? {} : JSON.parse(response.body);
  assert.ok(typeof parsed === 'object' && parsed !== null);
  return { status: response.statusCode, headers: flat, raw: response.body, body: { ...parsed } };
}

function arrayAt(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  assert.ok(Array.isArray(value), `${key} should be an array in ${JSON.stringify(record).slice(0, 200)}`);
  return value;
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  assert.ok(typeof value === 'object' && value !== null, `${key} should be an object`);
  return { ...value };
}

function recordsAt(record: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
  return arrayAt(record, key).map((entry) => {
    assert.ok(typeof entry === 'object' && entry !== null);
    return { ...entry };
  });
}

function numericQuestion(quizId: string, questionId: string): Extract<QuizQuestion, { kind: 'numeric' }> {
  const quiz = content().quizzes.find((candidate) => candidate.id === quizId);
  assert.ok(quiz !== undefined, `no quiz ${quizId}`);
  const question = quiz.questions.find((candidate) => candidate.id === questionId);
  assert.ok(question !== undefined, `no question ${questionId}`);
  assert.equal(question.kind, 'numeric');
  assert.ok(question.kind === 'numeric');
  return question;
}

describe('content responses: what may be cached and what may not', () => {
  it('never lets a list carrying progress be cached, and never gives it a validator', async () => {
    const app = await contentApp();
    try {
      for (const url of ['/api/v1/content/lessons', '/api/v1/content/scenarios']) {
        const response = await get(app, url);
        assert.equal(response.status, 200, url);
        assert.equal(response.headers['cache-control'], 'no-store', `${url} must not be cacheable`);
        assert.equal(
          response.headers['etag'],
          undefined,
          `${url} differs per learner, so there is nothing an ETag could honestly mean`,
        );
      }
    } finally {
      await app.close();
    }
  });

  it('gives the immutable resources a strong ETag and answers a revalidation with 304', async () => {
    const app = await contentApp();
    try {
      const first = scenarios()[0];
      assert.ok(first !== undefined);
      const urls = [
        '/api/v1/content/glossary',
        `/api/v1/content/lessons/${content().lessons[0]?.id ?? ''}`,
        `/api/v1/content/scenarios/${first.id}`,
      ];

      for (const url of urls) {
        const fresh = await get(app, url);
        assert.equal(fresh.status, 200, url);
        const etag = fresh.headers['etag'] ?? '';
        assert.match(etag, /^"[^"]+"$/, `${url} should carry a strong ETag, got ${etag}`);
        assert.ok(!etag.startsWith('W/'), `${url} ETag must be strong, not weak`);
        assert.equal(fresh.headers['cache-control'], 'public, max-age=300', url);

        const revalidated = await get(app, url, { 'if-none-match': etag });
        assert.equal(revalidated.status, 304, `${url} should revalidate to 304`);
        assert.equal(revalidated.raw, '', 'a 304 carries no body');
        assert.equal(revalidated.headers['etag'], etag);

        // A GET uses weak comparison.
        const weak = await get(app, url, { 'if-none-match': `W/${etag}` });
        assert.equal(weak.status, 304, `${url} should accept the weak form of its own tag`);

        const stale = await get(app, url, { 'if-none-match': '"0.0.0-stale"' });
        assert.equal(stale.status, 200, `${url} should send the body when the validator is stale`);
        assert.equal(stale.headers['etag'], etag, 'the tag is a function of the bytes, so it is stable');
      }
    } finally {
      await app.close();
    }
  });

  it('answers 404 for content that does not exist, with the same code for each kind', async () => {
    const app = await contentApp();
    try {
      for (const url of [
        '/api/v1/content/lessons/no-such-lesson',
        '/api/v1/content/scenarios/no-such-scenario',
      ]) {
        const response = await get(app, url);
        assert.equal(response.status, 404, url);
        assert.equal(objectAt(response.body, 'error')['code'], 'content_not_found');
      }
    } finally {
      await app.close();
    }
  });
});

describe('reading lessons, scenarios and the glossary', () => {
  it('lists lessons in reading order with nothing ticked for an anonymous reader', async () => {
    const app = await contentApp();
    try {
      const response = await get(app, '/api/v1/content/lessons');
      const lessons = recordsAt(response.body, 'lessons');
      assert.ok(lessons.length > 0);
      for (const lesson of lessons) {
        assert.equal(lesson['completed'], false, 'an anonymous reader has completed nothing');
        assert.equal(typeof lesson['title'], 'string');
        assert.equal(typeof lesson['estimatedMinutes'], 'number');
      }
      const seen = new Set<string>();
      for (const lesson of lessons) {
        for (const prerequisite of arrayAt(lesson, 'prerequisites')) {
          const id = String(prerequisite);
          assert.ok(
            seen.has(id) || !lessons.some((candidate) => candidate['id'] === id),
            `${String(lesson['id'])} came before its prerequisite ${id}`,
          );
        }
        seen.add(String(lesson['id']));
      }
    } finally {
      await app.close();
    }
  });

  it('serves a lesson with its quiz and glossary terms', async () => {
    const app = await contentApp();
    try {
      const lesson = content().lessons.find((candidate) => candidate.quizId !== undefined);
      assert.ok(lesson !== undefined, 'the bundle should have at least one lesson with a quiz');
      const response = await get(app, `/api/v1/content/lessons/${lesson.id}`);
      assert.equal(response.status, 200);
      assert.equal(objectAt(response.body, 'lesson')['id'], lesson.id);
      assert.equal(objectAt(response.body, 'quiz')['id'], lesson.quizId);
      assert.ok(arrayAt(response.body, 'glossary').length > 0);
    } finally {
      await app.close();
    }
  });

  it('computes a scenario analysis live, with its assumptions and its method', async () => {
    const app = await contentApp();
    try {
      const scenario = scenarios()[0];
      assert.ok(scenario !== undefined);
      const response = await get(app, `/api/v1/content/scenarios/${scenario.id}`);
      assert.equal(response.status, 200);
      assert.equal(objectAt(response.body, 'scenario')['id'], scenario.id);

      const analysis = objectAt(response.body, 'analysis');
      assert.ok(arrayAt(analysis, 'assumptions').length > 0, 'no analysis without its assumptions');
      assert.ok(arrayAt(analysis, 'teachingNotes').length >= 0);
      const equity = objectAt(analysis, 'equity');
      assert.ok(['exact-enumeration', 'monte-carlo'].includes(String(equity['method'])));
      const uncertainty = objectAt(analysis, 'uncertainty');
      assert.equal(uncertainty['method'], equity['method'], 'the two must not disagree about the method');
      if (equity['method'] === 'exact-enumeration') {
        assert.equal(equity['confidenceHalfWidthPoints'], null);
        assert.equal(uncertainty['confidenceInterval'], null);
      } else {
        assert.notEqual(uncertainty['confidenceInterval'], null);
      }

      // ADR 0006. The stored scenario has no figures to serve.
      assert.equal(Object.keys(objectAt(response.body, 'scenario')).includes('equity'), false);

      const again = await get(app, `/api/v1/content/scenarios/${scenario.id}`);
      assert.equal(again.raw, response.raw);
    } finally {
      await app.close();
    }
  });
});

describe('POST /content/quizzes/:id/attempt', () => {
  /** A field the endpoint cannot compute in the declared unit is a 500 for one learner, so sweep all. */
  it('can compute the expected value for every numeric question in the bundle', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      let checked = 0;
      for (const quiz of content().quizzes) {
        for (const question of quiz.questions) {
          if (question.kind !== 'numeric') continue;
          checked += 1;
          const response = await post(
            app,
            `/api/v1/content/quizzes/${quiz.id}/attempt`,
            { questionId: question.id, answer: { kind: 'number', value: 0 } },
            csrf,
          );
          assert.equal(
            response.status,
            200,
            `${quiz.id}/${question.id} (${question.calculation.kind}.${question.field}): ` +
              `${JSON.stringify(response.body).slice(0, 300)}`,
          );
          const expected = objectAt(response.body, 'expected');
          assert.ok(
            Number.isFinite(Number(expected['value'])),
            `${question.id} produced a non-finite expected value`,
          );
          assert.equal(expected['unit'], question.unit, `${question.id} disagreed about its unit`);
          assert.equal(expected['tolerance'], question.tolerance);
          assert.equal(typeof response.body['correct'], 'boolean');
        }
      }
      assert.ok(checked >= 10, `expected the bundle to contain numeric questions, found ${checked}`);
    } finally {
      await app.close();
    }
  });

  /** `Math.abs(3.2 - 3)` is 0.20000000000000018, which a naive check marks wrong at `spr-q2`'s 0.2. */
  it('accepts an answer at exactly the stated tolerance, and refuses one past it', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      const attempt = async (quizId: string, questionId: string, value: number) =>
        post(
          app,
          `/api/v1/content/quizzes/${quizId}/attempt`,
          { questionId, answer: { kind: 'number', value } },
          csrf,
        );
      const refusedAtTheEdge: string[] = [];
      let checked = 0;
      for (const quiz of content().quizzes) {
        for (const question of quiz.questions) {
          if (question.kind !== 'numeric') continue;
          checked += 1;
          const probe = await attempt(quiz.id, question.id, 0);
          const value = Number(objectAt(probe.body, 'expected')['value']);
          // Typed to six decimals, rounded toward the value.
          // Rounding 30.769230… + 2 outward leaves the band.
          const typed = (x: number): number => {
            const rounded = Number(x.toFixed(6));
            if (Math.abs(rounded - value) <= Math.abs(x - value)) return rounded;
            return Number((rounded + (x > value ? -1e-6 : 1e-6)).toFixed(6));
          };
          for (const edge of [typed(value + question.tolerance), typed(value - question.tolerance)]) {
            const graded = await attempt(quiz.id, question.id, edge);
            if (graded.body['correct'] !== true)
              refusedAtTheEdge.push(`${question.id}: ${String(edge)} vs ${String(value)}`);
          }
          const past = await attempt(quiz.id, question.id, typed(value + question.tolerance * 1.5));
          assert.equal(past.body['correct'], false, `${question.id} accepted an answer past its tolerance`);
        }
      }
      assert.ok(checked >= 10, `expected the bundle to contain numeric questions, found ${checked}`);
      assert.deepEqual(refusedAtTheEdge, [], 'answers at exactly the stated tolerance were marked wrong');
    } finally {
      await app.close();
    }
  });

  it('grades a numeric answer against a value it computed, and returns no score', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      const question = numericQuestion('quiz-pot-odds', 'pot-odds-q2');
      assert.equal(question.calculation.kind, 'potOdds');
      assert.ok(question.calculation.kind === 'potOdds');

      // Computed independently, so a stored answer key in the endpoint would be caught.
      const expected = potOdds(question.calculation.pot, question.calculation.toCall).breakEvenEquity * 100;

      const right = await post(
        app,
        '/api/v1/content/quizzes/quiz-pot-odds/attempt',
        { questionId: question.id, answer: { kind: 'number', value: expected } },
        csrf,
      );
      assert.equal(right.status, 200);
      assert.equal(right.body['correct'], true);
      assert.equal(right.headers['cache-control'], 'no-store', 'an attempt is about one caller');

      const computed = objectAt(right.body, 'expected');
      assert.ok(
        Math.abs(Number(computed['value']) - expected) < 1e-9,
        'the reported value is the computed one',
      );
      assert.equal(computed['unit'], question.unit);
      assert.equal(computed['tolerance'], question.tolerance);
      assert.ok(
        String(right.body['explanation']).length > question.explanation.length,
        'the response should carry the working as well as the stored explanation',
      );

      // `recorded` says whether a row was written for this answer. It is not an aggregate.
      assert.deepEqual(Object.keys(right.body).sort(), ['correct', 'expected', 'explanation', 'recorded']);
      for (const forbidden of ['score', 'streak', 'total', 'percentage', 'grade', 'passed']) {
        assert.equal(right.body[forbidden], undefined, `there must be no ${forbidden} in the response`);
      }

      const wrong = await post(
        app,
        '/api/v1/content/quizzes/quiz-pot-odds/attempt',
        { questionId: question.id, answer: { kind: 'number', value: expected + question.tolerance + 5 } },
        csrf,
      );
      assert.equal(wrong.body['correct'], false, 'an answer outside the tolerance is not accepted');
      assert.equal(
        Number(objectAt(wrong.body, 'expected')['value']),
        Number(computed['value']),
        'the computed value does not depend on the answer',
      );
    } finally {
      await app.close();
    }
  });

  it('accepts an answer inside the tolerance and refuses one just outside it', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      // No sampling in the rule of 2 and 4, so the boundary is exact.
      const question = numericQuestion('quiz-rule-of-2-and-4', 'rule24-q2');
      assert.ok(question.calculation.kind === 'ruleOf24');
      const exact = ruleOf24(question.calculation.outs, question.calculation.cardsToCome).estimatePercent;

      const inside = await post(
        app,
        '/api/v1/content/quizzes/quiz-rule-of-2-and-4/attempt',
        { questionId: question.id, answer: { kind: 'number', value: exact - question.tolerance } },
        csrf,
      );
      assert.equal(inside.body['correct'], true);

      const outside = await post(
        app,
        '/api/v1/content/quizzes/quiz-rule-of-2-and-4/attempt',
        { questionId: question.id, answer: { kind: 'number', value: exact - question.tolerance - 0.01 } },
        csrf,
      );
      assert.equal(outside.body['correct'], false);
    } finally {
      await app.close();
    }
  });

  it('grades a multiple-choice answer and passes the option notes through', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      const quiz = content().quizzes.find((candidate) => candidate.id === 'quiz-pot-odds');
      assert.ok(quiz !== undefined);
      const question = quiz.questions.find((candidate) => candidate.kind === 'multipleChoice');
      assert.ok(question !== undefined && question.kind === 'multipleChoice');

      const right = await post(
        app,
        '/api/v1/content/quizzes/quiz-pot-odds/attempt',
        { questionId: question.id, answer: { kind: 'choice', index: question.correctIndex } },
        csrf,
      );
      assert.equal(right.body['correct'], true);
      assert.equal(right.body['expected'], undefined, 'there is nothing to compute for a choice');

      const wrongIndex = question.correctIndex === 0 ? 1 : 0;
      const wrong = await post(
        app,
        '/api/v1/content/quizzes/quiz-pot-odds/attempt',
        { questionId: question.id, answer: { kind: 'choice', index: wrongIndex } },
        csrf,
      );
      assert.equal(wrong.body['correct'], false);
      assert.equal(
        String(wrong.body['explanation']),
        question.explanation,
        'a choice question explains itself; there is no working to add',
      );
    } finally {
      await app.close();
    }
  });

  it('refuses an answer of the wrong kind, naming the field', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      const response = await post(
        app,
        '/api/v1/content/quizzes/quiz-pot-odds/attempt',
        { questionId: 'pot-odds-q2', answer: { kind: 'choice', index: 1 } },
        csrf,
      );
      assert.equal(response.status, 400);
      const error = objectAt(response.body, 'error');
      assert.equal(error['code'], 'invalid_request');
      const fields = objectAt(error, 'fields');
      assert.match(String(fields['answer.kind']), /"number" answer/);
    } finally {
      await app.close();
    }
  });

  it('answers 404 for an unknown quiz or an unknown question inside a known quiz', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      const unknownQuiz = await post(
        app,
        '/api/v1/content/quizzes/no-such-quiz/attempt',
        { questionId: 'pot-odds-q2', answer: { kind: 'number', value: 1 } },
        csrf,
      );
      assert.equal(unknownQuiz.status, 404);

      const unknownQuestion = await post(
        app,
        '/api/v1/content/quizzes/quiz-pot-odds/attempt',
        { questionId: 'no-such-question', answer: { kind: 'number', value: 1 } },
        csrf,
      );
      assert.equal(unknownQuestion.status, 404);
      assert.equal(objectAt(unknownQuestion.body, 'error')['code'], 'content_not_found');
    } finally {
      await app.close();
    }
  });

  it('fails loudly when a question declares a unit its field does not produce', async () => {
    // Unchecked, a unit mismatch would mark 33.3 wrong and 0.333 right for every learner.
    const pool = new WorkerPool({ size: 1, timeoutMs: 1_000 });
    try {
      const broken: Extract<QuizQuestion, { kind: 'numeric' }> = {
        kind: 'numeric',
        id: 'synthetic-unit-mismatch',
        prompt: 'what is the price?',
        calculation: { kind: 'potOdds', pot: 100, toCall: 50 },
        field: 'breakEvenEquity',
        unit: 'chips',
        tolerance: 1,
        explanation: 'synthetic',
      };
      await assert.rejects(
        () => expectedValueFor(broken, pool, DEFAULT_WORK_LIMITS),
        (error: unknown) => isAppError(error) && error.code === 'internal_error',
      );

      const missingField: Extract<QuizQuestion, { kind: 'numeric' }> = {
        ...broken,
        field: 'notAField',
        unit: 'percent',
      };
      await assert.rejects(
        () => expectedValueFor(missingField, pool, DEFAULT_WORK_LIMITS),
        (error: unknown) => isAppError(error) && error.code === 'internal_error',
      );
    } finally {
      await pool.close();
    }
  });
});

describe('POST /content/scenarios/:id/attempt', () => {
  it('reports consistency with the analysis rather than a grade', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      const scenario = scenarios()[0];
      assert.ok(scenario !== undefined);

      const response = await post(
        app,
        `/api/v1/content/scenarios/${scenario.id}/attempt`,
        { action: 'call' },
        csrf,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(
        Object.keys(response.body).sort(),
        ['analysis', 'commonMistakes', 'consistentWithAnalysis', 'reasoning', 'recorded'],
        'exactly the contract, and nothing that could be read as a mark',
      );
      assert.equal(typeof response.body['recorded'], 'boolean');
      assert.ok(String(response.body['reasoning']).length > 0);
      assert.ok(arrayAt(response.body, 'commonMistakes').length > 0);
      assert.ok(arrayAt(objectAt(response.body, 'analysis'), 'assumptions').length > 0);
      for (const forbidden of ['score', 'correct', 'passed', 'grade']) {
        assert.equal(response.body[forbidden], undefined, `there must be no ${forbidden}`);
      }
    } finally {
      await app.close();
    }
  });

  it('says so plainly when the chosen action is not even available', async () => {
    const app = await contentApp();
    try {
      const csrf = await csrfPair(app);
      const scenario = scenarios().find((candidate) => candidate.toCall > 0);
      assert.ok(scenario !== undefined);
      const response = await post(
        app,
        `/api/v1/content/scenarios/${scenario.id}/attempt`,
        { action: 'check' },
        csrf,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body['consistentWithAnalysis'], false);
      assert.match(String(response.body['reasoning']), /not one of the actions available/);
    } finally {
      await app.close();
    }
  });

  /**
   * The check is in the route, not only in the write, or an anonymous reader would get 200 and a
   * signed-in learner 400 for the same request. The signed-in case never reaches the insert.
   */
  it('refuses a bet or a raise with no sizing, for signed-in and anonymous callers alike', async () => {
    const scenario = scenarios()[0];
    assert.ok(scenario !== undefined);
    for (const userId of [undefined, 'usr_sizingtest000000000000']) {
      const app = await contentApp(userId === undefined ? {} : { userId });
      try {
        const csrf = await csrfPair(app);
        for (const action of ['bet', 'raise']) {
          const response = await post(
            app,
            `/api/v1/content/scenarios/${scenario.id}/attempt`,
            { action },
            csrf,
          );
          assert.equal(response.status, 400, `${action} with no sizing, caller=${String(userId)}`);
          const error = objectAt(response.body, 'error');
          assert.equal(error['code'], 'invalid_request');
          assert.match(String(objectAt(error, 'fields')['to']), /required for a bet or a raise/);
        }
      } finally {
        await app.close();
      }
    }
  });

  it('measures consistency against folding, not against the highest-value action', async () => {
    // A profitable call stays consistent even when a raise scores higher under an assumed fold rate.
    const app = await contentApp();
    try {
      const scenario = scenarios().find((candidate) =>
        candidate.expectedInsight.some((claim) => claim.kind === 'equityExceedsBreakEven'),
      );
      assert.ok(scenario !== undefined, 'the bundle should contain a profitable-call scenario');
      const response = await get(app, `/api/v1/content/scenarios/${scenario.id}`);
      const analysis = objectAt(response.body, 'analysis');
      const candidates = recordsAt(analysis, 'candidates');
      const call = candidates.find((candidate) => candidate['action'] === 'call');
      assert.ok(call !== undefined, 'a spot with something to call offers a call');
      assert.ok(Number(call['ev']) > 0, 'the scenario claims the call is profitable');

      const attempt = await post(
        app,
        `/api/v1/content/scenarios/${scenario.id}/attempt`,
        { action: 'call' },
        await csrfPair(app),
      );
      assert.equal(
        attempt.body['consistentWithAnalysis'],
        true,
        'a call the maths says is profitable must read as consistent',
      );
    } finally {
      await app.close();
    }
  });

  it('treats a spot with several defensible actions as making no single claim', async () => {
    // `claimsOneAction` decides whether a NULL goes into the database.
    const app = await contentApp();
    try {
      const scenario = scenarios()[0];
      assert.ok(scenario !== undefined);
      const response = await get(app, `/api/v1/content/scenarios/${scenario.id}`);
      const analysisJson: unknown = JSON.parse(response.raw);
      assert.ok(typeof analysisJson === 'object' && analysisJson !== null && 'analysis' in analysisJson);
      const container: { readonly analysis?: unknown } = analysisJson;
      const report = container.analysis;
      assert.ok(typeof report === 'object' && report !== null);
      const stored = scenarioById(scenario.id);
      assert.ok(stored !== null);
      const outcome = consistencyOf(JSON.parse(JSON.stringify(report)), 'fold', undefined, stored.bigBlind);
      assert.equal(typeof outcome.consistent, 'boolean');
      assert.equal(typeof outcome.claimsOneAction, 'boolean');
      assert.ok(outcome.reasoning.length > 0);
    } finally {
      await app.close();
    }
  });
});

describe('GET /me/progress', () => {
  it('refuses an anonymous caller rather than inventing an empty record', async () => {
    const app = await contentApp();
    try {
      const response = await get(app, '/api/v1/me/progress');
      assert.equal(response.status, 401);
      assert.equal(objectAt(response.body, 'error')['code'], 'not_authenticated');
      assert.equal(response.headers['cache-control'], 'no-store');
    } finally {
      await app.close();
    }
  });
});

describe('the signed-in paths', () => {
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

  it('records an attempt, reflects it in the lists, and counts it in progress', databaseTest, async () => {
    database();
    const sql = getSql();
    const userId = newUserId();
    await sql`insert into prl.users (id, kind, display_name) values (${userId}, 'guest', 'Test Learner')`;

    const app = await contentApp({ userId });
    try {
      const csrf = await csrfPair(app);
      const scenario = scenarios()[0];
      assert.ok(scenario !== undefined);

      const attempt = await post(
        app,
        `/api/v1/content/scenarios/${scenario.id}/attempt`,
        { action: 'call' },
        csrf,
      );
      assert.equal(attempt.status, 200);

      const question = numericQuestion('quiz-pot-odds', 'pot-odds-q2');
      const quizAttempt = await post(
        app,
        '/api/v1/content/quizzes/quiz-pot-odds/attempt',
        { questionId: question.id, answer: { kind: 'number', value: 33.3 } },
        csrf,
      );
      assert.equal(quizAttempt.status, 200);
      await post(
        app,
        '/api/v1/content/quizzes/quiz-pot-odds/attempt',
        { questionId: question.id, answer: { kind: 'number', value: 12 } },
        csrf,
      );

      const rows = await sql<{ scenario_id: string; matched_expected: boolean | null }[]>`
        select scenario_id, matched_expected from prl.scenario_attempts where user_id = ${userId}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.scenario_id, scenario.id);

      const answers = await sql<{ was_correct: boolean }[]>`
        select was_correct from prl.quiz_attempts where user_id = ${userId} order by created_at
      `;
      assert.equal(answers.length, 2);
      assert.equal(answers[0]?.was_correct, true);
      assert.equal(answers[1]?.was_correct, false);

      // This module only reads lesson progress, so the row is inserted directly.
      const lesson = content().lessons[0];
      assert.ok(lesson !== undefined);
      await sql`
        insert into prl.lesson_progress (id, user_id, lesson_id, completed_at)
        values (${newLessonProgressId()}, ${userId}, ${lesson.id}, now())
      `;

      const lessons = await get(app, '/api/v1/content/lessons');
      const listed = recordsAt(lessons.body, 'lessons').find((entry) => entry['id'] === lesson.id);
      assert.equal(listed?.['completed'], true, 'the list should reflect the completed lesson');

      const scenarioList = await get(app, '/api/v1/content/scenarios');
      const listedScenario = recordsAt(scenarioList.body, 'scenarios').find(
        (entry) => entry['id'] === scenario.id,
      );
      assert.equal(listedScenario?.['attempted'], true);

      const progress = await get(app, '/api/v1/me/progress');
      assert.equal(progress.status, 200);
      assert.equal(progress.headers['cache-control'], 'no-store');
      assert.deepEqual(arrayAt(progress.body, 'lessonsCompleted'), [lesson.id]);
      assert.deepEqual(arrayAt(progress.body, 'scenariosAttempted'), [scenario.id]);
      assert.equal(progress.body['quizQuestionsAnswered'], 1, 'distinct questions, not attempts');
      assert.equal(progress.body['handsPlayed'], 0);
      assert.equal(progress.body['unitsNetLifetime'], 0);
      assert.deepEqual(
        arrayAt(progress.body, 'topicsTouched').map(String).sort(),
        [...new Set([lesson.topic, scenario.topic])].sort(),
      );
      assert.deepEqual(Object.keys(progress.body).sort(), [
        'handsPlayed',
        'lessonsCompleted',
        'quizQuestionsAnswered',
        'scenariosAttempted',
        'topicsTouched',
        'unitsNetLifetime',
      ]);
    } finally {
      await app.close();
      await sql`delete from prl.users where id = ${userId}`;
    }
  });
});

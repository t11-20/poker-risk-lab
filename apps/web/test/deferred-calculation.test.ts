/**
 * A deferred lesson figure is computed on a worker, and the worker's figure must be the main thread's
 * to the bit. The real worker module runs on a real thread, so its reply crosses the same structured
 * clone a browser's `postMessage` uses.
 */

import assert from 'node:assert/strict';
import { on } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { lessons, quizzes } from '@prl/content';
import type { Lesson, LiveCalculation, Quiz } from '@prl/contracts';
import { LEARN_LESSONS } from '../src/fixtures/learn-lessons.ts';
import { LEARN_QUIZZES } from '../src/fixtures/learn-quizzes.ts';
import {
  type CalculationReply,
  type CalculationThread,
  computeDeferred,
  type DeferredHost,
} from '../src/lib/deferred-calculation.ts';
import { type CalculationOutcome, computeCalculation, isDeferred } from '../src/lib/learn-calculations.ts';

const WORKER_FILE = fileURLToPath(new URL('../src/lib/calculation-worker.ts', import.meta.url));

function deferredIn(from: string, lessonList: readonly Lesson[], quizList: readonly Quiz[]) {
  const found: { readonly where: string; readonly calculation: LiveCalculation }[] = [];
  for (const lesson of lessonList) {
    for (const block of lesson.blocks) {
      if (block.kind === 'liveCalculation' && isDeferred(block.calculation)) {
        found.push({ where: `${from} lesson ${lesson.id}`, calculation: block.calculation });
      }
    }
  }
  for (const quiz of quizList) {
    for (const question of quiz.questions) {
      if (question.kind === 'numeric' && isDeferred(question.calculation)) {
        found.push({ where: `${from} quiz ${quiz.id} ${question.id}`, calculation: question.calculation });
      }
    }
  }
  return found;
}

const DEFERRED = [
  ...deferredIn('content', lessons(), quizzes()),
  ...deferredIn('bundled', LEARN_LESSONS, LEARN_QUIZZES),
];

/** The browser's worker globals, backed by `parentPort`, then the real worker module. */
const SHIM = `
const { parentPort, workerData } = require('node:worker_threads');
globalThis.addEventListener = (type, listener) => {
  if (type === 'message') parentPort.on('message', (data) => listener({ data }));
};
globalThis.postMessage = (message) => parentPort.postMessage(message);
import(workerData.entry).then(() => parentPort.postMessage('ready'));
`;

/** One reply per request, in order; `on` rejects if the thread raises `error`. */
async function onWorker(calculations: readonly LiveCalculation[]): Promise<CalculationOutcome[]> {
  const thread = new Worker(SHIM, { eval: true, workerData: { entry: WORKER_FILE } });
  const messages = on(thread, 'message');
  try {
    assert.deepEqual((await messages.next()).value, ['ready']);
    const outcomes: CalculationOutcome[] = [];
    for (const calculation of calculations) {
      thread.postMessage({ calculation });
      const [reply] = (await messages.next()).value as [CalculationReply];
      outcomes.push(reply.outcome);
    }
    return outcomes;
  } finally {
    await thread.terminate();
  }
}

describe('a deferred lesson figure, computed on the worker', () => {
  it('matches the main thread exactly for every deferred calculation in every lesson and quiz', async () => {
    assert.ok(
      DEFERRED.some((entry) => entry.where === 'content lesson hand-flow'),
      `premise: hand-flow is deferred; found ${DEFERRED.map((entry) => entry.where).join(', ')}`,
    );
    const outcomes = await onWorker(DEFERRED.map((entry) => entry.calculation));
    assert.equal(outcomes.length, DEFERRED.length);
    DEFERRED.forEach((entry, index) => {
      const here = computeCalculation(entry.calculation);
      assert.ok(here.ok, `premise: ${entry.where} computes`);
      // Strict, so -0 against 0 or a lost property would fail.
      assert.deepStrictEqual(outcomes[index], here, entry.where);
    });
  });

  it('control: the comparison catches a figure one ulp away', () => {
    const here = computeCalculation(SAMPLE);
    assert.ok(here.ok);
    const lead = here.result.figures[0];
    assert.ok(lead !== undefined);
    const moved = {
      ...here,
      result: {
        ...here.result,
        figures: [
          { ...lead, value: lead.value + Number.EPSILON * lead.value },
          ...here.result.figures.slice(1),
        ],
      },
    };
    assert.notEqual(moved.result.figures[0]?.value, lead.value);
    assert.throws(() => assert.deepStrictEqual(moved, here));
  });

  it('the lesson hook hands deferred work to the worker, not to a main-thread timer', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/components/LiveCalculation.tsx', import.meta.url)),
      'utf8',
    );
    assert.ok(existsSync(WORKER_FILE));
    assert.match(source, /new Worker\(new URL\('\.\.\/lib\/calculation-worker\.ts', import\.meta\.url\)/u);
    assert.match(source, /return computeDeferred\(calculation, BROWSER_HOST, setComputed\);/u);
  });
});

const SAMPLE = DEFERRED[0]?.calculation ?? { kind: 'potOdds', pot: 10, toCall: 5 };
const ANSWER: CalculationOutcome = { ok: false, reason: 'from the worker' };
const HERE: CalculationOutcome = { ok: false, reason: 'from the main thread' };

class FakeThread implements CalculationThread {
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  posted = 0;
  terminated = false;
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(): void {
    this.posted += 1;
  }
  terminate(): void {
    this.terminated = true;
  }
  fire(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as unknown as Event);
  }
}

function harness(start: () => CalculationThread | null) {
  const timers: (() => void)[] = [];
  let computedHere = 0;
  const outcomes: CalculationOutcome[] = [];
  const host: DeferredHost = {
    startThread: start,
    computeHere: () => {
      computedHere += 1;
      return HERE;
    },
    later: (run) => {
      timers.push(run);
      return () => {
        const at = timers.indexOf(run);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  };
  const cancel = computeDeferred(SAMPLE, host, (outcome) => outcomes.push(outcome));
  return {
    cancel,
    outcomes,
    runTimers: () => {
      for (const run of timers.splice(0)) run();
    },
    computedHere: () => computedHere,
  };
}

describe('computeDeferred', () => {
  it('never computes on the main thread when the worker answers', () => {
    const thread = new FakeThread();
    const run = harness(() => thread);
    run.runTimers();
    assert.equal(thread.posted, 1);
    thread.fire('message', { outcome: ANSWER });
    run.runTimers();
    assert.equal(run.computedHere(), 0);
    assert.deepEqual(run.outcomes, [ANSWER]);
    assert.equal(thread.terminated, true);
  });

  it('computes here, after a timer, when workers are unavailable or cannot start', () => {
    for (const start of [
      () => null,
      () => {
        throw new Error('blocked');
      },
    ]) {
      const run = harness(start);
      assert.deepEqual(run.outcomes, [], 'not during the render that mounted it');
      run.runTimers();
      assert.deepEqual(run.outcomes, [HERE]);
    }
  });

  it('computes here once when the worker fails to load or to deliver', () => {
    for (const failure of ['error', 'messageerror']) {
      const thread = new FakeThread();
      const run = harness(() => thread);
      thread.fire(failure);
      thread.fire('error');
      assert.equal(thread.terminated, true);
      run.runTimers();
      assert.equal(run.computedHere(), 1, failure);
      assert.deepEqual(run.outcomes, [HERE]);
    }
  });

  it('reports nothing after it is cancelled', () => {
    const thread = new FakeThread();
    const run = harness(() => thread);
    run.cancel();
    thread.fire('message', { outcome: ANSWER });
    assert.equal(thread.terminated, true);
    assert.deepEqual(run.outcomes, []);

    const fallback = harness(() => null);
    fallback.cancel();
    fallback.runTimers();
    assert.deepEqual(fallback.outcomes, []);
  });
});

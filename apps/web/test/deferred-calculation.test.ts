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
  type ComputedOn,
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
    assert.match(
      source,
      /return computeDeferred\(calculation, BROWSER_HOST, \(outcome, on\) => setComputed\(/u,
    );
    assert.match(source, /data-computed=\{computedOn \?\? undefined\}/u);
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

/** `cancelable: false` is a timer whose task was already queued when it was cleared. */
function harness(start: () => CalculationThread | null, { cancelable = true } = {}) {
  const timers: (() => void)[] = [];
  let computedHere = 0;
  const outcomes: CalculationOutcome[] = [];
  const computedOn: ComputedOn[] = [];
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
        if (cancelable && at >= 0) timers.splice(at, 1);
      };
    },
  };
  const cancel = computeDeferred(SAMPLE, host, (outcome, on) => {
    outcomes.push(outcome);
    computedOn.push(on);
  });
  return {
    cancel,
    outcomes,
    computedOn,
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
    assert.deepEqual(run.computedOn, ['worker']);
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
      assert.deepEqual(run.computedOn, ['here']);
    }
  });

  for (const failure of ['error', 'messageerror']) {
    it(`computes here once when the worker raises ${failure}`, () => {
      const thread = new FakeThread();
      const run = harness(() => thread);
      thread.fire(failure);
      assert.equal(thread.terminated, true, failure);
      assert.equal(run.computedHere(), 0, 'not before the timer');
      run.runTimers();
      assert.equal(run.computedHere(), 1, failure);
      assert.deepEqual(run.outcomes, [HERE]);
      assert.deepEqual(run.computedOn, ['here']);
    });
  }

  it('computes here once when the worker raises both failures', () => {
    const thread = new FakeThread();
    const run = harness(() => thread);
    thread.fire('messageerror');
    thread.fire('error');
    run.runTimers();
    assert.equal(run.computedHere(), 1);
    assert.deepEqual(run.outcomes, [HERE]);
  });

  it('does not compute here when a worker reply lands after a failure scheduled the fallback', () => {
    const thread = new FakeThread();
    const run = harness(() => thread);
    thread.fire('error');
    thread.fire('message', { outcome: ANSWER });
    run.runTimers();
    assert.equal(run.computedHere(), 0);
    assert.deepEqual(run.outcomes, [ANSWER]);
  });

  it('computes and reports nothing after it is cancelled', () => {
    const thread = new FakeThread();
    const run = harness(() => thread);
    run.cancel();
    thread.fire('message', { outcome: ANSWER });
    thread.fire('error');
    run.runTimers();
    assert.equal(thread.terminated, true);
    assert.equal(run.computedHere(), 0);
    assert.deepEqual(run.outcomes, []);

    for (const cancelable of [true, false]) {
      const fallback = harness(() => null, { cancelable });
      fallback.cancel();
      fallback.runTimers();
      assert.equal(fallback.computedHere(), 0, `cancelable: ${String(cancelable)}`);
      assert.deepEqual(fallback.outcomes, []);

      const failed = new FakeThread();
      const late = harness(() => failed, { cancelable });
      failed.fire('error');
      late.cancel();
      late.runTimers();
      assert.equal(late.computedHere(), 0, `after a failure, cancelable: ${String(cancelable)}`);
      assert.deepEqual(late.outcomes, []);
    }
  });
});

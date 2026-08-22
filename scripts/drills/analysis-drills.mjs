/**
 * The drills that break the calculation threads: one that dies without warning, and one that
 * refuses to finish.
 *
 * ## Why the crash drill runs the pool in a child rather than in the API
 *
 * A worker thread cannot be killed from outside its own process — there is no pid, no signal,
 * and no handle. The only ways to make one die are to be inside the process, or to give it a
 * script that kills itself. `WorkerPool` has a documented seam for the second (`workerUrl`, "test
 * seam: a different worker script"), so this drill writes a worker that exits mid-task, points a
 * REAL `WorkerPool` at it in a child process, and checks what the pool does about it.
 *
 * That is a real failure injection against the real production class, and it is worth being
 * precise about what it is not: it does not prove the shipped `equity-worker.ts` can crash. It
 * cannot, as far as this drill can tell — every path in that file catches and replies with a
 * `WorkerFailure`, which is a *handled* failure and a different code path entirely. So the drill
 * also asks the live server for a real calculation afterwards, and reports that the surface a
 * user touches is unaffected.
 *
 * ## The timeout drill is the opposite shape
 *
 * `slow-simulation` needs no seam at all: the heaviest calculation the endpoint will accept,
 * against a budget measured to be well below what it costs, genuinely overruns — and the pool's
 * answer to that is `worker.terminate()`, which is a thread dying mid-task inside the real
 * server, on the real path, with a real client waiting. So between them the two drills cover both
 * halves: a thread that dies unexpectedly, and a thread the server itself kills.
 *
 * That budget is MEASURED and not written down, because writing it down is how this drill first
 * passed while proving nothing: at a fixed 150 ms the heaviest permitted request finished in
 * 134 ms on this machine and the drill reported a timeout that never happened.
 *
 * Both check the same three things afterwards: the process survived, the pool refilled, and the
 * next caller got an answer. A pool that leaks a thread per failure is invisible until the day
 * it has none left.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { newReport, REPO_ROOT, ROUTES, Session, sleep } from './harness.mjs';
import { logLine, scanForSecrets, scanTextForSecrets } from './invariants.mjs';

/**
 * The seed the stub worker treats as "die now".
 *
 * A value rather than "always crash", because the point of the drill is RECOVERY: a worker that
 * crashes on every task proves the pool notices and nothing else. One poisoned task followed by
 * a healthy one is what distinguishes a pool that replaces a dead thread from one that merely
 * survives the first death.
 */
const POISON_SEED = 999;

/** A worker script that exits mid-task, the way an OOM or a native fault would. */
const CRASH_WORKER = `import { parentPort } from 'node:worker_threads';

// A calculator stub, and a deliberately fatal one for a single task. Exiting rather than throwing
// is the point: a throw arrives at the pool as an 'error' event with a stack, while an exit is a
// thread that is simply gone, which is what a crash actually looks like.
parentPort.on('message', (request) => {
  if (request?.task?.seed === ${POISON_SEED}) process.exit(7);
  parentPort.postMessage({
    id: request.id,
    ok: true,
    kind: 'equity',
    result: { marker: 'served-by-a-replacement-thread', method: 'monte-carlo', trials: 1, assumptions: [] },
  });
});
`;

/** The driver: a real `WorkerPool`, the stub worker, one poisoned task and one healthy one. */
function driverSource(poolPath, workerPath) {
  return `import { WorkerPool } from ${JSON.stringify(poolPath)};

const warnings = [];
const pool = new WorkerPool({
  size: 1,
  timeoutMs: 5000,
  workerUrl: new URL(${JSON.stringify(workerPath)}),
  onWarn: (warning) => warnings.push(warning),
});

const spec = { heroCards: [], board: [], opponents: [] };
const task = (seed) => ({ spec, method: 'monte-carlo', samples: 10, shards: 1, seed });
const out = { crashed: null, recovered: null, warnings: [], stats: null };

try {
  await pool.runEquity(task(${POISON_SEED}));
  out.crashed = 'resolved';
} catch (error) {
  out.crashed = error?.code ?? error?.name ?? String(error);
}
try {
  const result = await pool.runEquity(task(1));
  out.recovered = result?.marker ?? 'ok';
} catch (error) {
  out.recovered = 'failed: ' + (error?.code ?? String(error));
}
out.stats = pool.stats();
out.warnings = warnings;
console.log(JSON.stringify(out));
await pool.close();
`;
}

// ---------------------------------------------------------------------------
// 8. A simulation worker that crashes
// ---------------------------------------------------------------------------

export const workerCrash = {
  name: 'worker-crash',
  title: 'A simulation worker thread that dies mid-task',
  async run(ctx) {
    const report = newReport();
    const directory = await mkdtemp(join(tmpdir(), 'prl-drill-worker-'));
    ctx.cleanup(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    const workerPath = join(directory, 'crash-worker.mjs');
    const driverPath = join(directory, 'driver.mjs');
    const poolPath = pathToFileURL(join(REPO_ROOT, 'apps', 'api', 'src', 'workers', 'pool.ts')).href;
    await writeFile(workerPath, CRASH_WORKER, 'utf8');
    await writeFile(driverPath, driverSource(poolPath, pathToFileURL(workerPath).href), 'utf8');

    const started = performance.now();
    const driver = await new Promise((done) => {
      const child = spawn(process.execPath, [driverPath], {
        cwd: REPO_ROOT,
        env: { ...process.env, NODE_ENV: 'development' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', (code) => done({ code, stdout, stderr }));
    });
    report.measurements.driverExitCode = driver.code;
    report.measurements.driverElapsedMs = Math.round(performance.now() - started);

    if (driver.code !== 0) {
      report.failures.push(
        `the process hosting the pool exited ${String(driver.code)}: a worker thread dying took the ` +
          `host down with it. Output:\n${(driver.stderr || driver.stdout).slice(-600)}`,
      );
      return report;
    }

    let outcome = null;
    try {
      outcome = JSON.parse(driver.stdout.trim().split('\n').at(-1) ?? '');
    } catch {
      report.failures.push(`the driver produced no readable result: ${driver.stdout.slice(-400)}`);
      return report;
    }

    report.measurements.crashedTaskOutcome = outcome.crashed;
    report.measurements.recoveredTaskOutcome = outcome.recovered;
    if (outcome.crashed === 'resolved') {
      report.failures.push('the task whose thread died resolved successfully, which cannot be right');
    } else if (outcome.crashed !== 'internal_error') {
      report.warnings.push(`the crashed task rejected with "${String(outcome.crashed)}", not internal_error`);
    } else {
      report.observations.push('the task whose thread died was rejected internal_error, not left pending');
    }

    if (outcome.recovered !== 'served-by-a-replacement-thread') {
      report.failures.push(
        `the next task after the crash returned "${String(outcome.recovered)}"; the pool did not ` +
          'replace the dead thread',
      );
    } else {
      report.observations.push('the pool spawned a replacement thread and the next task was served');
    }

    const stats = outcome.stats ?? {};
    report.measurements.poolStatsAfterCrash =
      `workers=${String(stats.workers)} busy=${String(stats.busy)} failed=${String(stats.failed)} ` +
      `completed=${String(stats.completed)}`;
    if (stats.failed !== 1) {
      report.warnings.push(`the pool counted ${String(stats.failed)} failures for one crash`);
    }
    if (stats.workers > 1) {
      report.failures.push(
        `${String(stats.workers)} threads are alive for a pool of size 1, so the dead thread was ` +
          'counted but never discarded',
      );
    }
    const events = (outcome.warnings ?? []).map((warning) => `${warning.event}: ${warning.detail}`);
    if (events.length === 0) {
      report.failures.push(
        'the pool reported nothing to its onWarn hook, so an operator would see no log line',
      );
    } else {
      report.evidence.push({ label: 'what the pool reported', text: events.join(' | ').slice(0, 200) });
    }
    report.failures.push(...scanForSecrets(outcome, 'the pool driver output'));

    // The live surface, in the real server, with the real worker script.
    const server = await ctx.startServer();
    const session = new Session(server.origin, ctx.webOrigin, 'Worker drill');
    await session.createGuest();
    const equity = await session.request(ROUTES.equity, {
      method: 'POST',
      body: { heroCards: 'AhAd', opponents: ['KsKc'], samples: 2_000 },
    });
    if (!equity.ok) {
      report.failures.push(`the live equity endpoint answered ${equity.status} after the crash drill`);
    } else {
      report.observations.push('the live server serves a real Monte Carlo request on its own worker pool');
    }
    report.failures.push(...scanForSecrets(equity.body, 'the equity response'));
    return report;
  },
};

// ---------------------------------------------------------------------------
// 9. A simulation that exceeds COACH_TIMEOUT_MS
// ---------------------------------------------------------------------------

/** The smallest `COACH_TIMEOUT_MS` that `config.ts` accepts. The budget cannot go below it. */
const MINIMUM_BUDGET_MS = 100;

/**
 * The two heaviest requests `POST /math/equity` will accept, and they are heavy in different ways.
 *
 * The first is planned as an EXACT enumeration: two known hands preflop is 3.42 million hand
 * evaluations, under `maxExactEvaluations` (4 million), so the sample count is ignored entirely.
 * The second is genuinely sampled — five players is far past the exact ceiling — and 200,000
 * samples against five players is exactly `maxSampledEvaluations` (1 million). Between them they
 * are the most work a caller can buy through this endpoint, which is what the drill needs: the
 * budget has a floor of 100 ms, so a request that cannot be made to take meaningfully longer
 * than that cannot exercise the timeout at all.
 */
const HEAVY_REQUESTS = [
  { label: 'exact enumeration', body: { heroCards: 'AhAd', opponents: ['KsKc'], samples: 200_000 } },
  {
    label: 'sampled five-way',
    body: { heroCards: 'AhAd', opponents: ['KsKc', 'QsQc', 'JsJc', 'TsTc'], samples: 200_000 },
  },
];

export const slowSimulation = {
  name: 'slow-simulation',
  title: 'A simulation that exceeds COACH_TIMEOUT_MS',
  async run(ctx) {
    const report = newReport();

    /** One equity request against a given server, timed from the caller's side. */
    const ask = async (session, body) => {
      const startedAt = performance.now();
      const response = await session.request(ROUTES.equity, { method: 'POST', body });
      return { ...response, waitedMs: performance.now() - startedAt };
    };

    // --- calibration ---------------------------------------------------------
    //
    // The budget is measured rather than guessed, and that is the whole reason this drill has two
    // servers. A fixed budget is a bet on how fast the machine is: written at 150 ms it passed on
    // one machine and, on this one, watched the heaviest permitted request finish in 134 ms and
    // report a timeout drill that had timed nothing out. So the first server measures what the
    // heaviest request actually costs here, and the second is configured from that measurement.
    const calibrationServer = await ctx.startServer({ env: { COACH_TIMEOUT_MS: '25000' } });
    const calibrationSession = new Session(calibrationServer.origin, ctx.webOrigin, 'Calibration');
    await calibrationSession.createGuest();
    // Once to warm a thread, so the measurement is of the calculation and not of a module import.
    await ask(calibrationSession, HEAVY_REQUESTS[0].body);

    let heaviest = null;
    for (const candidate of HEAVY_REQUESTS) {
      const measured = await ask(calibrationSession, candidate.body);
      report.measurements[`calibration_${candidate.label.replaceAll(' ', '_')}Ms`] = Math.round(
        measured.waitedMs,
      );
      if (!measured.ok) {
        report.warnings.push(`${candidate.label} was refused ${measured.status} during calibration`);
        continue;
      }
      if (heaviest === null || measured.waitedMs > heaviest.waitedMs) {
        heaviest = { ...candidate, waitedMs: measured.waitedMs };
      }
    }
    await calibrationServer.stop();

    if (heaviest === null) {
      report.failures.push('no heavy calculation was accepted at all, so nothing could be timed out');
      return report;
    }
    const coachTimeoutMs = Math.max(MINIMUM_BUDGET_MS, Math.floor(heaviest.waitedMs * 0.4));
    report.measurements.heaviestRequest = heaviest.label;
    report.measurements.heaviestRequestMs = Math.round(heaviest.waitedMs);
    report.measurements.coachTimeoutMs = coachTimeoutMs;
    if (heaviest.waitedMs < coachTimeoutMs * 1.5) {
      report.skipped =
        `the heaviest request this endpoint accepts takes ${Math.round(heaviest.waitedMs)} ms on this ` +
        `machine, which is not far enough above the ${MINIMUM_BUDGET_MS} ms floor that ` +
        'COACH_TIMEOUT_MS allows for a timeout to be provoked through the public API. Nothing was ' +
        'weakened to make it pass.';
      return report;
    }

    // --- the drill -----------------------------------------------------------
    const server = await ctx.startServer({ env: { COACH_TIMEOUT_MS: String(coachTimeoutMs) } });
    const session = new Session(server.origin, ctx.webOrigin, 'Slow simulation drill');
    await session.createGuest();

    const slow = await ask(session, heaviest.body);
    report.measurements.slowRequestMs = Math.round(slow.waitedMs);
    report.measurements.slowRequestStatus = slow.status;
    report.measurements.slowRequestCode = slow.body?.error?.code ?? null;

    if (slow.status === 200) {
      report.failures.push(
        `the ${heaviest.label} finished in ${Math.round(slow.waitedMs)} ms against a ${coachTimeoutMs} ms ` +
          `budget, having taken ${Math.round(heaviest.waitedMs)} ms during calibration`,
      );
    } else if (slow.status !== 504) {
      report.failures.push(
        `an overrunning calculation answered ${slow.status} ${String(slow.body?.error?.code)}, not 504 ` +
          '(computation_timeout maps to 504 in the contract)',
      );
    } else if (slow.body?.error?.code !== 'computation_timeout') {
      report.failures.push(
        `the 504 carried code "${String(slow.body?.error?.code)}", not computation_timeout`,
      );
    } else {
      report.observations.push(
        `the ${heaviest.label} was stopped and answered 504 computation_timeout in ` +
          `${Math.round(slow.waitedMs)} ms against a ${coachTimeoutMs} ms budget`,
      );
    }

    // Bounded: the caller must not wait meaningfully longer than the budget. Ten times it is
    // generous and still catches "the deadline never fired".
    const bound = coachTimeoutMs * 10 + 2_000;
    if (slow.waitedMs > bound) {
      report.failures.push(
        `the caller waited ${Math.round(slow.waitedMs)} ms for a ${coachTimeoutMs} ms budget`,
      );
    }
    if (/at async|node_modules|\.ts:\d+/.test(slow.text)) {
      report.failures.push('the timeout response carried a stack trace');
    }
    report.failures.push(...scanForSecrets(slow.body, 'the timeout response'));

    const noticed = logLine(server.output(), /task-timeout|timed out; terminating/);
    if (noticed.found) report.evidence.push({ label: 'the pool reported it', text: noticed.line });
    else report.failures.push('nothing in the log says a calculation was abandoned');

    // --- recovery, inside the same process, on a replacement thread ----------
    //
    // A request naming a `top:NN` range gets `STRENGTH_TABLE_ALLOWANCE_MS` (12 s) on top of the
    // budget, because building the preflop strength table legitimately takes about three seconds.
    // That is what makes recovery observable at a budget this tight: this request has the room to
    // run, so if it succeeds the pool must have spawned a replacement for the thread it just
    // terminated and served real Monte Carlo work on it.
    await sleep(200);
    const recovered = await ask(session, { heroCards: 'AhAd', opponents: ['top:40'], samples: 20_000 });
    report.measurements.recoveryRequestMs = Math.round(recovered.waitedMs);
    report.measurements.recoveryStatus = recovered.status;
    if (!recovered.ok) {
      report.failures.push(
        `the calculation after the timeout answered ${recovered.status} ` +
          `${String(recovered.body?.error?.code)}: the pool did not replace the thread it terminated`,
      );
    } else {
      report.observations.push(
        `a real Monte Carlo analysis succeeded ${Math.round(recovered.waitedMs)} ms later on a ` +
          'replacement thread',
      );
    }

    // And the timeout path is stable rather than a one-off. A pool that leaked its terminated
    // threads would answer service_unavailable here instead, having run out of threads to lose.
    const again = await ask(session, heaviest.body);
    report.measurements.secondTimeoutStatus = again.status;
    report.measurements.secondTimeoutCode = again.body?.error?.code ?? null;
    if (again.body?.error?.code !== 'computation_timeout') {
      report.failures.push(
        `a second overrun answered ${again.status} ${String(again.body?.error?.code)} rather than ` +
          'timing out the same way; the pool degraded between the two',
      );
    } else {
      report.observations.push('a second overrun times out identically, so no thread was leaked');
    }

    // Graceful degradation: only the expensive endpoint is affected. A learner can still play.
    const table = await session.request(ROUTES.rooms, {
      method: 'POST',
      body: { name: 'Slow simulation drill', maxSeats: 2, smallBlind: 1, bigBlind: 2, startingStack: 200 },
    });
    if (!table.ok) {
      report.failures.push(`ordinary routes broke while calculations were timing out: ${table.status}`);
    } else {
      report.observations.push('ordinary routes are unaffected: a table can still be created');
    }

    if (server.exited() !== null) {
      report.failures.push('the API process exited when a calculation was abandoned');
    } else {
      report.observations.push('the API process stayed up while threads were terminated under it');
    }
    report.failures.push(...scanTextForSecrets(server.output(), 'the API log'));
    return report;
  },
};

export const analysisDrills = [workerCrash, slowSimulation];

#!/usr/bin/env node
/**
 * The failure-injection suite: sixteen drills that break a running Poker Risk Lab on purpose and
 * check what a learner at a table experienced while it was broken.
 *
 * This is what `pnpm run test:drills` does.
 *
 * ## The defect this exists for
 *
 * Everything in this repository that tests failure tests it from the inside. `shutdown.test.ts`
 * signals a real process, and it is the closest thing here to a drill — but every one of its
 * cases kills a server whose tables are empty, and the evidence trail for "the API survives a
 * restart" has never once included a hand that was in progress at the moment of the signal. The
 * same gap runs through the rest of the failure surface: nothing has ever frozen the database
 * under a live pool, exhausted the pool and looked for the signal in the metrics, dropped a
 * socket in the middle of a hand, or asked what a migration that fails halfway leaves behind.
 *
 * Each of those is a plausible Tuesday, and each is invisible to a unit test because the failure
 * lives in the seam between the process and the operating system. So every drill here spawns the
 * real entry point, speaks HTTP and WebSocket over loopback the way a browser does, breaks
 * something with a signal or a container command, and then asks the same five questions:
 *
 *   - were any chips created or destroyed;
 *   - did anything the client received name a card, a deck, a salt or a cursor it should not have;
 *   - did recovery happen, and inside what measured bound;
 *   - did the log say anything an operator could act on;
 *   - did readiness report the truth while it was happening.
 *
 * ## What this suite does NOT prove
 *
 * One machine, one API process, loopback, and a development database. So: nothing about a
 * rolling deploy in which two versions serve the same table; nothing about a real network, its
 * partitions or its latency; nothing about a load balancer's own behaviour; and no capacity
 * figure of any kind. It is a check that named failures are handled, not a measure of how much
 * failure the system can take.
 *
 * ## What it touches
 *
 * A scratch database named `prl_drills_<pid>` that it creates and drops, plus one or two more for
 * the migration drill. Two drills need to stop a database outright, and they start a Postgres
 * container of their own to do it to — the shared `poker-risk-lab-postgres-1` is never paused,
 * restarted or written to outside the scratch databases above. Every drill cleans up after
 * itself, including on failure, so the suite is re-runnable with no manual tidying.
 *
 * Usage:
 *     pnpm run test:drills
 *     pnpm run test:drills -- --only sigterm-mid-hand --only ws-disconnect-mid-hand
 *     pnpm run test:drills -- --list
 *     pnpm run test:drills -- --exclude postgres-restart --json
 *
 * Exit codes:
 *     0  every selected drill passed
 *     1  any drill failed, OR any drill could not run and was not explicitly excluded
 *     0  --help and --list
 *
 * A skipped drill is a failure on purpose. A suite that silently skips is a suite that lies.
 */

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { analysisDrills } from './drills/analysis-drills.mjs';
import { databaseDrills } from './drills/database-drills.mjs';
import {
  bold,
  containerHealth,
  createScratchDatabase,
  dim,
  docker,
  dropScratchDatabase,
  green,
  migrate,
  REPO_ROOT,
  red,
  startServer,
  yellow,
} from './drills/harness.mjs';
import { processDrills } from './drills/process-drills.mjs';
import { protocolDrills } from './drills/protocol-drills.mjs';

/**
 * Every drill, in the order they run.
 *
 * Order matters only for legibility: the process drills come first because a failure there
 * explains failures everywhere else, and the database drills come last because they are the ones
 * that start containers.
 */
const ALL_DRILLS = [...processDrills, ...protocolDrills, ...analysisDrills, ...databaseDrills];

/**
 * Defaults, mirroring `.env.example` where one exists.
 *
 * `PRL_DRILL_CONTAINER` names the compose Postgres because that is what `docker-compose.yml`
 * calls it on the default project. `DATABASE_URL` is read rather than defaulted: a wrong guess
 * here would point the suite at somebody's real database, and the whole point is that it never
 * does.
 */
const DEFAULTS = {
  container: process.env.PRL_DRILL_CONTAINER ?? 'poker-risk-lab-postgres-1',
  databaseUrl: process.env.DATABASE_URL ?? '',
  webOrigin: process.env.PUBLIC_WEB_ORIGIN?.split(',')[0] ?? 'http://localhost:3000',
  /**
   * The API's shutdown grace for every drill that does not set its own.
   *
   * Short enough that a drain which hangs is obvious in seconds rather than tedious, long enough
   * that a healthy drain finishes far inside it — the assertions allow a third of it.
   */
  graceMs: 5_000,
};

const HELP = `
${bold('pnpm run test:drills')} — break a running Poker Risk Lab on purpose, and check what survived

  ${yellow('This suite creates and DROPS scratch databases, and starts and removes containers.')}
  It never writes to the developer's own database and never pauses the shared container.

  Selection
    --only <name>        run only this drill; repeatable      (default: all ${ALL_DRILLS.length})
    --exclude <name>     skip this drill, and do not fail for it; repeatable
    --list               print the drill names and exit 0

  Targets
    --container <name>   the Postgres container to create scratch databases in
                                                              (default ${DEFAULTS.container})
    --database-url <dsn> the DSN whose server the scratch databases live on
                                                              (default: the DATABASE_URL in the environment)
    --web-origin <url>   the Origin the synthetic clients send (default ${DEFAULTS.webOrigin})
    --grace <ms>         SHUTDOWN_GRACE_MS for the spawned API (default ${DEFAULTS.graceMs})

  Output
    --json               print the whole report as one JSON object
    --out <file>         write that JSON object to a file as well
    -h, --help           this text

  Exit codes: 0 when every selected drill passed; 1 on any failure, and 1 when a drill could not
  run and was not named in --exclude.
`;

function parseArgs(argv) {
  const options = {
    ...DEFAULTS,
    only: [],
    exclude: [],
    list: false,
    json: false,
    out: null,
    help: false,
  };
  const strings = new Map([
    ['--container', 'container'],
    ['--database-url', 'databaseUrl'],
    ['--web-origin', 'webOrigin'],
    ['--out', 'out'],
  ]);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    // `pnpm run test:drills -- --only x` forwards the `--` itself, so absorb it rather than
    // rejecting the conventional invocation as an unknown option.
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const value = argv[index + 1];
    if (arg === '--only' || arg === '--exclude') {
      if (value === undefined) throw new Error(`${arg} needs a drill name`);
      const key = arg === '--only' ? 'only' : 'exclude';
      options[key].push(value);
      index += 1;
      continue;
    }
    if (arg === '--grace') {
      if (value === undefined) throw new Error('--grace needs a value in milliseconds');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 500 || parsed > 120_000) {
        throw new Error('--grace must be a whole number of milliseconds between 500 and 120000');
      }
      options.graceMs = parsed;
      index += 1;
      continue;
    }
    if (strings.has(arg)) {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[strings.get(arg)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option ${arg} (try --help)`);
  }

  const known = new Set(ALL_DRILLS.map((drill) => drill.name));
  for (const name of [...options.only, ...options.exclude]) {
    if (!known.has(name)) {
      throw new Error(`no drill is called "${name}". Run with --list to see the ${known.size} names.`);
    }
  }
  return options;
}

/** The drills this invocation will attempt, in declaration order. */
export function selectDrills(all, options) {
  const wanted = options.only.length === 0 ? all : all.filter((drill) => options.only.includes(drill.name));
  return wanted.filter((drill) => !options.exclude.includes(drill.name));
}

/**
 * Whether a run's outcomes mean success.
 *
 * Exported and pure so `scripts/reliability-drills.test.mjs` can hold the exit-code contract
 * still: the rule that a SKIP fails the run unless it was excluded is the one thing about this
 * suite that is easiest to soften by accident and most damaging when softened.
 */
export function runPassed(outcomes) {
  return outcomes.every((outcome) => outcome.status === 'pass');
}

const tick = (text) => `  ${green('+')} ${text}`;
const cross = (text) => `  ${red('x')} ${text}`;
const bang = (text) => `  ${yellow('!')} ${text}`;

function printOutcome(outcome) {
  const heading =
    outcome.status === 'pass'
      ? green(`PASS  ${outcome.name}`)
      : outcome.status === 'skip'
        ? yellow(`SKIP  ${outcome.name}`)
        : red(`FAIL  ${outcome.name}`);
  console.log(`\n${bold(heading)}  ${dim(outcome.title)}`);
  for (const line of outcome.observations) console.log(tick(line));
  for (const line of outcome.warnings) console.log(bang(line));
  for (const line of outcome.failures) console.log(cross(line));
  if (outcome.skipped !== null) console.log(bang(`skipped: ${outcome.skipped}`));
  for (const entry of outcome.evidence) {
    console.log(dim(`      ${entry.label}: ${entry.text.slice(0, 220)}`));
  }
  const measured = Object.entries(outcome.measurements);
  if (measured.length > 0) {
    console.log(dim(`      measured  ${measured.map(([k, v]) => `${k}=${String(v)}`).join('  ')}`));
  }
  console.log(dim(`      ${(outcome.elapsedMs / 1000).toFixed(1)}s`));
}

/**
 * The context object a drill is handed: the run's settings, plus the two ways it registers work
 * for cleanup.
 *
 * Exported and parameterised on `spawnServer` so `scripts/reliability-drills.test.mjs` can drive
 * the ordering below with a stub. See the comment inside `startServer`: the ordering is the
 * whole point of this function existing, and it is not observable from outside without one.
 */
export function drillContext(ctx, cleanups, spawnServer = startServer) {
  return {
    ...ctx,
    cleanup: (fn) => cleanups.push(fn),
    startServer: async (extra = {}) =>
      spawnServer({
        databaseUrl: ctx.databaseUrl,
        webOrigin: ctx.webOrigin,
        graceMs: ctx.graceMs,
        metricsToken: ctx.metricsToken,
        ...extra,
        /**
         * Registered from inside `onSpawn`, which the harness calls synchronously with the child
         * in hand — BEFORE it waits up to thirty seconds for the server's listening line.
         *
         * ## The defect this exists for
         *
         * The push used to sit after `await startServer(...)`, so it was only ever reached when
         * the start SUCCEEDED. A server that never printed a listening address — a bad
         * DATABASE_URL, a port lost to a race, a machine slow enough under a drill's own load to
         * miss the thirty-second budget — rejected with the child still running, `detached: true`
         * and in its own process group. Nothing held a reference to it: the rejection carries a
         * message, not a pid. It outlived the drill, the suite and the terminal, holding its port
         * and a pool of database connections, and made the NEXT run fail somewhere unrelated.
         *
         * The file header promises that every drill cleans up after itself, INCLUDING ON FAILURE.
         * That promise was false in precisely the case it was written for. Do not move this back
         * outside the call.
         */
        onSpawn: (handle) => {
          cleanups.push(async () => {
            await handle.stop();
          });
        },
      }),
  };
}

/**
 * Runs one drill, then everything it registered for cleanup, in reverse order.
 *
 * Cleanup runs whether the drill passed, failed or threw, and a cleanup that itself fails is
 * recorded as a warning rather than allowed to mask the drill's own result. That ordering is what
 * makes the suite re-runnable: a drill that left a container or a database behind would make the
 * next run's first failure somebody else's mess.
 *
 * What gets INTO `cleanups`, and when, is `drillContext`'s job — and the "when" is the part that
 * was wrong: a server the drill never managed to start was not registered at all.
 */
async function runDrill(drill, ctx) {
  const cleanups = [];
  const startedAt = performance.now();
  const scoped = drillContext(ctx, cleanups);

  let report;
  try {
    report = await drill.run(scoped);
  } catch (error) {
    report = {
      observations: [],
      warnings: [],
      failures: [`the drill threw: ${error?.stack ?? String(error)}`.slice(0, 1_200)],
      evidence: [],
      measurements: {},
      skipped: null,
    };
  }
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch (error) {
      report.warnings.push(`cleanup failed: ${String(error).slice(0, 200)}`);
    }
  }

  const status = report.failures.length > 0 ? 'fail' : report.skipped !== null ? 'skip' : 'pass';
  return {
    name: drill.name,
    title: drill.title,
    status,
    elapsedMs: performance.now() - startedAt,
    ...report,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Everything the command line does, in a function.
 *
 * Wrapped rather than left at the top level so that `scripts/reliability-drills.test.mjs` can
 * import `selectDrills` and `runPassed` without the import spawning servers and calling
 * `process.exit`. `apps/api/scripts/migrate.mjs` and `apps/api/src/server.ts` both do this for
 * the same reason, and the guard below is the same one.
 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(red(`reliability-drills — ${error.message}`));
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (options.list) {
    console.log(bold('\nReliability drills'));
    for (const drill of ALL_DRILLS) console.log(`  ${drill.name.padEnd(28)} ${dim(drill.title)}`);
    console.log('');
    process.exit(0);
  }

  if (options.databaseUrl === '') {
    console.error(
      red('reliability-drills — no DATABASE_URL. Pass --database-url, or run with ') +
        red('`node --env-file-if-exists=.env scripts/reliability-drills.mjs`.'),
    );
    process.exit(1);
  }

  const selected = selectDrills(ALL_DRILLS, options);
  if (selected.length === 0) {
    console.error(red('reliability-drills — every drill was excluded, so nothing would be proved'));
    process.exit(1);
  }

  console.log(bold('\nPoker Risk Lab reliability drills'));
  console.log(
    yellow('  Breaks a LOCAL server on purpose. Creates and drops scratch databases and containers.'),
  );
  console.log(dim(`  ${selected.length} of ${ALL_DRILLS.length} drills, container ${options.container}`));

  // --- preflight ---------------------------------------------------------------
  const state = await containerHealth(options.container);
  if (state === '') {
    console.error(
      cross(`the container ${options.container} is not running; start it with \`pnpm run db:up\``),
    );
    process.exit(1);
  }
  console.log(dim(`  ${options.container} is ${state}`));

  /**
   * The scrape token for the spawned servers.
   *
   * Generated per run rather than fixed, because a token checked into a repository is a token that
   * ends up in a deployment. `config.ts` demands at least 32 characters and real entropy, which is
   * what 32 random bytes of base64url provides.
   */
  const metricsToken = randomBytes(32).toString('base64url');
  const scratchName = `prl_drills_${process.pid}`;
  let scratchUrl;
  try {
    scratchUrl = await createScratchDatabase(options.container, options.databaseUrl, scratchName);
    const migrated = await migrate(scratchUrl);
    if (migrated.code !== 0) {
      console.error(cross(`migrating ${scratchName} failed:\n${migrated.stderr || migrated.stdout}`));
      await dropScratchDatabase(options.container, options.databaseUrl, scratchName);
      process.exit(1);
    }
  } catch (error) {
    console.error(cross(`could not prepare a scratch database: ${String(error)}`));
    process.exit(1);
  }
  console.log(dim(`  scratch database ${scratchName} created and migrated`));

  const ctx = {
    options,
    container: options.container,
    adminDsn: options.databaseUrl,
    databaseUrl: scratchUrl,
    webOrigin: options.webOrigin,
    graceMs: options.graceMs,
    metricsToken,
  };

  /**
   * Removes everything this run made, whatever happened.
   *
   * Registered for the signals as well as the normal path: a run stopped with Ctrl-C that left a
   * Postgres container and a scratch database behind would make the next run start from a mess,
   * which is exactly the manual cleanup the suite promises not to need.
   */
  let tidied = false;
  async function tidyUp() {
    if (tidied) return;
    tidied = true;
    await dropScratchDatabase(options.container, options.databaseUrl, scratchName);
    // Any private Postgres a drill started carries this run's pid in its name.
    await docker(['rm', '-f', `prl-drills-pg-${process.pid}`]);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void tidyUp().then(() => process.exit(1));
    });
  }

  const outcomes = [];
  const startedAt = performance.now();
  for (const drill of selected) {
    process.stdout.write(dim(`\n  running ${drill.name} ...`));
    const outcome = await runDrill(drill, ctx);
    process.stdout.write('\r');
    outcomes.push(outcome);
    printOutcome(outcome);
  }
  const wallSeconds = (performance.now() - startedAt) / 1000;

  await tidyUp();
  const finalState = await containerHealth(options.container);

  // --- report ------------------------------------------------------------------
  const passed = outcomes.filter((outcome) => outcome.status === 'pass').length;
  const failed = outcomes.filter((outcome) => outcome.status === 'fail').length;
  const skipped = outcomes.filter((outcome) => outcome.status === 'skip').length;

  console.log(bold('\nSummary'));
  console.log(`  drills run              ${outcomes.length} of ${ALL_DRILLS.length}`);
  console.log(`  passed                  ${passed}`);
  console.log(`  failed                  ${failed}`);
  console.log(`  skipped (counts as a failure unless --exclude'd)  ${skipped}`);
  console.log(`  excluded                ${options.exclude.length}`);
  console.log(`  wall clock              ${wallSeconds.toFixed(1)}s`);
  console.log(`  ${options.container} after the run   ${finalState === '' ? 'gone' : finalState}`);

  if (finalState !== 'healthy' && finalState !== 'running') {
    console.log(cross(`the shared container is "${finalState}" after the run; it must be put back`));
  }

  const report = {
    measuredAgainst: 'one local API process, loopback, a development database; NOT a deployment',
    container: options.container,
    scratchDatabase: scratchName,
    containerStateAfter: finalState,
    selected: selected.map((drill) => drill.name),
    excluded: options.exclude,
    wallSeconds,
    drills: outcomes,
    counts: { passed, failed, skipped },
    passed: runPassed(outcomes) && (finalState === 'healthy' || finalState === 'running'),
  };

  if (options.json) console.log(JSON.stringify(report, null, 2));
  if (options.out !== null) {
    const target = resolve(REPO_ROOT, options.out);
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(dim(`  report written to ${target}`));
  }

  if (report.passed) {
    console.log(green(bold('\nPASS')));
  } else {
    console.log(red(bold('\nFAIL')));
    for (const outcome of outcomes) {
      if (outcome.status === 'pass') continue;
      console.log(
        red(`  - ${outcome.name}: ${outcome.failures[0] ?? outcome.skipped ?? 'no reason recorded'}`),
      );
    }
  }

  console.log(
    yellow(
      '\nThese drills broke ONE local process against a development database over loopback.\n' +
        'They say that named failures are handled; they say nothing about a real deployment,\n' +
        'a real network, or how much load any of this survives. See the file header.\n',
    ),
  );

  process.exit(report.passed ? 0 : 1);
}

/**
 * True when this file was started from the command line rather than imported.
 *
 * realpath on both sides so a checkout reached through a symlink still recognises itself.
 */
function startedFromCommandLine() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedFromCommandLine()) await main();

#!/usr/bin/env node
/**
 * `pnpm run test:drills`: sixteen drills that break a running API on purpose and check chips,
 * leaks, recovery bound, logging and readiness while it is broken. One machine, one API process,
 * loopback, so it proves nothing about rolling deploys, real networks or capacity. It writes only
 * to `prl_drills_*` scratch databases and its own Postgres containers, and cleans up on failure.
 * A skipped drill fails the run unless it was excluded by name.
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

/** Process drills first, since their failure explains others. Database drills start containers, so last. */
const ALL_DRILLS = [...processDrills, ...protocolDrills, ...analysisDrills, ...databaseDrills];

/** `DATABASE_URL` is read, never defaulted, so a wrong guess cannot point the suite at a real database. */
const DEFAULTS = {
  container: process.env.PRL_DRILL_CONTAINER ?? 'poker-risk-lab-postgres-1',
  databaseUrl: process.env.DATABASE_URL ?? '',
  webOrigin: process.env.PUBLIC_WEB_ORIGIN?.split(',')[0] ?? 'http://localhost:3000',
  /** The assertions allow a third of this, so a hung drain shows in seconds. */
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
    // `pnpm run test:drills -- --only x` forwards the `--` itself.
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

export function selectDrills(all, options) {
  const wanted = options.only.length === 0 ? all : all.filter((drill) => options.only.includes(drill.name));
  return wanted.filter((drill) => !options.exclude.includes(drill.name));
}

/** Pure so the test can pin that a skip fails the run unless it was excluded. */
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

/** Parameterised on `spawnServer` so `reliability-drills.test.mjs` can check the cleanup ordering. */
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
         * Registered in `onSpawn`, before the 30 s wait for the listening line. Registered after
         * the await, a server that never listened survived the run detached, holding its port and
         * pool, and broke the next run. Do not move this outside the call.
         */
        onSpawn: (handle) => {
          cleanups.push(async () => {
            await handle.stop();
          });
        },
      }),
  };
}

/** Cleanups run in reverse order whatever the drill did, and a failing cleanup is only a warning. */
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

/** Wrapped so the test can import `selectDrills` and `runPassed` without spawning servers. */
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

  const state = await containerHealth(options.container);
  if (state === '') {
    console.error(
      cross(`the container ${options.container} is not running; start it with \`pnpm run db:up\``),
    );
    process.exit(1);
  }
  console.log(dim(`  ${options.container} is ${state}`));

  /** Generated per run so no token is committed. `config.ts` requires 32+ characters of entropy. */
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

  /** Also runs on signals, so Ctrl-C does not leave a container or database behind. */
  let tidied = false;
  async function tidyUp() {
    if (tidied) return;
    tidied = true;
    await dropScratchDatabase(options.container, options.databaseUrl, scratchName);
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

/** realpath on both sides so a checkout reached through a symlink still recognises itself. */
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

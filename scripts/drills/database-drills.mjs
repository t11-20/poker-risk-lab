/**
 * The drills that take the database and the identity provider away.
 *
 * ## Where the damage is done, and why it is not done to the shared container
 *
 * `poker-risk-lab-postgres-1` is the container every other developer and every other agent on
 * this machine is using. Freezing or restarting it fails their queries too, and a drill that
 * breaks somebody else's work to prove a point about ours is a bad trade. So the two drills that
 * genuinely need to stop a database — `postgres-outage` and `postgres-restart` — start a
 * container of their OWN, migrate a database into it, break that, and remove it afterwards. The
 * shared container is used only for the drills that need nothing more than a database to write
 * to, and even then every one of them writes to a scratch database this suite created and drops.
 *
 * If the private container cannot be started, those two drills SKIP with the reason rather than
 * quietly falling back to freezing the shared one behind the operator's back.
 *
 * ## What "the database is down" is actually being asked
 *
 * Not "does it error". Three specific things, in order of how much they matter:
 *
 *   1. `/health` must keep answering 200. It exists so an orchestrator can tell whether the
 *      PROCESS is alive, and a process that is alive but cannot reach Postgres must not be
 *      killed and replaced — the replacement will not be able to reach Postgres either.
 *   2. `/ready` must answer 503, promptly, with a fixed reason. An orchestrator that gets no
 *      answer at all takes the instance out on a probe timeout, which is the same outcome by a
 *      slower and less legible route.
 *   3. Recovery must need no human. When the database comes back the instance must go back into
 *      service on its own.
 *
 * Each of those is measured below rather than asserted in prose, and the probe is given a
 * deadline of its own so that a `/ready` which HANGS is a finding rather than a hung drill.
 */

import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  containerHealth,
  createScratchDatabase,
  docker,
  dropScratchDatabase,
  freePort,
  histogramBucket,
  measureUntil,
  metricValue,
  migrate,
  newReport,
  parseDsn,
  psql,
  ROUTES,
  Session,
  scrapeMetrics,
  sleep,
} from './harness.mjs';
import { logLine, recoveryBound, scanForSecrets, scanTextForSecrets } from './invariants.mjs';

/** The image the compose file already pulls, so no drill has to reach the network for one. */
const POSTGRES_IMAGE = 'postgres:16-bookworm';
/** Credentials for the throwaway container. Not a secret: it exists for seconds, bound to loopback. */
const PRIVATE_USER = 'drills';
const PRIVATE_PASSWORD = 'drills-throwaway';

/**
 * How long any single probe of a failing dependency may take before the drill gives up on it.
 *
 * This is the number that turns "the endpoint hung" into evidence. Without a deadline on the
 * probe itself, a `/ready` that never answers looks exactly like a slow drill.
 */
const PROBE_TIMEOUT_MS = 4_000;

/** One probe with a deadline, reporting the outcome rather than throwing. */
async function probe(origin, path) {
  const startedAt = performance.now();
  try {
    const response = await fetch(new URL(path, origin), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body, text, elapsedMs: performance.now() - startedAt };
  } catch (error) {
    return {
      status: 0,
      body: null,
      text: '',
      elapsedMs: performance.now() - startedAt,
      error: error?.name === 'TimeoutError' ? 'timed out' : (error?.cause?.code ?? error?.name ?? 'failed'),
    };
  }
}

/**
 * A Postgres container belonging to this run alone, with the schema already migrated.
 *
 * Bound to 127.0.0.1 so nothing outside the machine can reach it, given a name that carries this
 * process's pid so two concurrent runs cannot collide, and removed by the caller's cleanup even
 * when the drill throws.
 */
async function startPrivatePostgres(register) {
  const name = `prl-drills-pg-${process.pid}`;
  const port = await freePort();
  // Any earlier run that died before its cleanup left one of these behind; removing by name
  // first is what makes the suite re-runnable without a human clearing up.
  await docker(['rm', '-f', name]);
  const started = await docker([
    'run',
    '-d',
    '--name',
    name,
    '-e',
    `POSTGRES_USER=${PRIVATE_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${PRIVATE_PASSWORD}`,
    '-e',
    'POSTGRES_DB=postgres',
    '-p',
    `127.0.0.1:${port}:5432`,
    POSTGRES_IMAGE,
  ]);
  if (started.code !== 0) {
    return {
      ok: false,
      reason: `docker run ${POSTGRES_IMAGE} failed: ${started.stderr.trim().slice(0, 200)}`,
    };
  }
  register(async () => {
    await docker(['rm', '-f', name]);
  });

  const serverDsn = `postgresql://${PRIVATE_USER}:${PRIVATE_PASSWORD}@127.0.0.1:${port}/postgres`;
  // Two consecutive successful queries, half a second apart, and not `pg_isready`.
  //
  // The official Postgres entrypoint runs a TEMPORARY server on a unix socket to initialise the
  // cluster, shuts it down, and only then starts the real one. `pg_isready` answers yes to the
  // temporary server, so a run that trusted it created its database into a server that was about
  // to be stopped and then failed with "connection to server on socket ... No such file or
  // directory" — which is exactly what the second full run of this suite did, on the drill after
  // the one that had just worked. Two successes with a gap between them span the shutdown.
  let consecutive = 0;
  const up = await measureUntil(
    async () => {
      const answered = await psql(name, serverDsn, 'postgres', 'select 1');
      consecutive = answered.code === 0 ? consecutive + 1 : 0;
      return consecutive >= 2;
    },
    60_000,
    500,
  );
  if (up === null) return { ok: false, reason: 'the private Postgres never became ready within 60s' };

  const database = 'prl_drills_private';
  const dsn = await createScratchDatabase(name, serverDsn, database);
  const migrated = await migrate(dsn);
  if (migrated.code !== 0) {
    return {
      ok: false,
      reason: `migrating the private database failed: ${migrated.stderr.trim().slice(0, 300)}`,
    };
  }
  return { ok: true, container: name, serverDsn, dsn, startupMs: Math.round(up) };
}

// ---------------------------------------------------------------------------
// 5. A temporary Postgres outage
// ---------------------------------------------------------------------------

export const postgresOutage = {
  name: 'postgres-outage',
  title: 'PostgreSQL frozen mid-flight, then released',
  async run(ctx) {
    const report = newReport();
    const postgres = await startPrivatePostgres(ctx.cleanup);
    if (!postgres.ok) {
      report.skipped = `${postgres.reason}. The shared container was deliberately not frozen instead.`;
      return report;
    }
    report.observations.push(`a private ${POSTGRES_IMAGE} container carried the damage, not the shared one`);
    report.measurements.privatePostgresStartMs = postgres.startupMs;

    const server = await ctx.startServer({ databaseUrl: postgres.dsn });
    const session = new Session(server.origin, ctx.webOrigin, 'Outage drill');
    await session.createGuest();

    const before = await probe(server.origin, ROUTES.ready);
    if (before.status !== 200) report.failures.push(`/ready answered ${before.status} before the outage`);

    let frozen = false;
    /** The probe held open across the freeze, and how long the freeze lasted. Read after it ends. */
    let latchedProbe = null;
    let frozenForMs = 0;
    try {
      const paused = await docker(['pause', postgres.container]);
      if (paused.code !== 0) {
        report.skipped = `docker pause failed: ${paused.stderr.trim().slice(0, 200)}`;
        return report;
      }
      frozen = true;
      report.observations.push('the database container is frozen (cgroup freezer, sockets left open)');

      // One probe issued the instant the freeze starts, with a deadline long enough to outlive it.
      //
      // This is the sharpest question the drill can ask, and it is different from the bounded
      // probes below. Those ask "does /ready answer 503 promptly". This one asks what a patient
      // caller is eventually TOLD about a window it already knows was an outage. An answer of 200
      // means the endpoint reported the instance healthy for a period in which it could not reach
      // its database at all — which is worse than no answer, because a monitoring system that
      // waits will record the outage as healthy.
      const frozenAt = performance.now();
      const latched = fetch(new URL(ROUTES.ready, server.origin), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(45_000),
      })
        .then(async (response) => ({ status: response.status, ms: performance.now() - frozenAt }))
        .catch((error) => ({ status: 0, error: error?.name ?? 'failed', ms: performance.now() - frozenAt }));

      // Liveness first, and repeatedly: this is the property an orchestrator uses to decide
      // whether to kill the process, and one lucky 200 proves nothing.
      const liveness = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        liveness.push(await probe(server.origin, ROUTES.health));
        await sleep(150);
      }
      const badLiveness = liveness.filter((entry) => entry.status !== 200);
      report.measurements.healthProbesDuringOutage = liveness.length;
      report.measurements.slowestHealthMs = Math.round(Math.max(...liveness.map((e) => e.elapsedMs)));
      if (badLiveness.length > 0) {
        report.failures.push(
          `${badLiveness.length} of ${liveness.length} /health probes did not answer 200 while the ` +
            'database was frozen; a live process must not be killed for a dependency outage',
        );
      } else {
        report.observations.push(
          `/health answered 200 on all ${liveness.length} probes, slowest ` +
            `${Math.round(Math.max(...liveness.map((e) => e.elapsedMs)))} ms`,
        );
      }

      // Readiness. The interesting failure is not 200 — it is no answer at all.
      const readiness = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        readiness.push(await probe(server.origin, ROUTES.ready));
      }
      const degraded = readiness.filter((entry) => entry.status === 503);
      const hung = readiness.filter((entry) => entry.error === 'timed out');
      const stillReady = readiness.filter((entry) => entry.status === 200);
      report.measurements.readyProbes = readiness.length;
      report.measurements.readyDegraded = degraded.length;
      report.measurements.readyHung = hung.length;
      report.measurements.slowestReadyMs = Math.round(Math.max(...readiness.map((e) => e.elapsedMs)));

      if (stillReady.length > 0) {
        report.failures.push(
          `${stillReady.length} /ready probe(s) answered 200 with the database frozen, so a load ` +
            'balancer would keep sending traffic to an instance that cannot serve it',
        );
      }
      if (hung.length > 0) {
        report.failures.push(
          `${hung.length} of ${readiness.length} /ready probes did not answer within ${PROBE_TIMEOUT_MS} ms. ` +
            "`db.ts`'s `ping()` runs `select 1` with no deadline of its own, so a frozen server " +
            'leaves the probe waiting on a socket that will never answer, and an orchestrator sees ' +
            'a probe timeout rather than the 503 the endpoint was written to return',
        );
      }
      if (degraded.length > 0) {
        const withBody = degraded.find((entry) => entry.body !== null);
        report.observations.push(`${degraded.length} of ${readiness.length} /ready probes answered 503`);
        if (withBody !== undefined) {
          const detail = withBody.body?.checks?.database?.detail;
          report.evidence.push({ label: '/ready body while degraded', text: JSON.stringify(withBody.body) });
          if (typeof detail === 'string' && /host|user|password|postgres:\/\/|ECONN|role /i.test(detail)) {
            report.failures.push(`the 503 body named an internal detail: ${detail}`);
          }
          report.failures.push(...scanForSecrets(withBody.body, '/ready body'));
        }
      }

      // A feature route, AUTHENTICATED, to be sure the degradation is graceful rather than a 500
      // with a stack. Through the session client rather than the bare probe: an unauthenticated
      // request to `/rooms` is refused 401 before it reaches the database, so the first version of
      // this check recorded a clean 401 during every outage and was measuring the CSRF and session
      // layer rather than the database at all. Given a deadline of its own for the same reason
      // `/ready` is: an answer that never comes is the interesting case.
      const rooms = await session.request(ROUTES.rooms, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      report.measurements.featureStatusDuringOutage = rooms.status;
      if (rooms.status === 200) {
        report.warnings.push(
          'GET /rooms answered 200 with the database frozen, so it was served from memory',
        );
      } else if (rooms.status === 0) {
        report.warnings.push(
          `an authenticated GET /rooms did not answer within ${PROBE_TIMEOUT_MS} ms of the freeze ` +
            `(${rooms.transportError}); a request that hangs for the length of an outage holds a ` +
            'connection and a browser tab open with it',
        );
      } else if (/at async|\.ts:|node_modules/.test(rooms.text)) {
        report.failures.push('a feature route returned an internal stack trace during the outage');
      } else if (rooms.status === 401 || rooms.status === 403) {
        report.warnings.push(
          `an authenticated GET /rooms answered ${rooms.status} during the outage: a database that ` +
            'cannot be read is being reported to the learner as "you are not signed in", which is ' +
            'the wrong thing for a client to act on',
        );
      } else {
        report.observations.push(`GET /rooms degraded to ${rooms.status} with a contract error body`);
      }

      frozenForMs = performance.now() - frozenAt;
      latchedProbe = latched;
    } finally {
      if (frozen) await docker(['unpause', postgres.container]);
    }

    // Read after the unpause, because that is when a probe held open across the freeze finally
    // resolves. The window it spans is known, so what it says about that window can be judged.
    if (latchedProbe !== null) {
      const latchedResult = await latchedProbe;
      report.measurements.probeHeldAcrossTheFreezeMs = Math.round(latchedResult.ms);
      report.measurements.probeHeldAcrossTheFreezeStatus = latchedResult.status;
      if (latchedResult.status === 200 && latchedResult.ms > frozenForMs * 0.8) {
        report.failures.push(
          'a /ready issued the instant the database froze answered 200 READY after ' +
            `${Math.round(latchedResult.ms)} ms, having spanned a ${Math.round(frozenForMs)} ms ` +
            'outage. The probe waited for the database to come back and then reported the ' +
            'instance healthy for a window in which it could not reach it at all.',
        );
      } else if (latchedResult.status === 503) {
        report.observations.push(
          `a /ready held open across the freeze answered 503 after ${Math.round(latchedResult.ms)} ms`,
        );
      }
    }

    // Recovery, with no human and no restart.
    const recovered = await measureUntil(
      async () => {
        const entry = await probe(server.origin, ROUTES.ready);
        return entry.status === 200;
      },
      60_000,
      250,
    );
    report.measurements.readyAgainMs = recovered === null ? null : Math.round(recovered);
    report.failures.push(...recoveryBound('/ready after the freeze was lifted', recovered, 60_000));
    if (recovered !== null) {
      report.observations.push(
        `/ready returned to 200 ${Math.round(recovered)} ms after the unpause, unaided`,
      );
    }
    if (server.exited() !== null) {
      report.failures.push('the API process exited during the database outage rather than degrading');
    } else {
      report.observations.push('the API process stayed up throughout');
    }

    const noticed = logLine(server.output(), /readiness check failed/);
    if (noticed.found) report.evidence.push({ label: 'the server noticed', text: noticed.line });
    else report.warnings.push('nothing in the log says a readiness check failed');
    report.failures.push(...scanTextForSecrets(server.output(), 'the API log'));

    const health = await containerHealth(postgres.container);
    report.measurements.privateContainerState = health;
    return report;
  },
};

// ---------------------------------------------------------------------------
// 6. A Postgres restart
// ---------------------------------------------------------------------------

export const postgresRestart = {
  name: 'postgres-restart',
  title: 'PostgreSQL restarted underneath a running API',
  async run(ctx) {
    const report = newReport();
    const postgres = await startPrivatePostgres(ctx.cleanup);
    if (!postgres.ok) {
      report.skipped = `${postgres.reason}. The shared container was deliberately not restarted instead.`;
      return report;
    }

    const server = await ctx.startServer({ databaseUrl: postgres.dsn });
    const session = new Session(server.origin, ctx.webOrigin, 'Restart drill');
    await session.createGuest();
    const before = await session.request(ROUTES.rooms);
    if (!before.ok) report.failures.push(`an authenticated call failed before the restart: ${before.status}`);

    const restarted = await docker(['restart', '-t', '5', postgres.container]);
    if (restarted.code !== 0) {
      report.skipped = `docker restart failed: ${restarted.stderr.trim().slice(0, 200)}`;
      return report;
    }
    report.observations.push('the private database container was restarted, closing every pooled connection');

    // Liveness must not blink, whatever happened to the pool.
    const health = await probe(server.origin, ROUTES.health);
    report.measurements.healthDuringRestart = health.status;
    if (health.status !== 200) {
      report.failures.push(`/health answered ${String(health.status)} while the database restarted`);
    }
    if (server.exited() !== null) {
      report.failures.push('the API process exited because the database restarted');
    }

    const readyAgain = await measureUntil(
      async () => {
        const entry = await probe(server.origin, ROUTES.ready);
        return entry.status === 200;
      },
      90_000,
      250,
    );
    report.measurements.readyAgainMs = readyAgain === null ? null : Math.round(readyAgain);
    report.failures.push(...recoveryBound('/ready after the database restart', readyAgain, 90_000));

    // A read is the real proof: the pool has to have reconnected, not merely answered a probe.
    const after = await measureUntil(
      async () => {
        const response = await session.request(ROUTES.rooms);
        return response.ok;
      },
      30_000,
      250,
    );
    report.measurements.featureUsableAgainMs = after === null ? null : Math.round(after);
    report.failures.push(...recoveryBound('an authenticated read after the restart', after, 30_000));
    if (after !== null) {
      report.observations.push(
        `a real query succeeded again ${Math.round(after)} ms after readiness returned`,
      );
    }

    // A guest session created after the restart proves writes work too, and that the pool did not
    // come back holding connections to a database that no longer has the schema.
    const fresh = new Session(server.origin, ctx.webOrigin, 'After restart');
    try {
      await fresh.createGuest();
      report.observations.push('a new guest session was created after the restart, so writes recovered');
    } catch (error) {
      report.failures.push(`a write after the restart failed: ${String(error).slice(0, 200)}`);
    }

    const noticed = logLine(server.output(), /readiness check failed|postgres|database/i);
    if (noticed.found) report.evidence.push({ label: 'the server noticed', text: noticed.line });
    report.failures.push(...scanTextForSecrets(server.output(), 'the API log'));
    report.measurements.privateContainerState = await containerHealth(postgres.container);
    return report;
  },
};

// ---------------------------------------------------------------------------
// 7. Connection pool exhaustion
// ---------------------------------------------------------------------------

export const poolExhaustion = {
  name: 'pool-exhaustion',
  title: 'Connection pool exhaustion, and whether the probe histogram shows it',
  async run(ctx) {
    const report = newReport();
    // A pool of two, so exhausting it takes three requests rather than eleven — the defect being
    // looked for is "the saturation is invisible", not "a large pool can be filled".
    const poolMax = 2;
    const server = await ctx.startServer({
      env: { DATABASE_POOL_MAX: String(poolMax) },
      metricsToken: ctx.metricsToken,
    });
    const session = new Session(server.origin, ctx.webOrigin, 'Pool drill');
    await session.createGuest();
    // A room, so `GET /rooms` has rows to read and takes the lock path rather than short-circuiting.
    await session.request(ROUTES.rooms, {
      method: 'POST',
      body: { name: 'Pool drill', maxSeats: 2, smallBlind: 1, bigBlind: 2, startingStack: 200 },
    });

    // Three probes before the baseline, because a histogram with no observations is not in the
    // exposition text at all — the first run of this drill read "not exported" and reported it as
    // a missing metric when the truth was that nothing had scraped `/ready` yet. Sampling it
    // deliberately also gives the comparison below a healthy-pool baseline to move away from.
    for (let attempt = 0; attempt < 3; attempt++) await probe(server.origin, ROUTES.ready);

    const baseline = await scrapeMetrics(server.origin, ctx.metricsToken);
    if (baseline === null) {
      // The status separates the two very different reasons a scrape comes back empty: 401 is a
      // token this drill got wrong, and 404 is `/metrics` not being registered by `app.ts` at all
      // — in which case pool saturation has no external signal whatever the histogram declares.
      const raw = await probe(server.origin, ROUTES.metrics);
      report.measurements.metricsScrapeStatus = raw.status;
      report.failures.push(
        `GET ${ROUTES.metrics} answered ${String(raw.status)}, so the saturation signal cannot be read. ` +
          (raw.status === 404
            ? 'The route is not registered: `app.ts` serves no /metrics, so nothing exports ' +
              'prl_db_probe_duration_seconds however saturated the pool gets.'
            : 'The scrape token was refused.'),
      );
      return report;
    }
    const seriesName = 'prl_db_probe_duration_seconds';
    const baselineCount = metricValue(baseline, `${seriesName}_count`);
    const baselineFast = histogramBucket(baseline, seriesName, '0.05');
    if (baselineCount === null) {
      report.failures.push(`${seriesName} is not exported at all, so pool saturation has no signal`);
      return report;
    }
    report.measurements.probeCountBefore = baselineCount;
    report.observations.push(
      `${seriesName} is exported and has ${baselineCount} observations before the squeeze`,
    );

    // Every pooled connection is made to wait on a lock nothing else needs. `select 1` does not
    // need the lock either — which is exactly the point: what the probe measures under this load
    // is time spent QUEUEING for a connection, with no slow query anywhere.
    const holdSeconds = 4;
    const lockHeld = psql(
      ctx.container,
      ctx.adminDsn,
      parseDsn(ctx.databaseUrl).database,
      `begin; lock table prl.rooms in access exclusive mode; select pg_sleep(${holdSeconds}); commit;`,
    );
    await sleep(300);

    const blocked = [];
    for (let index = 0; index < poolMax + 2; index++) blocked.push(session.request(ROUTES.rooms));
    await sleep(500);

    const readyProbes = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      readyProbes.push(await probe(server.origin, ROUTES.ready));
      await sleep(200);
    }
    const slowest = Math.max(...readyProbes.map((entry) => entry.elapsedMs));
    report.measurements.slowestReadyMsUnderSaturation = Math.round(slowest);
    report.measurements.readyStatusesUnderSaturation = readyProbes.map((entry) => entry.status).join(',');

    const saturated = await scrapeMetrics(server.origin, ctx.metricsToken);
    const saturatedCount = metricValue(saturated, `${seriesName}_count`);
    const saturatedFast = histogramBucket(saturated, seriesName, '0.05');
    const sum = metricValue(saturated, `${seriesName}_sum`);
    report.measurements.probeCountAfter = saturatedCount;
    report.measurements.probeSumSeconds = sum === null ? null : Number(sum.toFixed(4));

    const newProbes = (saturatedCount ?? 0) - baselineCount;
    const newSlowProbes = newProbes - ((saturatedFast ?? 0) - (baselineFast ?? 0));
    report.measurements.probesOver50ms = newSlowProbes;
    if (newProbes <= 0) {
      report.failures.push('no new probe observations were recorded, so the drill measured nothing');
    } else if (newSlowProbes <= 0) {
      report.failures.push(
        `all ${newProbes} probes taken while every pooled connection was blocked landed under 50 ms, ` +
          'so pool saturation left no trace in prl_db_probe_duration_seconds',
      );
    } else {
      report.observations.push(
        `${newSlowProbes} of ${newProbes} readiness probes taken under saturation exceeded 50 ms, ` +
          'which is the queueing signal the histogram exists for',
      );
    }
    if (slowest < 50) {
      report.warnings.push(
        `the slowest /ready under saturation was ${Math.round(slowest)} ms, so the pool may not have ` +
          'been genuinely exhausted on this machine',
      );
    }

    // Everything must come back on its own once the lock is released.
    await lockHeld;
    const settled = await Promise.allSettled(blocked);
    const answered = settled.filter((entry) => entry.status === 'fulfilled' && entry.value.status !== 0);
    report.measurements.blockedRequestsAnswered = `${answered.length}/${blocked.length}`;
    const recovered = await measureUntil(
      async () => {
        const entry = await probe(server.origin, ROUTES.ready);
        return entry.status === 200 && entry.elapsedMs < 250;
      },
      30_000,
      200,
    );
    report.measurements.poolRecoveredMs = recovered === null ? null : Math.round(recovered);
    report.failures.push(...recoveryBound('the pool after the lock was released', recovered, 30_000));

    const usable = await session.request(ROUTES.rooms);
    if (!usable.ok) report.failures.push(`GET /rooms still failed after the lock released: ${usable.status}`);
    else report.observations.push('the API serves normally again with no restart');

    const gauge = metricValue(saturated, 'prl_db_pool_max');
    report.measurements.poolMaxGauge = gauge;
    if (gauge !== poolMax) {
      report.warnings.push(`prl_db_pool_max reports ${String(gauge)} for a pool configured at ${poolMax}`);
    }
    report.failures.push(...scanTextForSecrets(server.output(), 'the API log'));
    // `scanTextForSecrets`, not `scanForSecrets`. The metrics body is Prometheus text exposition,
    // not JSON, and `scanForSecrets` is a KEY-walker: its first act is `if (node === null ||
    // typeof node !== 'object') return`, so wrapping the text in `{ metrics: '...' }` handed it an
    // object with exactly one key — `metrics`, which is not forbidden — and one string value it
    // returned from immediately. The scan was structurally incapable of producing a finding, and
    // had been reporting a clean metrics body on every run since it was written. The line above
    // is the correct shape and always was.
    report.failures.push(...scanTextForSecrets(saturated ?? '', 'the metrics body'));
    return report;
  },
};

// ---------------------------------------------------------------------------
// 14. A failed migration
// ---------------------------------------------------------------------------

export const failedMigration = {
  name: 'failed-migration',
  title: 'A migration that fails, a ledger that has drifted, and an attempted rollback',
  async run(ctx) {
    const report = newReport();
    const database = `prl_drills_migrate_${process.pid}`;
    const dsn = await createScratchDatabase(ctx.container, ctx.adminDsn, database);
    ctx.cleanup(async () => {
      await dropScratchDatabase(ctx.container, ctx.adminDsn, database);
    });

    // --- a migration that cannot apply ---
    // The object it is about to create already exists, so `0001_initial.sql` fails partway
    // through. This is what a genuinely broken migration file does from the runner's point of
    // view, produced without putting a broken file into db/migrations, which this suite does not
    // own and which another agent may be editing.
    const poison = await psql(
      ctx.container,
      ctx.adminDsn,
      database,
      'create schema prl; create table prl.users (id text primary key)',
    );
    if (poison.code !== 0) {
      report.failures.push(`could not prepare the failing case: ${poison.stderr.trim().slice(0, 200)}`);
      return report;
    }
    const failed = await migrate(dsn, 'up');
    report.measurements.failedMigrationExit = failed.code;
    if (failed.code === 0) {
      report.failures.push('a migration that could not apply reported success');
    } else {
      report.observations.push(`the runner exited ${failed.code} on a migration that could not apply`);
    }
    const combined = `${failed.stdout}\n${failed.stderr}`;
    if (!/0001_initial/.test(combined)) {
      report.failures.push('the failure did not name the migration that failed');
    } else {
      const named = logLine(combined, /0001_initial/);
      report.evidence.push({ label: 'the runner named the file', text: named.line.slice(0, 160) });
    }
    // Atomicity: `applyFile` runs each file inside a transaction, so a failure must leave the
    // ledger with no row for it. A half-applied migration is the failure mode that turns one bad
    // deploy into a database nobody can move forwards or backwards.
    const ledger = await psql(
      ctx.container,
      ctx.adminDsn,
      database,
      "select count(*) from prl.schema_migrations where version = '0001_initial.sql'",
    );
    const recorded = Number(ledger.stdout.trim());
    report.measurements.ledgerRowsAfterFailure = ledger.code === 0 ? recorded : 'no ledger table';
    if (ledger.code === 0 && recorded > 0) {
      report.failures.push('the ledger recorded a migration that failed to apply');
    } else {
      report.observations.push('the failed migration left no row in the ledger; the transaction rolled back');
    }

    // --- a ledger that has drifted from the files ---
    const clean = `${database}_clean`;
    const cleanDsn = await createScratchDatabase(ctx.container, ctx.adminDsn, clean);
    ctx.cleanup(async () => {
      await dropScratchDatabase(ctx.container, ctx.adminDsn, clean);
    });
    const applied = await migrate(cleanDsn, 'up');
    if (applied.code !== 0) {
      report.failures.push(`the control migration failed: ${applied.stderr.trim().slice(0, 200)}`);
      return report;
    }
    await psql(
      ctx.container,
      ctx.adminDsn,
      clean,
      "update prl.schema_migrations set checksum = repeat('0', 64) where version = '0001_initial.sql'",
    );
    const drifted = await migrate(cleanDsn, 'up');
    report.measurements.checksumDriftExit = drifted.code;
    const driftText = `${drifted.stdout}\n${drifted.stderr}`;
    if (drifted.code === 0) {
      report.failures.push(
        'a checksum mismatch was accepted; the repository and the database can now disagree',
      );
    } else if (!/no longer match|Nothing has been applied/i.test(driftText)) {
      report.failures.push(`the drift was refused but not explained: ${driftText.slice(0, 200)}`);
    } else {
      report.observations.push('a checksum mismatch aborts with nothing applied, and says why');
      const line = logLine(driftText, /no longer match/);
      report.evidence.push({ label: 'checksum drift refused', text: line.line.slice(0, 160) });
    }
    const status = await migrate(cleanDsn, 'status');
    if (!/ledger .*!=|drift|mismatch/i.test(`${status.stdout}${status.stderr}`)) {
      report.warnings.push('`migrate status` did not report the drift it was told about');
    } else {
      report.observations.push('`migrate status` reports the drift rather than claiming to be up to date');
    }

    // --- a ledger row with no file ---
    // Its own database, because the drifted checksum above cannot be repaired: the row records a
    // file whose real checksum this drill has thrown away, so anything done to that ledger next
    // would be testing the drift check again rather than the orphan check.
    const orphanDb = `${database}_orphan`;
    const orphanDsn = await createScratchDatabase(ctx.container, ctx.adminDsn, orphanDb);
    ctx.cleanup(async () => {
      await dropScratchDatabase(ctx.container, ctx.adminDsn, orphanDb);
    });
    const orphanBase = await migrate(orphanDsn, 'up');
    if (orphanBase.code === 0) {
      await psql(
        ctx.container,
        ctx.adminDsn,
        orphanDb,
        "insert into prl.schema_migrations (version, checksum) values ('0009_not_a_file.sql', repeat('a', 64))",
      );
      const withOrphan = await migrate(orphanDsn, 'up');
      report.measurements.orphanLedgerExit = withOrphan.code;
      if (withOrphan.code === 0) {
        report.warnings.push(
          'a ledger row with no file in db/migrations did not stop the runner, so a database that ' +
            'cannot be rebuilt from this repository still reports itself up to date',
        );
      } else {
        report.observations.push('a ledger row with no file aborts the run rather than being ignored');
      }
    }

    // --- an attempted rollback ---
    const down = await migrate(dsn, 'down');
    report.measurements.downExit = down.code;
    const downText = `${down.stdout}\n${down.stderr}`;
    if (down.code === 0) {
      report.failures.push('`migrate down` succeeded; this project is documented as roll-forward only');
    } else if (!/roll-forward|no `down`|There is no/i.test(downText)) {
      report.failures.push(`\`down\` failed without stating the policy: ${downText.slice(0, 200)}`);
    } else {
      report.observations.push('`migrate down` refuses with the policy rather than an unknown-command error');
      const line = logLine(downText, /roll-forward|There is no/);
      report.evidence.push({ label: 'rollback refused', text: line.line.slice(0, 160) });
    }

    report.failures.push(...scanTextForSecrets(combined, 'the migration output'));
    return report;
  },
};

// ---------------------------------------------------------------------------
// 16. A dependency service that is unavailable
// ---------------------------------------------------------------------------

/** A TCP listener that accepts connections and never says anything. A black hole with a port. */
function blackHole() {
  return new Promise((done, fail) => {
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      done({
        port: address.port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

export const dependencyUnavailable = {
  name: 'dependency-unavailable',
  title: 'The identity provider is refused, and then a black hole',
  async run(ctx) {
    const report = newReport();
    const deadPort = await freePort();
    const hole = await blackHole();
    // Synchronous, and the cleanup contract takes any function: closing a listener needs no await.
    ctx.cleanup(() => {
      hole.close();
    });

    const oidcEnv = (issuerPort) => ({
      OIDC_ISSUER: `http://localhost:${issuerPort}`,
      OIDC_CLIENT_ID: 'drill-client',
      OIDC_CLIENT_SECRET: 'drill-secret-value-for-a-drill-only',
      OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    });

    for (const testCase of [
      { label: 'a provider that refuses the connection', port: deadPort, budgetMs: 5_000 },
      { label: 'a provider that accepts and never answers', port: hole.port, budgetMs: 12_000 },
    ]) {
      const server = await ctx.startServer({ env: oidcEnv(testCase.port) });

      // The API must be healthy: a sign-in provider being down is not a reason to take the whole
      // instance out of the load balancer, because everything except sign-in still works.
      const health = await probe(server.origin, ROUTES.health);
      const ready = await probe(server.origin, ROUTES.ready);
      if (health.status !== 200 || ready.status !== 200) {
        report.failures.push(
          `${testCase.label}: /health ${String(health.status)} and /ready ${String(ready.status)} — ` +
            'an unreachable identity provider must not make this instance unready',
        );
      } else {
        report.observations.push(`${testCase.label}: the instance stays healthy and ready`);
      }

      // Graceful degradation: guest play is the product's main path and must be untouched.
      const guest = new Session(server.origin, ctx.webOrigin, 'IdP drill');
      try {
        await guest.createGuest();
        report.observations.push(`${testCase.label}: guest sign-in still works`);
      } catch (error) {
        report.failures.push(`${testCase.label}: guest sign-in broke: ${String(error).slice(0, 160)}`);
      }

      // And the sign-in route itself must fail inside a bound, with nothing internal in the body.
      const startedAt = performance.now();
      let response;
      try {
        response = await fetch(new URL('/api/v1/auth/oidc/start', server.origin), {
          headers: { accept: 'application/json' },
          redirect: 'manual',
          signal: AbortSignal.timeout(testCase.budgetMs),
        });
      } catch (error) {
        response = null;
        report.failures.push(
          `${testCase.label}: GET /auth/oidc/start did not answer within ${testCase.budgetMs} ms ` +
            `(${error?.name ?? 'error'}); the outbound fetch bound is HTTP_TIMEOUT_MS = 5000 ms in ` +
            'auth/oidc.ts, so an unbounded wait here means a request can outlive it',
        );
      }
      const elapsed = performance.now() - startedAt;
      report.measurements[`oidcStartMs_${testCase.port === deadPort ? 'refused' : 'blackhole'}`] =
        Math.round(elapsed);
      if (response !== null) {
        const text = await response.text();
        report.measurements[`oidcStatus_${testCase.port === deadPort ? 'refused' : 'blackhole'}`] =
          response.status;
        if (response.status < 400) {
          report.failures.push(
            `${testCase.label}: /auth/oidc/start answered ${response.status} with no provider behind it`,
          );
        } else {
          report.observations.push(
            `${testCase.label}: /auth/oidc/start answered ${response.status} in ${Math.round(elapsed)} ms`,
          );
        }
        if (/ECONNREFUSED|at async|node_modules|\.ts:\d+|localhost:\d+/.test(text)) {
          report.failures.push(`${testCase.label}: the error body exposed an internal detail`);
        }
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        report.failures.push(...scanForSecrets(body, `${testCase.label} error body`));
      }

      // Deliberately narrow. `/oidc/i` also matches the boot line, which carries `oidcEnabled`,
      // so the evidence quoted was the server saying it had started rather than the server
      // saying the provider was unreachable.
      const noticed = logLine(server.output(), /discovery|exchange_failed|could not be fetched/i);
      if (noticed.found) report.evidence.push({ label: `${testCase.label}: the log`, text: noticed.line });
      report.failures.push(...scanTextForSecrets(server.output(), `${testCase.label} log`));
      await server.stop();
    }

    return report;
  },
};

export const databaseDrills = [
  postgresOutage,
  postgresRestart,
  poolExhaustion,
  failedMigration,
  dependencyUnavailable,
];

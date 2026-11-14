/**
 * `/metrics` keeps its series bounded, renders valid Prometheus exposition, and puts no secret or
 * identifier in a label.
 * A request-derived label is a memory leak anyone can reach, a rejected scrape looks like a healthy
 * unwatched service, and metrics stores have weaker access control than the database.
 * Each detector has a negative control. The histogram figures are by hand. 0.05 and 5 against
 * bounds 0.1 and 1 give buckets 1, 1, 2 and a sum of 5.05. The database is a stub.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WS_CLOSE } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { AppMetrics, recordApiError } from '../src/observability/metrics.ts';
import { MetricsRegistry, OVERFLOW_LABEL } from '../src/observability/registry.ts';
import { observeAnalysis, PROBLEM_EVENTS, recordProblem } from '../src/observability/telemetry.ts';
import { ID_PREFIXES } from '../src/repositories/ids.ts';
import { closeCodeLabel } from '../src/ws/hub.ts';

/**
 * Restated, not imported, because the cap is not exported and a test reading its own constant
 * passes whatever it becomes. The "stops growing" assertion does not depend on the number.
 */
const EXPECTED_SERIES_CAP = 256;

const ALLOWED_ORIGIN = 'http://localhost:3000';

/** 32 characters, 32 distinct, no placeholder substring, as `readOptionalSecret` requires. */
const SCRAPE_TOKEN = 'Mq7Zb4Xw9Rk2Ty6Vn3Hs8Lc5Jd1Ga0Pf';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    // Quiet, so access logs do not bury a failure message.
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

/** Routes go on before `ready()`, because Fastify refuses `AVV_ERR_ROOT_PLG_BOOTED` afterwards. */
async function appWith(
  config: AppConfig,
  metrics: AppMetrics,
  attach: (app: FastifyInstance) => void = () => undefined,
): Promise<FastifyInstance> {
  const app = await buildApp({ config, database: stubDatabase, metrics });
  attach(app);
  await app.ready();
  return app;
}

/** Every `name="value"` pair in a rendered exposition, in the order they appear. */
function labelPairs(exposition: string): readonly (readonly [string, string])[] {
  const out: [string, string][] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  for (const match of exposition.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) out.push([name, value]);
  }
  return out;
}

/** `# HELP`/`# TYPE` excluded. */
function samplesFor(exposition: string, metric: string): readonly string[] {
  return exposition
    .split('\n')
    .filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `));
}

function sampleValue(line: string): number {
  const value = Number(line.slice(line.lastIndexOf(' ') + 1));
  assert.ok(Number.isFinite(value), `expected a numeric sample, got ${JSON.stringify(line)}`);
  return value;
}

/**
 * Built from `ID_PREFIXES`, so a new prefix is covered automatically. The tail of 8 or more
 * matches `prl.prefixed_id` (`^[a-z]{3,6}_[A-Za-z0-9_-]{8,64}$`), and keeps it from firing on
 * `not_room_member` or `room_closed`. The lookbehind skips a prefix at the end of a longer word.
 */
const IDENTIFIER_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${Object.values(ID_PREFIXES).join('|')})_[A-Za-z0-9_-]{8,}`,
);

/** As a whole value or as a word inside one. */
const CARD_PATTERN = /(?<![A-Za-z0-9_])[2-9TJQKA][cdhs](?![A-Za-z0-9_])/;

/** A commitment root, a salt, a session digest. */
const DIGEST_PATTERN = /\b[0-9a-f]{32,}\b/;

/**
 * Route patterns carry `/` and `:`, `le` carries `+Inf` and decimals, codes carry `_`. Anything
 * else is more likely escaped request data than a meant label.
 */
const LABEL_VALUE_SHAPE = /^[A-Za-z0-9_./:+-]+$/;

const MAX_REASONABLE_LABEL = 64;

/** Returns the offending pairs rather than asserting, so the negative control can reuse it. */
function complaintAbout(value: string): string | null {
  if (IDENTIFIER_PATTERN.test(value)) return 'looks like a prefixed identifier';
  if (CARD_PATTERN.test(value)) return 'looks like card notation';
  if (DIGEST_PATTERN.test(value)) return 'looks like a digest or a salt';
  if (value.length > MAX_REASONABLE_LABEL) return 'is longer than any declared label value';
  if (!LABEL_VALUE_SHAPE.test(value)) return 'contains characters no declared label uses';
  return null;
}

function leakedLabels(exposition: string): readonly string[] {
  const found: string[] = [];
  for (const [name, value] of labelPairs(exposition)) {
    const complaint = complaintAbout(value);
    if (complaint !== null) found.push(`${name}="${value}" ${complaint}`);
  }
  return found;
}

describe('the metric registry is bounded by construction', () => {
  it('folds every label combination past the cap into one overflow series, and stops growing', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({ name: 'prl_probe_total', help: 'A probe.', labelNames: ['key'] });

    // One distinct value per call, as a request-derived label would produce.
    for (let index = 0; index < 400; index += 1) counter.inc({ key: `key-${index}` });

    // MAX + 1, because the overflow series is itself a series.
    assert.equal(counter.seriesCount, EXPECTED_SERIES_CAP + 1);
    assert.equal(registry.totalSeries(), EXPECTED_SERIES_CAP + 1);
    assert.ok(registry.anyOverflowed(), 'the registry must admit that precision was lost');

    // Everything past the first 256 landed in the overflow, so nothing was dropped.
    assert.equal(counter.get({ key: OVERFLOW_LABEL }), 400 - EXPECTED_SERIES_CAP);

    const before = counter.seriesCount;
    for (let index = 400; index < 1_400; index += 1) counter.inc({ key: `key-${index}` });
    assert.equal(counter.seriesCount, before, 'a thousand more combinations must allocate nothing');
    assert.equal(counter.get({ key: OVERFLOW_LABEL }), 1_400 - EXPECTED_SERIES_CAP);

    // Visible in the scrape, not only in a getter.
    assert.match(registry.render(), new RegExp(`prl_probe_total\\{key="${OVERFLOW_LABEL}"\\} `));
  });

  it('does not claim overflow for a metric that is comfortably inside the cap', () => {
    // Negative control. An `anyOverflowed()` that always returned `true` passes everything else.
    const registry = new MetricsRegistry();
    const counter = registry.counter({ name: 'prl_small_total', help: 'A small one.', labelNames: ['key'] });
    for (let index = 0; index < 10; index += 1) counter.inc({ key: `key-${index}` });
    assert.equal(counter.seriesCount, 10);
    assert.equal(registry.anyOverflowed(), false);
    assert.doesNotMatch(registry.render(), new RegExp(OVERFLOW_LABEL));
  });

  it('ignores a label key the metric never declared, rather than forking the series', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({ name: 'prl_declared_total', help: 'h', labelNames: ['kind'] });
    counter.inc({ kind: 'coach' });
    // An extra key must not fork a second series for the same declared labels.
    counter.inc({ kind: 'coach', roomId: 'room_smuggled' });
    assert.equal(counter.seriesCount, 1);
    assert.equal(counter.get({ kind: 'coach' }), 2);
    assert.doesNotMatch(registry.render(), /room_smuggled/);
  });

  it('refuses to register the same metric name twice', () => {
    const registry = new MetricsRegistry();
    registry.counter({ name: 'prl_once_total', help: 'h' });
    assert.throws(
      () => registry.counter({ name: 'prl_once_total', help: 'h' }),
      /already registered/,
      'two modules believing they own one metric must fail at boot, not silently at runtime',
    );
  });
});

describe('the Prometheus exposition', () => {
  function populatedRegistry(): MetricsRegistry {
    const registry = new MetricsRegistry();
    const counter = registry.counter({ name: 'prl_probe_total', help: 'Probe count.', labelNames: ['kind'] });
    const gauge = registry.gauge({ name: 'prl_probe_live', help: 'Probe gauge.' });
    const histogram = registry.histogram(
      { name: 'prl_probe_seconds', help: 'Probe timing.', labelNames: ['kind'] },
      [0.1, 1],
    );
    counter.inc({ kind: 'coach' }, 3);
    gauge.set({}, 7);
    histogram.observe({ kind: 'coach' }, 0.05);
    histogram.observe({ kind: 'coach' }, 5);
    return registry;
  }

  it('emits a HELP and a TYPE line for every metric', () => {
    const text = populatedRegistry().render();
    for (const [name, type] of [
      ['prl_probe_total', 'counter'],
      ['prl_probe_live', 'gauge'],
      ['prl_probe_seconds', 'histogram'],
    ] as const) {
      assert.ok(text.includes(`# HELP ${name} `), `no HELP line for ${name}`);
      assert.ok(text.includes(`# TYPE ${name} ${type}`), `no TYPE line for ${name}`);
    }
    assert.ok(text.endsWith('\n'), 'the format requires a trailing newline');
  });

  it('renders a histogram as cumulative buckets, a sum and a count that agree', () => {
    const text = populatedRegistry().render();
    const buckets = samplesFor(text, 'prl_probe_seconds_bucket');
    const sum = samplesFor(text, 'prl_probe_seconds_sum');
    const count = samplesFor(text, 'prl_probe_seconds_count');

    assert.equal(buckets.length, 3, buckets.join(' | '));
    assert.ok(buckets[0]?.includes('le="0.1"'));
    assert.ok(buckets[1]?.includes('le="1"'));
    assert.ok(buckets[2]?.includes('le="+Inf"'), 'the +Inf bucket is required by the format');

    // 0.05 is in both bounded buckets and 5 in neither. Cumulative.
    assert.equal(sampleValue(buckets[0] ?? ''), 1);
    assert.equal(sampleValue(buckets[1] ?? ''), 1);
    assert.equal(sampleValue(buckets[2] ?? ''), 2, '+Inf holds every observation');

    // A scraper rejects a histogram whose counts decrease.
    const counts = buckets.map((line) => sampleValue(line));
    for (let index = 1; index < counts.length; index += 1) {
      assert.ok(
        (counts[index] ?? 0) >= (counts[index - 1] ?? 0),
        `bucket counts must not decrease: ${counts.join(', ')}`,
      );
    }

    assert.equal(sampleValue(count[0] ?? ''), 2);
    assert.equal(
      sampleValue(count[0] ?? ''),
      sampleValue(buckets[2] ?? ''),
      '_count and the +Inf bucket are the same number by definition',
    );
    assert.ok(Math.abs(sampleValue(sum[0] ?? '') - 5.05) < 1e-9, `expected a sum of 5.05, got ${sum[0]}`);
  });

  it('renders an unchanged registry byte-identically twice, so two captures can be diffed', () => {
    const registry = populatedRegistry();
    assert.equal(registry.render(), registry.render());
  });

  it('escapes a label value rather than emitting a quote that would break the line', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({ name: 'prl_escape_total', help: 'h', labelNames: ['reason'] });
    counter.inc({ reason: 'a"b\\c' });
    const line = samplesFor(registry.render(), 'prl_escape_total')[0] ?? '';
    assert.equal(line, 'prl_escape_total{reason="a\\"b\\\\c"} 1');
  });
});

describe('the route label', () => {
  it('labels a request by its route pattern and an unmatched one as `unmatched`', async () => {
    const metrics = new AppMetrics();
    // Parameterised, so the parameter's value is what must not reach the label.
    const app = await appWith(testConfig(), metrics, (instance) => {
      instance.get('/api/v1/probe/:probeId', async () => ({ ok: true }));
    });

    const matched = await app.inject({ method: 'GET', url: '/api/v1/probe/room_leakcanary' });
    const missing = await app.inject({ method: 'GET', url: '/api/v1/no-such-path-42' });
    assert.equal(matched.statusCode, 200);
    assert.equal(missing.statusCode, 404);

    const text = metrics.render();
    assert.ok(text.includes('route="/api/v1/probe/:probeId"'), text);
    assert.ok(
      text.includes('route="unmatched"'),
      'a request that matched no route must be labelled `unmatched`, never by its URL',
    );
    assert.doesNotMatch(text, /room_leakcanary/, 'the parameter must never reach the label');
    assert.doesNotMatch(text, /no-such-path-42/, 'a scanner must not be able to mint a series');

    // Control. The exposition `routeLabel` would produce if it returned the URL is reported.
    assert.equal(
      leakedLabels('prl_http_requests_total{route="/api/v1/probe/room_leakcanary9"} 1\n').length,
      1,
    );
    await app.close();
  });
});

describe('GET /metrics', () => {
  it('is served openly outside production when no token is configured', async () => {
    const metrics = new AppMetrics();
    const app = await appWith(testConfig({ NODE_ENV: 'development' }), metrics);
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(response.body.startsWith('# HELP '), response.body.slice(0, 120));
    await app.close();
  });

  it('requires the bearer token when one is configured, and rejects a wrong one', async () => {
    const metrics = new AppMetrics();
    const app = await appWith(testConfig({ METRICS_TOKEN: SCRAPE_TOKEN }), metrics);

    const anonymous = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(anonymous.statusCode, 401);
    assert.equal((anonymous.json() as { error: { code: string } }).error.code, 'not_authenticated');
    assert.doesNotMatch(anonymous.body, /# HELP/);

    const wrong = await app.inject({
      method: 'GET',
      url: '/metrics',
      // Same length as the real token, so this reaches the comparison, not the length guard.
      headers: { authorization: `Bearer ${'A'.repeat(SCRAPE_TOKEN.length)}` },
    });
    assert.equal(wrong.statusCode, 401);

    const wrongScheme = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: SCRAPE_TOKEN },
    });
    assert.equal(wrongScheme.statusCode, 401, 'a bare token without the Bearer scheme is not a token');

    const accepted = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${SCRAPE_TOKEN}` },
    });
    assert.equal(accepted.statusCode, 200);
    assert.ok(accepted.body.startsWith('# HELP '));
    assert.doesNotMatch(accepted.body, new RegExp(SCRAPE_TOKEN));
    await app.close();
  });

  it('is not registered at all in production without a token, so the path 404s like any other', async () => {
    const metrics = new AppMetrics();
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
      PUBLIC_WEB_ORIGIN: 'https://app.example.test',
      SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
      // Production refuses `silent`.
      LOG_LEVEL: 'fatal',
    });
    assert.equal(config.metricsToken, null);
    const app = await appWith(config, metrics);
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    // 404, because a 401 or 403 would confirm this software is here and meant to expose metrics.
    assert.equal(response.statusCode, 404);
    assert.doesNotMatch(response.body, /# HELP/);
    await app.close();
  });

  it('serves production with a token, so the closed door is a configuration and not a wall', async () => {
    const metrics = new AppMetrics();
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
      PUBLIC_WEB_ORIGIN: 'https://app.example.test',
      SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
      METRICS_TOKEN: SCRAPE_TOKEN,
      // Production refuses `silent`.
      LOG_LEVEL: 'fatal',
    });
    const app = await appWith(config, metrics);
    assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 401);
    const accepted = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${SCRAPE_TOKEN}` },
    });
    assert.equal(accepted.statusCode, 200);
    await app.close();
  });
});

describe('no metric label carries anything secret or identifying', () => {
  /**
   * Drives every labelled metric with hostile values, meaning ids in the shapes `repositories/ids.ts`
   * mints, card notation and a fake digest.
   */
  async function populate(metrics: AppMetrics): Promise<string> {
    const app = await appWith(testConfig(), metrics, (instance) => {
      instance.get('/api/v1/probe/:probeId', async () => ({ ok: true }));
    });
    await app.inject({ method: 'GET', url: '/api/v1/probe/room_leakcanary9' });
    await app.inject({ method: 'GET', url: '/api/v1/usr_leakcanary9/Ah/Kd' });
    await app.inject({ method: 'HEAD', url: '/api/v1/health' });

    for (const code of ['not_authenticated', 'session_expired', 'forbidden', 'not_room_member'] as const) {
      recordApiError(code, metrics);
    }

    // `closeCodeLabel` is fed a client-chosen code as well as ours.
    metrics.wsOpened.inc();
    for (const code of Object.values(WS_CLOSE)) metrics.wsClosed.inc({ code: closeCodeLabel(code) });
    metrics.wsClosed.inc({ code: closeCodeLabel(4999) });
    for (const reason of ['bad_origin', 'unauthenticated', 'rate_limited']) {
      metrics.wsRefused.inc({ reason });
    }
    for (const reason of ['too_large', 'schema', 'not_json', 'unknown_type']) {
      metrics.wsFramesRejected.inc({ reason });
    }

    metrics.handsStarted.inc();
    metrics.handsCompleted.inc();
    metrics.handsFailed.inc({ reason: 'interrupted_by_restart' });
    metrics.handsFailed.inc({ reason: 'room_closed' });
    metrics.archiveFailures.inc();
    for (const event of PROBLEM_EVENTS) recordProblem(event, metrics);

    await observeAnalysis('equity', async () => 1, metrics);
    await observeAnalysis(
      'coach',
      () =>
        Promise.reject(
          new AppError('computation_timeout', {
            logDetail: 'hand hand_leakcanary9 in room_leakcanary9 held Ah Kd, salt deadbeef16',
          }),
        ),
      metrics,
    ).catch(() => undefined);

    metrics.workerTasks.inc({ outcome: 'failed' });
    metrics.workerTasks.inc({ outcome: 'timed_out' });
    metrics.rateLimitEvents.inc({ kind: 'banned' });
    metrics.dbErrors.inc({ category: 'probe' });

    const text = metrics.render();
    await app.close();
    return text;
  }

  it('renders a populated registry with no identifier, card, digest or oversized value anywhere', async () => {
    const metrics = new AppMetrics();
    const text = await populate(metrics);

    // A sweep of nothing is not a pass.
    const pairs = labelPairs(text);
    assert.ok(pairs.length > 40, `expected a populated exposition, saw ${pairs.length} label pairs`);
    assert.deepEqual(leakedLabels(text), [], 'a label carried something it must never carry');

    // Plain-text check, which also covers metric names and help text.
    for (const forbidden of ['room_leakcanary9', 'usr_leakcanary9', 'hand_leakcanary9', 'deadbeef16']) {
      assert.doesNotMatch(text, new RegExp(forbidden), `${forbidden} reached the exposition`);
    }
  });

  it('the leak detector can actually fail', () => {
    // One real defect each, so the passing scan above is evidence.
    const roomId = 'prl_probe_total{room="room_leakcanary9"} 1\n';
    const card = 'prl_probe_total{holding="Ah"} 1\n';
    const digest = 'prl_probe_total{commitment="deadbeefdeadbeefdeadbeefdeadbeefdead"} 1\n';
    const oversized = `prl_probe_total{note="${'x'.repeat(MAX_REASONABLE_LABEL + 1)}"} 1\n`;
    const spacey = 'prl_probe_total{note="two words"} 1\n';

    assert.equal(leakedLabels(roomId).length, 1, roomId);
    assert.equal(leakedLabels(card).length, 1, card);
    assert.equal(leakedLabels(digest).length, 1, digest);
    assert.equal(leakedLabels(oversized).length, 1, oversized);
    assert.equal(leakedLabels(spacey).length, 1, spacey);

    // And no false alarm on values the service really emits.
    const legitimate =
      'prl_http_requests_total{method="GET",route="/api/v1/rooms/:roomId",status="2xx"} 1\n' +
      'prl_analysis_duration_seconds_bucket{kind="coach",le="+Inf"} 2\n' +
      'prl_table_actor_failures_total{reason="bot-action-rejected"} 1\n';
    assert.deepEqual(leakedLabels(legitimate), []);
  });
});

describe('counters whose alerts are zero-tolerance are primed at zero', () => {
  /**
   * A counter series starts at its first `inc()`, and Prometheus does not assume a series that
   * appears mid-range began at zero, so the first event is invisible to `rate()` and `increase()`:
   * unprimed, a first ban never fires `RateLimitBans` (`increase(...[15m]) > 0`).
   */
  it('renders the banned and limited series before anything is limited', () => {
    const metrics = new AppMetrics();
    const text = metrics.render();
    assert.match(
      text,
      /prl_rate_limit_events_total\{kind="banned"\} 0/,
      'a ban that is the first ever ban must be a rise from zero, not a series appearing',
    );
    assert.match(text, /prl_rate_limit_events_total\{kind="limited"\} 0/);
  });

  it('renders the archive-failure series before anything fails', () => {
    // Play continues when an archive write fails, so nothing else surfaces it.
    assert.match(new AppMetrics().render(), /prl_archive_failures_total 0/);
  });

  /**
   * A failed seat release is seen nowhere else, because the room summary comes from the live table
   * and nothing retries. With `primeLabels` removed, this fails on the match.
   */
  it('renders the seat-release series before any chair is stuck', () => {
    assert.match(new AppMetrics().render(), /prl_seat_release_failures_total 0/);
  });

  /**
   * Both lease rules are `increase(...) > 0` for events that must never happen, so the first one is
   * the only one. Both fencing reasons are primed because they send an operator to different places.
   */
  it('renders the room-lease series before any process contends for a room', () => {
    const text = new AppMetrics().render();
    assert.match(text, /prl_room_ownership_refusals_total 0/);
    assert.match(text, /prl_room_fencings_total\{reason="fenced"\} 0/);
    assert.match(text, /prl_room_fencings_total\{reason="lease_expired"\} 0/);
  });

  /**
   * `HandsFailing` is `increase(...) > 0`, and `rooms/registry.ts` adds `abandoned.length` in one
   * step, so an unprimed incident can go from absent to three with an `increase()` of zero.
   * `HandCompletionGap` subtracts the counters, and subtracting an absent series is an empty vector,
   * so with no completed hand the rule could not fire
   * (`deploy/staging/observability/rule-tests/product-correctness.test.yml`).
   * With `primeLabels` removed, all four matches fail.
   */
  it('renders all three hand counters before a single hand has been dealt', () => {
    const text = new AppMetrics().render();
    assert.match(text, /prl_hands_started_total 0/);
    assert.match(
      text,
      /prl_hands_completed_total 0/,
      'absent is not zero: a subtraction against a series that has never been scraped is empty, ' +
        'and HandCompletionGap is a subtraction',
    );
    assert.match(text, /prl_hands_failed_total\{reason="room_closed"\} 0/);
    assert.match(text, /prl_hands_failed_total\{reason="interrupted_by_restart"\} 0/);
  });

  it('a primed series still counts normally, so priming costs nothing (POSITIVE CONTROL)', () => {
    // Positive control. A counter broken into always reporting zero would pass the tests above.
    const metrics = new AppMetrics();
    metrics.rateLimitEvents.inc({ kind: 'banned' });
    metrics.archiveFailures.inc();
    // By two, because one settlement can fail to free several chairs and priming must add.
    metrics.seatReleaseFailures.inc({}, 2);
    metrics.roomOwnershipRefusals.inc();
    metrics.roomFencings.inc({ reason: 'fenced' });
    // By three, because one reconciliation records every hand a restart abandoned.
    metrics.handsFailed.inc({ reason: 'interrupted_by_restart' }, 3);
    metrics.handsStarted.inc();
    const text = metrics.render();
    assert.match(text, /prl_hands_failed_total\{reason="interrupted_by_restart"\} 3/);
    assert.match(text, /prl_hands_failed_total\{reason="room_closed"\} 0/);
    assert.match(text, /prl_hands_started_total 1/);
    assert.match(text, /prl_hands_completed_total 0/);
    assert.match(text, /prl_rate_limit_events_total\{kind="banned"\} 1/);
    assert.match(text, /prl_archive_failures_total 1/);
    assert.match(text, /prl_seat_release_failures_total 2/);
    assert.match(text, /prl_room_ownership_refusals_total 1/);
    assert.match(text, /prl_room_fencings_total\{reason="fenced"\} 1/);
    assert.match(
      text,
      /prl_room_fencings_total\{reason="lease_expired"\} 0/,
      'one reason moving must not move the other; they are different incidents',
    );
    assert.match(text, /prl_rate_limit_events_total\{kind="limited"\} 0/, 'priming must not move a sibling');
  });
});

/**
 * `ProcessRestartLoop` pages on `changes(prl_process_start_time_seconds[15m]) >= 3`, so the gauge
 * must export one integer for the life of the process. Re-deriving it from two drifting clocks
 * counted 32 changes in 20 s near a second boundary, so the value is computed once and `set()`.
 */
describe('the process start time is a constant, not a reading', () => {
  /** Negative control. A `setFrom` collector runs on every render, so two scrapes can disagree. */
  it('a setFrom gauge is re-derived on every scrape, and two scrapes can disagree (NEGATIVE CONTROL)', () => {
    const registry = new MetricsRegistry();
    const drifting = registry.gauge({ name: 'prl_probe_start_time_seconds', help: 'probe' });
    let scrape = 0;
    // Two clocks disagreeing across a second boundary.
    drifting.setFrom(() => {
      scrape += 1;
      return 1787678914 + (scrape % 2);
    });
    const first = sampleValue(samplesFor(registry.render(), 'prl_probe_start_time_seconds')[0] ?? '');
    const second = sampleValue(samplesFor(registry.render(), 'prl_probe_start_time_seconds')[0] ?? '');
    assert.notEqual(first, second, 'a collector that can return two values is a restart to changes()');
  });

  it('renders the same integer on every scrape for the life of the process', () => {
    const metrics = new AppMetrics();
    const seen = new Set<number>();
    // 200 scrapes at 15 s is 50 minutes, more than three of `ProcessRestartLoop`'s 15 m windows.
    for (let index = 0; index < 200; index += 1) {
      seen.add(sampleValue(samplesFor(metrics.render(), 'prl_process_start_time_seconds')[0] ?? ''));
    }
    assert.equal(
      seen.size,
      1,
      `two hundred scrapes produced ${seen.size} distinct start times: ${[...seen].join(', ')}`,
    );
    // A broken gauge rendering zero would pass the assertion above.
    const [only] = [...seen];
    assert.ok(
      only !== undefined && only > 1_700_000_000 && only <= Math.floor(Date.now() / 1000),
      `start time ${only} is not a moment in this process's past`,
    );
  });
});

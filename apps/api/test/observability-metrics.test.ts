/**
 * The metrics endpoint: what it is bounded by, what it renders, and what it must never carry.
 *
 * ## Why this file exists
 *
 * `/metrics` is the one route in this API that an operator reaches during an incident and an
 * attacker reaches on a Tuesday. Three things about it are load-bearing, and none of them is
 * visible by reading a response:
 *
 * 1. **It cannot be made to grow without bound.** A label whose value comes from the request is
 *    an in-process memory leak reachable by anybody with a socket. `registry.ts` bounds it with a
 *    per-metric series cap; that cap is asserted here, including that it actually stops growing.
 * 2. **It renders something Prometheus will accept.** A histogram whose cumulative buckets are
 *    not monotonic, or whose `+Inf` disagrees with `_count`, is exposition a scraper rejects
 *    outright — and a rejected scrape looks exactly like a healthy service that nobody is
 *    watching.
 * 3. **It leaks nothing.** Metrics are scraped into a store with weaker access control and longer
 *    retention than the database (`logging.ts` opens with that sentence). A hole card, a deck, a
 *    salt, a room id, a hand id, a user id or a session id in a label is a disclosure with a very
 *    long tail.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Every detector here has a negative control that feeds it the real defect and asserts it fires,
 * because a guard whose failure mode has never been observed is a guard nobody has tested:
 *
 * - `does not claim overflow for a metric that is comfortably inside the cap` is the control for
 *   the overflow assertions. An `anyOverflowed()` wired to `true` would satisfy every other check
 *   in this file and fails that one; a cap that never engaged would fail the series count, the
 *   overflow value, and the `stops growing` assertion after a further thousand combinations.
 * - `the leak detector can actually fail` feeds `leakedLabels` five expositions carrying one real
 *   defect each — a room id, card notation, a digest, an oversized value, and a value with a space
 *   in it — asserts each is reported, and then asserts the three shapes this service genuinely
 *   emits are not, so the detector is neither blind nor crying wolf.
 * - The route-label case carries its own control: the same detector is pointed at
 *   `route="/api/v1/probe/room_leakcanary9"`, which is exactly what the exposition would contain
 *   if `routeLabel` returned `request.url` instead of the matched pattern.
 * - The histogram assertions are pinned to numbers computed by hand rather than to whatever the
 *   renderer produced: 0.05 and 5, against bounds of 0.1 and 1, give bucket counts 1, 1, 2 and a
 *   sum of 5.05. Each of the four plausible rendering bugs — cumulative counts that do not
 *   accumulate, a missing `+Inf`, `_sum` rendered as the count, buckets emitted out of order —
 *   moves one of those.
 *
 * ## No database
 *
 * `buildApp` takes a `DatabaseHandle` and this passes a stub. Nothing here issues a query.
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
 * The cap `registry.ts` applies per metric.
 *
 * Restated rather than imported because it is deliberately not exported — it is an internal
 * bound, not a knob — and a test that reads the constant it is checking would pass whatever the
 * constant became. The assertion that does not depend on the number is the one below it: past the
 * cap the series count stops moving however many more combinations arrive.
 */
const EXPECTED_SERIES_CAP = 256;

const ALLOWED_ORIGIN = 'http://localhost:3000';

/** 32 characters, 32 distinct, no placeholder substring: what `readOptionalSecret` insists on. */
const SCRAPE_TOKEN = 'Mq7Zb4Xw9Rk2Ty6Vn3Hs8Lc5Jd1Ga0Pf';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    // Silenced because every assertion in this file is about the exposition, and the access log
    // for the dozen injected requests below would bury a real failure message in the output.
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

/**
 * An app on the given metrics, with any extra probe routes attached before it boots.
 *
 * The routes have to go on before `ready()`: Fastify refuses `AVV_ERR_ROOT_PLG_BOOTED` afterwards,
 * and a test that added one late would fail with a framework error rather than an assertion.
 */
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

// ---------------------------------------------------------------------------
// Reading the exposition
// ---------------------------------------------------------------------------

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

/** Every sample line for one metric name, `# HELP`/`# TYPE` excluded. */
function samplesFor(exposition: string, metric: string): readonly string[] {
  return exposition
    .split('\n')
    .filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `));
}

/** The numeric value at the end of a sample line. */
function sampleValue(line: string): number {
  const value = Number(line.slice(line.lastIndexOf(' ') + 1));
  assert.ok(Number.isFinite(value), `expected a numeric sample, got ${JSON.stringify(line)}`);
  return value;
}

/**
 * Anything shaped like one of this schema's prefixed identifiers.
 *
 * Built from `ID_PREFIXES` rather than from a hand-written list, so a prefix added to the schema is
 * covered by this detector without anybody remembering to come back here: `usr_`, `ses_`, `room_`,
 * `hand_`, `hseat_`, `act_`, `aud_` and the rest.
 *
 * The random tail is required, and required to be at least eight characters, because that is what
 * `prl.prefixed_id` demands of a real id (`^[a-z]{3,6}_[A-Za-z0-9_-]{8,64}$`) — and because the
 * prefixes are ordinary English fragments. Without it this fires on the error code
 * `not_room_member` and on the perfectly legitimate `handsFailed` reason `room_closed`, which is
 * how a leak detector becomes a detector nobody trusts. The lookbehind keeps it from matching a
 * prefix that is merely the tail of a longer word.
 */
const IDENTIFIER_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${Object.values(ID_PREFIXES).join('|')})_[A-Za-z0-9_-]{8,}`,
);

/** Two-character card notation, as a whole value or as a word inside one. */
const CARD_PATTERN = /(?<![A-Za-z0-9_])[2-9TJQKA][cdhs](?![A-Za-z0-9_])/;

/** A hex digest: a commitment root, a salt, a session digest. */
const DIGEST_PATTERN = /\b[0-9a-f]{32,}\b/;

/**
 * What a label value is allowed to look like.
 *
 * Route patterns carry `/` and `:`, the `le` label carries `+Inf` and decimal points, error codes
 * and reasons carry `_`. Nothing legitimate here needs anything else, and a value that does is
 * far more likely to be something that escaped from a request than a label somebody meant.
 */
const LABEL_VALUE_SHAPE = /^[A-Za-z0-9_./:+-]+$/;

/** Longest label value any of this service's declared labels legitimately produces. */
const MAX_REASONABLE_LABEL = 64;

/**
 * Reports every label value in an exposition that must not be there.
 *
 * Returns the offending `name="value"` pairs rather than asserting, so the same function can be
 * pointed at a deliberately poisoned exposition to prove it fires — see the negative control at
 * the bottom of this file.
 */
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

// ---------------------------------------------------------------------------
// The registry's bounds
// ---------------------------------------------------------------------------

describe('the metric registry is bounded by construction', () => {
  it('folds every label combination past the cap into one overflow series, and stops growing', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({ name: 'prl_probe_total', help: 'A probe.', labelNames: ['key'] });

    // One distinct label value per call, which is what a caller passing something request-derived
    // would do — a path with an id in it, a client-chosen close code, a schema error string.
    for (let index = 0; index < 400; index += 1) counter.inc({ key: `key-${index}` });

    // The cap plus one: the overflow series is itself a series, so the bound is `MAX + 1` rather
    // than `MAX`. Stated here because the off-by-one is real and a future reader would otherwise
    // assume one of the two numbers is wrong.
    assert.equal(counter.seriesCount, EXPECTED_SERIES_CAP + 1);
    assert.equal(registry.totalSeries(), EXPECTED_SERIES_CAP + 1);
    assert.ok(registry.anyOverflowed(), 'the registry must admit that precision was lost');

    // The first 256 combinations each got their own series; every one after that landed in the
    // overflow, so the overflow's value is the remainder and nothing was silently dropped.
    assert.equal(counter.get({ key: OVERFLOW_LABEL }), 400 - EXPECTED_SERIES_CAP);

    const before = counter.seriesCount;
    for (let index = 400; index < 1_400; index += 1) counter.inc({ key: `key-${index}` });
    assert.equal(counter.seriesCount, before, 'a thousand more combinations must allocate nothing');
    assert.equal(counter.get({ key: OVERFLOW_LABEL }), 1_400 - EXPECTED_SERIES_CAP);

    // And the overflow is visible in the output, not merely in a getter, so an operator looking at
    // a scrape can tell the metric stopped being precise.
    assert.match(registry.render(), new RegExp(`prl_probe_total\\{key="${OVERFLOW_LABEL}"\\} `));
  });

  it('does not claim overflow for a metric that is comfortably inside the cap', () => {
    // The negative control for the assertion above: without this, an `anyOverflowed()` that
    // returned `true` unconditionally would pass every other check in this file.
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
    // A caller smuggling an extra key must not be able to create a second series for the same
    // declared labels — that is the same unbounded growth by another route.
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

// ---------------------------------------------------------------------------
// The exposition format
// ---------------------------------------------------------------------------

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

    // Two declared bounds plus the mandatory `+Inf`.
    assert.equal(buckets.length, 3, buckets.join(' | '));
    assert.ok(buckets[0]?.includes('le="0.1"'));
    assert.ok(buckets[1]?.includes('le="1"'));
    assert.ok(buckets[2]?.includes('le="+Inf"'), 'the +Inf bucket is required by the format');

    // 0.05 falls in both bounded buckets; 5 falls in neither. Cumulative, so each bound counts
    // everything at or below it.
    assert.equal(sampleValue(buckets[0] ?? ''), 1);
    assert.equal(sampleValue(buckets[1] ?? ''), 1);
    assert.equal(sampleValue(buckets[2] ?? ''), 2, '+Inf holds every observation');

    // Non-decreasing across `le`, which is what makes the exposition valid at all: a scraper
    // rejects a histogram whose counts go down, and `histogram_quantile` would be meaningless.
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

// ---------------------------------------------------------------------------
// The route label
// ---------------------------------------------------------------------------

describe('the route label', () => {
  it('labels a request by its route pattern and an unmatched one as `unmatched`', async () => {
    const metrics = new AppMetrics();
    // A parameterised route, because the whole point of the pattern is that the parameter's value
    // does not reach the label.
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

    // The control for the two assertions above: this is the exposition `routeLabel` would produce
    // if it returned the URL, and the detector reports it. Without this, an assertion that happens
    // never to be able to fail would read exactly the same.
    assert.equal(
      leakedLabels('prl_http_requests_total{route="/api/v1/probe/room_leakcanary9"} 1\n').length,
      1,
    );
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET /metrics
// ---------------------------------------------------------------------------

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
    // No part of the exposition may be in the refusal body.
    assert.doesNotMatch(anonymous.body, /# HELP/);

    const wrong = await app.inject({
      method: 'GET',
      url: '/metrics',
      // Same length as the real token, so this exercises the comparison rather than the length
      // guard in front of it.
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
    // And the token itself is never echoed into the exposition.
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
      LOG_LEVEL: 'silent',
    });
    assert.equal(config.metricsToken, null);
    const app = await appWith(config, metrics);
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    // 404 rather than 401 or 403: a refusal confirms both that this software is running here and
    // that somebody meant to expose metrics. A 404 is what every other absent path returns.
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
      LOG_LEVEL: 'silent',
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

// ---------------------------------------------------------------------------
// Nothing secret, nothing identifying
// ---------------------------------------------------------------------------

describe('no metric label carries anything secret or identifying', () => {
  /**
   * Drives every labelled metric this service declares, using values that would be a disclosure
   * if any of them reached a label.
   *
   * Deliberately hostile inputs: a room id, a hand id, a user id and a session id in the shapes
   * `repositories/ids.ts` mints, card notation, and a fake commitment digest. If any code path
   * turns one of these into a label, the scan below names it.
   */
  async function populate(metrics: AppMetrics): Promise<string> {
    const app = await appWith(testConfig(), metrics, (instance) => {
      instance.get('/api/v1/probe/:probeId', async () => ({ ok: true }));
    });
    await app.inject({ method: 'GET', url: '/api/v1/probe/room_leakcanary9' });
    await app.inject({ method: 'GET', url: '/api/v1/usr_leakcanary9/Ah/Kd' });
    await app.inject({ method: 'HEAD', url: '/api/v1/health' });

    // The error, authentication and authorisation counters.
    for (const code of ['not_authenticated', 'session_expired', 'forbidden', 'not_room_member'] as const) {
      recordApiError(code, metrics);
    }

    // Sockets: opened, closed by every close code the contract defines, refused for each reason,
    // and frames rejected. `closeCodeLabel` is fed a code a client chose as well as ours.
    metrics.wsOpened.inc();
    for (const code of Object.values(WS_CLOSE)) metrics.wsClosed.inc({ code: closeCodeLabel(code) });
    metrics.wsClosed.inc({ code: closeCodeLabel(4999) });
    for (const reason of ['bad_origin', 'unauthenticated', 'rate_limited']) {
      metrics.wsRefused.inc({ reason });
    }
    for (const reason of ['too_large', 'schema', 'not_json', 'unknown_type']) {
      metrics.wsFramesRejected.inc({ reason });
    }

    // Tables and hands, including every seat-actor failure reason the problem hook can produce.
    metrics.handsStarted.inc();
    metrics.handsCompleted.inc();
    metrics.handsFailed.inc({ reason: 'interrupted_by_restart' });
    metrics.handsFailed.inc({ reason: 'room_closed' });
    metrics.archiveFailures.inc();
    for (const event of PROBLEM_EVENTS) recordProblem(event, metrics);

    // Analysis, on both the success and the failure path.
    await observeAnalysis('equity', async () => 1, metrics);
    await observeAnalysis(
      'coach',
      () =>
        Promise.reject(
          new AppError('computation_timeout', {
            // A `logDetail` naming cards and a room, to prove none of it can reach a label.
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

    // The scan looked at something: a passing result over an empty exposition would prove nothing.
    const pairs = labelPairs(text);
    assert.ok(pairs.length > 40, `expected a populated exposition, saw ${pairs.length} label pairs`);
    assert.deepEqual(leakedLabels(text), [], 'a label carried something it must never carry');

    // And the plain-text belt-and-braces check, which also covers metric NAMES and help text, not
    // only label values.
    for (const forbidden of ['room_leakcanary9', 'usr_leakcanary9', 'hand_leakcanary9', 'deadbeef16']) {
      assert.doesNotMatch(text, new RegExp(forbidden), `${forbidden} reached the exposition`);
    }
  });

  it('the leak detector can actually fail', () => {
    // Each of these is a real defect this file exists to catch, built by hand so that the passing
    // scan above is evidence rather than an accident of an empty regex.
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

    // And it does not cry wolf over the values this service really emits.
    const legitimate =
      'prl_http_requests_total{method="GET",route="/api/v1/rooms/:roomId",status="2xx"} 1\n' +
      'prl_analysis_duration_seconds_bucket{kind="coach",le="+Inf"} 2\n' +
      'prl_table_actor_failures_total{reason="bot-action-rejected"} 1\n';
    assert.deepEqual(leakedLabels(legitimate), []);
  });
});

describe('counters whose alerts are zero-tolerance are primed at zero', () => {
  /**
   * The defect, measured against staging rather than reasoned about.
   *
   * A counter series is created by its first `inc()`. Until then the exposition has no line for
   * it, and `rate()`/`increase()` are computed only from samples inside their range — Prometheus
   * does not assume a series that appears mid-range began at zero, so `1, 1, 1` has an increase
   * of 0. The first occurrence of a counted event is therefore invisible to any alert keyed on
   * its rate.
   *
   * `docs/production/alerts.md` writes exactly those alerts that way, on the stated grounds that
   * there is no acceptable background rate: `RateLimitBans` on
   * `increase(prl_rate_limit_events_total{kind="banned"}[15m]) > 0` and `ArchiveFailing` on
   * `rate(prl_archive_failures_total[15m]) > 0`.
   *
   * What was measured: a flood drove the staging limiter past its ban threshold, the counter read
   * `prl_rate_limit_events_total{kind="banned"} 1`, and `RateLimitBans` never fired. One recorded
   * ban — the dedupe working — and an alert that could not see it.
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
    // The metric whose own documentation says nothing else surfaces the failure, because play
    // deliberately continues when an archive write fails.
    assert.match(new AppMetrics().render(), /prl_archive_failures_total 0/);
  });

  /**
   * The same argument, for the same reason, one subsystem over.
   *
   * A seat is released when the hand it was in settles, and the durable write that frees
   * `room_members.seat` hangs off that settlement. When it fails nothing else sees it: the room
   * summary is built from the live table, which has already dropped the chair, so it advertises a
   * seat the database refuses — and nothing retries. The FIRST stuck chair is the one worth
   * paging on, and priming is what makes it a rise from zero rather than a series appearing.
   *
   * Run against the counter with `primeLabels` removed: `prl_seat_release_failures_total` is
   * absent from the exposition entirely and this fails on the match, exactly as the two above do.
   */
  it('renders the seat-release series before any chair is stuck', () => {
    assert.match(new AppMetrics().render(), /prl_seat_release_failures_total 0/);
  });

  it('a primed series still counts normally, so priming costs nothing (POSITIVE CONTROL)', () => {
    // Without this, the two assertions above would also hold for a counter that had been broken
    // into always reporting zero.
    const metrics = new AppMetrics();
    metrics.rateLimitEvents.inc({ kind: 'banned' });
    metrics.archiveFailures.inc();
    // By two, because this counter counts CHAIRS rather than passes: one settlement can fail to
    // free several at once, and a primed series must add to what is already there rather than
    // replace it.
    metrics.seatReleaseFailures.inc({}, 2);
    const text = metrics.render();
    assert.match(text, /prl_rate_limit_events_total\{kind="banned"\} 1/);
    assert.match(text, /prl_archive_failures_total 1/);
    assert.match(text, /prl_seat_release_failures_total 2/);
    assert.match(text, /prl_rate_limit_events_total\{kind="limited"\} 0/, 'priming must not move a sibling');
  });
});

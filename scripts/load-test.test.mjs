#!/usr/bin/env node
/**
 * Tests for the load and capacity harness.
 *
 * Run with:  node --test scripts/load-test.test.mjs
 * Also run by:  pnpm run test:scripts
 *
 * ## What these exist to prevent
 *
 * Everything in `scripts/load-test.mjs` that turns raw observations into a claim is pure and is
 * tested here, because the claims are the dangerous part. A load harness that is slightly wrong
 * does not crash — it prints a plausible number that somebody puts in a capacity plan.
 *
 * The four specific defects being guarded against:
 *
 * 1. **An off-by-one in the nearest-rank percentile.** `Math.ceil(fraction * n)` is a RANK and
 *    the array index is one less. Both plausible mistakes — dropping the `-1`, or using `floor`
 *    — shift every reported figure by one sample and look entirely reasonable at any
 *    concurrency. So the percentile is pinned against a known distribution AND both wrong
 *    variants are computed here and asserted to differ, which is what makes this a negative
 *    control rather than a restatement of the implementation.
 *
 * 2. **A hand-written exposition parser that silently mis-reads a scrape.** The fixture below is
 *    a verbatim excerpt of a real `GET /metrics` response from this service, captured with
 *    `curl -s -H 'Authorization: Bearer ...' http://127.0.0.1:3051/metrics`, so the format being
 *    parsed is the format the server emits rather than the format the parser's author imagined.
 *    A second, hand-written fixture carries the things a real scrape of a healthy process never
 *    contains and a scraper must still survive: escaped quotes and backslashes in a label value,
 *    a label value containing `}` and `,`, the `+Inf` / `-Inf` / `NaN` value tokens, a trailing
 *    timestamp, and outright malformed lines.
 *
 * 3. **A stop criterion that does not stop, or stops for the wrong reason.** "The ramp stopped at
 *    24 players because of p95" is the single most consequential sentence the harness produces.
 *    Every criterion is driven here with a level built to breach exactly one of them, and the
 *    healthy level is asserted NOT to stop — a criterion that always fires is as useless as one
 *    that never does.
 *
 * 4. **The JSON and the human output drifting apart.** They are one object rendered twice, and
 *    the test renders a fabricated report and finds the report's own numbers in the text. If
 *    somebody adds a figure to the printed output that is computed in the renderer rather than
 *    taken from the report, the `--json` consumer and the reader stop agreeing, and only one of
 *    them is auditable.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Checked by breaking each one on purpose while writing them:
 *
 *   - percentile: the two off-by-one variants are computed in the test itself and asserted to
 *     produce DIFFERENT answers from the real one, so a regression to either is caught by
 *     construction, not by hope.
 *   - parser: `sampleValue` for a declared-but-never-incremented metric is asserted to be `null`
 *     and explicitly asserted NOT to be `0`. Returning `0` there is the exact mistake that would
 *     make the harness report missing instrumentation as an absence of load, and it passes every
 *     test that only checks the happy path.
 *   - stop criteria: a level that breaches nothing is asserted not to stop, and a level whose
 *     ONLY fault is a reconnect consistency failure is asserted to stop — proving correctness is
 *     not traded away for throughput.
 *   - saturation: a signal whose metric is absent is asserted never to fire, even though its
 *     numeric threshold (1 queued task) would be crossed by a naive `null >= 1` comparison —
 *     which is false in JavaScript for `null >= 1`, but `0 >= 1` is also false and `null` sorts
 *     as 0 in several plausible refactors, so the test pins the `exported` flag as well.
 *   - report: the renderer's output is asserted to contain the JSON's own values, and a failing
 *     report is asserted to print FAIL and not PASS.
 *
 * Every scan-style assertion also checks it scanned something: the parser fixture is asserted to
 * yield more than 12 samples and the renderer more than 12 lines, so a fixture that silently
 * emptied could not pass.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildReport,
  classifySaturation,
  compareAfterResume,
  evaluateStopCriteria,
  histogramBoundAtQuantile,
  histogramDelta,
  histogramOf,
  parseArgs,
  parseExposition,
  parseExpositionValue,
  percentile,
  renderReport,
  sampleValue,
  seriesByLabel,
  seriesTotal,
  snapshotOfView,
  summariseLatency,
  thinkTimePerHandMs,
} from './load-test.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A verbatim excerpt of a real scrape of this service.
 *
 * Captured from a running `apps/api` on 2026-08-22 after a short load run, with
 * `curl -s -H 'Authorization: Bearer <token>' http://127.0.0.1:3051/metrics`. Lines are copied
 * unchanged, including the exact float formatting the registry produces; only whole metric
 * blocks that add nothing to these assertions have been left out.
 *
 * `prl_worker_tasks_total` is kept deliberately: it is declared in `observability/metrics.ts`,
 * has a HELP and TYPE preamble, and has NO sample line because nothing had incremented it. That
 * is the shape the "absent is not zero" assertions below depend on, and it is real rather than
 * contrived.
 */
const REAL_SCRAPE = `# HELP prl_api_errors_total Error responses by contract error code.
# TYPE prl_api_errors_total counter
prl_api_errors_total{code="content_not_found"} 3
# HELP prl_db_pool_max Configured upper bound on pooled connections for this process.
# TYPE prl_db_pool_max gauge
prl_db_pool_max 10
# HELP prl_db_probe_duration_seconds Time for the readiness probe to acquire a pooled connection and run select 1.
# TYPE prl_db_probe_duration_seconds histogram
prl_db_probe_duration_seconds_bucket{le="0.001"} 1
prl_db_probe_duration_seconds_bucket{le="0.005"} 7
prl_db_probe_duration_seconds_bucket{le="0.01"} 9
prl_db_probe_duration_seconds_bucket{le="0.05"} 10
prl_db_probe_duration_seconds_bucket{le="0.1"} 10
prl_db_probe_duration_seconds_bucket{le="0.5"} 10
prl_db_probe_duration_seconds_bucket{le="1"} 10
prl_db_probe_duration_seconds_bucket{le="5"} 10
prl_db_probe_duration_seconds_bucket{le="10"} 10
prl_db_probe_duration_seconds_bucket{le="+Inf"} 10
prl_db_probe_duration_seconds_sum 0.06696433100000466
prl_db_probe_duration_seconds_count 10
# HELP prl_event_loop_delay_p99_seconds 99th percentile event-loop delay since the previous scrape.
# TYPE prl_event_loop_delay_p99_seconds gauge
prl_event_loop_delay_p99_seconds 0.001157503
# HELP prl_http_request_duration_seconds Wall-clock time from request received to response sent.
# TYPE prl_http_request_duration_seconds histogram
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="0.005"} 0
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="0.01"} 0
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="0.025"} 1
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="0.05"} 1
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="0.1"} 1
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="0.25"} 1
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="0.5"} 1
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="1"} 1
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="2.5"} 1
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="5"} 1
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="10"} 1
prl_http_request_duration_seconds_bucket{method="POST",route="/api/v1/rooms",le="+Inf"} 1
prl_http_request_duration_seconds_sum{method="POST",route="/api/v1/rooms"} 0.017587666000001265
prl_http_request_duration_seconds_count{method="POST",route="/api/v1/rooms"} 1
# HELP prl_http_requests_total HTTP requests completed, by method, matched route pattern and status class.
# TYPE prl_http_requests_total counter
prl_http_requests_total{method="GET",route="/api/v1/health",status="2xx"} 2
prl_http_requests_total{method="GET",route="/api/v1/ready",status="2xx"} 10
prl_http_requests_total{method="GET",route="/metrics",status="2xx"} 10
prl_http_requests_total{method="POST",route="/api/v1/rooms",status="2xx"} 1
# HELP prl_process_cpu_seconds_total Cumulative user plus system CPU time consumed by this process.
# TYPE prl_process_cpu_seconds_total counter
prl_process_cpu_seconds_total 3.785529
# HELP prl_process_resident_memory_bytes Resident set size of this process.
# TYPE prl_process_resident_memory_bytes gauge
prl_process_resident_memory_bytes 64897024
# HELP prl_websocket_connections WebSocket connections currently open.
# TYPE prl_websocket_connections gauge
prl_websocket_connections 0
# HELP prl_worker_pool_queued Tasks waiting for a worker thread.
# TYPE prl_worker_pool_queued gauge
prl_worker_pool_queued 0
# HELP prl_worker_tasks_total Worker tasks by terminal outcome (completed, failed, timed_out, rejected).
# TYPE prl_worker_tasks_total counter
`;

/**
 * Hand-written, and labelled as such because this service never emits any of it.
 *
 * Every line here is legal exposition that a scraper has to survive and that a healthy scrape of
 * a well-behaved process will not contain: the format's three label escapes, a label value
 * carrying the two characters a regex-based parser splits on, the non-finite value tokens, a
 * trailing timestamp (which the format permits and `registry.ts` does not write), a plain `#`
 * comment, and two lines that are not exposition at all.
 *
 * The escaping matters because `registry.ts` DOES escape backslash, double quote and newline in
 * a label value — see `escapeLabelValue` — so the day a label carries one of them, this parser
 * has to undo it correctly or every series with that label collides onto the wrong key.
 */
const HOSTILE_EXPOSITION = `# a bare comment, which is legal and carries no metric
# HELP prl_test_escapes Hand-written: the three escapes the exposition format defines.
# TYPE prl_test_escapes gauge
prl_test_escapes{note="a \\"quoted\\" value"} 1
prl_test_escapes{note="a back\\\\slash"} 2
prl_test_escapes{note="line\\nbreak"} 3
prl_test_escapes{note="brace } and comma , inside"} 4
prl_test_values{kind="positive_infinity"} +Inf
prl_test_values{kind="negative_infinity"} -Inf
prl_test_values{kind="not_a_number"} NaN
prl_test_timestamped{kind="with_timestamp"} 42.5 1787404421000
prl_test_plain 7
this line is not exposition at all
prl_test_unclosed{kind="missing brace 1
`;

// ---------------------------------------------------------------------------
// Builders for the pure report machinery
// ---------------------------------------------------------------------------

/** A latency summary with the shape `summariseLatency` produces, for fabricated levels. */
function latency({ count = 500, p50 = 5, p95 = 20, p99 = 40, max = 60, mean = 8 } = {}) {
  return { count, meanMs: mean, p50Ms: p50, p95Ms: p95, p99Ms: p99, maxMs: max };
}

/** A level summary in the shape `summariseLevel` produces. Healthy unless told otherwise. */
function level(overrides = {}) {
  const client = {
    action: latency(),
    coach: latency({ count: 40, p50: 25, p95: 40, p99: 55, max: 60 }),
    review: latency({ count: 20, p50: 30, p95: 60, p99: 80, max: 90 }),
    connect: latency({ count: 6, p50: 3, p95: 5, p99: 6, max: 6 }),
    reconnect: latency({ count: 12, p50: 3, p95: 5, p99: 6, max: 6 }),
    actionsSent: 500,
    actionsApplied: 500,
    actionsPerSecond: 33.3,
    handsCompleted: 40,
    handsPerMinute: 160,
    coachRequested: 40,
    coachAnswered: 40,
    reviewsOpened: 20,
    serverMessages: 4000,
    seatTimeouts: 0,
    socketsOpenPeak: 6,
    connectionsAttempted: 6,
    connectionsEstablished: 6,
    reconnectsAttempted: 12,
    reconnectsEstablished: 12,
    reconnectsConsistent: 12,
    reconnectsHandAdvanced: 1,
    reconnectRate: 1,
    errors: {},
    errorCount: 0,
    errorRate: 0,
    errorRateDenominator: 540,
    consistencyFailures: [],
    ...(overrides.client ?? {}),
  };
  const server = {
    scrapes: 6,
    scrapeFailures: 0,
    usable: true,
    scrapeSpanSeconds: 15,
    httpRequestsPerSecond: 4,
    httpRequestsDelta: 60,
    harnessRequestsDelta: 12,
    apiErrors: {},
    rateLimitLimited: 0,
    rateLimitBanned: 0,
    cpuSecondsDelta: 3,
    cpuCores: 0.2,
    residentMemoryPeakBytes: 180 * 1024 * 1024,
    heapUsedPeakBytes: 60 * 1024 * 1024,
    eventLoopP99PeakMs: 4,
    eventLoopMeanPeakMs: 1,
    eventLoopMaxPeakMs: 12,
    dbPoolMax: 10,
    dbProbeCount: 6,
    dbProbeMeanMs: 2,
    dbProbeP99BoundMs: 10,
    readinessState: 1,
    websocketConnectionsPeak: 6,
    workerPoolBusyPeak: 0,
    workerPoolQueuedPeak: 0,
    handsStartedDelta: 41,
    handsCompletedDelta: 40,
    missing: [],
    ...(overrides.server ?? {}),
  };
  return {
    level: overrides.level ?? 1,
    tables: overrides.tables ?? 2,
    seats: 3,
    virtualUsers: overrides.virtualUsers ?? 6,
    holdSeconds: 15,
    wallSeconds: 15.4,
    client,
    server,
    tableOutcomes: [{ index: 0, handsCompleted: 20, outcome: 'complete' }],
  };
}

const THRESHOLDS = {
  maxErrorRate: 0.01,
  maxP95Ms: 150,
  maxP99Ms: 250,
  minReconnectRate: 0.99,
  eventLoopP99Ms: 50,
  cpuCores: 0.9,
  dbProbeP99Ms: 50,
};

/** The arguments `buildReport` takes, with everything but `levels` held fixed. */
function reportInput(levels, overrides = {}) {
  return {
    options: { ...parseArgs([]), metricsToken: 'a-real-token-that-must-not-be-echoed' },
    environment: {
      target: 'http://127.0.0.1:3001',
      transport: 'plaintext (no TLS)',
      network: 'loopback — no network hop, no packet loss, no RTT',
      generatorLocation: 'same host as the server, competing with it for CPU',
      serverNodeEnv: 'development (asserted with --server-env; a client cannot observe it)',
      proxy: 'none asserted; nothing here detects a transparent one',
      otherTenants: 'neither controlled nor measured by this harness',
      generator: {
        node: 'v24.18.0',
        platform: 'darwin arm64',
        logicalCpus: 10,
        totalMemoryBytes: 1,
        loadAverageAtStart: [1, 1, 1],
      },
      generatorCpuSeconds: 12.5,
      loadAverageAtEnd: [2, 2, 2],
    },
    levels,
    thresholds: THRESHOLDS,
    stopped: { reason: null },
    runSeconds: 123.4,
    setup: {
      sessionsRequested: 24,
      sessionsCreated: 24,
      seconds: 0.4,
      failures: [],
      errors: {},
      warmup: {
        handsCompleted: 1,
        firstCoachMs: 2966.4,
        coachSamples: 1,
        firstReviewMs: 30.2,
        reviewSamples: 1,
        eventLoopP99Ms: 2957.5,
        note: 'a cold process, measured once.',
      },
    },
    ...overrides,
  };
}

const textOf = (lines) => lines.map((line) => line.text).join('\n');

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

describe('percentile', () => {
  // 1..100 inclusive. Chosen because the nearest rank for each fraction lands on an integer, so
  // the expected answers can be stated without a calculator and a reader can check them.
  const hundred = Array.from({ length: 100 }, (_unused, index) => index + 1);

  it('reports the nearest-rank value for each fraction over a known distribution', () => {
    assert.equal(percentile(hundred, 0.5), 50);
    assert.equal(percentile(hundred, 0.9), 90);
    // p95 is the figure the previous harness never reported at all, and the one every alert
    // threshold in observability/metrics.ts is expressed in.
    assert.equal(percentile(hundred, 0.95), 95);
    assert.equal(percentile(hundred, 0.99), 99);
    assert.equal(percentile(hundred, 1), 100);
  });

  it('clamps at both ends rather than reading off the array', () => {
    assert.equal(percentile(hundred, 0), 1);
    assert.equal(percentile(hundred, 2), 100);
    assert.equal(percentile([], 0.95), null);
    assert.equal(percentile([7], 0.99), 7);
  });

  it('is not the two plausible off-by-one variants (NEGATIVE CONTROL)', () => {
    // Seven samples, so `fraction * n` is fractional for every interesting fraction and the two
    // wrong index formulas cannot coincidentally agree with the right one — which is exactly what
    // happens at n = 100, where floor and ceil of 95 are both 95.
    const seven = [1, 2, 3, 4, 5, 6, 7];

    // The real implementation: index = ceil(fraction * n) - 1.
    assert.equal(percentile(seven, 0.5), 4);
    assert.equal(percentile(seven, 0.95), 7);

    // Variant A: the `- 1` forgotten, so a rank is used as an index.
    const missingTheMinusOne = (sorted, fraction) => sorted[Math.ceil(fraction * sorted.length)];
    assert.equal(missingTheMinusOne(seven, 0.5), 5);
    assert.notEqual(missingTheMinusOne(seven, 0.5), percentile(seven, 0.5));

    // Variant B: `floor` instead of `ceil`, which is the other way people write nearest rank.
    const flooredRank = (sorted, fraction) => sorted[Math.floor(fraction * sorted.length) - 1];
    assert.equal(flooredRank(seven, 0.5), 3);
    assert.notEqual(flooredRank(seven, 0.5), percentile(seven, 0.5));
  });

  it('never interpolates a value no sample had', () => {
    // Two widely separated samples. An interpolating percentile would answer somewhere in the
    // middle, which is a latency no request experienced.
    const gap = [1, 1000];
    assert.equal(percentile(gap, 0.5), 1);
    assert.equal(percentile(gap, 0.51), 1000);
    assert.ok([1, 1000].includes(percentile(gap, 0.75)));
  });
});

describe('summariseLatency', () => {
  it('reports p50, p95, p99, max, mean and the sample count together', () => {
    const samples = Array.from({ length: 100 }, (_unused, index) => index + 1);
    const summary = summariseLatency(samples);
    assert.equal(summary.count, 100);
    assert.equal(summary.p50Ms, 50);
    assert.equal(summary.p95Ms, 95);
    assert.equal(summary.p99Ms, 99);
    assert.equal(summary.maxMs, 100);
    assert.equal(summary.meanMs, 50.5);
  });

  it('sorts a copy rather than the caller array, and handles the empty case', () => {
    const samples = [30, 10, 20];
    const summary = summariseLatency(samples);
    assert.deepEqual(samples, [30, 10, 20], 'the input array must not be sorted in place');
    assert.equal(summary.p50Ms, 20);
    assert.deepEqual(summariseLatency([]), {
      count: 0,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The Prometheus exposition parser
// ---------------------------------------------------------------------------

describe('parseExposition, against a real captured scrape', () => {
  const snapshot = parseExposition(REAL_SCRAPE);

  it('scanned a non-empty set and read every line', () => {
    assert.ok(
      snapshot.samples.length > 12,
      `expected more than 12 samples from the captured scrape, got ${snapshot.samples.length}`,
    );
    assert.deepEqual(snapshot.malformed, [], 'a real scrape must parse without a single bad line');
    assert.ok(snapshot.help.size > 5, 'HELP lines were not collected');
    assert.equal(snapshot.types.get('prl_db_probe_duration_seconds'), 'histogram');
    assert.equal(snapshot.types.get('prl_http_requests_total'), 'counter');
  });

  it('reads unlabelled gauges and counters', () => {
    assert.equal(sampleValue(snapshot, 'prl_db_pool_max'), 10);
    assert.equal(sampleValue(snapshot, 'prl_process_resident_memory_bytes'), 64897024);
    assert.equal(sampleValue(snapshot, 'prl_process_cpu_seconds_total'), 3.785529);
    assert.equal(sampleValue(snapshot, 'prl_event_loop_delay_p99_seconds'), 0.001157503);
  });

  it('reads a labelled counter, exactly, and by label', () => {
    assert.equal(sampleValue(snapshot, 'prl_api_errors_total', { code: 'content_not_found' }), 3);
    assert.equal(sampleValue(snapshot, 'prl_api_errors_total', { code: 'never_happened' }), null);
    assert.deepEqual(seriesByLabel(snapshot, 'prl_api_errors_total', 'code'), { content_not_found: 3 });
  });

  it('sums a labelled counter and can exclude the harness own traffic', () => {
    assert.equal(seriesTotal(snapshot, 'prl_http_requests_total'), 23);
    // This is the filter the harness uses so that scraping and probing are not counted as load.
    const applied = seriesTotal(
      snapshot,
      'prl_http_requests_total',
      (labels) => labels.route !== '/metrics' && labels.route !== '/api/v1/ready',
    );
    assert.equal(applied, 3);
  });

  it('an absent series is null, and NEVER zero (NEGATIVE CONTROL)', () => {
    // `prl_worker_tasks_total` is declared, carries HELP and TYPE, and has no sample line because
    // nothing had incremented it. Reporting that as `0` would turn missing instrumentation into a
    // confident claim that no worker task ran.
    assert.equal(sampleValue(snapshot, 'prl_worker_tasks_total'), null);
    assert.notEqual(sampleValue(snapshot, 'prl_worker_tasks_total'), 0);
    assert.equal(seriesTotal(snapshot, 'prl_worker_tasks_total'), null);
    assert.equal(seriesByLabel(snapshot, 'prl_worker_tasks_total', 'outcome'), null);
    // And a gauge that IS exported with the value zero must still read as zero, or the harness
    // could not tell an idle worker pool from an uninstrumented one.
    assert.equal(sampleValue(snapshot, 'prl_worker_pool_queued'), 0);
    assert.equal(sampleValue(snapshot, 'prl_websocket_connections'), 0);
  });

  it('reads an unlabelled histogram including its +Inf bucket', () => {
    const histogram = histogramOf(snapshot, 'prl_db_probe_duration_seconds');
    assert.equal(histogram.count, 10);
    assert.equal(histogram.sum, 0.06696433100000466);
    assert.equal(histogram.buckets.length, 10);
    assert.deepEqual(
      histogram.buckets.map((bucket) => bucket.le),
      [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, Number.POSITIVE_INFINITY],
    );
    assert.equal(histogram.buckets[histogram.buckets.length - 1].cumulative, 10);
  });

  it('reads a LABELLED histogram, and only the series asked for', () => {
    const histogram = histogramOf(snapshot, 'prl_http_request_duration_seconds', {
      method: 'POST',
      route: '/api/v1/rooms',
    });
    assert.equal(histogram.count, 1);
    assert.equal(histogram.sum, 0.017587666000001265);
    assert.equal(histogram.buckets.length, 12);
    // The observation was between 10ms and 25ms, so the first two buckets are empty.
    assert.equal(histogram.buckets[0].cumulative, 0);
    assert.equal(histogram.buckets[2].cumulative, 1);
    assert.equal(histogramOf(snapshot, 'prl_http_request_duration_seconds', { route: 'nope' }), null);
  });

  it('answers a quantile as a bucket BOUND rather than an interpolated number', () => {
    const histogram = histogramOf(snapshot, 'prl_db_probe_duration_seconds');
    // count 10, so the 0.99 target is 9.9 observations: the first bucket whose cumulative count
    // reaches it is le=0.05.
    assert.equal(histogramBoundAtQuantile(histogram, 0.99), 0.05);
    // The 0.5 target is 5: le=0.005 already holds 7.
    assert.equal(histogramBoundAtQuantile(histogram, 0.5), 0.005);
    // A bound, never a decimal between two bounds — this is what makes the figure a statement the
    // data supports rather than an assumption about how observations are spread inside a bucket.
    assert.ok(
      [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10].includes(histogramBoundAtQuantile(histogram, 0.9)),
    );
    assert.equal(histogramBoundAtQuantile(null, 0.99), null);
    assert.equal(histogramBoundAtQuantile({ buckets: [], sum: 0, count: 0 }, 0.99), null);
  });

  it('separates "above the top bound" from "nothing was measured"', () => {
    // Everything landed above the top bound, so all that is known is "above 10 s". This used to
    // return null, which is also what no observations returns — so the slowest reading the
    // histogram can produce was indistinguishable from an absent metric, and the signal that
    // exists to name it stayed quiet. Infinity is not an invented number: it is the bound.
    const overflowing = {
      buckets: [
        { le: 1, cumulative: 0 },
        { le: 10, cumulative: 0 },
        { le: Number.POSITIVE_INFINITY, cumulative: 4 },
      ],
      sum: 400,
      count: 4,
    };
    assert.equal(histogramBoundAtQuantile(overflowing, 0.99), Number.POSITIVE_INFINITY);
    assert.equal(histogramBoundAtQuantile({ buckets: [], sum: 0, count: 0 }, 0.99), null);
  });
});

describe('parseExposition, against hand-written hostile input', () => {
  const snapshot = parseExposition(HOSTILE_EXPOSITION);

  it('undoes the three label escapes the format defines', () => {
    assert.equal(sampleValue(snapshot, 'prl_test_escapes', { note: 'a "quoted" value' }), 1);
    assert.equal(sampleValue(snapshot, 'prl_test_escapes', { note: 'a back\\slash' }), 2);
    assert.equal(sampleValue(snapshot, 'prl_test_escapes', { note: 'line\nbreak' }), 3);
  });

  it('handles a label value containing a brace and a comma (NEGATIVE CONTROL for a regex parser)', () => {
    // A parser that split the label block on `,` or terminated it at the first `}` would produce
    // either a wrong key or a dropped sample here. Both are silent.
    assert.equal(sampleValue(snapshot, 'prl_test_escapes', { note: 'brace } and comma , inside' }), 4);
  });

  it('reads the non-finite value tokens as numbers rather than as failures', () => {
    assert.equal(
      sampleValue(snapshot, 'prl_test_values', { kind: 'positive_infinity' }),
      Number.POSITIVE_INFINITY,
    );
    assert.equal(
      sampleValue(snapshot, 'prl_test_values', { kind: 'negative_infinity' }),
      Number.NEGATIVE_INFINITY,
    );
    assert.ok(Number.isNaN(sampleValue(snapshot, 'prl_test_values', { kind: 'not_a_number' })));
    assert.equal(parseExpositionValue('+Inf'), Number.POSITIVE_INFINITY);
    assert.equal(parseExpositionValue('1.5e-9'), 1.5e-9);
    assert.equal(parseExpositionValue('not-a-number-at-all'), null);
  });

  it('discards a trailing timestamp instead of folding it into the value', () => {
    // The failure this guards against multiplies every reading by about 10^13 and produces
    // latency figures in the hundreds of years, which is at least obvious. The version where the
    // sample is dropped entirely is not.
    assert.equal(sampleValue(snapshot, 'prl_test_timestamped', { kind: 'with_timestamp' }), 42.5);
  });

  it('collects unparseable lines instead of throwing or inventing a sample', () => {
    assert.equal(sampleValue(snapshot, 'prl_test_plain'), 7);
    assert.equal(snapshot.malformed.length, 2, `unexpected malformed set: ${snapshot.malformed.join(' | ')}`);
    assert.ok(snapshot.malformed.some((line) => line.includes('not exposition at all')));
    assert.ok(snapshot.malformed.some((line) => line.includes('missing brace')));
    assert.equal(sampleValue(snapshot, 'prl_test_unclosed', { kind: 'missing brace 1' }), null);
  });

  it('treats a bare comment as neither a metric nor a failure', () => {
    assert.ok(!snapshot.samples.some((sample) => sample.name.includes('bare')));
    assert.ok(!snapshot.malformed.some((line) => line.startsWith('#')));
  });
});

describe('histogramDelta', () => {
  const before = parseExposition(REAL_SCRAPE);

  /**
   * The same scrape, plus five FAST probes.
   *
   * Fast on purpose. The point of subtracting a baseline is that a level's own distribution is
   * not the process's distribution since boot, and that only shows up when the two disagree —
   * which they cannot when the new observations are the slow ones, because a cumulative
   * histogram's tail is dominated by whatever arrived last. Five probes at or below 1 ms leave
   * the cumulative 0.99 pinned at the old slow bound while the delta's is three bounds lower.
   */
  const AFTER_FIVE_FAST_PROBES = [
    ['{le="0.001"} 1', '{le="0.001"} 6'],
    ['{le="0.005"} 7', '{le="0.005"} 12'],
    ['{le="0.01"} 9', '{le="0.01"} 14'],
    ['{le="0.05"} 10', '{le="0.05"} 15'],
    ['{le="0.1"} 10', '{le="0.1"} 15'],
    ['{le="0.5"} 10', '{le="0.5"} 15'],
    ['{le="1"} 10', '{le="1"} 15'],
    ['{le="5"} 10', '{le="5"} 15'],
    ['{le="10"} 10', '{le="10"} 15'],
    ['{le="+Inf"} 10', '{le="+Inf"} 15'],
    ['_count 10', '_count 15'],
  ].reduce(
    (text, [from, to]) =>
      text
        .replace(`prl_db_probe_duration_seconds_bucket${from}`, `prl_db_probe_duration_seconds_bucket${to}`)
        .replace('prl_db_probe_duration_seconds_count 10', 'prl_db_probe_duration_seconds_count 15'),
    REAL_SCRAPE,
  );
  const after = parseExposition(AFTER_FIVE_FAST_PROBES);

  it('describes only the observations made between the two readings', () => {
    const cumulative = histogramOf(after, 'prl_db_probe_duration_seconds');
    const delta = histogramDelta(histogramOf(before, 'prl_db_probe_duration_seconds'), cumulative);

    assert.equal(cumulative.count, 15);
    assert.equal(delta.count, 5, 'five probes happened during the interval');
    // Every one of the five was at or below 1 ms, so the DELTA's 0.99 bound is 0.001 while the
    // cumulative histogram still reports 0.05 because of a slow probe from before the level
    // started. Without the subtraction, level 8 would be reported carrying level 1's tail.
    assert.equal(histogramBoundAtQuantile(delta, 0.99), 0.001);
    assert.equal(histogramBoundAtQuantile(cumulative, 0.99), 0.05);
    assert.notEqual(histogramBoundAtQuantile(delta, 0.99), histogramBoundAtQuantile(cumulative, 0.99));
  });

  it('treats an absent baseline as zero rather than as a failure', () => {
    const only = histogramOf(after, 'prl_db_probe_duration_seconds');
    assert.deepEqual(histogramDelta(null, only), only);
    assert.equal(histogramDelta(only, null), null);
  });
});

// ---------------------------------------------------------------------------
// Stop criteria
// ---------------------------------------------------------------------------

describe('evaluateStopCriteria', () => {
  it('does not stop a healthy level', () => {
    const verdict = evaluateStopCriteria(level(), THRESHOLDS);
    assert.equal(verdict.stop, false, `unexpected breaches: ${JSON.stringify(verdict.breaches)}`);
    assert.deepEqual(verdict.breaches, []);
  });

  it('stops on p95, and names p95', () => {
    const verdict = evaluateStopCriteria(
      level({ client: { action: latency({ p95: 151, p99: 200 }) } }),
      THRESHOLDS,
    );
    assert.equal(verdict.stop, true);
    assert.deepEqual(
      verdict.breaches.map((breach) => breach.criterion),
      ['latency-p95'],
    );
    assert.equal(verdict.breaches[0].limit, 150);
    assert.equal(verdict.breaches[0].observed, 151);
  });

  it('stops on p99 independently of p95', () => {
    const verdict = evaluateStopCriteria(
      level({ client: { action: latency({ p95: 100, p99: 251 }) } }),
      THRESHOLDS,
    );
    assert.deepEqual(
      verdict.breaches.map((breach) => breach.criterion),
      ['latency-p99'],
    );
  });

  it('stops on the error rate, and prints the denominator in the detail', () => {
    const verdict = evaluateStopCriteria(
      level({ client: { errorRate: 0.02, errorCount: 11, errorRateDenominator: 550 } }),
      THRESHOLDS,
    );
    assert.deepEqual(
      verdict.breaches.map((breach) => breach.criterion),
      ['error-rate'],
    );
    assert.match(verdict.breaches[0].detail, /550 operations/);
  });

  it('stops when reconnects stop resuming', () => {
    const verdict = evaluateStopCriteria(
      level({ client: { reconnectsAttempted: 20, reconnectsEstablished: 17, reconnectRate: 0.85 } }),
      THRESHOLDS,
    );
    assert.deepEqual(
      verdict.breaches.map((breach) => breach.criterion),
      ['reconnect-rate'],
    );
  });

  it('stops on a refused connection and on a server-side rate-limit refusal', () => {
    const refusedSockets = evaluateStopCriteria(
      level({ client: { connectionsAttempted: 24, connectionsEstablished: 22 } }),
      THRESHOLDS,
    );
    assert.deepEqual(
      refusedSockets.breaches.map((breach) => breach.criterion),
      ['refusal-connect'],
    );

    const limited = evaluateStopCriteria(level({ server: { rateLimitLimited: 4 } }), THRESHOLDS);
    assert.deepEqual(
      limited.breaches.map((breach) => breach.criterion),
      ['refusal-rate-limited'],
    );
  });

  it('stops when a level completed no hand at all', () => {
    const verdict = evaluateStopCriteria(
      level({ client: { handsCompleted: 0, handsPerMinute: 0 } }),
      THRESHOLDS,
    );
    assert.deepEqual(
      verdict.breaches.map((breach) => breach.criterion),
      ['no-progress'],
    );
    // At think time 0 there is nothing to blame but the server, so no excuse is offered.
    assert.ok(!verdict.breaches[0].detail.includes('likely the hold'));
  });

  it('says so when a hold that is too short for one hand is the likely cause', () => {
    // Observed for real: six seats at one second a decision needs about twenty-four seconds of
    // think time per hand, and a twenty-second hold then reports "no hand completed" at every
    // level, which reads as a saturated server and is a misconfigured run.
    const starved = level({ client: { handsCompleted: 0, handsPerMinute: 0 } });
    starved.thinkMs = 1000;
    starved.seats = 6;
    starved.holdSeconds = 20;
    const verdict = evaluateStopCriteria(starved, THRESHOLDS);
    assert.equal(verdict.breaches[0].criterion, 'no-progress');
    assert.match(verdict.breaches[0].detail, /roughly 24s of think time alone and the hold was 20s/);
    assert.match(verdict.breaches[0].detail, /very likely the hold rather than the server/);
    assert.equal(thinkTimePerHandMs(starved), 24_000);

    // NEGATIVE CONTROL: a hold that comfortably fits a hand gets no excuse, so the message
    // cannot be used to explain away a genuinely stalled server.
    starved.holdSeconds = 120;
    assert.ok(!evaluateStopCriteria(starved, THRESHOLDS).breaches[0].detail.includes('likely the hold'));
    assert.equal(thinkTimePerHandMs({ thinkMs: 0, seats: 6 }), 0);
  });

  it('stops on a reconnect consistency failure even when every other number is perfect', () => {
    // The point of the whole criterion: there is no concurrency at which a resumed client seeing
    // the wrong hand is an acceptable trade for throughput, so this has no configurable
    // threshold and cannot be tuned away.
    const verdict = evaluateStopCriteria(
      level({
        client: { consistencyFailures: ['own hole cards changed on resume within hand hnd_1'] },
      }),
      THRESHOLDS,
    );
    assert.equal(verdict.stop, true);
    assert.equal(verdict.breaches[0].criterion, 'reconnect-consistency');
    assert.equal(verdict.breaches[0].limit, 0);
    assert.match(verdict.breaches[0].detail, /hole cards changed/);
  });

  it('stops when the level had no usable server-side half, rather than passing on client timings', () => {
    // This test used to assert the OPPOSITE — `verdict.stop === false` — on the reasoning that
    // `rateLimitLimited` is undefined on an unusable summary and a comparison against undefined
    // must not become a breach. The first half is true; the conclusion was the defect. Skipping
    // every server-side criterion left the level passing on client timings alone, and
    // `buildReport` then published it: four levels of `{usable:false, scrapes:1,
    // scrapeFailures:5}` with healthy client numbers returned `passed:true`, `failures:[]`,
    // `capacity.concurrentSeatedPlayers: 24`, `saturation.resource: null`. A capacity figure with
    // no server-side evidence behind any of it, from a harness whose header says an unreachable
    // /metrics is a hard failure — and whose preflight only guards the FIRST scrape.
    //
    // It matters most for `refusal-rate-limited`: a level with no scrapes cannot see a single
    // refusal, so a ramp bounded by the LIMITER rather than by the machine — the bug that
    // criterion exists for — was reachable again through this door.
    const verdict = evaluateStopCriteria(
      level({
        server: {
          usable: false,
          scrapes: 1,
          scrapeFailures: 5,
          note: 'fewer than two successful scrapes',
        },
      }),
      THRESHOLDS,
    );
    assert.equal(verdict.stop, true);
    assert.deepEqual(
      verdict.breaches.map((breach) => breach.criterion),
      ['server-side-blind'],
      'exactly one breach: the missing evidence, not a guess at what it would have said',
    );
    assert.match(verdict.breaches[0].detail, /rate-limit refusal count/);
    assert.match(verdict.breaches[0].detail, /fewer than two successful scrapes/);
  });

  it('does not fire server-side-blind on a healthy level, so it cannot fail every run', () => {
    // The positive control. A criterion that fired unconditionally would satisfy the assertions
    // above and would make the ramp incapable of producing any capacity figure at all.
    assert.equal(evaluateStopCriteria(level(), THRESHOLDS).stop, false);
  });

  it('publishes no capacity from a run whose /metrics scrapes all failed', () => {
    // The end-to-end shape of the same defect, through the report builder that CI reads.
    const blind = {
      scrapes: 1,
      scrapeFailures: 5,
      usable: false,
      missing: [],
      note: 'fewer than two successful scrapes',
    };
    const report = buildReport(
      reportInput(
        [1, 2, 4, 8].map((tables, index) => {
          const built = level();
          built.level = index + 1;
          built.tables = tables;
          built.virtualUsers = tables * 3;
          built.server = blind;
          return built;
        }),
      ),
    );
    assert.equal(report.passed, false);
    assert.equal(report.capacity, null);
    assert.ok(report.failures.some((failure) => /server-side-blind|no capacity figure/.test(failure)));
  });
});

// ---------------------------------------------------------------------------
// Saturation classification
// ---------------------------------------------------------------------------

describe('classifySaturation', () => {
  it('names nothing when every exported signal is below its threshold', () => {
    const verdict = classifySaturation(level(), THRESHOLDS);
    assert.equal(verdict.resource, 'not-identified');
    assert.ok(verdict.signals.every((signal) => !signal.fired));
    // The signals are still all reported: "the database was fine" is part of an honest claim.
    assert.ok(verdict.signals.length >= 5);
  });

  it('blames the event loop when it is over its threshold', () => {
    const verdict = classifySaturation(level({ server: { eventLoopP99PeakMs: 420 } }), THRESHOLDS);
    assert.equal(verdict.resource, 'event-loop');
    assert.match(verdict.meaning, /event loop/);
    const fired = verdict.signals.find((signal) => signal.name === 'event-loop');
    assert.equal(fired.fired, true);
    assert.equal(fired.observed, 420);
  });

  it('prefers the event loop over CPU when both fire, because one causes the other', () => {
    const verdict = classifySaturation(
      level({ server: { eventLoopP99PeakMs: 420, cpuCores: 0.98 } }),
      THRESHOLDS,
    );
    assert.equal(verdict.resource, 'event-loop');
    assert.equal(
      verdict.signals.filter((signal) => signal.fired).length,
      2,
      'both signals must still be shown as fired',
    );
  });

  it('blames the database pool when only the probe is slow', () => {
    const verdict = classifySaturation(level({ server: { dbProbeP99BoundMs: 500 } }), THRESHOLDS);
    assert.equal(verdict.resource, 'db-pool');
    const probe = verdict.signals.find((signal) => signal.name === 'db-pool');
    assert.equal(probe.confoundedBy, 'event-loop', 'the probe must always declare what confounds it');
  });

  it('does not blame the pool for a bound that MEETS the threshold (NEGATIVE CONTROL)', () => {
    // The observed value is a bound: 50 ms means "99% of probes finished within 50 ms", which is
    // the threshold being met, not exceeded. Firing on `>=` reported `resource: db-pool` for a
    // three-player level at 0.4 requests per second, where the reading was the pool opening its
    // first connection. The report printed `db probe p99 <= 50.0ms` and `FIRED 50.00 ms
    // (threshold 50 ms)` on the same screen.
    const verdict = classifySaturation(
      level({ server: { dbProbeP99BoundMs: THRESHOLDS.dbProbeP99Ms } }),
      THRESHOLDS,
    );
    assert.equal(verdict.resource, 'not-identified');
    assert.equal(verdict.signals.find((signal) => signal.name === 'db-pool').fired, false);
  });

  it('blames the pool when the probe quantile is above the top bucket', () => {
    // The worst reading the histogram can give. It must fire, and it must not be mistaken for an
    // unexported metric.
    const verdict = classifySaturation(
      level({ server: { dbProbeP99BoundMs: Number.POSITIVE_INFINITY } }),
      THRESHOLDS,
    );
    assert.equal(verdict.resource, 'db-pool');
    const probe = verdict.signals.find((signal) => signal.name === 'db-pool');
    assert.equal(probe.fired, true);
    assert.equal(probe.exported, true);
  });

  it('a signal whose metric is not exported can never fire (NEGATIVE CONTROL)', () => {
    // The worker pool threshold is 1 queued task. With the metric absent the observed value is
    // null, and the harness must report "not exported" rather than blaming a subsystem it cannot
    // see — the exact mistake that would let missing instrumentation masquerade as a diagnosis.
    const verdict = classifySaturation(
      level({
        server: {
          workerPoolQueuedPeak: null,
          eventLoopP99PeakMs: null,
          cpuCores: null,
          dbProbeP99BoundMs: null,
          rateLimitLimited: null,
          missing: ['prl_worker_pool_queued'],
        },
      }),
      THRESHOLDS,
    );
    assert.equal(verdict.resource, 'not-identified');
    for (const signal of verdict.signals) {
      assert.equal(signal.exported, false, `${signal.name} should be reported as not exported`);
      assert.equal(signal.fired, false, `${signal.name} must not fire on an absent metric`);
    }
  });

  it('reports a queued worker task when the metric IS exported', () => {
    const verdict = classifySaturation(
      level({ server: { workerPoolQueuedPeak: 3, eventLoopP99PeakMs: 4, cpuCores: 0.2 } }),
      THRESHOLDS,
    );
    assert.equal(verdict.resource, 'worker-pool');
  });
});

// ---------------------------------------------------------------------------
// Reconnect consistency
// ---------------------------------------------------------------------------

describe('snapshotOfView', () => {
  it('takes the caller own seat by isSelf, not by seat index', () => {
    // `isSelf` is decided server-side by playerId, and a recipient may sit at an index that
    // somebody else was dealt into. Reading `seats[viewerSeat]` would compare the wrong seat's
    // cards after a resume and report a leak that never happened.
    const view = {
      handId: 'hnd_1',
      roomId: 'rm_1',
      viewerSeat: 1,
      actionSequence: 4,
      potTotal: 30,
      street: 'flop',
      seats: [
        { seat: 0, isSelf: false, holeCards: null },
        { seat: 1, isSelf: true, holeCards: ['Ah', 'Kd'] },
      ],
    };
    assert.deepEqual(snapshotOfView(view), {
      handId: 'hnd_1',
      roomId: 'rm_1',
      viewerSeat: 1,
      actionSequence: 4,
      potTotal: 30,
      street: 'flop',
      holeCards: 'AhKd',
    });
    assert.equal(snapshotOfView(null), null);
  });
});

describe('compareAfterResume', () => {
  const before = {
    handId: 'hnd_1',
    roomId: 'rm_1',
    viewerSeat: 1,
    actionSequence: 4,
    potTotal: 30,
    street: 'flop',
    holeCards: 'AhKd',
  };
  const welcome = { room: { id: 'rm_1' } };

  it('is silent when the resumed view agrees, and when it has only moved forward', () => {
    assert.deepEqual(compareAfterResume(before, { ...before }, welcome, 'rm_1'), []);
    // The other seats kept playing: a later sequence and a bigger pot are correct, not a fault.
    assert.deepEqual(
      compareAfterResume(
        before,
        { ...before, actionSequence: 9, potTotal: 90, street: 'turn' },
        welcome,
        'rm_1',
      ),
      [],
    );
  });

  it('treats a finished hand as benign and says so by kind', () => {
    const advanced = compareAfterResume(before, { ...before, handId: 'hnd_2' }, welcome, 'rm_1');
    assert.deepEqual(
      advanced.map((problem) => problem.kind),
      ['hand-advanced'],
    );
    const noHand = compareAfterResume(before, null, welcome, 'rm_1');
    assert.deepEqual(
      noHand.map((problem) => problem.kind),
      ['hand-advanced'],
    );
  });

  it('catches a resume that came back with the wrong cards (NEGATIVE CONTROL)', () => {
    const problems = compareAfterResume(before, { ...before, holeCards: '7c2d' }, welcome, 'rm_1');
    assert.deepEqual(
      problems.map((problem) => problem.kind),
      ['hole-cards-changed'],
    );
    assert.match(problems[0].detail, /hnd_1/);
  });

  it('catches a rewound sequence, a shrinking pot, a changed seat and the wrong room', () => {
    assert.deepEqual(
      compareAfterResume(before, { ...before, actionSequence: 2 }, welcome, 'rm_1').map((p) => p.kind),
      ['sequence-rewound'],
    );
    assert.deepEqual(
      compareAfterResume(before, { ...before, potTotal: 10 }, welcome, 'rm_1').map((p) => p.kind),
      ['pot-shrank'],
    );
    assert.deepEqual(
      compareAfterResume(before, { ...before, viewerSeat: 3 }, welcome, 'rm_1').map((p) => p.kind),
      ['seat-changed'],
    );
    assert.deepEqual(
      compareAfterResume(before, { ...before }, { room: { id: 'rm_other' } }, 'rm_1').map((p) => p.kind),
      ['wrong-room'],
    );
  });

  it('reports nothing when there was no pre-drop snapshot to compare against', () => {
    assert.deepEqual(compareAfterResume(null, { ...before }, welcome, 'rm_1'), []);
  });
});

// ---------------------------------------------------------------------------
// The report: one object, rendered twice
// ---------------------------------------------------------------------------

describe('buildReport', () => {
  it('names the highest passing level as the capacity, and the first failing one as saturation', () => {
    const report = buildReport(
      reportInput([
        level({ level: 1, tables: 1, virtualUsers: 3 }),
        level({ level: 2, tables: 2, virtualUsers: 6 }),
        level({
          level: 3,
          tables: 4,
          virtualUsers: 12,
          client: { action: latency({ p95: 400, p99: 900 }) },
          server: { eventLoopP99PeakMs: 380 },
        }),
      ]),
    );
    assert.equal(report.capacity.concurrentSeatedPlayers, 6);
    assert.equal(report.capacity.instances, 1);
    assert.equal(report.saturation.found, true);
    assert.equal(report.saturation.atLevel, 3);
    assert.equal(report.saturation.atConcurrency, 12);
    assert.deepEqual(report.saturation.stoppedBy, ['latency-p95', 'latency-p99']);
    assert.equal(report.saturation.resource, 'event-loop');
    assert.equal(report.passed, false);
  });

  it('says the saturation point is above the ramp when nothing broke', () => {
    const report = buildReport(
      reportInput([level({ level: 1, virtualUsers: 3 }), level({ level: 2, virtualUsers: 6 })]),
    );
    assert.equal(report.passed, true);
    assert.equal(report.saturation.found, false);
    assert.match(report.saturation.note, /ABOVE the widest level/);
    assert.equal(report.capacity.concurrentSeatedPlayers, 6);
  });

  it('refuses to state a capacity when no level passed', () => {
    const report = buildReport(
      reportInput([level({ level: 1, client: { action: latency({ p95: 900, p99: 900 }) } })]),
    );
    assert.equal(report.capacity, null);
    assert.equal(report.passed, false);
    assert.ok(report.failures.some((failure) => failure.includes('no capacity figure')));
  });

  it('flags a level whose p99 came from too few samples to be a percentile', () => {
    const report = buildReport(reportInput([level({ client: { action: latency({ count: 18 }) } })]));
    assert.deepEqual(report.thinTails, [{ level: 1, samples: 18 }]);
  });

  it('carries the environment, the caveats and the reconnect failures into the JSON', () => {
    const report = buildReport(
      reportInput([
        level({ client: { consistencyFailures: ['own hole cards changed on resume within hand hnd_9'] } }),
      ]),
    );
    assert.match(report.environment.network, /loopback/);
    assert.match(report.environment.serverNodeEnv, /asserted/);
    assert.ok(
      report.notMeasured.length >= 5,
      'the standing caveats must travel in the JSON, not only on screen',
    );
    assert.deepEqual(report.consistencyFailures, [
      'level 1: own hole cards changed on resume within hand hnd_9',
    ]);
  });

  it('never echoes the metrics token, and survives JSON.stringify unchanged', () => {
    const report = buildReport(reportInput([level()]));
    assert.equal(report.settings.metricsToken, 'set (not shown)');
    assert.ok(!JSON.stringify(report).includes('a-real-token-that-must-not-be-echoed'));
    // A Map or a class instance anywhere in the report would survive this call and come back
    // empty, which is how a `--json` consumer ends up with `"errors": {}` for a failing run.
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  });
});

describe('renderReport', () => {
  const report = buildReport(
    reportInput([
      level({ level: 1, tables: 1, virtualUsers: 3 }),
      level({ level: 2, tables: 2, virtualUsers: 6 }),
      level({
        level: 3,
        tables: 4,
        virtualUsers: 12,
        client: { action: latency({ count: 900, p50: 60, p95: 402.5, p99: 913.5, max: 1200 }) },
        server: { eventLoopP99PeakMs: 381.5, cpuCores: 0.97 },
      }),
    ]),
  );
  const lines = renderReport(report);
  const text = textOf(lines);

  it('rendered a non-empty report', () => {
    assert.ok(lines.length > 12, `expected more than 12 rendered lines, got ${lines.length}`);
    assert.ok(lines.every((line) => typeof line.text === 'string' && typeof line.tone === 'string'));
  });

  it('prints every number the JSON carries, so the two cannot drift', () => {
    for (const reported of report.levels) {
      assert.ok(
        text.includes(`${reported.client.action.p95Ms.toFixed(1)}ms`),
        `level ${reported.level} p95 ${reported.client.action.p95Ms} is missing from the printed output`,
      );
      assert.ok(
        text.includes(`${reported.client.action.p99Ms.toFixed(1)}ms`),
        `level ${reported.level} p99 ${reported.client.action.p99Ms} is missing from the printed output`,
      );
      assert.ok(text.includes(String(reported.virtualUsers)), 'the player count is missing');
    }
    assert.ok(text.includes(String(report.capacity.concurrentSeatedPlayers)));
    assert.ok(text.includes(report.saturation.resource));
    assert.ok(text.includes(String(report.saturation.atConcurrency)));
  });

  it('prints the environment label beside the numbers, never only in the JSON', () => {
    assert.ok(text.includes(report.environment.target));
    assert.ok(text.includes(report.environment.transport));
    assert.ok(text.includes(report.environment.network));
    assert.ok(text.includes(report.environment.serverNodeEnv));
    assert.ok(text.includes(report.environment.proxy));
    for (const caveat of report.notMeasured) assert.ok(text.includes(caveat), `missing caveat: ${caveat}`);
    assert.match(text, /CAVEAT: every figure above describes ONE API process/);
    assert.match(text, /loopback the generator and the server share a machine/);
  });

  it('prints the cold-start figure separately from the ramp', () => {
    assert.match(text, /Cold start/);
    assert.ok(text.includes('2966.4ms'), 'the first-Coach cost must be printed, not buried');
  });

  it('prints FAIL and not PASS for a failing report (NEGATIVE CONTROL)', () => {
    assert.equal(report.passed, false);
    const verdicts = lines.filter((line) => line.text === 'PASS' || line.text === 'FAIL');
    assert.deepEqual(
      verdicts.map((line) => line.text),
      ['FAIL'],
    );
    assert.equal(verdicts[0].tone, 'bad');
  });

  it('prints PASS for a passing report', () => {
    const clean = buildReport(reportInput([level({ level: 1 }), level({ level: 2 })]));
    const verdicts = renderReport(clean).filter((line) => line.text === 'PASS' || line.text === 'FAIL');
    assert.deepEqual(
      verdicts.map((line) => line.text),
      ['PASS'],
    );
  });

  it('states what one "player" was, and warns when that is not a person', () => {
    // A capacity figure in players is worthless without the load shape one player stood for.
    // The default run has zero think time, which is a load shape and not a reader.
    assert.equal(report.capacity.virtualUserModel.thinkMs, 0);
    assert.match(text, /one "player" here = think time 0ms/);
    assert.match(text, /asks Coach in-hand/);
    assert.match(text, /reconnects every 2 hand\(s\)/);
    assert.match(text, /opens Hand Review every 2 hand\(s\)/);
    assert.ok(text.includes(report.capacity.virtualUserModel.note));
    assert.match(text, /do not convert this figure to a population of readers by hand/);
  });

  it('says a slow database probe is not a pool problem when the event loop also stalled', () => {
    // Both fire together constantly, because the probe is timed inside the request handler and
    // therefore includes the time the process could not reach the event loop. Printing the
    // db-pool number without that sentence attached invites the wrong remediation.
    const confounded = buildReport(
      reportInput([level({ server: { eventLoopP99PeakMs: 3600, dbProbeP99BoundMs: 5000 } })]),
    );
    const printed = textOf(renderReport(confounded));
    assert.match(printed, /db-pool cannot be read as a db-pool problem here: event-loop also fired/);

    // NEGATIVE CONTROL: with the event loop quiet, the caveat must NOT appear — otherwise it is
    // decoration rather than a finding, and a real pool problem would be talked out of.
    const genuine = buildReport(
      reportInput([level({ server: { eventLoopP99PeakMs: 4, dbProbeP99BoundMs: 5000 } })]),
    );
    const genuineText = textOf(renderReport(genuine));
    assert.ok(!genuineText.includes('cannot be read as a db-pool problem'));
    assert.equal(genuine.levels[0].saturation.resource, 'db-pool');
  });

  it('warns when the gauge peaks came from a level that had already finished', () => {
    // Real artefact: an eight-second level that hit its hand cap in under two seconds left one
    // gauge reading, taken after the sockets were closed, and the report then said the level ran
    // with zero connections. The number is not corrected — the fix is a longer hold — but it is
    // never printed without the sentence that says what it describes.
    const tornDown = buildReport(
      reportInput([
        level({
          server: {
            gaugeReadings: 1,
            gaugeNote:
              'gauge peaks come from a single reading taken after this level had already finished, ' +
              'so sockets, memory and event-loop figures below describe a torn-down level',
            websocketConnectionsPeak: 0,
          },
        }),
      ]),
    );
    assert.match(textOf(renderReport(tornDown)), /describe a torn-down level/);

    // NEGATIVE CONTROL: a level with enough readings must not carry the warning, or it becomes
    // noise that a reader learns to skip past on the one run where it matters.
    assert.ok(!text.includes('torn-down level'));
  });

  it('says a signal is not exported rather than printing a zero for it', () => {
    const missing = buildReport(
      reportInput([
        level({
          server: {
            workerPoolQueuedPeak: null,
            websocketConnectionsPeak: null,
            missing: ['prl_worker_pool_queued', 'prl_websocket_connections'],
          },
        }),
      ]),
    );
    const printed = textOf(renderReport(missing));
    assert.match(printed, /worker-pool\s+not exported by this build \(prl_worker_pool_queued\)/);
  });
});

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('produces the documented defaults', () => {
    const options = parseArgs([]);
    assert.deepEqual(options.levels, [1, 2, 4, 8]);
    assert.equal(options.seats, 3);
    assert.equal(options.holdSeconds, 15);
    // 0, not a number: the hold decides how long a level lasts. A default cap of 200 truncated
    // every fast level after about two seconds and made the hands-per-minute column meaningless.
    assert.equal(options.hands, 0);
    assert.equal(options.coach, true);
    assert.equal(options.reconnect, true);
    assert.equal(options.review, true);
    assert.equal(options.warmup, true);
    assert.equal(options.json, false);
  });

  it('absorbs the `--` that pnpm forwards', () => {
    assert.equal(parseArgs(['--', '--seats', '4']).seats, 4);
  });

  it('takes a ramp, and refuses one that does not ascend', () => {
    assert.deepEqual(parseArgs(['--ramp', '1,3,9']).levels, [1, 3, 9]);
    assert.deepEqual(parseArgs(['--ramp', ' 2 , 5 ']).levels, [2, 5]);
    assert.throws(() => parseArgs(['--ramp', '4,2']), /must ascend strictly/);
    assert.throws(() => parseArgs(['--ramp', '1,1']), /must ascend strictly/);
    assert.throws(() => parseArgs(['--ramp', '0']), /positive integers/);
    assert.throws(() => parseArgs(['--ramp', '']), /at least one table count/);
  });

  it('lets --tables replace the ramp with a single level', () => {
    assert.deepEqual(parseArgs(['--tables', '6']).levels, [6]);
    assert.deepEqual(parseArgs(['--tables', '6', '--ramp', '1,2']).levels, [6]);
  });

  it('rejects an option with the reason, not the word invalid', () => {
    assert.throws(() => parseArgs(['--seats', '7']), /rooms\.max_seats CHECK/);
    assert.throws(() => parseArgs(['--seats', '1']), /from 2 to 6/);
    assert.throws(() => parseArgs(['--action-timeout', '3']), /createRoomBody schema/);
    assert.throws(() => parseArgs(['--big-blind', '1']), /must exceed --small-blind/);
    assert.throws(() => parseArgs(['--starting-stack', '1']), /twice --big-blind/);
    assert.throws(() => parseArgs(['--max-error-rate', '4']), /fraction between 0 and 1/);
    assert.throws(() => parseArgs(['--min-reconnect-rate', '-1']), /fraction between 0 and 1/);
    assert.throws(() => parseArgs(['--hold', '0']), /cannot carry a p99/);
    assert.throws(() => parseArgs(['--reconnect-every', '0']), /--no-reconnect/);
    assert.throws(() => parseArgs(['--think', '-1']), /--think cannot be negative/);
    assert.throws(() => parseArgs(['--hands', '-1']), /non-negative integer/);
    assert.equal(parseArgs(['--hands', '5']).hands, 5);
  });

  it('refuses a think time that would race the server turn clock', () => {
    // Past half the clock the seat and the server's timer are in a race, and the loser is folded
    // automatically — so the run would measure the timeout path while reporting a hand rate.
    assert.equal(parseArgs([]).thinkMs, 0);
    assert.equal(parseArgs(['--think', '1000']).thinkMs, 1000);
    assert.equal(parseArgs(['--think', '7500']).thinkMs, 7500);
    assert.throws(() => parseArgs(['--think', '7501']), /turn clock/);
    assert.equal(parseArgs(['--think', '20000', '--action-timeout', '120']).thinkMs, 20000);
  });

  it('refuses a scrape interval that would leave a level with one reading', () => {
    // Two scrapes are the minimum for a counter delta, and the harness takes one before and one
    // after regardless — but a scrape interval wider than the hold means no reading DURING the
    // level, so every gauge peak would be sampled while the level was not running.
    assert.throws(() => parseArgs(['--scrape', '20', '--hold', '10']), /exceeds --hold/);
    assert.throws(() => parseArgs(['--scrape', '0.1']), /at least 0\.5s/);
  });

  it('rejects an unknown option and a flag with no value', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown option --nope \(try --help\)/);
    assert.throws(() => parseArgs(['--seats']), /--seats needs a value/);
    assert.throws(() => parseArgs(['--seats', 'lots']), /needs a number, got "lots"/);
  });

  it('turns the journey legs off without touching the others', () => {
    const options = parseArgs(['--no-coach', '--no-review', '--skip-warmup']);
    assert.equal(options.coach, false);
    assert.equal(options.review, false);
    assert.equal(options.warmup, false);
    assert.equal(options.reconnect, true, 'a disable flag must not switch off its neighbours');
  });

  it('skips validation for --help so that a broken invocation can still read the help', () => {
    const options = parseArgs(['--seats', '99', '--help']);
    assert.equal(options.help, true);
  });
});

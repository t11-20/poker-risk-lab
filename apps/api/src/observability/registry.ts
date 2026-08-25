/**
 * A metrics registry, written here rather than taken from a package.
 *
 * ## Why not `prom-client`
 *
 * The supply-chain policy in this repository is deliberately hostile to new runtime
 * dependencies: every one of them is pinned, hashed, IOC-scanned, SBOM'd and re-reviewed on
 * every bump (`docs/adr/0007-supply-chain-policy.md`). A metrics client is a poor trade
 * against that. What it buys is the Prometheus text format — which is a documented, stable,
 * line-oriented serialisation that fits in the `render()` function below — and a label
 * registry, which is the part this file actually cares about getting right.
 *
 * ## The part that matters: label cardinality is bounded by construction
 *
 * The way a metrics endpoint takes down a service is not CPU. It is a label whose value comes
 * from the request — a path with an id in it, a user id, an error string — so the registry
 * grows one time series per distinct value and never shrinks. That is an unbounded in-process
 * memory leak reachable by an unauthenticated caller, and it is the single most common
 * production defect in hand-rolled instrumentation.
 *
 * So label values are not free text here. Every metric declares its label NAMES up front, and
 * every series is capped (`MAX_SERIES_PER_METRIC`). Past the cap, new label combinations
 * collapse into one overflow series rather than allocating: the metric stops being precise and
 * never stops being bounded, and the overflow series is itself visible so an operator can see
 * that it happened. Callers are additionally expected to pass values from a closed set —
 * `routeLabel()` in `metrics.ts` is what turns a URL into one — and the cap is the net under
 * that rule, not a replacement for it.
 *
 * ## Why histograms are explicit buckets and not a summary
 *
 * p50/p95/p99 have to be computable *across* processes. A per-process summary cannot be
 * aggregated — averaging two p99s is meaningless — while cumulative bucket counters can be
 * summed and then interpolated (`histogram_quantile`). Buckets are declared per metric because
 * the right ones for an HTTP request (milliseconds) and for a Monte Carlo analysis (hundreds
 * of milliseconds) are not the same set.
 *
 * ## What this file must never do
 *
 * Touch the database, throw, or block. It is scraped by a probe that is often the only thing
 * still working during an incident. `render()` allocates a string and nothing else.
 */

/** Metric types this registry can render. Matches the Prometheus exposition `# TYPE` line. */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/**
 * Upper bound on distinct label combinations per metric.
 *
 * 256 is chosen against the widest metric here: HTTP requests, labelled by method (7) × route
 * (about 30 declared routes) × status class (5). The real product is far below the cap in
 * normal operation, so hitting it means a caller is passing something unbounded — which is
 * exactly when collapsing into the overflow series is the behaviour we want.
 */
const MAX_SERIES_PER_METRIC = 256;

/** The label value every series past the cap collapses into. Deliberately greppable. */
export const OVERFLOW_LABEL = 'overflow_cardinality_capped';

/**
 * Longest label value kept.
 *
 * Prometheus' text format escapes backslash, double quote and newline in label values, and
 * `escapeLabelValue()` below does that. This cap is a second, stricter gate applied at the
 * point a value enters the registry: a value carrying a control character, or arriving from a
 * caller as megabytes of text, is a defect wherever it came from, and bounding it here keeps
 * one bad call site from corrupting an entire scrape. Same reasoning as
 * `withoutControlCharacters` in `logging.ts`.
 */
const MAX_LABEL_VALUE_LENGTH = 120;

/** A label set, already reduced to the closed values the metric declared. */
export type Labels = Readonly<Record<string, string>>;

interface MetricDefinition {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  /** Declared once. A sample carrying any other key is ignored; see `keyOf`. */
  readonly labelNames: readonly string[];
}

/**
 * Sanitises one label value.
 *
 * Truncation rather than rejection: a metric that silently drops a sample is worse during an
 * incident than one that reports a shortened label, and the length cap exists to bound memory,
 * not to validate input. Control characters are replaced by code point rather than by regex so
 * that no control character has to be typed into this repository — the hygiene gate rejects
 * them in source, for exactly the reason they are being stripped here.
 */
function safeLabelValue(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? '_' : char;
    if (out.length >= MAX_LABEL_VALUE_LENGTH) break;
  }
  return out === '' ? 'none' : out;
}

/**
 * The series key for a label set.
 *
 * Built from the metric's DECLARED label names in their declared order, so two calls that pass
 * the same labels in a different object order land on the same series, and a caller that
 * passes an undeclared key cannot create a series at all — the key is ignored rather than
 * silently forking the metric in two.
 *
 * The separator is a unit separator rather than a comma or a space because a label value may
 * legitimately contain either, and a key built with a separator that can appear inside a value
 * lets two different label sets collide onto one series.
 */
const KEY_SEPARATOR = String.fromCodePoint(0x1f);

function keyOf(labelNames: readonly string[], labels: Labels): string {
  if (labelNames.length === 0) return '';
  return labelNames.map((name) => safeLabelValue(labels[name] ?? 'none')).join(KEY_SEPARATOR);
}

function labelsFromKey(labelNames: readonly string[], key: string): Labels {
  if (labelNames.length === 0) return {};
  const values = key.split(KEY_SEPARATOR);
  const out: Record<string, string> = {};
  labelNames.forEach((name, index) => {
    out[name] = values[index] ?? 'none';
  });
  return out;
}

/** Escapes a label value for the text exposition format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

/** Escapes help text. Only backslash and a line break are special in a `# HELP` line. */
function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ');
}

function renderLabels(labels: Labels, extra?: readonly (readonly [string, string])[]): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(labels)) {
    parts.push(`${name}="${escapeLabelValue(value)}"`);
  }
  for (const [name, value] of extra ?? []) {
    parts.push(`${name}="${escapeLabelValue(value)}"`);
  }
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

/**
 * The shared behaviour of every metric: a bounded map from series key to value.
 *
 * `series` is a plain `Map` and not a `WeakMap` on purpose — the keys are strings, and the
 * whole point is that a series persists across scrapes so a counter can be monotonic.
 */
abstract class BaseMetric<TSeries> {
  readonly definition: MetricDefinition;
  protected readonly series = new Map<string, TSeries>();
  /** Set once the cap is hit, so an operator can tell precision was lost. */
  protected overflowed = false;

  constructor(definition: MetricDefinition) {
    this.definition = definition;
  }

  /**
   * The series for a label set, creating it if there is room.
   *
   * Past the cap every new combination is folded into one overflow series. Returning a series
   * rather than `undefined` keeps every call site free of a null check — a metric that throws
   * or returns nothing during an incident is worse than one that is imprecise.
   */
  protected resolve(labels: Labels): TSeries {
    const key = keyOf(this.definition.labelNames, labels);
    const existing = this.series.get(key);
    if (existing !== undefined) return existing;
    if (this.series.size >= MAX_SERIES_PER_METRIC) {
      this.overflowed = true;
      const overflowKey = keyOf(
        this.definition.labelNames,
        Object.fromEntries(this.definition.labelNames.map((name) => [name, OVERFLOW_LABEL])),
      );
      const overflow = this.series.get(overflowKey);
      if (overflow !== undefined) return overflow;
      const created = this.createSeries();
      this.series.set(overflowKey, created);
      return created;
    }
    const created = this.createSeries();
    this.series.set(key, created);
    return created;
  }

  protected abstract createSeries(): TSeries;

  /** Renders every sample line for this metric, without the `# HELP`/`# TYPE` preamble. */
  protected abstract renderSamples(): readonly string[];

  /** True once at least one label combination was folded into the overflow series. */
  get didOverflow(): boolean {
    return this.overflowed;
  }

  /** Number of live series. Feeds the registry's own self-metric. */
  get seriesCount(): number {
    return this.series.size;
  }

  render(): string {
    const { name, help, type } = this.definition;
    const lines = [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`];
    lines.push(...this.renderSamples());
    return lines.join('\n');
  }
}

/**
 * A monotonically increasing count.
 *
 * There is no `dec()` and no `reset()`, and that is the contract rather than an omission: a
 * counter that can go down breaks every `rate()` computed over it, and the resulting graph
 * shows a spike at the moment of the decrement. Something that goes both ways is a gauge.
 */
export class Counter extends BaseMetric<{ value: number }> {
  protected createSeries(): { value: number } {
    return { value: 0 };
  }

  inc(labels: Labels = {}, amount = 1): void {
    // A negative or non-finite increment is a caller bug that would corrupt every rate derived
    // from this series. Ignoring it keeps the series usable; the alternative — throwing — turns
    // an instrumentation bug into a failed request.
    if (!Number.isFinite(amount) || amount < 0) return;
    this.resolve(labels).value += amount;
  }

  /** Reads one series. For tests; not used in rendering. */
  get(labels: Labels = {}): number {
    return this.series.get(keyOf(this.definition.labelNames, labels))?.value ?? 0;
  }

  protected renderSamples(): readonly string[] {
    const out: string[] = [];
    for (const [key, entry] of this.series) {
      const labels = labelsFromKey(this.definition.labelNames, key);
      out.push(`${this.definition.name}${renderLabels(labels)} ${entry.value}`);
    }
    return out;
  }
}

/**
 * A value that goes up and down: connections open, rooms live, threads busy.
 *
 * `setFrom` is the form most of this codebase uses. A gauge whose value already exists
 * somewhere authoritative — `pool.stats()`, `live.size` — must be *read at scrape time* rather
 * than mirrored on every change, because a mirror drifts the first time an edit adds a code
 * path that changes the source and forgets the metric. Drift in a gauge is worse than no
 * gauge: it is a number an operator trusts during an incident and that is quietly wrong.
 */
export class Gauge extends BaseMetric<{ value: number }> {
  /** Set when the gauge is computed at scrape time instead of being written to. */
  private collector: (() => number) | null = null;

  protected createSeries(): { value: number } {
    return { value: 0 };
  }

  set(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    this.resolve(labels).value = value;
  }

  inc(labels: Labels = {}, amount = 1): void {
    if (!Number.isFinite(amount)) return;
    this.resolve(labels).value += amount;
  }

  dec(labels: Labels = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  get(labels: Labels = {}): number {
    if (this.collector !== null) return this.collector();
    return this.series.get(keyOf(this.definition.labelNames, labels))?.value ?? 0;
  }

  /**
   * Binds this gauge to a function read at scrape time.
   *
   * Only valid for an unlabelled gauge: a collector cannot know which label set it is being
   * asked about. A labelled gauge that is computed rather than written belongs in the
   * registry's `onCollect` hook, which can `set()` every series it owns.
   */
  setFrom(collector: () => number): void {
    this.collector = collector;
  }

  protected renderSamples(): readonly string[] {
    if (this.collector !== null) {
      const value = this.collector();
      return Number.isFinite(value) ? [`${this.definition.name} ${value}`] : [];
    }
    const out: string[] = [];
    for (const [key, entry] of this.series) {
      const labels = labelsFromKey(this.definition.labelNames, key);
      out.push(`${this.definition.name}${renderLabels(labels)} ${entry.value}`);
    }
    return out;
  }
}

interface HistogramSeries {
  /** Cumulative counts, parallel to `buckets`. Index i counts observations <= buckets[i]. */
  readonly counts: number[];
  sum: number;
  count: number;
}

/**
 * A cumulative histogram with explicit upper bounds.
 *
 * The bucket list is the whole design decision. Too few and `histogram_quantile` interpolates
 * across a range wide enough to hide the problem; too many and every series costs a line per
 * bucket on every scrape. The lists in `metrics.ts` are chosen so that the threshold each one
 * is alerted on falls *on a bucket boundary* — otherwise the alert fires on an interpolated
 * number rather than a counted one, which is the difference between "p99 is over 500 ms" and
 * "p99 is somewhere between 300 ms and 1 s and we assumed the observations were uniform".
 */
export class Histogram extends BaseMetric<HistogramSeries> {
  readonly buckets: readonly number[];

  constructor(definition: MetricDefinition, buckets: readonly number[]) {
    super(definition);
    // Sorted and de-duplicated here rather than trusted: the cumulative rendering below depends
    // on ascending order, and an out-of-order bound produces counts that decrease across `le`
    // values, which is invalid exposition that a scraper rejects outright.
    this.buckets = [...new Set(buckets)].sort((a, b) => a - b);
  }

  protected createSeries(): HistogramSeries {
    return { counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
  }

  /** Records one observation, in the metric's declared unit (seconds throughout this app). */
  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const series = this.resolve(labels);
    series.sum += value;
    series.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      const bound = this.buckets[i];
      if (bound !== undefined && value <= bound) series.counts[i] = (series.counts[i] ?? 0) + 1;
    }
  }

  /** Total observations across one series. For tests. */
  count(labels: Labels = {}): number {
    return this.series.get(keyOf(this.definition.labelNames, labels))?.count ?? 0;
  }

  protected renderSamples(): readonly string[] {
    const out: string[] = [];
    const { name, labelNames } = this.definition;
    for (const [key, series] of this.series) {
      const labels = labelsFromKey(labelNames, key);
      for (let i = 0; i < this.buckets.length; i += 1) {
        const bound = this.buckets[i];
        if (bound === undefined) continue;
        out.push(`${name}_bucket${renderLabels(labels, [['le', String(bound)]])} ${series.counts[i] ?? 0}`);
      }
      // The `+Inf` bucket is required by the format and equals the total count by definition.
      out.push(`${name}_bucket${renderLabels(labels, [['le', '+Inf']])} ${series.count}`);
      out.push(`${name}_sum${renderLabels(labels)} ${series.sum}`);
      out.push(`${name}_count${renderLabels(labels)} ${series.count}`);
    }
    return out;
  }
}

/** Everything a metric needs to be declared. */
export interface MetricSpec {
  readonly name: string;
  readonly help: string;
  readonly labelNames?: readonly string[];
  /**
   * Label sets to render at zero from process start, before anything increments them.
   *
   * ## The defect this exists for, which is subtle and cost a real alert
   *
   * A counter series is created by its first `inc()`, so until something goes wrong the series
   * does not exist and the exposition has no line for it. `rate()` and `increase()` are computed
   * from samples INSIDE their range, and Prometheus does not assume a series that appears
   * mid-range started at zero — a series whose samples read `1, 1, 1` has an increase of 0. So
   * the FIRST occurrence of a counted event is invisible to any alert keyed on its rate.
   *
   * That is precisely how the zero-tolerance alerts are written.
   * `docs/production/alerts.md` keys `RateLimitBans` on `increase(...{kind="banned"}[15m]) > 0`,
   * `HandsFailing` on `rate(prl_hands_failed_total[10m]) > 0`, and `ArchiveFailing` on
   * `rate(prl_archive_failures_total[15m]) > 0`, each with the reasoning that there is no
   * acceptable background rate. Every one of them would have missed the first event on a fresh
   * process and fired only on the second.
   *
   * Measured: a real ban was recorded against staging — the counter read
   * `prl_rate_limit_events_total{kind="banned"} 1` — and `RateLimitBans` did not fire, because
   * the series had never been zero for Prometheus to see it rise from.
   *
   * Priming the series makes the 0 → 1 step visible. It only works for a CLOSED label set, which
   * is why it is opt-in per metric rather than automatic: `authFailures` is keyed on a contract
   * error code and `handsFailed` on a reason, and inventing every possible value would be worse
   * than the problem. Prime the ones whose alert cannot afford to miss the first event.
   *
   * This is the same failure `scripts/load-test.mjs` documents from the other side — that a
   * scraper "cannot tell `0` from 'nothing in this build feeds this metric'". Here it is the
   * alerting rule that could not tell them apart.
   */
  readonly primeLabels?: readonly Labels[];
}

/**
 * The collection of metrics rendered by one scrape.
 *
 * Instantiated once per process (`metrics.ts`) rather than being a module-level singleton in
 * this file, so a test can build a registry, exercise it and throw it away — the same reason
 * `db.ts` has no eagerly-created `sql` export.
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, BaseMetric<unknown>>();
  private readonly beforeCollect: (() => void)[] = [];

  private add<T extends BaseMetric<unknown>>(metric: T): T {
    const name = metric.definition.name;
    if (this.metrics.has(name)) {
      // A duplicate registration means two modules believe they own the same metric, and
      // whichever loaded second would silently win. Worth failing at boot for: it happens at
      // module load, never on a request.
      throw new Error(`metric "${name}" is already registered`);
    }
    this.metrics.set(name, metric as unknown as BaseMetric<unknown>);
    return metric;
  }

  counter(spec: MetricSpec): Counter {
    const counter = this.add(new Counter({ ...spec, type: 'counter', labelNames: spec.labelNames ?? [] }));
    // `inc(labels, 0)` creates the series through the same path a real increment uses, so a primed
    // series is identical to one that has been incremented and then never again. Nothing special
    // renders it and nothing special has to remember it exists.
    for (const labels of spec.primeLabels ?? []) counter.inc(labels, 0);
    return counter;
  }

  gauge(spec: MetricSpec): Gauge {
    return this.add(new Gauge({ ...spec, type: 'gauge', labelNames: spec.labelNames ?? [] }));
  }

  histogram(spec: MetricSpec, buckets: readonly number[]): Histogram {
    return this.add(
      new Histogram({ ...spec, type: 'histogram', labelNames: spec.labelNames ?? [] }, buckets),
    );
  }

  /**
   * Registers a function run at the start of every scrape.
   *
   * This is where a gauge that mirrors state owned elsewhere gets its value — see the note on
   * `Gauge.setFrom`. A hook that throws must not fail the scrape: `/metrics` answering with
   * most of the picture beats it answering 500 during the incident it was built for.
   */
  onCollect(hook: () => void): void {
    this.beforeCollect.push(hook);
  }

  /**
   * The full exposition body.
   *
   * Sorted by metric name so two consecutive scrapes of an unchanged process produce
   * byte-identical output, which makes a diff of two captures meaningful.
   */
  render(): string {
    for (const hook of this.beforeCollect) {
      try {
        hook();
      } catch {
        // Deliberately swallowed, and deliberately not logged: this runs on every scrape, and a
        // collector that fails every 15 seconds would fill the log with one repeated line. The
        // symptom is visible in the output instead — the metric it feeds stops changing.
      }
    }
    const names = [...this.metrics.keys()].sort();
    const blocks = names.map((name) => this.metrics.get(name)?.render() ?? '');
    // The trailing newline is required by the text exposition format.
    return `${blocks.filter((block) => block !== '').join('\n')}\n`;
  }

  /** Total live series across every metric. Feeds `prl_metrics_series`. */
  totalSeries(): number {
    let total = 0;
    for (const metric of this.metrics.values()) total += metric.seriesCount;
    return total;
  }

  /** True if any metric has folded a label combination into its overflow series. */
  anyOverflowed(): boolean {
    for (const metric of this.metrics.values()) {
      if (metric.didOverflow) return true;
    }
    return false;
  }
}

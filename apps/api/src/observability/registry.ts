/**
 * A Prometheus registry written here instead of `prom-client`, because every runtime dependency
 * carries the supply-chain cost in `docs/adr/0007-supply-chain-policy.md`.
 * Label cardinality is bounded by construction. Label names are declared up front and each metric
 * is capped at `MAX_SERIES_PER_METRIC`, past which new combinations fold into one visible overflow
 * series. Histograms use explicit buckets so quantiles aggregate across processes.
 * Nothing here touches the database, throws or blocks.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

/**
 * Sized against the widest metric, HTTP requests (7 methods x about 30 routes x 5 status classes).
 * Reaching it means a caller is passing something unbounded.
 */
const MAX_SERIES_PER_METRIC = 256;

export const OVERFLOW_LABEL = 'overflow_cardinality_capped';

/** Bounds memory so one bad call site cannot corrupt a scrape. */
const MAX_LABEL_VALUE_LENGTH = 120;

export type Labels = Readonly<Record<string, string>>;

interface MetricDefinition {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  /** A sample carrying any other key is ignored. */
  readonly labelNames: readonly string[];
}

/**
 * Truncates rather than rejects, so no sample is dropped. Control characters are matched by code
 * point so none has to appear in source, which the hygiene gate forbids.
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
 * Keys follow the declared label order, so object order does not fork a series. The unit separator
 * cannot appear in a value, so two label sets cannot collide.
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

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

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

abstract class BaseMetric<TSeries> {
  readonly definition: MetricDefinition;
  protected readonly series = new Map<string, TSeries>();
  protected overflowed = false;

  constructor(definition: MetricDefinition) {
    this.definition = definition;
  }

  /** Always returns a series, so no call site needs a null check. Past the cap, the overflow one. */
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

  protected abstract renderSamples(): readonly string[];

  get didOverflow(): boolean {
    return this.overflowed;
  }

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

/** No `dec()` or `reset()`, because a decrement breaks every `rate()` over the series. */
export class Counter extends BaseMetric<{ value: number }> {
  protected createSeries(): { value: number } {
    return { value: 0 };
  }

  inc(labels: Labels = {}, amount = 1): void {
    // Ignored rather than thrown, so an instrumentation bug never fails a request.
    if (!Number.isFinite(amount) || amount < 0) return;
    this.resolve(labels).value += amount;
  }

  /** For tests. */
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
 * Prefer `setFrom`. A gauge whose value lives somewhere authoritative is read at scrape time,
 * because a mirror written on change drifts when a new code path forgets to update it.
 */
export class Gauge extends BaseMetric<{ value: number }> {
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

  /** Unlabelled gauges only. A computed labelled gauge belongs in the registry's `onCollect`. */
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
  /** Cumulative. Index i counts observations <= buckets[i]. */
  readonly counts: number[];
  sum: number;
  count: number;
}

/** Each alert threshold should sit on a bucket boundary, so it is counted rather than interpolated. */
export class Histogram extends BaseMetric<HistogramSeries> {
  readonly buckets: readonly number[];

  constructor(definition: MetricDefinition, buckets: readonly number[]) {
    super(definition);
    // Out-of-order bounds render decreasing `le` counts, which a scraper rejects.
    this.buckets = [...new Set(buckets)].sort((a, b) => a - b);
  }

  protected createSeries(): HistogramSeries {
    return { counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
  }

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

  /** For tests. */
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
      out.push(`${name}_bucket${renderLabels(labels, [['le', '+Inf']])} ${series.count}`);
      out.push(`${name}_sum${renderLabels(labels)} ${series.sum}`);
      out.push(`${name}_count${renderLabels(labels)} ${series.count}`);
    }
    return out;
  }
}

export interface MetricSpec {
  readonly name: string;
  readonly help: string;
  readonly labelNames?: readonly string[];
  /**
   * Label sets rendered at zero from process start. `increase()` and `rate()` cannot see the first
   * event on a series that did not exist before it, so a zero-tolerance alert would miss it.
   * Opt-in, because it only works for a closed label set.
   */
  readonly primeLabels?: readonly Labels[];
}

/** One per process (`metrics.ts`), not a module singleton, so tests can build and discard one. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, BaseMetric<unknown>>();
  private readonly beforeCollect: (() => void)[] = [];

  private add<T extends BaseMetric<unknown>>(metric: T): T {
    const name = metric.definition.name;
    if (this.metrics.has(name)) {
      // Two modules claiming one metric. Fails at module load, never on a request.
      throw new Error(`metric "${name}" is already registered`);
    }
    this.metrics.set(name, metric as unknown as BaseMetric<unknown>);
    return metric;
  }

  counter(spec: MetricSpec): Counter {
    const counter = this.add(new Counter({ ...spec, type: 'counter', labelNames: spec.labelNames ?? [] }));
    // Same path as a real increment, so a primed series is an ordinary series.
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

  /** Runs at the start of every scrape. A throwing hook must not fail the scrape. */
  onCollect(hook: () => void): void {
    this.beforeCollect.push(hook);
  }

  /** Sorted by name, so two scrapes of an unchanged process are byte-identical. */
  render(): string {
    for (const hook of this.beforeCollect) {
      try {
        hook();
      } catch {
        // Not logged, because it would repeat every scrape. The fed metric stops changing instead.
      }
    }
    const names = [...this.metrics.keys()].sort();
    const blocks = names.map((name) => this.metrics.get(name)?.render() ?? '');
    return `${blocks.filter((block) => block !== '').join('\n')}\n`;
  }

  totalSeries(): number {
    let total = 0;
    for (const metric of this.metrics.values()) total += metric.seriesCount;
    return total;
  }

  anyOverflowed(): boolean {
    for (const metric of this.metrics.values()) {
      if (metric.didOverflow) return true;
    }
    return false;
  }
}

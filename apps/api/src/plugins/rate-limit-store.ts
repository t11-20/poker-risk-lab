/**
 * A rate-limit store that can be emptied on demand, for test isolation only.
 *
 * The smoke test drains the address-keyed guest limiter, so a second run inside the window fails.
 * `@fastify/rate-limit` creates one store per route via `child()` with no shared handle, so
 * supplying the store is the only way to reach the counters.
 * Installed only when `config.rateLimitResetToken` is set, which `loadConfig` refuses in production.
 * `incr` and `read` reproduce the library's `LocalStore` fixed window exactly, so CI and production agree.
 */

/** The library's default. Keys come from caller input, so the map must be bounded. */
const DEFAULT_CACHE_SIZE = 5_000;

interface RateLimitState {
  current: number;
  ttl: number;
}

/** `iterationStartMs` makes the window fixed rather than sliding. */
interface Entry {
  current: number;
  iterationStartMs: number;
}

type StoreCallback = (error: Error | null, result?: RateLimitState) => void;

/** Only the fields this store reads. The plugin passes its whole merged options object. */
export interface RateLimitStoreOptions {
  readonly cache?: number;
  readonly continueExceeding?: boolean;
  readonly exponentialBackoff?: boolean;
}

/** Every store in the process. One child per rate-limited route, so this stays small. */
const instances = new Set<ResettableRateLimitStore>();

/** Returns the number of keys discarded, so a reset that cleared nothing is visible. */
export function resetAllRateLimitCounters(): number {
  let cleared = 0;
  for (const instance of instances) cleared += instance.clear();
  return cleared;
}

export function resettableStoreInstalled(): boolean {
  return instances.size > 0;
}

/** For tests that build several apps in one process. */
export function forgetRateLimitStoresForTests(): void {
  instances.clear();
}

export class ResettableRateLimitStore {
  private readonly cacheSize: number;
  /** Insertion-ordered `Map`. `remember` re-inserts on use, so the first key is the least recently used. */
  private readonly entries = new Map<string, Entry>();

  constructor(options: RateLimitStoreOptions = {}) {
    if (options.continueExceeding === true || options.exponentialBackoff === true) {
      // Both options change when a window restarts. A partial version would make CI and production differ.
      throw new Error(
        'ResettableRateLimitStore does not implement continueExceeding or exponentialBackoff; ' +
          'this application does not enable either, and a partial implementation would make CI ' +
          'and production disagree about when a window restarts',
      );
    }
    this.cacheSize = Math.max(1, Math.floor(options.cache ?? DEFAULT_CACHE_SIZE));
    instances.add(this);
  }

  /** Calls back synchronously, like `LocalStore`. The callback shape is shared with Redis stores. */
  incr(key: string, callback: StoreCallback, timeWindow: number, _max: number): void {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing === undefined || existing.iterationStartMs + timeWindow <= now) {
      const entry: Entry = { current: 1, iterationStartMs: now };
      this.remember(key, entry);
      callback(null, { current: 1, ttl: timeWindow });
      return;
    }
    existing.current += 1;
    this.remember(key, existing);
    callback(null, { current: existing.current, ttl: timeWindow - (now - existing.iterationStartMs) });
  }

  /** For the plugin's `{ increment: false }` path. Unused today, but a missing method fails at runtime. */
  read(key: string, callback: StoreCallback, timeWindow: number, _max?: number): void {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing === undefined || existing.iterationStartMs + timeWindow <= now) {
      callback(null, { current: 0, ttl: 0 });
      return;
    }
    callback(null, { current: existing.current, ttl: timeWindow - (now - existing.iterationStartMs) });
  }

  /** A fresh per-route instance, registered in `instances` so a reset reaches it. */
  child(): ResettableRateLimitStore {
    return new ResettableRateLimitStore({ cache: this.cacheSize });
  }

  clear(): number {
    const size = this.entries.size;
    this.entries.clear();
    return size;
  }

  private remember(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.cacheSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}

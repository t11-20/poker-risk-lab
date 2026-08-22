/**
 * A rate-limit counter store that can be emptied on demand — for test isolation, and only
 * ever for test isolation.
 *
 * ## The defect this exists to close
 *
 * `scripts/smoke-test.mjs` proves the guest limiter works by deliberately exhausting it: it
 * floods `POST /auth/guest` until the first 429. Because that limit is keyed on the caller's
 * ADDRESS — it has to be, since the endpoint issues the very session an address-free key
 * would rotate (`clientKeyedRateLimit` in `security.ts`) — the bucket it drains is the same
 * bucket the *next* run needs. A second `--strict` run started inside the 60-second window
 * fails at its second section, and then four later sections fail for the unrelated reason
 * that the run never obtained a session at all. The window, not the application, was the
 * thing under test.
 *
 * ## Why a whole store rather than a flag on the existing one
 *
 * `@fastify/rate-limit` accepts a store CONSTRUCTOR and calls `child()` on it once per route,
 * so the counters for the guest route, the OIDC routes, the expensive routes and the global
 * bucket live in four separate objects with no shared handle. There is no supported way to
 * reach them afterwards. Supplying the store is the only seam the library offers, and once it
 * is supplied the reset is a one-line walk of the instances it created.
 *
 * ## Why production never sees this file
 *
 * `securityPlugin` installs this store ONLY when `config.rateLimitResetToken` is set, and
 * `loadConfig` refuses to start a production process that sets that variable at all (see
 * `readRateLimitResetToken` in `config.ts` for why that is a refusal rather than a warning).
 * So a production deployment keeps the library's own `LocalStore`, byte for byte, and nothing
 * in this file is on any production code path. That is deliberate: replacing a working
 * security control's storage engine in order to make a test easier would be the wrong trade,
 * and confining the replacement to the environments that need it costs nothing.
 *
 * ## The semantics are the library's, not new ones
 *
 * `incr` and `read` reproduce `@fastify/rate-limit`'s `LocalStore` exactly, including the
 * fixed (non-sliding) window: the first request in a window stamps `iterationStartMs`, and
 * the count resets only once `timeWindow` has fully elapsed from that stamp. Any divergence
 * here would mean the limits behave differently in CI from production, which is worse than
 * having no reset at all. `continueExceeding` and `exponentialBackoff` are not implemented
 * because this application does not enable them; a caller that turns one on gets a refusal at
 * construction rather than a silently different limiter.
 */

/**
 * Upper bound on distinct keys held per store instance.
 *
 * Matches `@fastify/rate-limit`'s own default cache size. The bound is the point: keys here
 * are derived from caller-controlled input (a hashed address, a hashed session), so a store
 * without an eviction policy is an unbounded map an anonymous caller can grow — the same
 * cardinality failure `observability/registry.ts` guards against, in a place where it would
 * be reachable by anyone.
 */
const DEFAULT_CACHE_SIZE = 5_000;

/** What `incr` and `read` hand back to the plugin. */
interface RateLimitState {
  current: number;
  ttl: number;
}

/** What this store keeps per key. `iterationStartMs` is what makes the window fixed. */
interface Entry {
  current: number;
  iterationStartMs: number;
}

type StoreCallback = (error: Error | null, result?: RateLimitState) => void;

/**
 * The options `@fastify/rate-limit` passes to a store constructor.
 *
 * Only the three fields this store cares about are named. The plugin passes its whole merged
 * parameter object, which contains a great deal more; declaring the rest would be a copy of
 * the library's types that could drift from them.
 */
export interface RateLimitStoreOptions {
  readonly cache?: number;
  readonly continueExceeding?: boolean;
  readonly exponentialBackoff?: boolean;
}

/**
 * Every store instance created in this process, so one reset can reach all of them.
 *
 * A plain `Set` and not a `WeakSet`: the point is to hold them. It is bounded by the number
 * of rate-limited routes — the plugin creates exactly one child per route at registration and
 * never again — so this grows to a couple of dozen entries and then stops.
 */
const instances = new Set<ResettableRateLimitStore>();

/**
 * Empties every counter in the process.
 *
 * Returns the number of keys discarded, which is what the reset route reports: a reset that
 * silently cleared nothing (wrong process, store never installed) is indistinguishable from a
 * successful one without it, and that is precisely the confusion a test-isolation control
 * must not create.
 */
export function resetAllRateLimitCounters(): number {
  let cleared = 0;
  for (const instance of instances) cleared += instance.clear();
  return cleared;
}

/** True when this store is the one in use. Lets the reset route refuse honestly. */
export function resettableStoreInstalled(): boolean {
  return instances.size > 0;
}

/**
 * Drops every instance. For tests, which build several apps in one process and would
 * otherwise see one app's counters cleared by another's reset.
 */
export function forgetRateLimitStoresForTests(): void {
  instances.clear();
}

export class ResettableRateLimitStore {
  private readonly cacheSize: number;
  /**
   * Insertion-ordered, which is what makes the eviction below a real LRU: `Map` iterates in
   * insertion order, `get` re-inserts to move a key to the end, so the first key the iterator
   * yields is always the least recently used.
   */
  private readonly entries = new Map<string, Entry>();

  constructor(options: RateLimitStoreOptions = {}) {
    if (options.continueExceeding === true || options.exponentialBackoff === true) {
      // A refusal rather than a best-effort implementation. Both options change when a window
      // restarts, so getting one subtly wrong would make the limiter behave differently in the
      // environment where this store runs from the one where it does not — which is the single
      // outcome this file must never produce.
      throw new Error(
        'ResettableRateLimitStore does not implement continueExceeding or exponentialBackoff; ' +
          'this application does not enable either, and a partial implementation would make CI ' +
          'and production disagree about when a window restarts',
      );
    }
    this.cacheSize = Math.max(1, Math.floor(options.cache ?? DEFAULT_CACHE_SIZE));
    instances.add(this);
  }

  /**
   * Records one request against `key`.
   *
   * The callback is invoked synchronously, as the library's own local store does. It is a
   * callback rather than a return value because the interface has to accommodate a Redis store
   * as well, and the plugin calls both through the same signature.
   */
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
    // Re-inserted so this key becomes the most recently used one; see `entries`.
    this.remember(key, existing);
    callback(null, { current: existing.current, ttl: timeWindow - (now - existing.iterationStartMs) });
  }

  /**
   * Reports the state of `key` without changing it.
   *
   * Required by the plugin's `{ increment: false }` path. This application does not use that
   * path today, and the method is implemented anyway: a store that is missing it fails with a
   * runtime error the first time somebody enables the option, which is a poor way to find out.
   */
  read(key: string, callback: StoreCallback, timeWindow: number, _max?: number): void {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing === undefined || existing.iterationStartMs + timeWindow <= now) {
      callback(null, { current: 0, ttl: 0 });
      return;
    }
    callback(null, { current: existing.current, ttl: timeWindow - (now - existing.iterationStartMs) });
  }

  /**
   * The per-route store.
   *
   * A fresh instance, which is what keeps the guest route's counters separate from the global
   * bucket's — and it registers itself in `instances`, so a reset reaches it too.
   */
  child(): ResettableRateLimitStore {
    return new ResettableRateLimitStore({ cache: this.cacheSize });
  }

  /** Discards every key. Returns how many there were. */
  clear(): number {
    const size = this.entries.size;
    this.entries.clear();
    return size;
  }

  private remember(key: string, entry: Entry): void {
    // Delete first so a re-inserted key moves to the end of the iteration order rather than
    // keeping its original position, which is what makes eviction least-recently-used rather
    // than first-inserted.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.cacheSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}

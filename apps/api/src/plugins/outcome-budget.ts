/**
 * Budgets charged by OIDC outcomes rather than by requests.
 *
 * Both OIDC routes are keyed on the hashed address, so a cohort behind one NAT shares a bucket.
 * At the old ceiling of 15, fifteen of thirty learners signed in and the rest got a 429.
 * The ceiling is now sized for the cohort and these budgets are sized for abuse, since a script
 * can send unlimited requests but cannot complete a sign-in.
 * `routes/auth.ts` builds two, a failed-outcome budget (charge only) and an unredeemed-start budget
 * (charged by a start, credited by a completed sign-in), windowed on the attempt TTL.
 * The window is fixed, matching `LocalStore`, so `Retry-After` has one answer per route.
 * `refusalFor` never charges, so retrying does not extend a refusal (no `continueExceeding`).
 * The caller passes `addressRateLimitKey`, the same key the route limiter uses.
 */

/**
 * Bounded because keys come from caller input. Eviction can only permit, never refuse, so filling
 * the map gains an attacker nothing. A cohort signing in successfully has no entry, and an attacker
 * with 5,000 addresses already has 5,000 budgets.
 */
const DEFAULT_CACHE_SIZE = 5_000;

/** `iterationStartMs` makes the window fixed rather than sliding. */
interface Entry {
  charged: number;
  iterationStartMs: number;
}

export interface OutcomeBudgetOptions {
  /** Outcomes allowed per key per window before `refusalFor` starts refusing. */
  readonly max: number;
  readonly windowMs: number;
  /** Distinct keys held before the least recently used one is evicted. */
  readonly cache?: number;
}

export class OutcomeBudget {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly cacheSize: number;
  /** Insertion-ordered LRU, the same scheme as `ResettableRateLimitStore`. */
  private readonly entries = new Map<string, Entry>();

  constructor(options: OutcomeBudgetOptions) {
    this.max = Math.max(1, Math.floor(options.max));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.cacheSize = Math.max(1, Math.floor(options.cache ?? DEFAULT_CACHE_SIZE));
  }

  /** Milliseconds until `key` may retry, or `null` when within budget. Charges nothing. */
  refusalFor(key: string, now: number = Date.now()): number | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    const elapsed = now - entry.iterationStartMs;
    if (elapsed >= this.windowMs) return null;
    if (entry.charged < this.max) return null;
    return this.windowMs - elapsed;
  }

  charge(key: string, now: number = Date.now()): void {
    const entry = this.entries.get(key);
    if (entry === undefined || now - entry.iterationStartMs >= this.windowMs) {
      this.remember(key, { charged: 1, iterationStartMs: now });
      return;
    }
    entry.charged += 1;
    this.remember(key, entry);
  }

  /**
   * Gives one charge back when a callback redeems a start.
   * Never creates an entry or goes below zero, so a caller cannot bank credit for a later flood.
   */
  credit(key: string, now: number = Date.now()): void {
    const entry = this.entries.get(key);
    if (entry === undefined || now - entry.iterationStartMs >= this.windowMs) return;
    entry.charged = Math.max(0, entry.charged - 1);
    this.remember(key, entry);
  }

  /** For tests, which must not assert on internals. */
  chargedFor(key: string, now: number = Date.now()): number {
    const entry = this.entries.get(key);
    if (entry === undefined || now - entry.iterationStartMs >= this.windowMs) return 0;
    return entry.charged;
  }

  size(): number {
    return this.entries.size;
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

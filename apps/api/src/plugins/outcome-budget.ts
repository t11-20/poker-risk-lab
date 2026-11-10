/**
 * Budgets spent by OUTCOMES rather than by requests.
 *
 * ## The incident this exists to prevent
 *
 * A paying cohort's first five minutes. Thirty students on one campus, office or VPN egress
 * address open the app together and sign in. Both OIDC endpoints are keyed on the hashed client
 * ADDRESS — deliberately and correctly, because a route that issues a session cannot be limited
 * by that session (`clientKeyedRateLimit` in `security.ts` records the measurement that proved
 * it) — so all sixty of those requests land in two buckets of fifteen. Measured against the
 * shipped defaults before this file existed: **fifteen of thirty learners completed a sign-in and
 * fifteen got a 429, the first at learner sixteen.** Half a paying cohort met a refusal on its
 * very first interaction with the product.
 *
 * Raising the ceiling alone would have been the wrong fix, because it hands the same headroom to
 * a script. This is the other half.
 *
 * ## Why an outcome is a better thing to count than a request
 *
 * A start and a callback from a student look exactly like a start and a callback from a script at
 * the moment they arrive, so no limiter can tell them apart on the way in. What separates them is
 * how they END. Completing an OIDC sign-in requires a valid authorization code that only the
 * identity provider can mint, presented with the matching single-use attempt row and the PKCE
 * verifier from a cookie the caller was handed one request earlier. A script cannot produce that.
 * It can produce an unlimited number of requests that FAIL to produce it.
 *
 * So the ceiling is sized for the cohort and these budgets are sized for the abuse, and the two
 * numbers no longer have to be the same number.
 *
 * ## Two instances, two outcomes
 *
 * `routes/auth.ts` builds both. They are the same mechanism counting different endings:
 *
 *   1. **The failed-outcome budget.** Charged by an OIDC request that ended in an error, and by
 *      nothing else. `charge` only; `credit` is never called on it. This is the one a script
 *      driving start-then-bad-callback meets.
 *
 *   2. **The unredeemed-start budget.** Charged when a start writes an attempt row, CREDITED when
 *      a callback redeems one by completing a sign-in. What it therefore bounds is the number of
 *      attempt rows one address can leave behind unredeemed — which is precisely the traffic a
 *      caller that floods `/auth/oidc/start` and never comes back produces, and which the
 *      failed-outcome budget cannot see because a start that succeeds is not a failure.
 *
 * The second exists because measurement said it had to. See the arithmetic in `routes/auth.ts`;
 * the short version is that raising the ceiling from 15 to 60 took the number of addresses needed
 * to outrun the 6-hourly retention sweep from 19 down to 5, and this budget takes it to 46 —
 * better than either.
 *
 * ## Why the unredeemed window is the attempt TTL and not the rate-limit window
 *
 * Because "still outstanding when the window closes" then means exactly "the attempt row expired
 * without ever being redeemed", which is the thing being counted, and it means it without a timer
 * per attempt or a second sweep. A credit that arrives after its window has rolled lands on a
 * fresh entry and is discarded, so the count errs towards treating a redeemed start as unredeemed
 * — conservative in the safe direction, and immaterial because a start that has not been redeemed
 * within the attempt TTL cannot be redeemed at all.
 *
 * ## The window is the library's, not a new one
 *
 * Fixed rather than sliding, with `iterationStartMs` stamped by the first charge in a window —
 * byte for byte the semantics of `@fastify/rate-limit`'s `LocalStore` and of
 * `plugins/rate-limit-store.ts`. A budget that expired on different rules from the limiter beside
 * it would make "how long until I can retry?" have two different answers on one route, and the
 * `Retry-After` header can only carry one of them.
 *
 * ## What this deliberately does NOT do
 *
 * It does not charge the caller for being refused. `refusalFor` reports a refusal and charges
 * nothing; only `charge` charges. Without that separation a caller who kept retrying would keep
 * pushing their own window forward and never be let back in — `@fastify/rate-limit` calls that
 * `continueExceeding`, this application does not enable it, and enabling it accidentally here
 * would turn one mistyped password at the identity provider into a lockout that outlives the
 * window it was supposed to be bounded by.
 *
 * It also does not key itself. The caller passes the key, which is always
 * `addressRateLimitKey(request, config)` — the same function the route limiter beside it uses, so
 * the two cannot drift into keying on different things, and so the property the original
 * measurement established (the bucket key must not rotate under a caller who has just been handed
 * a fresh session cookie) holds here by construction rather than by a second implementation that
 * happens to agree.
 */

/**
 * Upper bound on distinct keys held.
 *
 * Matches `@fastify/rate-limit`'s own default and `ResettableRateLimitStore`'s, and for the same
 * reason: keys are derived from caller-controlled input, so a map without an eviction policy is
 * an unbounded structure an anonymous caller can grow. That would make the anti-abuse mechanism
 * itself the abuse channel.
 *
 * ## Can eviction be used as an attack? No, and the reason is worth stating.
 *
 * The question to ask of any LRU inside a security control is "what does an attacker gain by
 * filling it?", and here the answer is nothing, because of an asymmetry that is deliberate:
 *
 *   **An entry's only effect is to REFUSE. Evicting one can only ever permit.**
 *
 * There is no state here whose loss causes a refusal, so a flushed map cannot be used to deny
 * anyone service. Concretely:
 *
 *   * *Can an attacker cycling addresses flush a classroom's counters?* They can evict entries,
 *     but a cohort signing in successfully HAS no entry — nothing is charged for a start that is
 *     redeemed or for a request that succeeds. There is nothing of theirs to evict, and if there
 *     were, losing it would loosen their budget, not tighten it.
 *   * *Can an attacker flush their OWN counter to escape a refusal?* Yes, by presenting more than
 *     `DEFAULT_CACHE_SIZE` distinct addresses. But an attacker who controls that many addresses
 *     already has that many independent budgets, because every budget here is per-address —
 *     evicting one to reuse an old address buys nothing a fresh address does not already give.
 *     The bound on that attacker was never this map; it is how many addresses they hold.
 *   * *Can a classroom flush an attacker's counter?* Only by producing 5,000 distinct keys, and a
 *     classroom behind one NAT produces exactly one.
 *
 * At capacity the least recently used key is dropped, which is the right victim: the keys still
 * inside are the ones with recent activity, and a key with no activity for the last 5,000 distinct
 * callers is one whose window has almost certainly rolled anyway.
 */
const DEFAULT_CACHE_SIZE = 5_000;

/** What is kept per key. `iterationStartMs` is what makes the window fixed rather than sliding. */
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
  /**
   * Insertion-ordered, which is what makes the eviction a real LRU: `Map` iterates in insertion
   * order and `remember` re-inserts, so the first key the iterator yields is the least recently
   * used one. Same device as `ResettableRateLimitStore`, and copied from it on purpose — two
   * eviction policies in one process would be two things to reason about during an incident.
   */
  private readonly entries = new Map<string, Entry>();

  constructor(options: OutcomeBudgetOptions) {
    this.max = Math.max(1, Math.floor(options.max));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.cacheSize = Math.max(1, Math.floor(options.cache ?? DEFAULT_CACHE_SIZE));
  }

  /**
   * Milliseconds until `key` may try again, or `null` when it is within budget.
   *
   * Reads. Charges nothing. See the note in the file header on why those are two operations.
   */
  refusalFor(key: string, now: number = Date.now()): number | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    const elapsed = now - entry.iterationStartMs;
    if (elapsed >= this.windowMs) return null;
    if (entry.charged < this.max) return null;
    return this.windowMs - elapsed;
  }

  /** Records one outcome against `key`. */
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
   * Gives one charge back, for an outcome that turned out well after all.
   *
   * Only the unredeemed-start budget calls this, when a callback completes a sign-in and so
   * redeems the attempt row its start wrote.
   *
   * Two things it must not do, both deliberate:
   *
   *   * It never creates an entry. A credit with nothing to credit is a callback whose start was
   *     in a window that has already rolled, and inventing an entry at −1 would let a caller BANK
   *     credit by completing sign-ins now to pay for floods later.
   *   * It never goes below zero, for the same reason.
   */
  credit(key: string, now: number = Date.now()): void {
    const entry = this.entries.get(key);
    if (entry === undefined || now - entry.iterationStartMs >= this.windowMs) return;
    entry.charged = Math.max(0, entry.charged - 1);
    this.remember(key, entry);
  }

  /** What `key` currently has charged against it. For tests, which must not assert on internals. */
  chargedFor(key: string, now: number = Date.now()): number {
    const entry = this.entries.get(key);
    if (entry === undefined || now - entry.iterationStartMs >= this.windowMs) return 0;
    return entry.charged;
  }

  /** Distinct keys held. For the test that pins the eviction bound. */
  size(): number {
    return this.entries.size;
  }

  /** Discards every key. Returns how many there were. For tests and for the reset control. */
  clear(): number {
    const size = this.entries.size;
    this.entries.clear();
    return size;
  }

  private remember(key: string, entry: Entry): void {
    // Deleted first so a re-inserted key moves to the end of the iteration order rather than
    // keeping its original position, which is what makes the eviction least-recently-used
    // rather than first-inserted.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.cacheSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Which row of a sampled action distribution is the most likely one.
 *
 * ## The defect this module exists for
 *
 * `ActionDistribution` marks one row "— most likely" and decides which by comparing a string with
 * `===`. There were **two producers of that string**, in two packages, and they disagreed:
 *
 *   - the rows come from `@prl/poker-ai`'s `describeAction`, which formats a size with a private
 *     `formatChips` of its own — `Number.isInteger(v) ? String(v) : v.toFixed(1)` — so a raise to
 *     1,200 arrives as `"raise to 1200"`;
 *   - `PostHandComparison` rebuilt the same description locally with `@prl/ui`'s `formatChips`,
 *     which groups thousands — `"raise to 1,200"`.
 *
 * Below a thousand the two agree and everything looked fine. At a thousand and above they never
 * matched, so no row was marked and nothing said a mark had been dropped. Starting stacks are
 * 1,000, so this is an ordinary hand rather than an edge case.
 *
 * ## The rule
 *
 * The marker is **taken out of the distribution**, never described a second time. That is already
 * how the API does it for the compare page — `modalAction: distribution[0].action`, out of the
 * array it is sending — and doing the same here means `===` compares a value with itself and
 * cannot fail on a formatting difference in another package.
 *
 * ## Why this is a leaf module rather than a function in the component
 *
 * `ActionDistribution.tsx` is a `.tsx`, and Node's type stripping cannot load one under
 * `node --test` (`ERR_UNKNOWN_FILE_EXTENSION`) — so nothing in that file has ever been testable
 * here. Nothing is imported below, so this one is. Same shape and same reason as
 * `lib/quiz-tolerance.ts`, `lib/session-cookie-names.ts` and `lib/age-gate.ts`.
 */

/** One action and the weight the policy gave it. The subset this decision needs. */
export interface WeightedActionShare {
  /** The action as the model names it: `fold`, `check`, `call`, `bet 90`, `raise to 520`. */
  readonly action: string;
  /** A fraction in 0..1. */
  readonly probability: number;
}

/**
 * The most likely action's own string, from the list itself.
 *
 * The maximum is scanned for rather than assumed at index 0. Both producers of these lists sort
 * descending — the API's compare route and `explainModelDecision` — but neither type says so, and
 * a helper that silently marked the wrong row when handed an unsorted list would be a worse defect
 * than the one it replaces.
 *
 * Ties keep the first maximum, which is what the API's `distribution[0]` already yields from a
 * stable sort. `undefined` for an empty list, or when no entry carries a usable probability at
 * all: marking a row from a distribution that says nothing would be inventing the claim.
 */
export function mostLikelyAction(entries: readonly WeightedActionShare[]): string | undefined {
  let best: WeightedActionShare | undefined;
  for (const entry of entries) {
    if (!Number.isFinite(entry.probability)) continue;
    if (best === undefined || entry.probability > best.probability) best = entry;
  }
  return best?.action;
}

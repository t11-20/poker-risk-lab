/**
 * Which row of a sampled action distribution is the most likely one. The marker is taken out of the
 * distribution, never described a second time, because `@prl/poker-ai` and `@prl/ui` format sizes
 * differently ("raise to 1200" against "raise to 1,200") and a `===` match fails from 1,000 up.
 * A leaf with no imports, so `node --test` can load it, which it cannot do for `ActionDistribution.tsx`.
 */

/** One action and the weight the policy gave it. The subset this decision needs. */
export interface WeightedActionShare {
  /** The action as the model names it: `fold`, `check`, `call`, `bet 90`, `raise to 520`. */
  readonly action: string;
  /** A fraction in 0..1. */
  readonly probability: number;
}

/**
 * Scans for the maximum rather than trusting index 0, since no type says the list is sorted. Ties keep
 * the first. `undefined` when no entry has a usable probability.
 */
export function mostLikelyAction(entries: readonly WeightedActionShare[]): string | undefined {
  let best: WeightedActionShare | undefined;
  for (const entry of entries) {
    if (!Number.isFinite(entry.probability)) continue;
    if (best === undefined || entry.probability > best.probability) best = entry;
  }
  return best?.action;
}

/**
 * Judging a learner's action against the analysis — the display shape, over the shared rule.
 *
 * ## The rule is not here any more
 *
 * It is `judgeConsistency` in `@prl/poker-math/consistency`, and `apps/api/src/routes/content.ts`
 * calls the same function. That is a correction rather than a refactor. This file used to carry its
 * own rule — "consistent when the chosen action is within five chips of the best-valued row" — while
 * the server used a different one — "consistent when the action does at least as well as folding,
 * give or take one big blind". They disagreed in both directions, and since the learner reads this
 * one and the database records that one, the product could tell somebody their decision was
 * defensible and store the opposite. This file's own header used to argue that "two copies of a rule
 * about what counts as consistent would eventually be two different rules"; it was right, and the
 * second copy was across the package boundary rather than within it.
 *
 * The server's rule is the one that survived, because the difference was not a tolerance but a
 * question. Measuring against the best-valued row marks a call wrong for being worth slightly less
 * than a raise whose value depends on an *assumed* fold frequency — which is grading a learner
 * against an invented parameter, and the guardrails forbid grading at all.
 *
 * ## What is still this file's job
 *
 * The shape the screens render. `Consistency` carries the verdict alongside the two expected values
 * and the margin, and every screen that renders it shows all three, so a reader who disagrees with
 * an assumption can see exactly which number to disagree with. That is presentation, and it is why
 * this wrapper exists rather than the components calling the maths package directly.
 *
 * ## Why this is not a score, and how the shape enforces that
 *
 * The product guardrails forbid calling anything "correct" or "optimal", and they forbid scoring.
 * That is easy to honour in copy and easy to lose in code: the moment a component computes a boolean
 * called `right`, every label above it starts drifting towards a grade. So the question answered is
 * narrower than "was that a good decision?" — see `isDefensible` in the shared module.
 */

import type { ActionCandidate, CoachReport } from '@prl/contracts';
import { type ConsistencyPricing, judgeConsistency as judgeShared } from '@prl/poker-math';

/** The action names a learner can commit to. Matches `ScenarioAttemptRequest.action`. */
export type ScenarioAction = ActionCandidate['action'];

export interface Consistency {
  /** True when the chosen action is defensible against the stated range. From the shared rule. */
  readonly consistent: boolean;
  /** The chosen action's EV, or null when the report has no candidate for it. */
  readonly chosenEv: number | null;
  /** The best EV in the candidate table. Folding is always available at 0, so this is never below 0. */
  readonly bestEv: number;
  /** The action that carries `bestEv`, for naming it in the copy. */
  readonly bestAction: ScenarioAction | null;
  /** The sizing on the best action, when it has one. */
  readonly bestTo: number | null;
  /**
   * `bestEv - chosenEv`, or null when there is nothing to compare.
   *
   * Reported because it is useful to see, and deliberately NOT what decides `consistent`: the rule
   * measures against folding, not against the best row. A large gap here with `consistent: true` is
   * the normal case in a spot where two lines are both defensible, and saying so is the point.
   */
  readonly gapUnits: number | null;
  /**
   * The indifference margin the verdict used, in chips — one big blind at these stakes.
   *
   * Displayed rather than hidden, because a threshold a reader cannot see is a threshold they cannot
   * argue with.
   */
  readonly toleranceUnits: number;
  /**
   * How far behind the benchmark the chosen action came out, in chips. Zero when it is consistent.
   *
   * THIS is the figure the verdict is decided on, and it was not surfaced until 2026-08-27. The
   * Verdict panel showed the chosen EV, the best row, and the tolerance — three numbers whose only
   * natural reading is "consistent when best minus mine is inside the tolerance", which is not the
   * rule. So a learner saw +20.6 against a best row of +51.4, a tolerance of 10, and the words
   * "consistent with the analysis", and had every reason to think the panel was broken.
   */
  readonly shortfallUnits: number;
  /**
   * The benchmark the verdict measured against: zero for any action but a fold, because the rule
   * asks whether the action beats folding. For a fold it is the best row that does NOT rest on an
   * assumed fold frequency — quoting a bet's fold equity at somebody who folded would be quoting
   * an assumption at them. `@prl/poker-math` publishes it as `measuredBestEv` for exactly this.
   */
  readonly benchmarkEv: number;
  /**
   * Whether the analysis priced this decision at all, and if not, which half was missing.
   *
   * `@prl/poker-math` carries the warning this field exists for, in as many words: "A caller that
   * renders the boolean without reading `pricing` will tell somebody their decision disagreed with
   * an analysis that never looked at it." This layer did not carry the field at all, so
   * `ScenarioStage` had a binary chip and an unpriced size got "not the line the analysis leans
   * towards" — a verdict on a decision nothing had judged.
   *
   * It happens on ordinary use. The Coach prices discrete rungs while the ActionBar exposes a
   * continuous range, so a panel reading "Raise — 51 to 95 units" accepts 70 and prices neither 70
   * nor anything between the two ends.
   */
  readonly pricing: ConsistencyPricing;
}

/**
 * Compares one action against the report's own candidate table.
 *
 * `bigBlind` should always be passed, and every caller in this app does. It stays optional only
 * because the shared rule's own parameter is: `judgeConsistency` in `@prl/poker-math` falls back to
 * one chip when nobody states the stakes.
 *
 * There was briefly a second way to supply it — a report with `bigBlind` attached (`stakedReport`),
 * so the denominator travelled inside the data and no signature had to mention it — which is how
 * `ScenarioStage` used to receive it. That is exactly why it stopped: an invisible dependency is one
 * a caller can drop without a compile error, and dropping it here means the browser judges against
 * the one-chip fallback while the server grades against a twenty-chip margin. `ScenarioStage` takes
 * `bigBlind` as a required prop now, and the attached-stakes helpers have been deleted rather than
 * left standing as a second, quieter way to do it.
 *
 * When neither is available the shared rule falls back to one chip, the strictest margin it allows —
 * an unstated big blind can widen nothing.
 */
export function judgeConsistency(
  report: CoachReport,
  action: ScenarioAction,
  to?: number,
  bigBlind?: number,
): Consistency {
  const verdict = judgeShared({
    report,
    action,
    ...(to === undefined ? {} : { to }),
    ...(bigBlind === undefined ? {} : { bigBlind }),
  });
  const chosenEv = verdict.chosen === null ? null : verdict.chosen.ev;
  const best = verdict.best;

  return {
    consistent: verdict.consistent,
    chosenEv,
    bestEv: verdict.bestEv,
    bestAction: best === null ? null : best.action,
    bestTo: best === null || best.to === undefined ? null : best.to,
    gapUnits: chosenEv === null ? null : verdict.bestEv - chosenEv,
    toleranceUnits: verdict.marginUnits,
    shortfallUnits: verdict.shortfallUnits,
    benchmarkEv: action === 'fold' ? verdict.measuredBestEv : 0,
    pricing: verdict.pricing,
  };
}

/**
 * One rule for "is this action consistent with the analysis?", in one place.
 *
 * ## Why this is a package and not two functions
 *
 * It was two functions. `apps/api/src/routes/content.ts` had one and `apps/web/src/lib/consistency.ts`
 * had another, and they did not merely differ in a constant — they asked different questions. The
 * server asked "does this action do at least as well as folding, give or take a big blind?"; the
 * client asked "is this action within five chips of the best-valued row?". At a big blind of 20 an
 * action 7 chips off the best row was consistent to the server and inconsistent to the learner; at a
 * big blind of 1 the reverse. Since the server's verdict is what lands in
 * `scenario_attempts.matched_expected` and the client's is what the learner reads, the product could
 * tell somebody their decision was defensible and record that it was not.
 *
 * The server's question is the one that survives, and the reason is a product guardrail rather than
 * a preference. See `isDefensible` below.
 *
 * ## Why `@prl/poker-math`
 *
 * It has to be a package both `apps/api` and `apps/web` can import, and of the three candidates only
 * this one is unconditionally safe on both sides. `@prl/content` reads the content bundle from disk
 * with `node:fs` and says in its own header that it is server-side only — importing it from a client
 * component would put a Node builtin in the browser bundle. `@prl/contracts` is types, schemas and
 * constants with no behaviour, and it does not depend on this package, so a rule that compares
 * expected values does not belong there. This package is pure, has no I/O, already depends on
 * `@prl/contracts` for `CoachReport`, and is already a dependency of both apps — so nothing here
 * creates a cycle.
 *
 * ## What this module does NOT do
 *
 * It does not produce prose. The API's reasoning strings are written for a JSON response and the
 * web's verdict panel renders three numbers in a layout; both are presentation, and pulling them in
 * here would make one of the two callers render the other's copy. What is shared is the decision and
 * the figures the decision rests on.
 */

import type { ActionCandidate, CoachReport } from '@prl/contracts';

export class ConsistencyError extends Error {
  override readonly name = 'ConsistencyError';
}

/** The action names an analysis can price. Matches `ScenarioAttemptRequest.action`. */
export type ConsistencyAction = ActionCandidate['action'];

/**
 * How far from folding an action may sit and still count as indifferent, in big blinds.
 *
 * One big blind, which is the same yardstick `buildCoachReport` uses when it downgrades its own
 * confidence: a gap under a big blind is "close to indifferent" there, and it would be incoherent
 * for this rule to call the same gap a wrong answer.
 */
export const CONSISTENCY_MARGIN_BIG_BLINDS = 1;

/**
 * The margin in chips.
 *
 * Floored at one chip so a degenerate `bigBlind` of 0 cannot collapse the margin to nothing and turn
 * every rounding difference into a verdict.
 */
export function consistencyMarginUnits(bigBlind: number): number {
  if (!Number.isFinite(bigBlind)) throw new ConsistencyError('bigBlind must be a finite number');
  return CONSISTENCY_MARGIN_BIG_BLINDS * Math.max(1, bigBlind);
}

/**
 * The candidate row for one action.
 *
 * With a `to`, an exact sizing match wins. Without one, the most favourable row for that action name
 * is used: several sizings share a name, and judging an unsized "raise" against the worst raise on
 * the table would be judging the learner for a choice they were not offered.
 */
export function candidateFor(report: CoachReport, action: string, to?: number): ActionCandidate | null {
  let best: ActionCandidate | null = null;
  for (const candidate of report.candidates) {
    if (candidate.action !== action) continue;
    if (to !== undefined && candidate.to === to) return candidate;
    if (best === null || candidate.ev > best.ev) best = candidate;
  }
  return best;
}

/** The highest-EV row in the table, or null when the report published no candidates. */
export function bestCandidate(report: CoachReport): ActionCandidate | null {
  let best: ActionCandidate | null = null;
  for (const candidate of report.candidates) {
    if (best === null || candidate.ev > best.ev) best = candidate;
  }
  return best;
}

/**
 * Is this action defensible against the stated range?
 *
 * Not "is it the highest-EV action". That distinction is the whole reason this reports consistency
 * instead of a grade, and getting it wrong would teach the wrong lesson: in a spot where hero holds
 * a profitable draw, calling and semi-bluff-raising are both defensible, and marking a call wrong
 * because a raise scores a few chips higher under an *assumed* fold frequency would be presenting an
 * invented parameter as a fact.
 *
 * So the test is against folding, which the maths defines as exactly zero:
 *
 * - Every action other than folding is consistent when it does at least as well as folding, give or
 *   take the indifference margin. A call that clears the price is consistent whether or not a raise
 *   clears it by more.
 * - Folding is consistent when nothing else clearly beats it. It cannot be tested against itself.
 */
export function isDefensible(report: CoachReport, candidate: ActionCandidate, marginUnits: number): boolean {
  if (candidate.action === 'fold') {
    const best = bestCandidate(report);
    return best === null || best.ev <= marginUnits;
  }
  return candidate.ev >= -marginUnits;
}

/** Every action the analysis supports, in the order the report priced them. Usually more than one. */
export function defensibleActions(report: CoachReport, marginUnits: number): readonly string[] {
  const actions = [...new Set(report.candidates.map((candidate) => candidate.action))];
  return actions.filter((action) => {
    const candidate = candidateFor(report, action);
    return candidate !== null && isDefensible(report, candidate, marginUnits);
  });
}

/** The verdict, and every figure it rests on. Both callers render from these; neither recomputes. */
export interface ConsistencyVerdict {
  readonly consistent: boolean;
  /** The row the chosen action was judged on, or null when the analysis did not price it. */
  readonly chosen: ActionCandidate | null;
  /** The highest-EV row in the table, or null when the report published none. */
  readonly best: ActionCandidate | null;
  /**
   * The best EV available, floored at zero.
   *
   * Folding is always available and always worth exactly zero relative to itself, so a table that
   * omits it still has a floor of 0. Without this a report whose only rows were negative would make
   * the worst of them look like the best available choice.
   */
  readonly bestEv: number;
  /** The margin in chips this verdict used, for showing the reader the threshold they were held to. */
  readonly marginUnits: number;
  /** Every action the analysis supports. */
  readonly supportedActions: readonly string[];
  /** Every action the analysis priced at all, supported or not. */
  readonly availableActions: readonly string[];
  /**
   * True when exactly one action is defensible against the stated range. Stored as
   * `scenario_attempts.matched_expected` only when it holds, and NULL otherwise — which is what that
   * nullable column is for. Never shown as a score.
   */
  readonly claimsOneAction: boolean;
  /**
   * How far behind the indifference point the chosen action came out, in chips. Zero when the action
   * is consistent, and zero when the analysis did not price it at all.
   */
  readonly shortfallUnits: number;
}

export interface ConsistencyInput {
  readonly report: CoachReport;
  /** Typed as `string` because the API receives it off the wire; an unpriced action is a real case. */
  readonly action: string;
  readonly to?: number;
  /**
   * The stakes the margin is denominated in. Falls back to a single chip — the strictest margin the
   * rule allows, so an unstated big blind can never widen the threshold silently.
   *
   * Optional, and every caller passes it. There used to be a second way to supply it: a
   * `StakedCoachReport` that carried `bigBlind` as an extra member, so the denominator could travel
   * inside the data. That existed to work around a component whose props could not be changed, the
   * component now takes `bigBlind` as a required prop, and the workaround was removed with it — an
   * invisible dependency is one a caller can drop with no compile error, which would silently judge
   * a learner against a one-chip margin while the server used twenty.
   */
  readonly bigBlind?: number;
}

/**
 * Judges one action against the report's own candidate table.
 *
 * An action the report has no row for is `consistent: false` with `chosen: null`, which the screens
 * render as "the analysis did not price this action" rather than as a wrong answer. That happens for
 * real: a learner can check where the report only priced fold, call and raise.
 */
export function judgeConsistency(input: ConsistencyInput): ConsistencyVerdict {
  const { report, action, to } = input;
  const bigBlind = input.bigBlind ?? 1;
  const marginUnits = consistencyMarginUnits(bigBlind);

  const chosen = candidateFor(report, action, to);
  const best = bestCandidate(report);
  const bestEv = Math.max(0, best === null ? 0 : best.ev);
  const supportedActions = defensibleActions(report, marginUnits);
  const availableActions = [...new Set(report.candidates.map((candidate) => candidate.action))];
  const claimsOneAction = supportedActions.length === 1;

  if (chosen === null) {
    return {
      consistent: false,
      chosen: null,
      best,
      bestEv,
      marginUnits,
      supportedActions,
      availableActions,
      claimsOneAction,
      shortfallUnits: 0,
    };
  }

  const consistent = isDefensible(report, chosen, marginUnits);
  // Measured against folding in both directions, because that is what the rule tests: a fold is
  // behind by whatever the best row is worth, and anything else by however far below zero it sits.
  const shortfall = chosen.action === 'fold' ? bestEv : -chosen.ev;
  return {
    consistent,
    chosen,
    best,
    bestEv,
    marginUnits,
    supportedActions,
    availableActions,
    claimsOneAction,
    shortfallUnits: consistent ? 0 : Math.max(0, shortfall),
  };
}

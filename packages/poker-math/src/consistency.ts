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
 * Without a `to`, the most favourable row for that action name is used: several sizings share a
 * name, and judging an unsized "raise" against the worst raise on the table would be judging the
 * learner for a choice they were not offered.
 *
 * **With a `to`, an exact sizing match is required and there is no fallback.** That second clause
 * is the fix for a defect that survived the release audit, so it is worth stating what it used to
 * do: the loop below ended `return best`, so a `to` matching no row fell through to the
 * highest-EV row for that action name and the learner's action was graded against a completely
 * different decision. Measured on the shipped Scenario Lab, at runtime:
 *
 *     POST /content/scenarios/eq-flush-draw-turn-small-bet/attempt {"action":"raise","to":26000}
 *       -> consistentWithAnalysis: true
 *
 * Hero had 500 behind. The 26,000-chip raise was scored against the 67-chip one the Coach liked,
 * and the product told a learner that an action nobody at that table could have made agreed with
 * an analysis that never considered it. `to: 100000`, `to: 1` and `to: 0` did the same. The
 * product's stated guardrail is that it never teaches something false, and a substitution that
 * quietly answers a different question than the one asked is the purest form of teaching
 * something false.
 *
 * So an unmatched size is `null` — the same answer as an action the report never priced at all,
 * and `judgeConsistency` tells the two apart with `pricing` so a caller can say which happened.
 * Callers holding a size a learner chose should reject an unpayable one before they get here; see
 * `minimumAggressiveTo` and `maximumTo` in `./coach.ts`, which are the Coach's own bounds.
 */
export function candidateFor(report: CoachReport, action: string, to?: number): ActionCandidate | null {
  if (to !== undefined) {
    return report.candidates.find((candidate) => candidate.action === action && candidate.to === to) ?? null;
  }
  let best: ActionCandidate | null = null;
  for (const candidate of report.candidates) {
    if (candidate.action !== action) continue;
    if (best === null || candidate.ev > best.ev) best = candidate;
  }
  return best;
}

/**
 * Every size the analysis priced for one action name, in the order it priced them.
 *
 * Published so a caller refusing an unpriced size can name the ones that were priced instead of
 * saying only that the learner's was not. Empty for an action the report did not price, and empty
 * for `fold` and `check`, which move no chips and carry no `to` at all.
 */
export function pricedSizesFor(report: CoachReport, action: string): readonly number[] {
  const sizes: number[] = [];
  for (const candidate of report.candidates) {
    if (candidate.action !== action || candidate.to === undefined) continue;
    if (!sizes.includes(candidate.to)) sizes.push(candidate.to);
  }
  return sizes;
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
 * Is this row's value a function of an assumed fold frequency?
 *
 * True for a bet or a raise the Coach priced with fold equity above zero, false for a check, a
 * call, a fold, and for an aggressive line priced at a stated 0% — where the parameter is
 * present but contributes nothing, so the figure rests on the equity alone after all.
 *
 * `foldEquityAssumed` is set by `buildCoachReport` on exactly the rows whose EV contains the
 * `f x pot` term, so this reads the producer's own marker rather than re-deriving which action
 * names happen to be aggressive today.
 */
function restsOnAssumedFoldEquity(candidate: ActionCandidate): boolean {
  const assumed = candidate.foldEquityAssumed;
  return assumed !== undefined && assumed > 0;
}

/**
 * The highest-EV row that a learner could be held to, or null when there is none.
 *
 * **The benchmark a FOLD is judged against**, and different from `bestCandidate` in exactly one
 * respect: it skips the rows whose value depends on how often an opponent is assumed to fold.
 *
 * That parameter — `DEFAULT_ASSUMED_FOLD_EQUITY`, 0.35 — is an input, not a measurement. The
 * Coach says so in its own assumptions ("That is an input you can change, not something
 * measured") and again in `whatWouldChangeIt` ("Being raised is not modelled here, so treat the
 * figure as optimistic"). `isDefensible`'s doc has always said the same thing about the rule:
 * marking an action wrong "because a raise scores a few chips higher under an *assumed* fold
 * frequency would be presenting an invented parameter as a fact".
 *
 * The fold branch did precisely that. It compared a fold against `bestCandidate`, which on a
 * spot where a bluff-raise wins the table under the assumed 35% is the bluff-raise. Two shipped
 * scenarios — `rk-the-fold-that-feels-wrong` and `eq-implied-odds-deep-stacks-turn` — asked
 * "call or fold?", concluded in their own prose that folding is better, and then told a learner
 * who folded that their answer was "not consistent with this analysis", quoting a shortfall in
 * thousands of chips against a raise nobody had claimed was right. `matched_expected` went to
 * the database as `false`.
 *
 * So a fold is measured against what the analysis actually measured: checking, calling, and
 * folding itself. If one of those clearly beats a fold, the fold is not defensible and the
 * reason is a number the report stands behind. If the only thing that beats it is an
 * assumption, the learner is not told they were wrong on the strength of it.
 *
 * This narrows nothing else. Every non-fold action is still judged against folding at zero, so
 * a bet or raise is not made easier to defend by this — its own row still has to clear the
 * margin.
 */
export function bestMeasuredCandidate(report: CoachReport): ActionCandidate | null {
  let best: ActionCandidate | null = null;
  for (const candidate of report.candidates) {
    if (restsOnAssumedFoldEquity(candidate)) continue;
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
 * - Folding is consistent when nothing else *that the analysis measured* clearly beats it. It
 *   cannot be tested against itself, and it is not tested against an assumed fold frequency
 *   either — see `bestMeasuredCandidate` for the two shipped scenarios that made the difference
 *   visible.
 * - With one exception, which runs the other way: **folding is never defensible while checking is
 *   free.** That is not an EV comparison and must not be left to one. A check costs nothing and
 *   keeps every future branch of the hand, so it dominates a fold outright however small the
 *   numbers are — and with a small pot and thin equity the gap between them sits inside the
 *   indifference margin, where an EV test would call giving up the hand for nothing "close
 *   enough". `buildCoachReport` refuses to rank a fold above a free check for the same reason and
 *   throws if it ever does; this is that invariant, restated where the learner's answer is judged.
 */
export function isDefensible(report: CoachReport, candidate: ActionCandidate, marginUnits: number): boolean {
  if (candidate.action === 'fold') {
    if (report.candidates.some((row) => row.action === 'check')) return false;
    const best = bestMeasuredCandidate(report);
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

/**
 * Whether the analysis had anything at all to say about the action that was submitted.
 *
 * Three outcomes rather than a boolean, because the two ways of having nothing to say are
 * different things to tell a learner and the copy for one reads as nonsense on the other:
 *
 * - `'priced'` — the report has a row for this exact decision, so there is a verdict.
 * - `'action-not-priced'` — the report priced no row for this action name at all. A learner who
 *   checks where the report priced only fold, call and raise. "The analysis did not evaluate
 *   checking here."
 * - `'sizing-not-priced'` — the report priced this action, but at other sizes. A learner who
 *   raises to 90 where the report priced raises to 67, 138 and 500. "The analysis priced raising,
 *   but not at that size."
 *
 * Neither of the last two is a wrong answer, and neither may be recorded as one: with no row to
 * compare against, `consistent` is `false` in the sense of "not established", never in the sense
 * of "established to be wrong". A caller writing a nullable "did this match?" column must write
 * NULL for both — the whole reason this member exists is that a boolean cannot carry that
 * distinction across the wire, and the audit's most damaging finding was a grader recording a
 * learner as wrong against a figure that did not apply to them.
 */
export type ConsistencyPricing = 'priced' | 'action-not-priced' | 'sizing-not-priced';

/** The verdict, and every figure it rests on. Both callers render from these; neither recomputes. */
export interface ConsistencyVerdict {
  readonly consistent: boolean;
  /** Whether the analysis priced this exact decision, and if not, in which of the two ways. */
  readonly pricing: ConsistencyPricing;
  /** The row the chosen action was judged on, or null when the analysis did not price it. */
  readonly chosen: ActionCandidate | null;
  /**
   * The sizes the analysis priced for the submitted action name, in the order it priced them.
   *
   * Empty when it priced none — either because it did not price the action, or because the action
   * moves no chips. For naming the alternatives when a submitted size matched nothing.
   */
  readonly pricedSizes: readonly number[];
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
  /**
   * The best EV among the rows that do not rest on an assumed fold frequency, floored at zero.
   *
   * The benchmark a fold was actually judged against, published so a caller can show the reader
   * the number the verdict used rather than a different one. It equals `bestEv` whenever the
   * best row is a check, a call or a fold; it is lower whenever a bet or raise tops the table on
   * the strength of the assumed fold equity, which is exactly the case where quoting `bestEv` at
   * somebody who folded would be quoting an assumption at them. See `bestMeasuredCandidate`.
   */
  readonly measuredBestEv: number;
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
 * A decision the report has no row for is `consistent: false` with `chosen: null` and a `pricing`
 * saying which kind of gap it was, which the screens render as "the analysis did not price this"
 * rather than as a wrong answer. Both kinds happen for real: a learner can check where the report
 * only priced fold, call and raise, and a learner can raise to a size the report did not put on
 * its ladder.
 *
 * **`consistent: false` in those two cases means "not established", not "established wrong".** The
 * distinction is not decoration — see `ConsistencyPricing`. A caller that renders the boolean
 * without reading `pricing` will tell somebody their decision disagreed with an analysis that
 * never looked at it.
 */
export function judgeConsistency(input: ConsistencyInput): ConsistencyVerdict {
  const { report, action, to } = input;
  const bigBlind = input.bigBlind ?? 1;
  const marginUnits = consistencyMarginUnits(bigBlind);

  const chosen = candidateFor(report, action, to);
  const best = bestCandidate(report);
  const bestEv = Math.max(0, best === null ? 0 : best.ev);
  const measured = bestMeasuredCandidate(report);
  const measuredBestEv = Math.max(0, measured === null ? 0 : measured.ev);
  const supportedActions = defensibleActions(report, marginUnits);
  const availableActions = [...new Set(report.candidates.map((candidate) => candidate.action))];
  const claimsOneAction = supportedActions.length === 1;
  const pricedSizes = pricedSizesFor(report, action);

  if (chosen === null) {
    // Which of the two gaps it is, decided on whether the report priced the action name at all.
    // Tested against the rows rather than against `pricedSizes`, because fold and check are priced
    // and carry no size — a `to` on one of those is an unpriced *sizing*, not an unpriced action.
    const pricing: ConsistencyPricing = report.candidates.some((candidate) => candidate.action === action)
      ? 'sizing-not-priced'
      : 'action-not-priced';
    return {
      consistent: false,
      pricing,
      chosen: null,
      pricedSizes,
      best,
      bestEv,
      measuredBestEv,
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
  //
  // `measuredBestEv` for the fold, not `bestEv`, so the shortfall a learner is shown is the one
  // the verdict was reached on. Quoting the assumed-fold-equity raise here while judging against
  // something else is how the same screen came to say "your fold is not consistent with this
  // analysis, 11,873.7 chips behind" next to prose concluding that folding was better.
  const shortfall = chosen.action === 'fold' ? measuredBestEv : -chosen.ev;
  return {
    consistent,
    pricing: 'priced',
    chosen,
    pricedSizes,
    best,
    bestEv,
    measuredBestEv,
    marginUnits,
    supportedActions,
    availableActions,
    claimsOneAction,
    shortfallUnits: consistent ? 0 : Math.max(0, shortfall),
  };
}

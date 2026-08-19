/**
 * The one consistency rule, and the properties both callers depend on.
 *
 * `apps/api/src/routes/content.ts` and `apps/web/src/lib/consistency.ts` used to each carry a rule of
 * their own, asking different questions with different tolerances, so the sentence a learner read and
 * the boolean written to `scenario_attempts.matched_expected` could disagree. These tests pin the
 * behaviour that fixed it — in particular the two properties that a future "simplification" would be
 * most likely to undo:
 *
 *  - the margin scales with the big blind, so the same EV gap is judged differently at different
 *    stakes and identically at the same stakes; and
 *  - the comparison is against FOLDING, not against the best-valued row, so a defensible call is not
 *    marked inconsistent for being worth slightly less than a raise.
 *
 * The reports here are hand-built rather than produced by `buildCoachReport`. `judgeConsistency` reads
 * only the candidate table, and a test that had to construct a real spot to exercise a comparison of
 * two numbers would fail whenever the Coach's own inputs changed — for reasons with nothing to do
 * with this rule.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActionCandidate, CoachReport } from '@prl/contracts';
import {
  CONSISTENCY_MARGIN_BIG_BLINDS,
  ConsistencyError,
  consistencyMarginUnits,
  judgeConsistency,
} from '../src/consistency.ts';

function candidate(input: {
  readonly action: ActionCandidate['action'];
  readonly ev: number;
  readonly to?: number;
  /**
   * Set on exactly the rows `buildCoachReport` sets it on: a bet or a raise, whose EV contains
   * the `f x pot` term. It is the marker `bestMeasuredCandidate` reads, so a case about the fold
   * rule has to state it or it is testing a report that could not exist.
   */
  readonly foldEquityAssumed?: number;
}): ActionCandidate {
  return {
    action: input.action,
    cost: 0,
    ev: input.ev,
    derivation: `${input.action} is worth ${input.ev} by assumption in this test`,
    ...(input.to === undefined ? {} : { to: input.to }),
    ...(input.foldEquityAssumed === undefined ? {} : { foldEquityAssumed: input.foldEquityAssumed }),
  };
}

/** A report whose only meaningful content is its candidate table. */
function reportWith(candidates: readonly ActionCandidate[]): CoachReport {
  return {
    street: 'flop',
    potTotal: 100,
    toCall: 50,
    outs: null,
    equity: {
      heroEquity: 0.5,
      method: 'exact-enumeration',
      trials: 0,
      confidenceHalfWidthPoints: null,
      ruleOfThumb: null,
      perPlayer: [],
    },
    potOdds: {
      pot: 100,
      toCall: 50,
      breakEvenEquity: 1 / 3,
      oddsRatio: 2,
      equitySurplus: 0.5 - 1 / 3,
      explanation: 'fixed for this test',
    },
    candidates,
    suggestion: {
      action: 'call',
      confidence: 'moderate',
      reason: 'fixed for this test',
      whatWouldChangeIt: ['nothing: this report is a fixture'],
    },
    stackContext: { effectiveStack: 500, spr: 5, potOddsOfferedByPotSizedBet: 1 / 3, explanation: 'fixed' },
    assumptions: ['every figure here is asserted by the test, not computed'],
    uncertainty: {
      method: 'exact-enumeration',
      summary: 'fixed for this test',
      confidenceInterval: null,
      limitations: ['this is a fixture, not an analysis'],
    },
    teachingNotes: [],
  };
}

describe('the indifference margin', () => {
  it('is one big blind, in chips', () => {
    assert.equal(CONSISTENCY_MARGIN_BIG_BLINDS, 1);
    assert.equal(consistencyMarginUnits(1), 1);
    assert.equal(consistencyMarginUnits(20), 20);
    assert.equal(consistencyMarginUnits(2000), 2000);
  });

  it('never falls below one chip, so a degenerate big blind cannot collapse it', () => {
    // Without the floor a `bigBlind` of 0 would make every rounding difference a verdict.
    assert.equal(consistencyMarginUnits(0), 1);
    assert.equal(consistencyMarginUnits(0.25), 1);
  });

  it('refuses a big blind that is not a number it can use', () => {
    assert.throws(() => consistencyMarginUnits(Number.NaN), ConsistencyError);
    assert.throws(() => consistencyMarginUnits(Number.POSITIVE_INFINITY), ConsistencyError);
  });
});

describe('what counts as consistent', () => {
  it('measures against folding rather than against the best-valued row', () => {
    // The exact case the old client-side rule got wrong: a call that clears the price while a raise
    // clears it by more. Both are defensible; marking the call inconsistent would be grading the
    // learner against an assumed fold frequency.
    const report = reportWith([
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'call', ev: 4 }),
      candidate({ action: 'raise', ev: 30, to: 120 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'call', bigBlind: 2 });
    assert.equal(verdict.consistent, true);
    // 26 chips behind the best row, and consistent anyway — the gap is reported, not judged.
    assert.equal(verdict.bestEv, 30);
    assert.equal(verdict.chosen?.ev, 4);
    // Folding is not among them: a raise worth 30 clearly beats it at a 2-chip margin.
    assert.deepEqual([...verdict.supportedActions], ['call', 'raise']);
    assert.equal(verdict.claimsOneAction, false);
  });

  it('rejects an action that loses more than the margin against folding', () => {
    const report = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: -15 })]);
    const verdict = judgeConsistency({ report, action: 'call', bigBlind: 10 });
    assert.equal(verdict.consistent, false);
    assert.equal(verdict.marginUnits, 10);
    assert.equal(verdict.shortfallUnits, 15);
  });

  it('scales with the stakes: the same EV gap flips verdict between big blinds', () => {
    const report = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: -7 })]);
    // This is the divergence R11 described, now expressible only as a function of the stakes rather
    // than as a difference between two implementations.
    assert.equal(judgeConsistency({ report, action: 'call', bigBlind: 2 }).consistent, false);
    assert.equal(judgeConsistency({ report, action: 'call', bigBlind: 10 }).consistent, true);
  });

  it('treats folding as consistent only when nothing clearly beats it', () => {
    const thin = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: 1 })]);
    assert.equal(judgeConsistency({ report: thin, action: 'fold', bigBlind: 10 }).consistent, true);

    const clear = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: 40 })]);
    const verdict = judgeConsistency({ report: clear, action: 'fold', bigBlind: 10 });
    assert.equal(verdict.consistent, false);
    assert.equal(verdict.shortfallUnits, 40);
  });

  it('does not mark a fold wrong on the strength of an assumed fold frequency', () => {
    // The shape of `rk-the-fold-that-feels-wrong` and `eq-implied-odds-deep-stacks-turn`: both ask
    // "call or fold?", both conclude in their own prose that folding is better, and both used to
    // tell a learner who folded that their answer was "not consistent with this analysis" — because
    // a bluff-raise priced at the Coach's default 35% fold equity topped the table. Nothing
    // measured beat the fold; an assumption did.
    const report = reportWith([
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'call', ev: -60 }),
      candidate({ action: 'raise', ev: 126, to: 560, foldEquityAssumed: 0.35 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'fold', bigBlind: 20 });
    assert.equal(verdict.consistent, true);
    assert.equal(verdict.shortfallUnits, 0);
    // Both figures are still published, and they are different numbers on purpose: `bestEv` is the
    // best row in the table and `measuredBestEv` is the one the verdict was reached on.
    assert.equal(verdict.bestEv, 126);
    assert.equal(verdict.measuredBestEv, 0);
    assert.deepEqual([...verdict.supportedActions], ['fold', 'raise']);
    // And the call is still wrong, at -60 against a 20-chip margin. The rule was not loosened for
    // everything, only for the one comparison that rested on an invented parameter.
    assert.equal(judgeConsistency({ report, action: 'call', bigBlind: 20 }).consistent, false);
  });

  it('still marks a fold wrong when something the analysis measured clearly beats it', () => {
    // The direction that must not move. A call worth 40 chips carries no assumed fold frequency,
    // so it is a measured figure and it does decide the verdict.
    const report = reportWith([
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'call', ev: 40 }),
      candidate({ action: 'raise', ev: 300, to: 560, foldEquityAssumed: 0.35 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'fold', bigBlind: 10 });
    assert.equal(verdict.consistent, false);
    // Quoted against the benchmark the verdict used, not against the raise. Telling somebody they
    // are 300 chips behind and then judging them against 40 is two answers to one question.
    assert.equal(verdict.shortfallUnits, 40);
    assert.equal(verdict.measuredBestEv, 40);
  });

  it('counts an aggressive row priced at zero fold equity as a measured figure', () => {
    // The marker is the parameter's value, not the action's name. A raise the caller priced with
    // `assumedFoldEquity: 0` rests on the equity alone, so excluding it would be excluding a real
    // measurement and would let a fold stand against a line that genuinely beats it.
    const report = reportWith([
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'call', ev: -5 }),
      candidate({ action: 'raise', ev: 45, to: 200, foldEquityAssumed: 0 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'fold', bigBlind: 10 });
    assert.equal(verdict.measuredBestEv, 45);
    assert.equal(verdict.consistent, false);
  });

  it('never calls a fold defensible while checking is free', () => {
    // Not an EV comparison, and it must not be left to one: a check costs nothing and keeps every
    // card still to come, so it dominates a fold outright — and with a small pot and thin equity
    // the gap between them sits inside the indifference margin, where an EV test would wave a fold
    // through. `buildCoachReport` throws rather than rank a fold above a free check; this is the
    // same invariant where the learner's own answer is judged.
    //
    // Every EV here is inside a 10-chip margin on purpose. An EV-only rule waves this fold
    // through; the dominance rule is the only thing that catches it, so the case is only
    // discriminating with these numbers.
    const report = reportWith([
      candidate({ action: 'check', ev: 0.6 }),
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'bet', ev: 6, to: 28, foldEquityAssumed: 0.35 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'fold', bigBlind: 10 });
    assert.equal(verdict.consistent, false, 'giving up a hand that costs nothing to keep is never right');
    assert.deepEqual([...verdict.supportedActions], ['check', 'bet']);
    // Checking itself is defensible, which is the other half of the same claim.
    assert.equal(judgeConsistency({ report, action: 'check', bigBlind: 10 }).consistent, true);
  });

  it('says the analysis did not price an action rather than calling it wrong', () => {
    const report = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: 5 })]);
    const verdict = judgeConsistency({ report, action: 'raise', bigBlind: 10 });
    assert.equal(verdict.consistent, false);
    assert.equal(verdict.pricing, 'action-not-priced');
    assert.equal(verdict.chosen, null);
    assert.deepEqual([...verdict.availableActions], ['fold', 'call']);
    assert.deepEqual([...verdict.pricedSizes], []);
    assert.equal(verdict.shortfallUnits, 0);
  });

  it('matches an exact sizing when one is given, and the best row for that action when none is', () => {
    const report = reportWith([
      candidate({ action: 'raise', ev: -40, to: 300 }),
      candidate({ action: 'raise', ev: 12, to: 120 }),
    ]);
    assert.equal(judgeConsistency({ report, action: 'raise', to: 300, bigBlind: 10 }).chosen?.ev, -40);
    // Unsized: judged on the most favourable raise, because several sizings share the name and the
    // learner was not offered the worst of them as "raise".
    assert.equal(judgeConsistency({ report, action: 'raise', bigBlind: 10 }).chosen?.ev, 12);
  });

  /**
   * The defect that survived the release audit, at the level of the rule itself.
   *
   * `candidateFor` used to end its loop with `return best`, so a `to` matching no row fell
   * through to the highest-EV row for that action name. A learner's 26,000-chip raise into a
   * 500-chip stack was scored against the 67-chip raise the Coach liked, and the product replied
   * `consistentWithAnalysis: true` — an action nobody could have made, reported as agreeing with
   * an analysis that never considered it.
   *
   * Both halves are asserted, because only asserting the boolean would pass against a rule that
   * had merely flipped the sign on the same substitution. The chosen row must be *absent*: there
   * is no row, so there is nothing to be consistent or inconsistent with.
   */
  it('does not grade an unmatched sizing against a row the learner did not choose', () => {
    const report = reportWith([
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'call', ev: 20, to: 25 }),
      candidate({ action: 'raise', ev: 51, to: 67 }),
      candidate({ action: 'raise', ev: 30, to: 138 }),
    ]);
    for (const to of [26_000, 100_000, 1, 0, 66, 68]) {
      const verdict = judgeConsistency({ report, action: 'raise', to, bigBlind: 10 });
      assert.equal(verdict.consistent, false, `raise to ${to} must not be reported as consistent`);
      assert.equal(verdict.chosen, null, `raise to ${to} must not borrow another row's figures`);
      assert.equal(verdict.pricing, 'sizing-not-priced');
      assert.equal(
        verdict.shortfallUnits,
        0,
        'there is no shortfall to quote against a row that does not exist',
      );
      // The sizes that *were* priced, so a caller can name them instead of only refusing.
      assert.deepEqual([...verdict.pricedSizes], [67, 138]);
    }
    // The honest case is untouched: a size the analysis did price is graded on its own row.
    const priced = judgeConsistency({ report, action: 'raise', to: 67, bigBlind: 10 });
    assert.equal(priced.pricing, 'priced');
    assert.equal(priced.chosen?.ev, 51);
    assert.equal(priced.consistent, true);
  });

  it('tells an unpriced action apart from an unpriced size, because they need different words', () => {
    const report = reportWith([
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'call', ev: 20, to: 25 }),
    ]);
    // No raise row at all: the analysis did not evaluate raising here.
    assert.equal(
      judgeConsistency({ report, action: 'raise', to: 90, bigBlind: 10 }).pricing,
      'action-not-priced',
    );
    // A call row exists, at a different total: the analysis evaluated calling, not this call.
    assert.equal(
      judgeConsistency({ report, action: 'call', to: 90, bigBlind: 10 }).pricing,
      'sizing-not-priced',
    );
    // Fold is priced and moves no chips, so a size attached to it matches nothing that exists.
    assert.equal(
      judgeConsistency({ report, action: 'fold', to: 5, bigBlind: 10 }).pricing,
      'sizing-not-priced',
    );
    // And an unsized fold is still judged on its own row, exactly as before.
    assert.equal(judgeConsistency({ report, action: 'fold', bigBlind: 10 }).pricing, 'priced');
  });

  it('floors the best EV at zero, because folding is always available at zero', () => {
    const report = reportWith([
      candidate({ action: 'call', ev: -3 }),
      candidate({ action: 'raise', ev: -9 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'call', bigBlind: 10 });
    assert.equal(verdict.bestEv, 0);
    assert.equal(verdict.best?.ev, -3, 'the row itself is still reported unchanged');
  });

  it('reports a single defensible action as such, which is what the nullable column records', () => {
    const report = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: -80 })]);
    const verdict = judgeConsistency({ report, action: 'fold', bigBlind: 10 });
    assert.deepEqual([...verdict.supportedActions], ['fold']);
    assert.equal(verdict.claimsOneAction, true);
  });
});

describe('the stakes the margin is denominated in', () => {
  /**
   * This suite used to cover `stakedReport`/`isStakedReport` — a `CoachReport` with `bigBlind`
   * attached, so the denominator could travel inside the data. They existed for one caller,
   * `ScenarioStage`, whose props could not then be changed; that component now takes `bigBlind` as a
   * required prop and the two functions had no callers left outside these tests. Removed rather than
   * kept, because a workaround left standing after its cause is fixed reads as load-bearing.
   *
   * What survives is the behaviour that always mattered: an explicit big blind sets the margin, and
   * nothing stating it gets the strictest margin the rule allows rather than a silently wider one.
   */
  it('uses the big blind it is given, and one chip when it is given none', () => {
    const report = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: -7 })]);
    assert.equal(judgeConsistency({ report, action: 'call', bigBlind: 10 }).marginUnits, 10);
    assert.equal(judgeConsistency({ report, action: 'call', bigBlind: 2 }).marginUnits, 2);
    assert.equal(judgeConsistency({ report, action: 'call' }).marginUnits, 1);
  });

  it('cannot be widened by a stray bigBlind riding along on the report', () => {
    // The failure mode the removed helpers made possible, pinned so it cannot come back by
    // accident: an unstated margin is one chip whatever else the object happens to carry.
    const report = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: -7 })]);
    const smuggled = { ...report, bigBlind: 10 };
    assert.equal(judgeConsistency({ report: smuggled, action: 'call' }).marginUnits, 1);
    assert.equal(judgeConsistency({ report: smuggled, action: 'call' }).consistent, false);
  });
});

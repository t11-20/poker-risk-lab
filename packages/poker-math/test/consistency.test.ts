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
}): ActionCandidate {
  return {
    action: input.action,
    cost: 0,
    ev: input.ev,
    derivation: `${input.action} is worth ${input.ev} by assumption in this test`,
    ...(input.to === undefined ? {} : { to: input.to }),
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

  it('says the analysis did not price an action rather than calling it wrong', () => {
    const report = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: 5 })]);
    const verdict = judgeConsistency({ report, action: 'raise', bigBlind: 10 });
    assert.equal(verdict.consistent, false);
    assert.equal(verdict.chosen, null);
    assert.deepEqual([...verdict.availableActions], ['fold', 'call']);
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

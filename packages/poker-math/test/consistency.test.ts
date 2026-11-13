/**
 * The one consistency rule, shared by `apps/api/src/routes/content.ts` and
 * `apps/web/src/lib/consistency.ts`. The margin scales with the big blind, and the comparison is
 * against folding, not the best-valued row, so a defensible call is not marked inconsistent for
 * trailing a raise. Reports are hand-built because `judgeConsistency` reads only the candidate table.
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
   * Set on the rows `buildCoachReport` sets it on (bets and raises, whose EV has the `f x pot` term).
   * `bestMeasuredCandidate` reads it.
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
    // A call that clears the price while a raise clears it by more. Both are defensible.
    const report = reportWith([
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'call', ev: 4 }),
      candidate({ action: 'raise', ev: 30, to: 120 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'call', bigBlind: 2 });
    assert.equal(verdict.consistent, true);
    // 26 chips behind the best row and still consistent. The gap is reported, not judged.
    assert.equal(verdict.bestEv, 30);
    assert.equal(verdict.chosen?.ev, 4);
    // A raise worth 30 beats folding at a 2-chip margin.
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
    // The verdict differs only with the stakes.
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
    // Shaped like `rk-the-fold-that-feels-wrong` and `eq-implied-odds-deep-stacks-turn`. Only a
    // bluff-raise priced at the default 35% fold equity beats the fold, and an assumption must not
    // decide the verdict.
    const report = reportWith([
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'call', ev: -60 }),
      candidate({ action: 'raise', ev: 126, to: 560, foldEquityAssumed: 0.35 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'fold', bigBlind: 20 });
    assert.equal(verdict.consistent, true);
    assert.equal(verdict.shortfallUnits, 0);
    // `bestEv` is the best row in the table, `measuredBestEv` the one the verdict used.
    assert.equal(verdict.bestEv, 126);
    assert.equal(verdict.measuredBestEv, 0);
    assert.deepEqual([...verdict.supportedActions], ['fold', 'raise']);
    // The call is still wrong, at -60 against a 20-chip margin.
    assert.equal(judgeConsistency({ report, action: 'call', bigBlind: 20 }).consistent, false);
  });

  it('still marks a fold wrong when something the analysis measured clearly beats it', () => {
    // A call carries no assumed fold frequency, so it is measured and does decide the verdict.
    const report = reportWith([
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'call', ev: 40 }),
      candidate({ action: 'raise', ev: 300, to: 560, foldEquityAssumed: 0.35 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'fold', bigBlind: 10 });
    assert.equal(verdict.consistent, false);
    // Quoted against the benchmark the verdict used, not against the raise.
    assert.equal(verdict.shortfallUnits, 40);
    assert.equal(verdict.measuredBestEv, 40);
  });

  it('counts an aggressive row priced at zero fold equity as a measured figure', () => {
    // The marker is the parameter's value. A raise priced with `assumedFoldEquity: 0` rests on equity
    // alone and counts as measured.
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
    // Not an EV comparison. A free check dominates a fold outright, and here every EV is inside the
    // 10-chip margin, so only the dominance rule catches the fold. `buildCoachReport` enforces the same.
    const report = reportWith([
      candidate({ action: 'check', ev: 0.6 }),
      candidate({ action: 'fold', ev: 0 }),
      candidate({ action: 'bet', ev: 6, to: 28, foldEquityAssumed: 0.35 }),
    ]);
    const verdict = judgeConsistency({ report, action: 'fold', bigBlind: 10 });
    assert.equal(verdict.consistent, false, 'giving up a hand that costs nothing to keep is never right');
    assert.deepEqual([...verdict.supportedActions], ['check', 'bet']);
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
    // Unsized raises are judged on the most favourable raise, because several sizings share the name.
    assert.equal(judgeConsistency({ report, action: 'raise', bigBlind: 10 }).chosen?.ev, 12);
  });

  /**
   * A `to` that matches no row must not fall through to the best row for that action name. A
   * 26,000-chip raise into a 500-chip stack was once graded consistent this way. The chosen row must be
   * absent, not just the boolean false.
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
      // The priced sizes, so a caller can name them.
      assert.deepEqual([...verdict.pricedSizes], [67, 138]);
    }
    // A size the analysis priced is graded on its own row.
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
    assert.equal(
      judgeConsistency({ report, action: 'raise', to: 90, bigBlind: 10 }).pricing,
      'action-not-priced',
    );
    // A call row exists, at a different total: the analysis evaluated calling, not this call.
    assert.equal(
      judgeConsistency({ report, action: 'call', to: 90, bigBlind: 10 }).pricing,
      'sizing-not-priced',
    );
    // Fold moves no chips, so a size attached to it matches nothing.
    assert.equal(
      judgeConsistency({ report, action: 'fold', to: 5, bigBlind: 10 }).pricing,
      'sizing-not-priced',
    );
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
  /** An explicit big blind sets the margin. Without one the margin is one chip, the strictest. */
  it('uses the big blind it is given, and one chip when it is given none', () => {
    const report = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: -7 })]);
    assert.equal(judgeConsistency({ report, action: 'call', bigBlind: 10 }).marginUnits, 10);
    assert.equal(judgeConsistency({ report, action: 'call', bigBlind: 2 }).marginUnits, 2);
    assert.equal(judgeConsistency({ report, action: 'call' }).marginUnits, 1);
  });

  it('cannot be widened by a stray bigBlind riding along on the report', () => {
    // An unstated margin is one chip whatever else the object carries.
    const report = reportWith([candidate({ action: 'fold', ev: 0 }), candidate({ action: 'call', ev: -7 })]);
    const smuggled = { ...report, bigBlind: 10 };
    assert.equal(judgeConsistency({ report: smuggled, action: 'call' }).marginUnits, 1);
    assert.equal(judgeConsistency({ report: smuggled, action: 'call' }).consistent, false);
  });
});

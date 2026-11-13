/**
 * `fixtures/table.ts` is a hand-typed Coach report that `fixtures:check` never reaches, and the live
 * table renders it when the API is unreachable, so this recomputes it. Its sentence "below roughly 20%
 * the raise and the call are worth about the same" was wrong: at 54.1% equity the raise wins even
 * against an opponent who never folds. Read as text, because the fixture imports `@prl/ui`, whose
 * barrel reaches `.tsx` that `node --test` cannot load. Every extraction asserts it matched.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evOfCall,
  evOfRaise,
  potOdds,
  probabilityOfHitting,
  ruleOf24,
  stackToPotRatio,
} from '@prl/poker-math';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'src', 'fixtures', 'table.ts'), 'utf8');

/** Just the `FLOP_DECISION_REPORT` literal, so a field name cannot be picked up from a neighbour. */
const REPORT = (() => {
  const start = SOURCE.indexOf('export const FLOP_DECISION_REPORT');
  assert.ok(start > 0, 'FLOP_DECISION_REPORT has been renamed or removed');
  const end = SOURCE.indexOf('export const', start + 1);
  assert.ok(end > start, 'the report literal must be followed by another export');
  return SOURCE.slice(start, end);
})();

/** Every value the fixture gives `field`, because `toCall` and `pot` appear twice and must agree. */
function values(field: string, text: string = REPORT): number[] {
  const found = [...text.matchAll(new RegExp(`\\b${field}:\\s*(-?[\\d_.]+)`, 'g'))].map((match) =>
    Number((match[1] as string).replace(/_/g, '')),
  );
  assert.ok(
    found.length > 0,
    `no "${field}:" in the fixture — the field was renamed and this check went blind`,
  );
  for (const one of found) assert.ok(Number.isFinite(one), `"${field}" is not a number: ${one}`);
  return found;
}

function value(field: string, text: string = REPORT): number {
  const found = values(field, text);
  const first = found[0] as number;
  for (const one of found) {
    assert.equal(one, first, `the fixture states "${field}" as both ${first} and ${one}`);
  }
  return first;
}

function candidate(action: string): string {
  const marker = `action: '${action}'`;
  const start = REPORT.indexOf(marker);
  assert.ok(start > 0, `the report no longer offers a "${action}" line`);
  const end = REPORT.indexOf('    {', start);
  return REPORT.slice(start, end > start ? end : REPORT.length);
}

const POT = value('potTotal');
const TO_CALL = value('toCall');
const EQUITY = value('heroEquity');
/** Two cards to come with hero's two and a three-card flop showing. */
const UNSEEN = 52 - 2 - 3;

describe('the bundled flop report is the arithmetic it claims to be', () => {
  it('counts outs that add up, and flush outs that are the suit less what is visible', () => {
    const clean = value('clean');
    const dirty = value('dirty');
    const total = value('total');
    assert.equal(clean + dirty, total, 'clean plus dirty is the total, by definition');

    const cleanCards = [...REPORT.matchAll(/cleanCards:\s*\[([^\]]*)\]/g)];
    assert.equal(cleanCards.length, 1, 'exactly one clean-out list');
    const named = ((cleanCards[0] as RegExpMatchArray)[1] as string)
      .split(',')
      .map((one) => one.trim().replace(/'/g, ''))
      .filter((one) => one.length > 0);
    assert.equal(named.length, clean, 'every clean out is named');
    assert.equal(new Set(named).size, named.length, 'no card may be counted twice');
    // Thirteen hearts in the suit, less the four on show: two in hand and two on the board.
    assert.equal(named.filter((card) => card.endsWith('h')).length, 13 - 4);
  });

  it('prices the call the way potOdds does', () => {
    const odds = potOdds(POT, TO_CALL);
    assert.ok(
      Math.abs(value('breakEvenEquity') - odds.breakEvenEquity) < 1e-6,
      `break-even: fixture ${value('breakEvenEquity')}, computed ${odds.breakEvenEquity}`,
    );
    assert.ok(
      Math.abs(value('oddsRatio') - (odds.oddsRatio ?? Number.NaN)) < 1e-3,
      `ratio: fixture ${value('oddsRatio')}, computed ${odds.oddsRatio}`,
    );
    assert.ok(
      Math.abs(value('equitySurplus') - (EQUITY - odds.breakEvenEquity)) < 1e-6,
      'the surplus is the equity less the price, and nothing else',
    );
  });

  it('reports the rule of 2 and 4 with the error the exact figure gives it', () => {
    const total = value('total');
    const estimate = ruleOf24(total, 2);
    // The shortcut is a fraction on this contract and `estimatePercent` is in points. Mixing them
    // rendered "160.0%" in the Scenario Lab.
    assert.ok(
      Math.abs(value('estimate') - estimate.estimatePercent / 100) < 1e-9,
      `fixture ${value('estimate')}, computed ${estimate.estimatePercent / 100}`,
    );
    const exact = probabilityOfHitting(total, UNSEEN, 2).probability;
    assert.ok(
      Math.abs(value('errorPoints') - (estimate.estimatePercent - exact * 100)) < 0.05,
      `error: fixture ${value('errorPoints')} points, computed ${estimate.estimatePercent - exact * 100}`,
    );
    // 54.10% is 1 - (32/47)(31/46). If the stored figure drifts, "the shortcut overstates by 5.9
    // points" stops being about this hand.
    assert.ok(Math.abs(EQUITY - exact) < 0.001, `equity ${EQUITY} against the exact ${exact}`);
  });

  it('states an interval its own trial count can support', () => {
    const trials = value('trials');
    const stated = value('halfWidthPoints');
    assert.equal(stated, value('confidenceHalfWidthPoints'), 'the two places that state it must agree');
    const halfWidth = 1.96 * Math.sqrt((EQUITY * (1 - EQUITY)) / trials) * 100;
    assert.ok(
      Math.abs(stated - halfWidth) < 0.02,
      `fixture ±${stated}, computed ±${halfWidth.toFixed(3)} from ${trials} trials`,
    );
  });

  it('splits the pot between the two players and nowhere else', () => {
    const shares = [
      ...REPORT.matchAll(/\{ label: '[^']*', equity: ([\d.]+), win: ([\d.]+), tie: ([\d.]+) \}/g),
    ];
    assert.equal(shares.length, 2, 'two players, two shares — the regex must still find them');
    let totalEquity = 0;
    for (const share of shares) {
      const equity = Number(share[1]);
      const win = Number(share[2]);
      const tie = Number(share[3]);
      totalEquity += equity;
      assert.ok(Math.abs(win + tie / 2 - equity) < 1e-3, 'equity must be wins plus half the chops');
    }
    assert.ok(Math.abs(totalEquity - 1) < 1e-9, `the shares must sum to one, they sum to ${totalEquity}`);
  });

  it('measures every expected value against folding', () => {
    assert.equal(value('ev', candidate('fold')), 0, 'folding is the zero point by definition');

    const call = candidate('call');
    const computedCall = evOfCall({ pot: POT, toCall: TO_CALL, equity: EQUITY });
    assert.ok(
      Math.abs(value('ev', call) - computedCall.ev) < 0.05,
      `call: fixture ${value('ev', call)}, computed ${computedCall.ev}`,
    );
    assert.equal(value('cost', call), TO_CALL);

    const raise = candidate('raise');
    const raiseTo = value('to', raise);
    const computedRaise = evOfRaise({
      pot: POT,
      toCall: TO_CALL,
      raiseBy: raiseTo - TO_CALL,
      foldProbability: value('foldEquityAssumed', raise),
      equityWhenCalled: EQUITY,
    });
    assert.ok(
      Math.abs(value('ev', raise) - computedRaise.ev) < 0.05,
      `raise: fixture ${value('ev', raise)}, computed ${computedRaise.ev}`,
    );
    assert.equal(value('cost', raise), raiseTo, 'the raise risks the call as well as the increment');
  });

  it('measures the effective stack against the pot', () => {
    const spr = stackToPotRatio(value('effectiveStack'), POT);
    assert.ok(Math.abs(value('spr') - spr.spr) < 1e-9, `fixture ${value('spr')}, computed ${spr.spr}`);
    // A pot-sized bet lays the caller exactly one third, which is the identity §8 checks.
    assert.ok(
      Math.abs(value('potOddsOfferedByPotSizedBet') - potOdds(POT * 2, POT).breakEvenEquity) < 1e-3,
      'a pot-sized bet lays the caller a third',
    );
  });

  /**
   * Every figure in the sentence is recomputed, and the shape is checked too. Above an even share of
   * equity no non-negative fold frequency equalises raise and call, so naming one is wrong.
   */
  it('does not promise a fold frequency at which the raise stops being better', () => {
    const raiseBy = value('to', candidate('raise')) - TO_CALL;
    const callEv = evOfCall({ pot: POT, toCall: TO_CALL, equity: EQUITY }).ev;
    const at = (foldProbability: number): number =>
      evOfRaise({ pot: POT, toCall: TO_CALL, raiseBy, foldProbability, equityWhenCalled: EQUITY }).ev;

    const never = at(0);
    const always = at(1);
    const crossover = (callEv - never) / (always - never);
    assert.ok(
      crossover < 0,
      `the fixture may promise a fold-equity threshold only if one exists; solving gives ${crossover}`,
    );
    assert.ok(never > callEv, 'above an even share the raise beats the call even against a station');

    const advice = (() => {
      const start = REPORT.indexOf('whatWouldChangeIt:');
      assert.ok(start > 0, 'the suggestion no longer says what would change it');
      const end = REPORT.indexOf('],', start);
      assert.ok(end > start);
      return REPORT.slice(start, end);
    })();

    for (const figure of [
      ((always - never) / 100).toFixed(2),
      (at(0.2) - callEv).toFixed(1),
      (never - callEv).toFixed(1),
      `${(EQUITY * 100).toFixed(1)}%`,
    ]) {
      assert.ok(
        advice.includes(figure),
        `the recomputed figure "${figure}" is not in the advice the panel shows:\n${advice}`,
      );
    }

    // The crossover it does name exists, at an even share.
    const evenShare = 0.5;
    assert.ok(
      Math.abs(
        evOfCall({ pot: POT, toCall: TO_CALL, equity: evenShare }).ev -
          evOfRaise({
            pot: POT,
            toCall: TO_CALL,
            raiseBy,
            foldProbability: 0,
            equityWhenCalled: evenShare,
          }).ev,
      ) < 1e-9,
      'at exactly half the pot the two lines are worth the same, which is what the sentence now says',
    );
    assert.ok(advice.includes('50% equity'), 'the sentence must still name the crossover that exists');
  });
});

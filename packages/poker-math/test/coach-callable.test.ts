/**
 * A bet or raise is priced on what an opponent can actually put in, and the half-pot break-even line
 * prices the size the table's ½-pot button offers. Expected figures are worked by hand in comments.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput } from '../src/coach.ts';
import { exactRange } from '../src/ranges.ts';
import { repriceAtFoldEquity } from '../src/reprice.ts';

/**
 * Hero's set of queens against the nut flush draw on the turn. Of the 44 unseen rivers, the seven
 * hearts that do not pair the board beat hero, so hero's equity is exactly 37/44.
 */
function setVersusDraw(overrides: Partial<CoachInput> = {}): CoachInput {
  return {
    heroCards: parseCards('Qs Qd'),
    board: parseCards('Qh 7h 2c 3d'),
    street: 'turn',
    opponents: [{ label: 'the draw', range: exactRange(parseCards('Ah Kh')) }],
    pot: 56,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 2589,
    opponentStacks: [370],
    bigBlind: 10,
    assumedFoldEquity: 0.35,
    ...overrides,
    contestablePot: overrides.contestablePot ?? overrides.pot ?? 56,
  };
}

function assertChips(actual: number | undefined, expected: number, what: string): void {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-6,
    `${what}: expected ${expected}, got ${actual}`,
  );
}

function rowAt(input: CoachInput, to: number) {
  const report = buildCoachReport(input);
  const row = report.candidates.find((candidate) => candidate.to === to);
  assert.ok(row !== undefined, `a row at ${to} is offered`);
  return { report, row };
}

test('a shove bigger than the opponent can call is priced on the 370 they can call', () => {
  // EV = 0.35 x 56 + 0.65 x [ (37/44) x (56 + 2 x 370) - 370 ] = 19.6 + 0.65 x 299.3636364 = 214.1863636.
  // Priced on the whole 2589 it read 19.6 + 0.65 x [ (37/44) x 5234 - 2589 ] = 1197.6068182.
  const { report, row } = rowAt(setVersusDraw(), 2589);
  assert.equal(row.action, 'bet');
  assertChips(report.equity.heroEquity, 37 / 44, 'hero equity');
  assertChips(row.ev, 214.18636364, 'EV of the all-in bet');
  assert.equal(row.cost, 370, 'only what can be called is at risk');
  assert.match(row.derivation, /only 370 of the 2589 bet can be called/);
  // A size the opponent can cover is unchanged: 19.6 + 0.65 x [ (37/44) x 168 - 56 ] = 75.0272727.
  assertChips(rowAt(setVersusDraw(), 56).row.ev, 75.02727273, 'EV of the pot-sized bet');
  assert.equal(repriceAtFoldEquity(report, 0.5).kind, 'available', 'the Lab can still re-price it');
});

test('a raise bigger than the bettor can call is priced on the 370 they have behind', () => {
  // Facing 20 into 76: EV = 0.35 x 76 + 0.65 x [ (37/44) x (76 + 20 + 740) - 390 ]
  //                       = 26.6 + 0.65 x (703 - 390) = 230.05.
  const { report, row } = rowAt(setVersusDraw({ pot: 76, toCall: 20 }), 2589);
  assert.equal(row.action, 'raise');
  assertChips(row.ev, 230.05, 'EV of the all-in raise');
  assert.equal(row.cost, 390, 'the call plus the 370 that can be matched');
  assert.equal(repriceAtFoldEquity(report, 0.2).kind, 'available', 'the Lab can still re-price it');
});

test('multiway, the cap is the deepest opponent, not the shortest', () => {
  // A set of sevens joins. Of 42 unseen rivers, the seven non-pairing hearts and the 7d beat hero,
  // so hero's equity is 34/42 = 17/21. Capped at 250, the larger of 100 and 250:
  //   EV = 0.35 x 60 + 0.65 x [ (17/21) x (60 + 500) - 250 ] = 21 + 0.65 x 203.3333333 = 153.1666667.
  const input = setVersusDraw({
    opponents: [
      { label: 'the draw', range: exactRange(parseCards('Ah Kh')) },
      { label: 'the set', range: exactRange(parseCards('7s 7c')) },
    ],
    pot: 60,
    heroStack: 1000,
    opponentStacks: [100, 250],
  });
  const { report, row } = rowAt(input, 1000);
  assertChips(report.equity.heroEquity, 17 / 21, 'hero equity');
  assertChips(row.ev, 153.16666667, 'EV of the all-in bet');
  assert.equal(row.cost, 250);
});

test('control: hero as the shorter stack is priced exactly as before', () => {
  // Hero's own 370 is the cap, so the shove is worth what the deeper hero's shove is worth above.
  const { row } = rowAt(setVersusDraw({ heroStack: 370, opponentStacks: [2589] }), 370);
  assertChips(row.ev, 214.18636364, 'EV of the all-in bet');
  assert.equal(row.cost, 370);
});

test('the half-pot break-even line prices the raise the ½-pot button offers', () => {
  // Hero holds the draw, equity 7/44. Facing 10 into 26 the button is 10 + round(0.5 x 36) = raise to
  // 28, which risks 28 to win 26. Called it is worth S = (7/44) x (26 + 10 + 36) - 28 = -728/44, so
  // the break-even fold rate is -S / (26 - S) = 728 / 1872 = 38.9%. Half of 26 priced as a bet said 15%.
  const report = buildCoachReport(
    setVersusDraw({
      heroCards: parseCards('Ah Kh'),
      opponents: [{ label: 'the set', range: exactRange(parseCards('Qs Qd')) }],
      pot: 26,
      toCall: 10,
      heroStack: 400,
      opponentStacks: [400],
    }),
  );
  assert.ok(report.candidates.some((candidate) => candidate.action === 'raise' && candidate.to === 28));
  const line = report.assumptions.find((assumption) => assumption.includes('½-pot'));
  assert.equal(
    line,
    'The ½-pot raise to 28 risks 28 to win 26. To break even it would need to win uncontested 39% of the time.',
  );
});

test('sizes that tie only because nobody can call more name the smallest of them', () => {
  // Into 600 with 100 behind, every size from 200 up risks the 100 that can be called and is worth
  // 0.35 x 600 + 0.65 x [ (37/44) x 800 - 100 ] = 210 + 0.65 x 572.7272727 = 582.2727273.
  // Betting 10 is worth 210 + 0.65 x [ (37/44) x 620 - 10 ] = 542.39, more than a big blind behind.
  const report = buildCoachReport(setVersusDraw({ pot: 600, opponentStacks: [100] }));
  const tied = report.candidates.filter((candidate) => candidate.cost === 100);
  assert.deepEqual(
    tied.map((candidate) => candidate.to),
    [200, 300, 400, 600, 2589],
  );
  for (const row of tied) assertChips(row.ev, 582.27272727, `EV of the bet to ${row.to}`);
  assert.equal(report.suggestion.action, 'bet');
  assert.deepEqual(report.suggestion.sizeRange, { min: 200, max: 200 });
});

test('control: an uncalled size within a big blind of the capped ones still widens the range', () => {
  // With 210 behind, 300 and up risk 210 and are worth 210 + 0.65 x [ (37/44) x 1020 - 210 ] = 631.02.
  // The 200 bet is called in full: 210 + 0.65 x [ (37/44) x 1000 - 200 ] = 626.59, 4.43 behind.
  const input = setVersusDraw({ pot: 600, opponentStacks: [210] });
  assertChips(rowAt(input, 300).row.ev, 631.02272727, 'EV of the bet to 300');
  assertChips(rowAt(input, 200).row.ev, 626.59090909, 'EV of the bet to 200');
  assert.deepEqual(buildCoachReport(input).suggestion.sizeRange, { min: 200, max: 300 });
});

test('a hand with no outs at all is not told that none of its 0 outs is clean', () => {
  // AsKs against AcKc on Qc 7c 2h 9d: every river chops or loses, so there is no out to count.
  const report = buildCoachReport(
    setVersusDraw({
      heroCards: parseCards('As Ks'),
      board: parseCards('Qc 7c 2h 9d'),
      opponents: [{ label: 'the other ace-king', range: exactRange(parseCards('Ac Kc')) }],
      opponentStacks: [2589],
    }),
  );
  const said = JSON.stringify(report);
  assert.doesNotMatch(said, /none of your 0 cards/u);
  assert.match(said, /No rule-of-2-and-4 figure here: no card that can come puts you in front/u);
});

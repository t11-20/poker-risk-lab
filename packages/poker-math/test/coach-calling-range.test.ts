/**
 * After the flop, heads-up and with nobody all in, a bet or raise is priced against the hands that
 * continue against that size, and it is the reading only when it beats checking or calling both ways:
 * called by the whole range and called by those hands alone. Expected figures are worked by hand.
 *
 * The river spot: hero holds Kc Jc on Kd 9s 5h 3c 2d against 39 combos, strongest first: 99 (3),
 * AK (8), KQ (8), KT (8), QQ (6), 88 (6). Hero beats KT, QQ and 88, so e = 20/39.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput } from '../src/coach.ts';
import { equity } from '../src/equity.ts';
import { exactRange, type ParsedRange, parseRange } from '../src/ranges.ts';

const HERO = 'Kc Jc';
const BOARD = 'Kd 9s 5h 3c 2d';
const river = (toCall: number, more: Partial<CoachInput> = {}): CoachInput => ({
  heroCards: parseCards(HERO),
  board: parseCards(BOARD),
  street: 'river',
  opponents: [
    { label: 'the bettor', range: parseRange('99, AK, KQ, KT, QQ, 88', parseCards(`${HERO} ${BOARD}`)) },
  ],
  pot: 100 + toCall,
  contestablePot: 100 + toCall,
  toCall,
  heroCommittedThisStreet: 0,
  heroStack: 300,
  opponentStacks: [{ behind: 300 - toCall, committedThisStreet: toCall }],
  bigBlind: 10,
  ...more,
});
const rowAt = (report: ReturnType<typeof buildCoachReport>, to: number) => {
  const row = report.candidates.find((c) => c.to === to && (c.action === 'bet' || c.action === 'raise'));
  assert.ok(row !== undefined, `no bet or raise to ${to}`);
  return row;
};
const close = (actual: number | undefined, expected: number, what: string) =>
  assert.ok(Math.abs((actual ?? Number.NaN) - expected) < 1e-9, `${what}: ${actual}, expected ${expected}`);

test('a raise is priced against the hands that continue, and its fold rate follows its size', () => {
  // Facing 50 into 100, P = 150. Raising to 100 risks 100: s = 150 / 200 = 0.75 of 39 is 29.25, so 30
  // continue, and the QQ tied with the 30th make it 33. Hero beats 14 of them. The final pot is 300.
  const report = buildCoachReport(river(50));
  const small = rowAt(report, 100);
  close(small.foldEquityAssumed, 0.25, 'fold rate');
  close(small.potShareIfCalled, 14 / 33, 'share when called');
  close(small.ev, 0.25 * 150 + 0.75 * ((14 / 33) * 300 - 100), 'EV');
  // Raising to 150 risks 150: s = 2/3 of 39 is 26, and the KT tied with the 26th make it 27.
  const pot = rowAt(report, 150);
  close(pot.foldEquityAssumed, 1 / 3, 'fold rate');
  close(pot.potShareIfCalled, 8 / 27, 'share when called');
  close(pot.ev, 150 / 3 + (2 / 3) * ((8 / 27) * 400 - 150), 'EV');
  // That raise is the ½-pot one. Called it is worth -31.48, so it breaks even at 31.48 / 181.48 = 17%.
  assert.ok(
    report.assumptions.some((line) =>
      line.includes(
        'need to win uncontested 17% of the time, counting the 29.6% equity you have when called',
      ),
    ),
  );
});

test('a raise ahead only on its folds stays set aside, though it tops the table', () => {
  // Calling is (20/39) x 200 - 50 = 52.56. The raise to 117 shows 59.85, but called by the 33 hands
  // that continue it is worth 24.70, and the raise to 100 is worth 27.27.
  const report = buildCoachReport(river(50));
  const top = [...report.candidates].sort((a, b) => b.ev - a.ev)[0];
  assert.equal(top?.to, 117, 'the premise: ranked on the table alone, a raise would be the reading');
  assert.equal(top?.ev.toFixed(2), '59.85');
  assert.equal(report.suggestion.action, 'call');
  assert.equal(report.suggestion.confidence, 'reasonable');
  assert.match(
    report.suggestion.reason,
    /by 25\.3 units over raising to 100 \(counted against the hands that/,
  );
  assert.match(
    report.suggestion.reason,
    /Raising to 117 shows a higher figure only because it assumes they fold 28%/,
  );
});

test('among the sizes that qualify, the reading follows the per-size figures', () => {
  // Checking is 51.28. Betting 10 or 33 is called by all 39 (the 88 tie with the last hand asked for),
  // worth 51.54 and 52.13 called and 53.85 and 58.91 on the table. From 50 up only stronger hands call.
  const report = buildCoachReport(river(0));
  close(rowAt(report, 33).ev, (1 - 100 / 116.5) * 100 + (100 / 116.5) * ((20 / 39) * 166 - 33), 'EV');
  assert.equal(report.suggestion.action, 'bet');
  assert.deepEqual(report.suggestion.sizeRange, { min: 10, max: 33 });
  assert.doesNotMatch(report.suggestion.reason, /whole range calls any size/);
  assert.ok(
    report.suggestion.whatWouldChangeIt.includes(
      'This assumes the line wins uncontested 14.2% of the time. An opponent who folds less often makes it worse.',
    ),
  );
});

test('a size past the pot is still set aside, and the report says what its figures assume', () => {
  // The nut straight wins whenever it is called, so a bet of B shows 100 + s x B: 166.67 at the pot,
  // and all in for 1,000, where s is 1/6, 266.67.
  const board = '9c 8d 7h 2s Kd';
  const nuts = (heroStack: number) =>
    buildCoachReport(
      river(0, {
        heroCards: parseCards('Jh Tc'),
        board: parseCards(board),
        opponents: [{ label: 'the caller', range: parseRange('KK, 99', parseCards(`Jh Tc ${board}`)) }],
        heroStack,
        opponentStacks: [{ behind: 1000, committedThisStreet: 0 }],
      }),
    );
  const report = nuts(1000);
  close(rowAt(report, 100).ev, 100 + 100 / 1.5, 'EV at the pot');
  close(rowAt(report, 1000).ev, 100 + 1000 / 6, 'EV all in');
  assert.deepEqual(report.suggestion.sizeRange, { min: 100, max: 100 });
  assert.match(
    report.suggestion.reason,
    /Betting 1000 shows a higher figure, but it rests on how often a bet that large is assumed to be called, so the reading goes no higher than a pot-sized bet/,
  );
  const stated = report.assumptions.filter((line) => line.startsWith('Bet and raise figures assume'));
  assert.equal(stated.length, 1);
  assert.match(
    stated[0] ?? '',
    /a chance that the opponent folds which grows with the size, and that a call comes from the strongest hands/,
  );
  assert.doesNotMatch(report.assumptions.join(' '), /35% of the time|Scenario Lab|whole range calls/);
  // All in for twice the pot is kept, as before, and says the same of its own figure.
  assert.match(
    nuts(200).suggestion.reason,
    /Betting 200 is more than the pot\. It is kept .*, but its figure rests on how often a bet that large is assumed to be called\.$/,
  );
});

test('ahead of what calls but behind the whole range is still not a bet', () => {
  // A small flush draw is a favourite against the pairs that call and far behind the bigger draws that
  // fold. Bet the pot and the six 33 continue: called by them it beats checking, called by all nine it
  // does not.
  const hero = parseCards('5h 4h');
  const board = parseCards('Kh 9h 2c');
  const pairs = parseRange('33', [...hero, ...board]);
  const draws = ['Ah Qh', 'Ah Jh', 'Ah Th'].map((cards) => exactRange(parseCards(cards)).combos[0]);
  const range: ParsedRange = {
    ...pairs,
    notation: '33 and three ace-high flush draws',
    combos: [...pairs.combos, ...draws.filter((combo) => combo !== undefined)],
  };
  const report = buildCoachReport({
    heroCards: hero,
    board,
    street: 'flop',
    opponents: [{ label: 'the caller', range }],
    pot: 100,
    contestablePot: 100,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 300,
    opponentStacks: [{ behind: 300, committedThisStreet: 0 }],
    bigBlind: 10,
  });
  const whole = report.equity.heroEquity;
  const againstPairs = equity({
    players: [
      { label: 'you', range: exactRange(hero) },
      { label: 'they', range: pairs },
    ],
    board,
  }).players[0]?.equity;
  assert.ok(againstPairs !== undefined && whole < 0.5 && againstPairs > 0.5, `${whole} and ${againstPairs}`);
  const bet = rowAt(report, 100);
  close(bet.potShareIfCalled, againstPairs, 'share when called');
  const check = whole * 100;
  assert.ok(againstPairs * 300 - 100 > check, 'the premise: called by the pairs alone it beats checking');
  assert.ok(whole * 300 - 100 < check, 'the premise: called by the whole range it does not');
  assert.ok(bet.ev > check, 'the premise: on the table it reads higher than checking');
  assert.equal(report.suggestion.action, 'check');
  assert.match(
    report.suggestion.reason,
    /Betting 300 shows a higher figure only if the weaker hands fold as assumed\. Called by the whole range it is behind checking\.$/,
  );
});

test('a reading behind a raise it set aside for its size says so, never a margin below zero', () => {
  // The sixteen jack-tens tie, the board's eights with queen, jack and ten, and are what calls every
  // size. Hero's fours are 51.6% against them and 55.5% against the range, so no raise up to the pot
  // beats calling when called.
  // All in for 1,000 does, 0.5162 x 2,100 - 1,000 = 84.0 against 58.8, and it is more than the pot.
  const hero = parseCards('4d 4c');
  const board = parseCards('8h 8s Qc');
  const report = buildCoachReport({
    heroCards: hero,
    board,
    street: 'flop',
    opponents: [{ label: 'the bettor', range: parseRange('JT, 42s', [...hero, ...board]) }],
    pot: 130,
    contestablePot: 130,
    toCall: 30,
    heroCommittedThisStreet: 0,
    heroStack: 1000,
    opponentStacks: [{ behind: 970, committedThisStreet: 30 }],
    bigBlind: 10,
  });
  assert.equal(report.suggestion.action, 'call');
  assert.equal(report.suggestion.confidence, 'low');
  assert.match(
    report.suggestion.reason,
    /^Call is the reading only because raising to 1000 is more than the pot\. Raising to 1000 \(counted against the hands that call it\) comes out ahead by 25\.2 units/,
  );
  const said = [report.suggestion.reason, ...report.suggestion.whatWouldChangeIt].join(' ');
  assert.doesNotMatch(said, /only -\d|The gap to/);
});

test('a share of exactly nothing stays a probability', () => {
  // Seven-deuce beats nothing that calls a raise here. Summed band by band the share came to -8e-18,
  // which the EV formulas refuse.
  const hero = parseCards('7s 2c');
  const board = parseCards('Tc As Jc 4d Ts');
  const range = parseRange('JJ+, AK, QJs, JTs, T9s, 98s, 87s, 76s', [...hero, ...board]);
  const report = buildCoachReport({
    heroCards: hero,
    board,
    street: 'river',
    opponents: [{ label: 'the bettor', range }],
    pot: 70,
    contestablePot: 70,
    toCall: 50,
    heroCommittedThisStreet: 0,
    heroStack: 1000,
    opponentStacks: [{ behind: 2000, committedThisStreet: 50 }],
    bigBlind: 10,
  });
  const shares = report.candidates.flatMap((row) => (row.action === 'raise' ? [row.potShareIfCalled] : []));
  assert.ok(shares.length > 1 && shares.includes(0), `no raise at a share of exactly 0: ${shares}`);
  assert.equal(report.suggestion.action, 'fold');
});

test('a spot that says the whole range continues keeps the flat fold rate and the whole-range share', () => {
  for (const toCall of [0, 50]) {
    const report = buildCoachReport(river(toCall, { wholeRangeContinues: true }));
    const sized = report.candidates.filter((c) => c.action === 'bet' || c.action === 'raise');
    assert.equal(sized.length, 6);
    for (const row of sized) {
      assert.equal(row.foldEquityAssumed, 0.35);
      assert.equal(row.potShareIfCalled, 20 / 39);
    }
    // 0.35 x 100 + 0.65 x ((20/39) x 300 - 100) = 70, and facing 50 the pot-sized raise to 250 is
    // 0.35 x 150 + 0.65 x ((20/39) x 600 - 250) = 90.
    close(rowAt(report, toCall === 0 ? 100 : 250).ev, toCall === 0 ? 70 : 90, 'EV');
    assert.deepEqual(
      report.suggestion.sizeRange,
      toCall === 0 ? { min: 10, max: 100 } : { min: 100, max: 300 },
    );
    assert.deepEqual(report, buildCoachReport(river(toCall, { assumedFoldEquity: 0.35 })));
  }
});

test('before the flop, multiway, against an all-in seat and into an empty pot nothing is narrowed', () => {
  const dead = parseCards(`${HERO} ${BOARD}`);
  const range = parseRange('99, AK, KQ, KT, QQ, 88', dead);
  const second = { label: 'the caller', range: parseRange('QQ, 88', dead) };
  const spots: readonly (readonly [string, CoachInput])[] = [
    ['preflop', { ...river(50), board: [], street: 'preflop' }],
    [
      'multiway',
      {
        ...river(50),
        opponents: [{ label: 'the bettor', range }, second],
        opponentStacks: [
          { behind: 250, committedThisStreet: 50 },
          { behind: 250, committedThisStreet: 50 },
        ],
      },
    ],
    [
      'all-in seat',
      {
        ...river(50),
        opponents: [{ label: 'the bettor', range }, second],
        opponentStacks: [
          { behind: 0, committedThisStreet: 50 },
          { behind: 250, committedThisStreet: 50 },
        ],
      },
    ],
    ['an empty pot', { ...river(0), pot: 0, contestablePot: 0 }],
    [
      'one range for two seats',
      {
        ...river(50),
        opponentStacks: [
          { behind: 250, committedThisStreet: 50 },
          { behind: 250, committedThisStreet: 50 },
        ],
      },
    ],
  ];
  for (const [name, spot] of spots) {
    const sized = buildCoachReport(spot).candidates.filter((c) => c.action === 'bet' || c.action === 'raise');
    assert.ok(sized.length > 0, `${name}: no bet or raise row; a sweep of nothing`);
    for (const row of sized) assert.equal(row.foldEquityAssumed, 0.35, `${name}: ${row.action} to ${row.to}`);
  }
});

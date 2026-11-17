/**
 * After the flop, heads-up and with nobody all in, a bet or raise is priced against the hands that
 * continue against that size, and it is the reading only when it beats checking or calling both ways:
 * called by the whole range and called by those hands alone. A row's fold rate is the share of hands
 * left out of its calling set, so a size every hand calls has none. Expected figures are worked by hand.
 *
 * The river spot: hero holds Kc Jc on Kd 9s 5h 3c 2d against 39 combos, strongest first: 99 (3),
 * AK (8), KQ (8), KT (8), QQ (6), 88 (6). Hero beats KT, QQ and 88, so e = 20/39.
 * The second: hero holds Ac Kc on the same board against 34: 99, 55, 33, 22 (3 each), KQ (8), KJ (8),
 * QQ (6). Hero beats KQ, KJ and QQ, so e = 22/34.
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
const topPair = (toCall: number, heroStack: number): CoachInput => {
  const dead = parseCards(`Ac Kc ${BOARD}`);
  const range = parseRange('99, 55, 33, 22, KQ, KJ, QQ', dead);
  return river(toCall, {
    heroCards: parseCards('Ac Kc'),
    opponents: [{ label: 'the bettor', range }],
    heroStack,
  });
};
const rowAt = (report: ReturnType<typeof buildCoachReport>, to: number) => {
  const row = report.candidates.find((c) => c.to === to && (c.action === 'bet' || c.action === 'raise'));
  assert.ok(row !== undefined, `no bet or raise to ${to}`);
  return row;
};
const close = (actual: number | undefined, expected: number, what: string) =>
  assert.ok(Math.abs((actual ?? Number.NaN) - expected) < 1e-9, `${what}: ${actual}, expected ${expected}`);

test('a raise is priced against the hands that continue, and the hands left out are its fold rate', () => {
  // Facing 50 into 100, P = 150. Raising to 100 risks 100: s = 150 / 200 = 0.75 of 39 is 29.25, so 30
  // are asked for, and the QQ tied with the 30th make it 33. Six fold, and hero beats 14 of the 33.
  const report = buildCoachReport(river(50));
  const small = rowAt(report, 100);
  close(small.continuingShare, 33 / 39, 'share that continues');
  close(small.foldEquityAssumed, 6 / 39, 'fold rate');
  close(small.potShareIfCalled, 14 / 33, 'share when called');
  close(small.ev, (6 / 39) * 150 + (33 / 39) * ((14 / 33) * 300 - 100), 'EV');
  // Raising to 150 risks 150: s = 2/3 of 39 is 26, and the KT tied with the 26th make it 27.
  const pot = rowAt(report, 150);
  close(pot.foldEquityAssumed, 12 / 39, 'fold rate');
  close(pot.potShareIfCalled, 8 / 27, 'share when called');
  close(pot.ev, (12 / 39) * 150 + (27 / 39) * ((8 / 27) * 400 - 150), 'EV');
  // That raise is the ½-pot one. Called it is worth -31.48, so it breaks even at 31.48 / 181.48 = 17%.
  assert.ok(
    report.assumptions.some((line) =>
      line.includes(
        'need to win uncontested 17% of the time, counting the 29.6% equity you have when called',
      ),
    ),
  );
  assert.equal(report.suggestion.action, 'call');
});

test('a size every hand calls carries no fold rate, and is priced as the whole range calling', () => {
  // Checked to, P = 100. Betting 33 asks for 0.858 x 39 = 33.5, so 34, and the 88 tied with the 34th
  // make it all 39: worth (20/39) x 166 - 33 = 52.13, against 51.28 for checking. From 50 up six fold.
  const report = buildCoachReport(river(0));
  const all = rowAt(report, 33);
  assert.equal(all.foldEquityAssumed, 0);
  assert.equal(all.continuingShare, 1);
  assert.equal(all.potShareIfCalled, report.equity.heroEquity);
  close(all.ev, (20 / 39) * 166 - 33, 'EV');
  close(rowAt(report, 50).foldEquityAssumed, 6 / 39, 'fold rate at 50');
  assert.equal(report.suggestion.action, 'bet');
  assert.deepEqual(report.suggestion.sizeRange, { min: 10, max: 33 });
  // 0.85 units over checking is under a quarter of the big blind of 10.
  assert.equal(report.suggestion.confidence, 'low');
  assert.ok(
    report.suggestion.whatWouldChangeIt.includes(
      'This assumes the line is called every time. An opponent who sometimes folds makes it better.',
    ),
  );
});

test('a size every hand calls reads the report’s own equity, to the last bit', () => {
  // On the turn the sixteen JT tie at the bottom, so every size up to the pot is called by all 47.
  // Summed and divided back, 47 x e / 47 is not e in floating point, so the whole range is not summed.
  const hero = parseCards('Ac Kc');
  const board = parseCards('Kd 9s 5h 3c');
  const range = parseRange('99, 55, 33, KQ, KJ, QQ, JT', [...hero, ...board]);
  const report = buildCoachReport({
    ...river(0),
    heroCards: hero,
    board,
    street: 'turn',
    opponents: [{ label: 'the caller', range }],
  });
  const e = report.equity.heroEquity;
  assert.notEqual((47 * e) / 47, e, 'the premise: the round trip moves the last bit');
  const pot = rowAt(report, 100);
  assert.equal(pot.continuingShare, 1);
  assert.equal(pot.potShareIfCalled, e);
  assert.equal(pot.ev, e * 300 - 100);
});

test('a raise ahead only on its folds stays set aside, though it tops the table', () => {
  // Facing 50 into 100 with 120 behind. Calling is (22/34) x 200 - 50 = 79.41. All in for 120 asks for
  // 0.714 x 34 = 24.3, so 25, and the KJ tied with the 25th make it 28: the six QQ fold. Hero beats 16
  // of the 28, so called it is (16/28) x 340 - 120 = 74.29, and on the table 87.65.
  const report = buildCoachReport(topPair(50, 120));
  const top = [...report.candidates].sort((a, b) => b.ev - a.ev)[0];
  assert.equal(top?.to, 120, 'the premise: ranked on the table alone, a raise would be the reading');
  close(top?.ev, (6 / 34) * 150 + (28 / 34) * ((16 / 28) * 340 - 120), 'EV');
  assert.equal(report.suggestion.action, 'call');
  assert.match(
    report.suggestion.reason,
    /by 5\.1 units over raising to 120 \(counted against the hands that call it\)\. Raising to 120 shows a higher figure only because it assumes they fold 18% of the time, .* only if they fold more than 6\.8% of the time\.$/,
  );
});

test('a bet ahead of what calls it is the reading, and states the fold rate it was priced at', () => {
  // Checked to with 100 behind. Checking is 64.71. All in for the pot is called by the same 28:
  // (16/28) x 300 - 100 = 71.43 called, and (6/34) x 100 + (28/34) x 71.43 = 76.47 on the table.
  const report = buildCoachReport(topPair(0, 100));
  close(rowAt(report, 100).ev, (6 / 34) * 100 + (28 / 34) * ((16 / 28) * 300 - 100), 'EV');
  assert.equal(report.suggestion.action, 'bet');
  assert.equal(report.suggestion.sizeRange?.max, 100);
  assert.match(
    report.suggestion.reason,
    /^Bet has the highest expected value .* by 11\.8 units over checking\./,
  );
  assert.ok(
    report.suggestion.whatWouldChangeIt.includes(
      'This assumes the line wins uncontested 17.6% of the time. An opponent who folds less often makes it worse.',
    ),
  );
});

test('a size past the pot is still set aside, and the report says what its figures assume', () => {
  // The nut straight wins whenever it is called. The three KK and the three 99 all call up to the pot,
  // worth 100 + 100 = 200. All in for 1,000 asks for one hand in six, so the KK call and the 99 fold:
  // 0.5 x 100 + 0.5 x 1,100 = 600.
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
  close(rowAt(report, 100).ev, 200, 'EV at the pot');
  close(rowAt(report, 1000).ev, 600, 'EV all in');
  assert.deepEqual(report.suggestion.sizeRange, { min: 100, max: 100 });
  assert.match(
    report.suggestion.reason,
    /Betting 1000 shows a higher figure, but it rests on how often a bet that large is assumed to be called, so the reading goes no higher than a pot-sized bet/,
  );
  const stated = report.assumptions.filter((line) => line.startsWith('Bet and raise figures assume'));
  assert.equal(stated.length, 1);
  assert.match(
    stated[0] ?? '',
    /a call comes from the strongest hands in the stated range as the board stands and that the rest fold/,
  );
  assert.doesNotMatch(report.assumptions.join(' '), /35% of the time|Scenario Lab|whole range calls/);
  // All in for one and a half pots is kept, as before, and says the same of its own figure. All six
  // hands call it, so no row there folds anybody and the assumption line says that instead.
  const kept = nuts(150);
  assert.match(
    kept.suggestion.reason,
    /Betting 150 is more than the pot\. It is kept .*, but its figure rests on how often a bet that large is assumed to be called\.$/,
  );
  assert.ok(
    kept.assumptions.includes(
      'Bet and raise figures assume the whole stated range calls every size here, so none of them rests on a fold. That is an assumption, not something measured.',
    ),
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

test('a size range stops at a size the reading sets aside, so it never spans one', () => {
  const dead = parseCards(`${HERO} ${BOARD}`);
  const report = buildCoachReport({
    ...river(50),
    opponents: [{ label: 'the bettor', range: parseRange('AK, K9, 99, 98, 87, 65', dead) }],
    pot: 150,
    contestablePot: 150,
    heroStack: 300,
    opponentStacks: [{ behind: 250, committedThisStreet: 50 }],
    bigBlind: 20,
  });
  // The raises to 150 and 183 lose to calling when only the hands that continue call, and 250 is ahead
  // again, so 100 to 250 would include two sizes the reading rejects.
  assert.equal(report.suggestion.action, 'raise');
  assert.deepEqual(report.suggestion.sizeRange, { min: 100, max: 117 });
});

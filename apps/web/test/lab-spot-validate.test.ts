/**
 * Every validation rule of the spot editor answers with its own sentence on its own field, and a draft
 * with any error yields no spot. The contract with the maths: a spot this validator passes is one
 * `buildCoachReport` accepts, but for ranges too tangled to sample, which get their own sentence.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCoachReport } from '@prl/poker-math';
import { parseCardText } from '@prl/ui/cards';
import { blankDraft, type OpponentDraft, type SpotDraft } from '../src/lib/spot.ts';
import { coachInputForSpot, reportForSpot } from '../src/lib/spot-analysis.ts';
import { type FieldKey, opponentField, validateDraft } from '../src/lib/spot-validate.ts';

function c(text: string): number {
  const card = parseCardText(text);
  assert.ok(card !== null, text);
  return card;
}

/** A flop spot that passes, so each test breaks exactly one thing. */
function good(): SpotDraft {
  const base = blankDraft();
  return {
    ...base,
    name: 'Test spot',
    cards: {
      hole1: c('Ah'),
      hole2: c('Kh'),
      flop1: c('Qh'),
      flop2: c('7h'),
      flop3: c('2c'),
      turn: null,
      river: null,
    },
    potBefore: '100',
    heroBet: '0',
    opponents: [{ ...(base.opponents[0] as OpponentDraft), name: 'Ledger', stack: '900', bet: '50' }],
  };
}

function opponent(draft: SpotDraft, change: Partial<OpponentDraft>): SpotDraft {
  return { ...draft, opponents: draft.opponents.map((o, i) => (i === 0 ? { ...o, ...change } : o)) };
}

function errorOn(draft: SpotDraft, field: FieldKey): string {
  const checked = validateDraft(draft);
  assert.equal(checked.ok, false, `expected an error on ${field}`);
  const message = checked.ok ? undefined : checked.errors.get(field);
  assert.ok(
    message !== undefined,
    `no error on ${field}: ${checked.ok ? '' : [...checked.errors.keys()].join(', ')}`,
  );
  return message;
}

const O = (field: Parameters<typeof opponentField>[1]): FieldKey => opponentField('o1', field);

describe('a valid draft', () => {
  it('passes and gives the spot it describes', () => {
    const checked = validateDraft(good());
    assert.ok(checked.ok, checked.ok ? '' : [...checked.errors.values()].join(' '));
    assert.equal(checked.spot.board.length, 3);
    assert.deepEqual(checked.spot.hero, { cards: [c('Ah'), c('Kh')], stack: 1000, bet: 0 });
  });

  it('stops at any street: preflop, turn and river all pass', () => {
    const draft = good();
    for (const cards of [
      { ...draft.cards, flop1: null, flop2: null, flop3: null },
      { ...draft.cards, turn: c('9d') },
      { ...draft.cards, turn: c('9d'), river: c('3s') },
    ]) {
      assert.ok(validateDraft({ ...draft, cards }).ok);
    }
  });
});

describe('each rule, with its message', () => {
  it('cards', () => {
    assert.equal(
      errorOn({ ...good(), cards: { ...good().cards, hole2: null } }, 'hole'),
      'Pick both of your hole cards.',
    );
    assert.equal(
      errorOn({ ...good(), cards: { ...good().cards, flop3: null } }, 'board'),
      'The flop needs all three cards, or none.',
    );
    assert.equal(
      errorOn(
        { ...good(), cards: { ...good().cards, flop1: null, flop2: null, flop3: null, turn: c('9d') } },
        'board',
      ),
      'Add the flop before the turn.',
    );
    assert.equal(
      errorOn({ ...good(), cards: { ...good().cards, river: c('3s') } }, 'board'),
      'Add the turn before the river.',
    );
    assert.equal(
      errorOn({ ...good(), cards: { ...good().cards, flop1: c('Ah') } }, 'board'),
      'The ace of hearts is used twice. Each card can appear once.',
    );
    const exact = opponent(good(), { handKind: 'cards', cards: [c('Kh'), c('2d')] });
    assert.equal(errorOn(exact, O('cards')), 'The king of hearts is used twice. Each card can appear once.');
    assert.equal(
      errorOn(opponent(good(), { handKind: 'cards', cards: [c('3d'), null] }), O('cards')),
      "Pick both of Ledger's cards.",
    );
  });

  it('amounts are whole, non-negative and present', () => {
    for (const bad of ['12a', '-5', '2.5', '1e3']) {
      assert.equal(
        errorOn({ ...good(), heroStack: bad }, 'heroStack'),
        'Use a whole number of chips, like 250.',
        bad,
      );
    }
    assert.equal(errorOn({ ...good(), heroStack: ' ' }, 'heroStack'), 'Enter your stack.');
    assert.equal(errorOn({ ...good(), potBefore: '' }, 'potBefore'), 'Enter the pot, or 0.');
    assert.equal(errorOn({ ...good(), bigBlind: '0' }, 'bigBlind'), 'The big blind must be at least 1 chip.');
    assert.equal(
      errorOn({ ...good(), heroStack: '1000000000' }, 'heroStack'),
      'Keep it to 100,000,000 chips or fewer.',
    );
    assert.equal(
      errorOn(opponent(good(), { stack: 'x' }), O('stack')),
      'Use a whole number of chips, like 250.',
    );
  });

  it('a bet cannot be more than the stack it came from', () => {
    assert.equal(
      errorOn(opponent(good(), { bet: '901' }), O('bet')),
      'Ledger cannot bet more than their stack of 900.',
    );
    assert.equal(
      errorOn({ ...good(), heroBet: '1001' }, 'heroBet'),
      'You cannot have put in more than your stack of 1,000.',
    );
    assert.equal(
      errorOn({ ...good(), heroBet: '1000' }, 'heroStack'),
      'You need chips left to decide with. Make your stack larger than what you have put in.',
    );
    assert.equal(
      errorOn({ ...good(), heroBet: '60' }, 'heroBet'),
      'You have put in more than any opponent has bet. Lower this, or raise a bet to match it.',
    );
  });

  it('the pot cannot be empty', () => {
    assert.equal(
      errorOn(opponent({ ...good(), potBefore: '0' }, { bet: '0' }), 'potBefore'),
      'The pot is empty. Add the blinds or earlier bets.',
    );
  });

  it('ranges', () => {
    assert.equal(errorOn(opponent(good(), { range: '  ' }), O('range')), 'Enter a range, like QQ+, AKs.');
    assert.equal(
      errorOn(opponent(good(), { range: 'QQ+++' }), O('range')),
      'This range could not be read. Write hands like AA, KQs, T9o, 22-66 or A2s+, with commas between.',
    );
    assert.equal(
      errorOn(opponent(good(), { range: 'top:0' }), O('range')),
      'Use top: with a whole number from 1 to 100, like top:20.',
    );
    assert.equal(
      errorOn(opponent(good(), { range: 'top:101' }), O('range')),
      'Use top: with a whole number from 1 to 100, like top:20.',
    );
    const aces = { ...good(), cards: { ...good().cards, hole1: c('Ah'), hole2: c('Ad'), flop1: c('Ac') } };
    assert.equal(
      errorOn(opponent(aces, { range: 'AA' }), O('range')),
      'Every hand in this range uses a card already in play.',
    );
    assert.equal(
      errorOn(opponent(good(), { range: 'A'.repeat(201) }), O('range')),
      'Keep the range to 200 characters.',
    );
    assert.ok(validateDraft(opponent(good(), { range: 'top:20' })).ok);
  });

  it('opponents', () => {
    assert.equal(errorOn(opponent(good(), { name: '' }), O('name')), 'Give this opponent a name.');
    assert.equal(
      errorOn(opponent(good(), { name: 'You' }), O('name')),
      'Use another name. The analysis calls you "you".',
    );
    assert.equal(errorOn({ ...good(), opponents: [] }, 'opponents'), 'Add at least one opponent.');
    assert.equal(
      errorOn(opponent(good(), { handKind: 'none' }), 'opponents'),
      'At least one opponent needs a range or cards, so there is a hand to compare against.',
    );
    const second: OpponentDraft = {
      ...(good().opponents[0] as OpponentDraft),
      key: 'o2',
      name: 'Mira',
      handKind: 'none',
      stack: '50',
      bet: '50',
    };
    assert.equal(
      errorOn({ ...good(), opponents: [...good().opponents, second] }, 'opponents'),
      'Mira is all in, so every opponent needs a range or cards.',
    );
    const tight = (key: string, name: string): OpponentDraft => ({
      ...(good().opponents[0] as OpponentDraft),
      key,
      name,
      range: 'KK',
    });
    assert.equal(
      errorOn({ ...good(), opponents: [tight('o1', 'A'), tight('o2', 'B')] }, 'opponents'),
      'These hands cannot all be dealt at once: 2 opponents need 4 different cards, and their ranges hold only 3.',
    );
  });

  it('name and fold rate', () => {
    assert.equal(errorOn({ ...good(), name: '' }, 'name'), 'Give the spot a name.');
    assert.equal(errorOn({ ...good(), name: 'x'.repeat(161) }, 'name'), 'Keep the name to 160 characters.');
    for (const bad of ['101', 'abc', '-1', '33.33']) {
      assert.equal(
        errorOn({ ...good(), foldRate: bad }, 'foldRate'),
        'Enter a percentage from 0 to 100, or leave it blank.',
        bad,
      );
    }
    const checked = validateDraft({ ...good(), foldRate: '33.3' });
    assert.ok(checked.ok);
    assert.equal(checked.spot.foldRate, 0.333);
  });

  it('never folds and a fold rate cannot both hold, so neither is silently ignored', () => {
    assert.equal(
      errorOn({ ...good(), neverFolds: true, foldRate: '60' }, 'foldRate'),
      'The opponent never folds, so leave the fold rate blank.',
    );
    assert.ok(validateDraft({ ...good(), neverFolds: true, foldRate: ' ' }).ok);
  });

  it('a draft with any error yields no spot at all', () => {
    const checked = validateDraft({ ...good(), heroStack: '12a' });
    assert.equal(checked.ok, false);
    assert.equal('spot' in checked, false);
  });
});

describe('a new spot, and the blinds before the flop', () => {
  const dealt = (draft: SpotDraft): SpotDraft => ({
    ...draft,
    cards: { ...draft.cards, hole1: c('Ah'), hole2: c('Kh') },
  });

  it('starts as a spot that can happen: preflop, facing the big blind, with no bet to open', () => {
    const checked = validateDraft(dealt(blankDraft()));
    assert.ok(checked.ok, checked.ok ? '' : [...checked.errors.values()].join(' '));
    const input = coachInputForSpot(checked.spot);
    assert.equal(input.street, 'preflop');
    assert.equal(input.toCall, Number(blankDraft().bigBlind) - Number(blankDraft().heroBet));
    assert.ok(!input.legalActions?.includes('bet'), `${input.legalActions?.join(', ')}`);
    assert.ok(input.legalActions?.includes('raise'));
  });

  it('refuses a preflop spot where nobody has posted the big blind', () => {
    const preflop = dealt({ ...good(), cards: { ...good().cards, flop1: null, flop2: null, flop3: null } });
    assert.equal(
      errorOn(opponent({ ...preflop, bigBlind: '20' }, { bet: '10' }), 'bigBlind'),
      "Before the flop, someone has put in the big blind of 20. Enter it as your bet or an opponent's.",
    );
    assert.ok(validateDraft(opponent(preflop, { bet: '20' })).ok);
    assert.ok(
      validateDraft({ ...opponent(preflop, { bet: '0' }), heroBet: '0', potBefore: '30' }).ok === false,
    );
  });
});

describe('ranges that cannot all be dealt at once', () => {
  const JOINT =
    'These ranges cannot all be dealt at once. Whatever one opponent holds, another is left with no hand. Widen a range.';
  const seats = (ranges: readonly string[]): OpponentDraft[] =>
    ranges.map((range, index) => ({
      ...(good().opponents[0] as OpponentDraft),
      key: `o${index + 1}`,
      name: `P${index + 1}`,
      range,
    }));
  const aces = (ranges: readonly string[]): SpotDraft => ({
    ...good(),
    cards: { ...good().cards, hole1: c('Ah'), hole2: c('Ad'), flop1: c('Ac'), flop2: c('7d') },
    opponents: seats(ranges),
  });

  it('refuses on the opponents field when every deal leaves someone without a hand', () => {
    // Both ranges need the one ace left, though between them they hold eight different cards.
    assert.equal(errorOn(aces(['AKs, AQs, AJs', 'AKs, AQs, AJs']), 'opponents'), JOINT);
    assert.ok(validateDraft(aces(['AKs, AQs, AJs', 'KQs'])).ok, 'one ace each is dealable');
  });

  it('the analysis makes the same check, because a top:NN range is expanded only there', () => {
    const checked = validateDraft(aces(['AKs, AQs, AJs', 'KQs']));
    assert.ok(checked.ok);
    const [first, second] = checked.spot.opponents;
    assert.ok(first !== undefined && second !== undefined);
    const result = reportForSpot({ ...checked.spot, opponents: [first, { ...second, hand: first.hand }] });
    assert.equal(result.ok ? '' : result.message, JOINT);
  });

  it('checks the seats it has combinations for even when another seat is top:NN', () => {
    const hero = {
      ...good().cards,
      hole1: c('Ah'),
      hole2: c('2d'),
      flop1: c('Kc'),
      flop2: c('7h'),
      flop3: c('3s'),
    };
    const draft: SpotDraft = { ...good(), cards: hero, opponents: seats(['top:20', 'AA', 'AA', 'AA']) };
    assert.equal(
      errorOn(draft, 'opponents'),
      'These hands cannot all be dealt at once: P2, P3 and P4 need 6 different cards, and their ranges hold only 3.',
    );
  });

  it('names the seats it counted when another seat cannot be read', () => {
    const draft: SpotDraft = { ...good(), opponents: seats(['AA', 'AA', 'AA, KQs+ nonsense']) };
    assert.equal(
      errorOn(draft, 'opponents'),
      'These hands cannot all be dealt at once: P1 and P2 need 4 different cards, and their ranges hold only 3.',
    );
    const joint: SpotDraft = {
      ...aces(['AKs, AQs, AJs', 'AKs, AQs, AJs', 'top:20']),
    };
    assert.equal(
      errorOn(joint, 'opponents'),
      'The ranges of P1 and P2 cannot all be dealt at once. Whatever one of them holds, another is left with no hand. Widen a range.',
    );
  });

  it('names seats by number when two of them share a typed name', () => {
    const named = (names: readonly string[]): SpotDraft => {
      const draft = { ...good(), opponents: seats(['AA', 'AA', 'AA, KQs+ nonsense']) };
      return {
        ...draft,
        opponents: draft.opponents.map((seat, index) => ({ ...seat, name: names[index] ?? '' })),
      };
    };
    assert.equal(
      errorOn(named(['Villain', 'Villain', 'Third']), 'opponents'),
      'These hands cannot all be dealt at once: Opponent 1 and Opponent 2 need 4 different cards, and their ranges hold only 3.',
    );
    assert.equal(
      errorOn(named(['Villain', 'Reg', 'Third']), 'opponents'),
      'These hands cannot all be dealt at once: Villain and Reg need 4 different cards, and their ranges hold only 3.',
    );
  });

  it('answers within a frame for five wide ranges that share four cards', () => {
    const anyAce = 'A2s+, A2o+';
    // The fastest of five, because the suite runs beside the other packages: one run took 71ms there.
    // A different second hole card each run, because `dealSearch` caches by combos and a hit takes 0.3ms.
    const runs = ['3d', '4d', '5d', '6d', '7d'].map((hole2) => {
      const draft: SpotDraft = {
        ...good(),
        cards: { ...good().cards, flop1: null, flop2: null, flop3: null, hole1: c('2c'), hole2: c(hole2) },
        opponents: seats([anyAce, anyAce, anyAce, anyAce, anyAce]),
      };
      const started = performance.now();
      assert.equal(errorOn(draft, 'opponents'), JOINT);
      return performance.now() - started;
    });
    assert.ok(Math.min(...runs) < 50, runs.map((ms) => `${Math.round(ms)} ms`).join(', '));
  });
});

describe('ranges too tangled to check or to sample', () => {
  const tangled = (range: string): SpotDraft => ({
    ...good(),
    cards: {
      ...good().cards,
      hole1: c('Ah'),
      hole2: c('As'),
      flop1: c('Kc'),
      flop2: c('Qd'),
      flop3: c('7h'),
    },
    opponents: [0, 1, 2, 3, 4].map((index) => ({
      ...(good().opponents[0] as OpponentDraft),
      key: `o${index + 1}`,
      name: `P${index + 1}`,
      range,
    })),
  });

  it('says so when the search runs out, rather than passing in silence', () => {
    // At most four of these five can be dealt, which neither bound can prove, so the search runs out.
    const checked = validateDraft(tangled('A2s+, A2o+, KK, QQ'));
    assert.ok(checked.ok, 'not refused: a spot the search could not finish may still be dealable');
    assert.equal(checked.dealChecked, false, 'and it says it could not check');
  });

  it('a spot the sampler cannot deal says what to change, in its own sentence', () => {
    const checked = validateDraft(tangled('A2s+, A2o+, KK, QQ, JJ'));
    assert.ok(checked.ok);
    const result = reportForSpot(checked.spot);
    assert.equal(
      result.ok ? '' : result.message,
      'The analysis could not deal every opponent a hand from these ranges, because they overlap too much. Widen a range or remove an opponent.',
    );
  });

  it('a spot one range wider still prices', () => {
    const checked = validateDraft(tangled('A2s+, A2o+, KK, QQ, JJ, TT'));
    assert.ok(checked.ok && checked.dealChecked);
    assert.equal(reportForSpot(checked.spot).ok, true);
  });
});

describe('a hero short of the bet', () => {
  const seat = (key: string, name: string, stack: string, bet: string): OpponentDraft => ({
    ...(good().opponents[0] as OpponentDraft),
    key,
    name,
    stack,
    bet,
    range: '22+, A2s+, KTo+, QTo+',
  });
  const short = (opponents: readonly OpponentDraft[]): SpotDraft => ({
    ...good(),
    heroStack: '100',
    potBefore: '100',
    opponents,
  });
  const priced = (draft: SpotDraft) => {
    const checked = validateDraft(draft);
    assert.ok(checked.ok, checked.ok ? '' : [...checked.errors.values()].join(' '));
    const result = reportForSpot(checked.spot);
    assert.ok(result.ok, result.ok ? '' : result.message);
    const call = result.report.candidates.find((candidate) => candidate.action === 'call');
    assert.ok(call !== undefined, 'no call row');
    return { report: result.report, call };
  };

  it('prices the call it can make: the price, break-even and EV agree', () => {
    const { report, call } = priced(short([seat('o1', 'Ledger', '1000', '500')]));
    assert.equal(call.cost, 100);
    assert.equal(report.potOdds.toCall, call.cost, 'the price line and the call row name one cost');
    assert.equal(report.potOdds.pot, 200, 'the 100 before plus the 100 of the bet hero can match');
    assert.ok(Math.abs(report.potOdds.breakEvenEquity - 100 / 300) < 1e-12);
    const equity = report.equity.heroEquity;
    assert.ok(Math.abs(call.ev - (equity * 300 - 100)) < 1e-9, 'EV is against the pot break-even uses');
    assert.match(report.potOdds.explanation, /You risk 100 to win the 200/u);
    assert.match(report.potOdds.explanation, /goes back to the bettor uncalled/u);
  });

  it('multiway, counts from each bet only what hero can match', () => {
    const both = priced(short([seat('o1', 'Ledger', '1000', '500'), seat('o2', 'Mira', '1000', '500')]));
    assert.equal(both.report.potOdds.pot, 300);
    assert.equal(both.report.potOdds.toCall, 100);
    assert.equal(both.report.outOfReach, 'side-pot');
    assert.match(both.report.potOdds.explanation, /800 of it is a side pot you are not in/u);
    const mixed = priced(short([seat('o1', 'Ledger', '1000', '500'), seat('o2', 'Mira', '60', '60')]));
    assert.equal(mixed.report.potOdds.pot, 260, "100 before, Mira's 60 and 100 of Ledger's 500");
    assert.equal(mixed.report.outOfReach, 'uncalled');
  });

  it('a call of exactly the stack is all in with nothing out of reach', () => {
    const { report, call } = priced(short([seat('o1', 'Ledger', '1000', '100')]));
    assert.equal(call.cost, 100);
    assert.equal(report.potOdds.pot, 200);
    assert.equal(report.outOfReach, undefined);
  });
});

describe('the contract with the maths', () => {
  it('a spot that passes is one buildCoachReport accepts, and each refused row is refused', () => {
    // A fixed walk over street, bets, stacks, hands and assumptions, so a failure reproduces.
    const boards = [
      { flop1: null, flop2: null, flop3: null, turn: null, river: null },
      { flop1: c('Qh'), flop2: c('7h'), flop3: c('2c'), turn: null, river: null },
      { flop1: c('Qh'), flop2: c('7h'), flop3: c('2c'), turn: c('9d'), river: null },
      { flop1: c('Qh'), flop2: c('7h'), flop3: c('2c'), turn: c('9d'), river: c('3s') },
    ];
    const hands: Partial<OpponentDraft>[] = [
      { handKind: 'range', range: 'QQ+, AKo' },
      { handKind: 'range', range: '22+, A2s+' },
      { handKind: 'cards', cards: [c('Js'), c('Td')] },
    ];
    // Each refused row names the field it is refused on. Without those rules, the maths throws.
    const rows: readonly (readonly [string, string, string, string, FieldKey | null])[] = [
      ['0', '0', '900', '1000', null],
      ['0', '50', '900', '1000', null],
      ['20', '20', '900', '1000', null],
      ['0', '900', '900', '1000', null],
      ['10', '400', '1500', '1000', null],
      ['0', '900', '1500', '300', null],
      ['20', '900', '1500', '300', null],
      ['0', '900', '400', '1000', O('bet')],
      ['20', '20', '900', '20', 'heroStack'],
      ['60', '50', '900', '1000', 'heroBet'],
    ];
    const assumptions: readonly (readonly [Partial<SpotDraft>, FieldKey | null])[] = [
      [{}, null],
      [{ neverFolds: true }, null],
      [{ foldRate: '30' }, null],
      [{ neverFolds: true, foldRate: '30' }, 'foldRate'],
    ];
    const drafts: (readonly [SpotDraft, FieldKey | null])[] = [];
    for (const board of boards) {
      for (const hand of hands) {
        for (const [heroBet, bet, stack, heroStack, rowRefusal] of rows) {
          // A second seat with a range, one the analysis does not model, or none.
          for (const extra of [null, 'range', 'none'] as const) {
            const opponents: OpponentDraft[] = [
              { ...(good().opponents[0] as OpponentDraft), stack, bet, ...hand },
              ...(extra === null
                ? []
                : [
                    {
                      ...(good().opponents[0] as OpponentDraft),
                      key: 'o2',
                      name: 'Mira',
                      handKind: extra,
                      range: 'TT+',
                      stack: '600',
                      bet: '0',
                    },
                  ]),
            ];
            for (const [assumption, assumed] of assumptions) {
              const unposted = board.flop1 === null && Math.max(Number(heroBet), Number(bet)) < 20;
              const draft: SpotDraft = {
                ...good(),
                cards: { ...good().cards, ...board },
                heroBet,
                heroStack,
                opponents,
                ...assumption,
              };
              const unmodelledBesideAllIn = extra === 'none' && stack === bet;
              const table = unposted ? 'bigBlind' : unmodelledBesideAllIn ? 'opponents' : null;
              drafts.push([draft, rowRefusal ?? assumed ?? table]);
            }
          }
        }
      }
    }
    const crowded = (ranges: readonly string[]): SpotDraft => ({
      ...good(),
      cards: { ...good().cards, hole1: c('Ah'), hole2: c('Ad'), flop1: c('Ac'), flop2: c('7d') },
      opponents: ranges.map((range, index) => ({
        ...(good().opponents[0] as OpponentDraft),
        key: `o${index + 1}`,
        name: `P${index + 1}`,
        range,
      })),
    });
    drafts.push([crowded(['AKs, AQs, AJs', 'AKs, AQs, AJs']), 'opponents']);
    drafts.push([crowded(['AKs, AQs, AJs', 'KQs']), null]);

    let priced = 0;
    let refused = 0;
    for (const [draft, refusal] of drafts) {
      const checked = validateDraft(draft);
      if (refusal !== null) {
        assert.ok(
          !checked.ok && checked.errors.has(refusal),
          `not refused on ${refusal}: ${JSON.stringify(draft)}`,
        );
        refused += 1;
        continue;
      }
      assert.ok(
        checked.ok,
        `${checked.ok ? '' : [...checked.errors.values()].join(' ')} ${JSON.stringify(draft)}`,
      );
      priced += 1;
      const report = buildCoachReport({ ...coachInputForSpot(checked.spot), samples: 2_000 });
      const call = report.candidates.find((candidate) => candidate.action === 'call');
      if (call !== undefined) assert.equal(report.potOdds.toCall, call.cost, JSON.stringify(draft));
    }
    assert.ok(priced > 300 && refused > 100, `${priced} priced, ${refused} refused: a sweep of nothing`);
  });

  it('a refusal comes back as a sentence, never a throw', () => {
    const checked = validateDraft(opponent(good(), { range: 'top:1' }));
    assert.ok(checked.ok);
    const seat = checked.spot.opponents[0];
    assert.ok(seat !== undefined);
    const crowded = {
      ...checked.spot,
      opponents: [0, 1, 2, 3, 4].map((i) => ({ ...seat, name: `P${i}` })),
    };
    const result = reportForSpot(crowded);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /cannot all be dealt at once/u);
  });
});

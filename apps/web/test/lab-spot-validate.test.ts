/**
 * Every validation rule of the spot editor answers with its own sentence on its own field, and a draft
 * with any error yields no spot. The last test is the contract with the maths: a spot this validator
 * passes is never one `buildCoachReport` refuses.
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

  it('a draft with any error yields no spot at all', () => {
    const checked = validateDraft({ ...good(), heroStack: '12a' });
    assert.equal(checked.ok, false);
    assert.equal('spot' in checked, false);
  });
});

describe('the contract with the maths', () => {
  it('a spot that passes is one buildCoachReport accepts', () => {
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
    let checkedCount = 0;
    for (const board of boards) {
      for (const hand of hands) {
        for (const [heroBet, bet, stack] of [
          ['0', '0', '900'],
          ['0', '50', '900'],
          ['20', '20', '900'],
          ['0', '900', '900'],
          ['10', '400', '1500'],
        ] as const) {
          for (const extra of [false, true]) {
            const opponents: OpponentDraft[] = [
              { ...(good().opponents[0] as OpponentDraft), stack, bet, ...hand },
              ...(extra
                ? [
                    {
                      ...(good().opponents[0] as OpponentDraft),
                      key: 'o2',
                      name: 'Mira',
                      range: 'TT+',
                      stack: '600',
                      bet: '0',
                    },
                  ]
                : []),
            ];
            for (const assumption of [{}, { neverFolds: true }, { foldRate: '30' }]) {
              const draft: SpotDraft = {
                ...good(),
                cards: { ...good().cards, ...board },
                heroBet,
                opponents,
                ...assumption,
              };
              const checked = validateDraft(draft);
              if (!checked.ok) continue;
              checkedCount += 1;
              assert.doesNotThrow(
                () => buildCoachReport({ ...coachInputForSpot(checked.spot), samples: 2_000 }),
                JSON.stringify(draft),
              );
            }
          }
        }
      }
    }
    assert.ok(checkedCount > 100, `only ${checkedCount} valid spots were priced: a sweep of nothing`);
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

/**
 * The editor's edits to a draft (the picker's slots, "Clear board", "Random hand", adding and removing
 * opponents), and the fences around the editor: it reaches neither the engine, the content bundle nor
 * the API, and it prices with the sampling the built-in pages use.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SCENARIO_ANALYSIS_SAMPLES, SCENARIO_ANALYSIS_SEED } from '@prl/content';
import { cardOwners, pickCard } from '@prl/ui/card-picker';
import { parseCardText } from '@prl/ui/cards';
import {
  blankDraft,
  MAX_OPPONENTS,
  opponentSlotIds,
  type RandomBytes,
  type SpotDraft,
} from '../src/lib/spot.ts';
import { SPOT_SAMPLES, SPOT_SEED } from '../src/lib/spot-analysis.ts';
import {
  addOpponent,
  allSlots,
  clearBoard,
  pickerGroups,
  priceLine,
  randomHand,
  removeOpponent,
  updateOpponent,
  withSlotCard,
} from '../src/lib/spot-editing.ts';

function c(text: string): number {
  const card = parseCardText(text);
  assert.ok(card !== null, text);
  return card;
}

function filled(): SpotDraft {
  return {
    ...blankDraft(),
    cards: {
      hole1: c('Ah'),
      hole2: c('Kh'),
      flop1: c('Qh'),
      flop2: c('7h'),
      flop3: c('2c'),
      turn: c('9d'),
      river: null,
    },
  };
}

/** Bytes from a fixed sequence, so a "random" hand is reproducible. */
function sequence(values: readonly number[]): RandomBytes {
  let at = 0;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = values[at++ % values.length] ?? 0;
    return bytes;
  };
}

describe('the picker on a draft', () => {
  it('lists hero, board and each exact-hand opponent, in fill order', () => {
    const draft = updateOpponent(blankDraft(), 'o1', { handKind: 'cards', name: 'Ledger' });
    const groups = pickerGroups(draft);
    assert.deepEqual(
      groups.map((group) => group.label),
      ['Your hand', 'Board', "Ledger's hand"],
    );
    assert.deepEqual(
      allSlots(draft).map((slot) => slot.label),
      ['Hole 1', 'Hole 2', 'Flop 1', 'Flop 2', 'Flop 3', 'Turn', 'River', 'Ledger, card 1', 'Ledger, card 2'],
    );
  });

  it('a pick lands in the draft, and a card held by an opponent cannot be picked for the board', () => {
    let draft = updateOpponent(blankDraft(), 'o1', { handKind: 'cards' });
    const [first] = opponentSlotIds('o1');
    draft = withSlotCard(draft, first, c('As'));
    assert.equal(draft.opponents[0]?.cards[0], c('As'));
    assert.equal(cardOwners(allSlots(draft)).get(c('As'))?.label, 'Big blind, card 1');
    assert.equal(pickCard(allSlots(draft), 'flop1', c('As')).placed, null);
  });

  it('clear board empties the five board slots and keeps the hole cards', () => {
    const cleared = clearBoard(filled());
    assert.deepEqual(
      [
        cleared.cards.flop1,
        cleared.cards.flop2,
        cleared.cards.flop3,
        cleared.cards.turn,
        cleared.cards.river,
      ],
      [null, null, null, null, null],
    );
    assert.equal(cleared.cards.hole1, c('Ah'));
  });

  it('random hand deals two different hole cards that no slot already holds', () => {
    const draft = updateOpponent(filled(), 'o1', { handKind: 'cards', cards: [c('As'), c('Ks')] });
    for (let seed = 0; seed < 200; seed++) {
      const dealt = randomHand(draft, sequence([seed, (seed * 7 + 3) % 256, 255, seed ^ 0x5a]));
      const { hole1, hole2 } = dealt.cards;
      assert.ok(hole1 !== null && hole2 !== null);
      assert.notEqual(hole1, hole2);
      const elsewhere = allSlots(dealt).filter((slot) => slot.id !== 'hole1' && slot.id !== 'hole2');
      assert.ok(!elsewhere.some((slot) => slot.card === hole1 || slot.card === hole2), `seed ${seed}`);
      assert.equal(dealt.cards.turn, c('9d'));
    }
  });

  it('random hand skips bytes past the last whole multiple, so no card is favoured', () => {
    // 48 cards are free and 256 % 48 = 16, so a byte from 240 up is rejected rather than folded down.
    const dealt = randomHand(filled(), sequence([250, 0, 240, 1]));
    const free = Array.from({ length: 52 }, (_u, card) => card).filter(
      (card) =>
        !allSlots(filled()).some((slot) => slot.id !== 'hole1' && slot.id !== 'hole2' && slot.card === card),
    );
    assert.equal(dealt.cards.hole1, free[0]);
  });
});

describe('opponents', () => {
  it('adds up to five, each with its own key, and never removes the last', () => {
    let draft = blankDraft();
    for (let i = 0; i < 10; i++) draft = addOpponent(draft);
    assert.equal(draft.opponents.length, MAX_OPPONENTS);
    assert.equal(new Set(draft.opponents.map((o) => o.key)).size, MAX_OPPONENTS);
    let one = blankDraft();
    one = removeOpponent(one, 'o1');
    assert.equal(one.opponents.length, 1);
  });

  it('the price line derives the pot and the call from the seats', () => {
    const draft = updateOpponent({ ...blankDraft(), potBefore: '100', heroBet: '10' }, 'o1', { bet: '60' });
    assert.deepEqual(priceLine(draft), { pot: 170, toCall: 50, allIn: false });
    assert.equal(priceLine({ ...draft, potBefore: 'x' }), null);
  });

  it('the price line caps the call at what you have behind, and says it is all in', () => {
    const draft = updateOpponent(
      { ...blankDraft(), potBefore: '100', heroStack: '100', heroBet: '0' },
      'o1',
      {
        stack: '1000',
        bet: '500',
      },
    );
    assert.deepEqual(priceLine(draft), { pot: 600, toCall: 100, allIn: true });
  });
});

describe('the fences', () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const CLIENT = [
    '../src/lib/spot.ts',
    '../src/lib/spot-analysis.ts',
    '../src/lib/spot-convert.ts',
    '../src/lib/spot-editing.ts',
    '../src/lib/spot-storage.ts',
    '../src/lib/spot-validate.ts',
    '../src/lib/spot-worker.ts',
    '../src/lib/use-spot-library.ts',
    '../src/lib/use-spot-report.ts',
    '../src/components/SpotEditor.tsx',
    '../src/components/SpotList.tsx',
    '../src/components/ScenarioSpotLinks.tsx',
  ];

  it('nothing the browser loads for the editor imports the engine, the content bundle or the API', () => {
    assert.ok(CLIENT.length > 10, 'a sweep of nothing is not a pass');
    for (const path of CLIENT) {
      const source = read(path);
      assert.ok(source.length > 0, path);
      for (const forbidden of [
        "'@prl/poker-engine'",
        "'@prl/content'",
        'lib/api.ts',
        'scenarioAttempt',
        'apiSend',
        'fetch(',
      ]) {
        assert.ok(!source.includes(forbidden), `${path} must not reference ${forbidden}`);
      }
    }
  });

  it('prices with the samples and seed the built-in pages use', () => {
    assert.equal(SPOT_SAMPLES, SCENARIO_ANALYSIS_SAMPLES);
    assert.equal(SPOT_SEED, SCENARIO_ANALYSIS_SEED);
  });

  it('starts the analysis on a same-origin worker, which the CSP allows', () => {
    assert.match(
      read('../src/lib/use-spot-report.ts'),
      /new Worker\(new URL\('\.\/spot-worker\.ts', import\.meta\.url\)/u,
    );
    assert.match(read('../src/lib/csp.ts'), /worker-src 'self'/u);
  });

  it('marks the three places the guided tour points at', () => {
    const editor = read('../src/components/SpotEditor.tsx');
    for (const mark of ['data-tour="hand-board"', 'data-tour="run"', 'data-tour="result"']) {
      assert.ok(editor.includes(mark), mark);
    }
  });
});

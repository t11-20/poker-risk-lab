/**
 * Tests for the card decoder.
 *
 * `src/cards.ts` re-derives the engine's integer encoding rather than importing it (see
 * the comment there for why the UI must not link against `@prl/poker-engine`). This test
 * file is the contract that makes that duplication safe: it checks all 52 cards against
 * an expectation written independently of the implementation, from the encoding as it is
 * documented in `packages/poker-engine/src/cards.ts`:
 *
 *   card = rankIndex * 4 + suitIndex
 *   rankIndex 0..12 -> 2 3 4 5 6 7 8 9 T J Q K A
 *   suitIndex 0..3  -> c d h s
 *
 * If the engine ever changes that, these assertions fail rather than the UI silently
 * printing the wrong card — which is the only failure mode that would matter here and
 * also the only one impossible to spot by eye.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeCard, isCardValue, listCardNames, parseCardText, SUIT_KEYS } from '../src/cards.ts';

/** Independently written expectations, in the engine's documented order. */
const RANK_FACES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_SHORT = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_WORDS = [
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'jack',
  'queen',
  'king',
  'ace',
];
const SUIT_LETTERS = ['c', 'd', 'h', 's'];
const SUIT_WORDS = ['clubs', 'diamonds', 'hearts', 'spades'];
const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'];

describe('isCardValue', () => {
  it('accepts exactly the integers 0..51', () => {
    assert.equal(isCardValue(0), true);
    assert.equal(isCardValue(51), true);
    assert.equal(isCardValue(-1), false);
    assert.equal(isCardValue(52), false);
    assert.equal(isCardValue(1.5), false);
    assert.equal(isCardValue(Number.NaN), false);
  });

  it('rejects anything that is not a number', () => {
    for (const value of ['0', null, undefined, {}, [], true]) {
      assert.equal(isCardValue(value), false);
    }
  });
});

describe('describeCard', () => {
  it('decodes all 52 cards exactly as the engine encodes them', () => {
    for (let rankIndex = 0; rankIndex < 13; rankIndex++) {
      for (let suitIndex = 0; suitIndex < 4; suitIndex++) {
        const card = rankIndex * 4 + suitIndex;
        const described = describeCard(card);
        assert.ok(described !== null, `card ${card} should decode`);
        assert.equal(described.card, card);
        assert.equal(described.face, RANK_FACES[rankIndex]);
        assert.equal(described.short, `${RANK_SHORT[rankIndex]}${SUIT_LETTERS[suitIndex]}`);
        assert.equal(described.suitKey, SUIT_KEYS[suitIndex]);
        assert.equal(described.suitLetter, SUIT_LETTERS[suitIndex]);
        assert.equal(described.suitSymbol, SUIT_SYMBOLS[suitIndex]);
        assert.equal(described.accessibleName, `${RANK_WORDS[rankIndex]} of ${SUIT_WORDS[suitIndex]}`);
      }
    }
  });

  it('produces the example from the brief', () => {
    // Ace of hearts: rank index 12, suit index 2 -> 12 * 4 + 2 = 50.
    const described = describeCard(50);
    assert.ok(described !== null);
    assert.equal(described.accessibleName, 'ace of hearts');
    assert.equal(described.short, 'Ah');
    assert.equal(described.face, 'A');
  });

  it('gives every card a distinct accessible name and short form', () => {
    const names = new Set<string>();
    const shorts = new Set<string>();
    for (let card = 0; card < 52; card++) {
      const described = describeCard(card);
      assert.ok(described !== null);
      names.add(described.accessibleName);
      shorts.add(described.short);
    }
    assert.equal(names.size, 52);
    assert.equal(shorts.size, 52);
  });

  it('pairs every suit with a letter, so colour is never the only cue', () => {
    const letters = new Set<string>();
    const symbols = new Set<string>();
    for (let suitIndex = 0; suitIndex < 4; suitIndex++) {
      const described = describeCard(suitIndex);
      assert.ok(described !== null);
      letters.add(described.suitLetter);
      symbols.add(described.suitSymbol);
    }
    assert.equal(letters.size, 4, 'four distinct suit letters');
    assert.equal(symbols.size, 4, 'four distinct suit symbols');
  });

  it('returns null instead of throwing for a value that is not a card', () => {
    for (const value of [-1, 52, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(describeCard(value), null);
    }
  });
});

describe('parseCardText', () => {
  it('round-trips every card through its short form', () => {
    for (let card = 0; card < 52; card++) {
      const described = describeCard(card);
      assert.ok(described !== null);
      assert.equal(parseCardText(described.short), card);
    }
  });

  it('accepts lower case and the 10 alias', () => {
    assert.equal(parseCardText('ah'), parseCardText('Ah'));
    assert.equal(parseCardText('10d'), parseCardText('Td'));
    assert.equal(parseCardText(' Qs '), parseCardText('Qs'));
  });

  it('accepts an upper-case suit letter', () => {
    assert.equal(parseCardText('AH'), parseCardText('Ah'));
  });

  it('returns null for anything unparseable', () => {
    for (const text of ['', 'A', 'Ax', 'Zh', '11d', 'hearts', '  ']) {
      assert.equal(parseCardText(text), null, `expected null for "${text}"`);
    }
  });
});

describe('listCardNames', () => {
  it('reads a hand as a sentence', () => {
    // Qh = 10 * 4 + 2 = 42, 7h = 5 * 4 + 2 = 22, 2c = 0.
    assert.equal(listCardNames([42, 22, 0]), 'queen of hearts, seven of hearts and two of clubs');
  });

  it('handles zero, one and two cards', () => {
    assert.equal(listCardNames([]), 'no cards');
    assert.equal(listCardNames([50]), 'ace of hearts');
    assert.equal(listCardNames([50, 51]), 'ace of hearts and ace of spades');
  });

  it('names an invalid entry rather than dropping it', () => {
    assert.equal(listCardNames([50, 99]), 'ace of hearts and unknown card');
  });
});

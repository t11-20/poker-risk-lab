/**
 * Card representation.
 *
 * A card is a single integer 0..51, encoded as `rankIndex * 4 + suitIndex`.
 *
 *   rankIndex  0..12  → 2 3 4 5 6 7 8 9 T J Q K A     (ace high; the wheel is
 *                                                      handled in the evaluator)
 *   suitIndex  0..3   → c d h s
 *
 * An integer encoding (rather than `{rank, suit}` objects) is what lets the
 * evaluator and the Monte Carlo sampler work on plain numbers with no allocation
 * per card, and lets a deck be compared, hashed and committed to as 52 bytes.
 */

/** A card as a small integer, 0..51 inclusive. */
export type Card = number;

/** A rank as an index, 0 ('2') .. 12 ('A'). */
export type RankIndex = number;

/** A suit as an index, 0 ('c') .. 3 ('s'). */
export type SuitIndex = number;

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['c', 'd', 'h', 's'] as const;

export const RANK_NAMES = [
  'deuce',
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
] as const;

export const RANK_NAMES_PLURAL = [
  'deuces',
  'threes',
  'fours',
  'fives',
  'sixes',
  'sevens',
  'eights',
  'nines',
  'tens',
  'jacks',
  'queens',
  'kings',
  'aces',
] as const;

export const SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'] as const;

export const DECK_SIZE = 52;
export const NUM_RANKS = 13;
export const NUM_SUITS = 4;

/** Raised for any malformed card, rank or suit input. */
export class CardParseError extends Error {
  override readonly name = 'CardParseError';
}

export function rankIndexOf(card: Card): RankIndex {
  return (card / 4) | 0;
}

export function suitIndexOf(card: Card): SuitIndex {
  return card & 3;
}

export function makeCard(rank: RankIndex, suit: SuitIndex): Card {
  if (!Number.isInteger(rank) || rank < 0 || rank >= NUM_RANKS) {
    throw new CardParseError(`rank index out of range: ${rank}`);
  }
  if (!Number.isInteger(suit) || suit < 0 || suit >= NUM_SUITS) {
    throw new CardParseError(`suit index out of range: ${suit}`);
  }
  return rank * 4 + suit;
}

export function isCard(value: unknown): value is Card {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < DECK_SIZE;
}

/** Throws unless `value` is a valid card id. */
export function assertCard(value: unknown, what = 'card'): Card {
  if (!isCard(value)) throw new CardParseError(`${what} is not a valid card id: ${String(value)}`);
  return value;
}

/**
 * Rank as a character. Written with an explicit bounds check rather than a bare
 * index because `noUncheckedIndexedAccess` is on: every indexed read in this
 * repo is either guarded or comes from iteration.
 */
export function rankChar(rank: RankIndex): string {
  const ch = RANKS[rank];
  if (ch === undefined) throw new CardParseError(`rank index out of range: ${rank}`);
  return ch;
}

export function suitChar(suit: SuitIndex): string {
  const ch = SUITS[suit];
  if (ch === undefined) throw new CardParseError(`suit index out of range: ${suit}`);
  return ch;
}

export function rankName(rank: RankIndex, plural = false): string {
  const table = plural ? RANK_NAMES_PLURAL : RANK_NAMES;
  const name = table[rank];
  if (name === undefined) throw new CardParseError(`rank index out of range: ${rank}`);
  return name;
}

export function suitName(suit: SuitIndex): string {
  const name = SUIT_NAMES[suit];
  if (name === undefined) throw new CardParseError(`suit index out of range: ${suit}`);
  return name;
}

/** `"Ah"` — rank uppercase, suit lowercase. */
export function cardToString(card: Card): string {
  assertCard(card);
  return `${rankChar(rankIndexOf(card))}${suitChar(suitIndexOf(card))}`;
}

export function cardsToString(cards: readonly Card[], separator = ' '): string {
  return cards.map(cardToString).join(separator);
}

const RANK_LOOKUP = new Map<string, RankIndex>();
for (const [index, ch] of RANKS.entries()) {
  RANK_LOOKUP.set(ch, index);
  RANK_LOOKUP.set(ch.toLowerCase(), index);
}
// '10' is accepted as an alias for 'T' when parsing multi-character input.
const SUIT_LOOKUP = new Map<string, SuitIndex>();
for (const [index, ch] of SUITS.entries()) {
  SUIT_LOOKUP.set(ch, index);
  SUIT_LOOKUP.set(ch.toUpperCase(), index);
}

/** Parses `"Ah"`, `"ah"`, `"10d"`. Throws `CardParseError` on anything else. */
export function parseCard(text: string): Card {
  const trimmed = text.trim();
  if (trimmed.length < 2) throw new CardParseError(`not a card: "${text}"`);
  const suitPart = trimmed.slice(-1);
  const rankPart = trimmed.slice(0, -1);
  const rank = rankPart === '10' ? 8 : RANK_LOOKUP.get(rankPart);
  const suit = SUIT_LOOKUP.get(suitPart);
  if (rank === undefined) throw new CardParseError(`unknown rank "${rankPart}" in "${text}"`);
  if (suit === undefined) throw new CardParseError(`unknown suit "${suitPart}" in "${text}"`);
  return makeCard(rank, suit);
}

/**
 * Parses a whitespace- or comma-separated list, e.g. `"Ah Kd"` or `"AhKd"`.
 * Compact input is only unambiguous because every rank is one character (with
 * `10` handled above), so the compact form is split two characters at a time.
 */
export function parseCards(text: string): Card[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const separated = trimmed.split(/[\s,]+/).filter((part) => part !== '');
  const out: Card[] = [];
  for (const token of separated) {
    if (token.length === 2 || (token.length === 3 && token.startsWith('10'))) {
      out.push(parseCard(token));
      continue;
    }
    // Compact run such as "AhKdQc" or "10h9s".
    let rest = token;
    while (rest.length > 0) {
      const width = rest.startsWith('10') ? 3 : 2;
      if (rest.length < width) throw new CardParseError(`trailing junk "${rest}" in "${text}"`);
      out.push(parseCard(rest.slice(0, width)));
      rest = rest.slice(width);
    }
  }
  return out;
}

/** True when no card appears twice. */
export function allDistinct(cards: readonly Card[]): boolean {
  let seen = 0n;
  for (const card of cards) {
    const bit = 1n << BigInt(card);
    if ((seen & bit) !== 0n) return false;
    seen |= bit;
  }
  return true;
}

/**
 * Throws if any card is invalid or duplicated. Used at every boundary where
 * cards arrive from outside the engine (content files, scenario definitions,
 * request payloads) so a malformed set can never reach the evaluator.
 */
export function assertDistinctCards(cards: readonly Card[], what = 'cards'): void {
  const seen = new Set<Card>();
  for (const card of cards) {
    assertCard(card, what);
    if (seen.has(card)) throw new CardParseError(`${what} contains ${cardToString(card)} twice`);
    seen.add(card);
  }
}

/** A fresh ordered deck, `[0, 1, ..., 51]`. Not shuffled. */
export function orderedDeck(): Card[] {
  return Array.from({ length: DECK_SIZE }, (_unused, index) => index);
}

/** 13-bit mask of the ranks present. Bit r set ⇔ some card has rank index r. */
export function rankMaskOf(cards: readonly Card[]): number {
  let mask = 0;
  for (const card of cards) mask |= 1 << rankIndexOf(card);
  return mask;
}

/** Every card in the deck except those given. Order is ascending. */
export function remainingDeck(excluded: readonly Card[]): Card[] {
  const blocked = new Set(excluded);
  const out: Card[] = [];
  for (let card = 0; card < DECK_SIZE; card++) {
    if (!blocked.has(card)) out.push(card);
  }
  return out;
}

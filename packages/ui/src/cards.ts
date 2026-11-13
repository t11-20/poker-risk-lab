/**
 * Decodes the engine's card integer (`rankIndex * 4 + suitIndex`, ranks 2..A, suits c d h s).
 * Re-derived rather than imported, because the engine graph carries the shuffler and deck secrets
 * that must never reach a browser. `test/cards.test.ts` checks all 52 cards and is the contract.
 * Ten renders as `10` (`short` keeps `T`), and two is spoken "two", not "deuce".
 */

/** An integer 0..51. */
export type CardValue = number;

export const SUIT_KEYS = ['club', 'diamond', 'heart', 'spade'] as const;
export type SuitKey = (typeof SUIT_KEYS)[number];

const DECK_SIZE = 52;
const SUIT_COUNT = 4;

const RANK_FACES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
const RANK_SHORT = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
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
] as const;

/**
 * In the engine's `c d h s` order. `letter` is the non-colour cue that separates suits for any
 * colour-vision deficiency. All four glyphs are filled so no suit looks lighter.
 */
const SUITS = [
  { key: 'club', symbol: '♣', letter: 'c', word: 'clubs' },
  { key: 'diamond', symbol: '♦', letter: 'd', word: 'diamonds' },
  { key: 'heart', symbol: '♥', letter: 'h', word: 'hearts' },
  { key: 'spade', symbol: '♠', letter: 's', word: 'spades' },
] as const;

export interface CardDescription {
  readonly card: CardValue;
  readonly face: string;
  /** `"Ah"`, the engine's compact form. */
  readonly short: string;
  readonly suitKey: SuitKey;
  readonly suitSymbol: string;
  readonly suitLetter: string;
  readonly accessibleName: string;
}

export function isCardValue(value: unknown): value is CardValue {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < DECK_SIZE;
}

/** `null` rather than a throw, because a throw in render blanks the whole table. */
export function describeCard(card: number): CardDescription | null {
  if (!isCardValue(card)) return null;
  const rankIndex = Math.floor(card / SUIT_COUNT);
  const suitIndex = card % SUIT_COUNT;
  const face = RANK_FACES[rankIndex];
  const short = RANK_SHORT[rankIndex];
  const word = RANK_WORDS[rankIndex];
  const suit = SUITS[suitIndex];
  // Always defined for 0..51, but `noUncheckedIndexedAccess` says otherwise and `!` is banned.
  if (face === undefined || short === undefined || word === undefined || suit === undefined) return null;
  return {
    card,
    face,
    short: `${short}${suit.letter}`,
    suitKey: suit.key,
    suitSymbol: suit.symbol,
    suitLetter: suit.letter,
    accessibleName: `${word} of ${suit.word}`,
  };
}

const RANK_INDEX_BY_TEXT = new Map<string, number>();
for (const [index, short] of RANK_SHORT.entries()) {
  RANK_INDEX_BY_TEXT.set(short, index);
  RANK_INDEX_BY_TEXT.set(short.toLowerCase(), index);
}
// `10` is accepted as an alias for `T`, matching the engine's parser.
RANK_INDEX_BY_TEXT.set('10', 8);

const SUIT_INDEX_BY_LETTER = new Map<string, number>();
for (const [index, suit] of SUITS.entries()) {
  SUIT_INDEX_BY_LETTER.set(suit.letter, index);
  SUIT_INDEX_BY_LETTER.set(suit.letter.toUpperCase(), index);
}

/** `CoachReport.outs` carries cards as strings. `null` on failure, so a bad one degrades to a text chip. */
export function parseCardText(text: string): CardValue | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;
  const rankIndex = RANK_INDEX_BY_TEXT.get(trimmed.slice(0, -1));
  const suitIndex = SUIT_INDEX_BY_LETTER.get(trimmed.slice(-1));
  if (rankIndex === undefined || suitIndex === undefined) return null;
  return rankIndex * SUIT_COUNT + suitIndex;
}

export function listCardNames(cards: readonly number[]): string {
  const names = cards.map((card) => describeCard(card)?.accessibleName ?? 'unknown card');
  if (names.length === 0) return 'no cards';
  if (names.length === 1) return names.join('');
  const last = names[names.length - 1] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * The one name `HandGlance` carries, so a screen reader hears hand and board as one sentence.
 * An empty board uses the table's words (`boardName` in `PokerTable.tsx`).
 */
export function handAndBoardName(hole: readonly number[], board: readonly number[]): string {
  const dealt = board.length === 0 ? 'none dealt yet' : listCardNames(board);
  return `Your cards: ${listCardNames(hole)}. Board: ${dealt}.`;
}

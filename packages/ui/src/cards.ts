/**
 * Decoding the engine's integer card encoding for display.
 *
 * ## Why this arithmetic is duplicated here
 *
 * `@prl/poker-engine/src/cards.ts` owns the encoding: a card is
 * `rankIndex * 4 + suitIndex`, ranks `0..12` = 2..A, suits `0..3` = c d h s. The
 * obvious move would be to import `cardToString`, `rankName` and `suitName` from
 * there. This package deliberately does not:
 *
 *  - `@prl/ui` depends on `@prl/contracts` and `@prl/poker-math` only. Adding a
 *    dependency is release-blocking in this repo, and Biome's
 *    `noUndeclaredDependencies` would reject the import outright.
 *  - The engine module graph contains the shuffler, the deck commitment and
 *    `HandState` — the secrets that must never reach a browser. Linking the whole
 *    engine into the client bundle so that a `<span>` can print "Ah" would put all
 *    of that one careless import away from shipping.
 *
 * So four lines of arithmetic and three lookup tables are re-derived here, on
 * purpose, and `test/cards.test.ts` checks all 52 cards against an independently
 * written expectation. That test is the contract: if the engine ever changes the
 * encoding, it fails.
 *
 * ## Where this deliberately differs from the engine
 *
 *  - Ten renders as `10`, not `T`. `T` is a compact wire form; a learner reading a
 *    card face expects `10`. `describeCard().short` still gives the engine's form.
 *  - Two is spoken as "two", not "deuce". The spoken form is an accessible name, and
 *    "deuce of clubs" is jargon that a beginner has to translate.
 */

/** A card as the engine encodes it: an integer 0..51. */
export type CardValue = number;

export const SUIT_KEYS = ['club', 'diamond', 'heart', 'spade'] as const;
export type SuitKey = (typeof SUIT_KEYS)[number];

const DECK_SIZE = 52;
const SUIT_COUNT = 4;

/** Display forms, indexed by rank index 0..12. */
const RANK_FACES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
/** The engine's compact forms, indexed the same way. */
const RANK_SHORT = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
/** Spoken forms for accessible names. */
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
 * Suit presentation, indexed by suit index 0..3 in the engine's `c d h s` order.
 *
 * `letter` is the redundant, non-colour cue that makes the four suits separable with
 * any colour-vision deficiency — see the note on `.prl-card__suit-letter`. The filled
 * glyphs are used for all four suits so no suit is visually lighter than another.
 */
const SUITS = [
  { key: 'club', symbol: '♣', letter: 'c', word: 'clubs' },
  { key: 'diamond', symbol: '♦', letter: 'd', word: 'diamonds' },
  { key: 'heart', symbol: '♥', letter: 'h', word: 'hearts' },
  { key: 'spade', symbol: '♠', letter: 's', word: 'spades' },
] as const;

export interface CardDescription {
  readonly card: CardValue;
  /** `"10"`, `"A"` — what goes in the card's corner. */
  readonly face: string;
  /** `"Ah"` — the engine's compact form, for copy-paste and range strings. */
  readonly short: string;
  readonly suitKey: SuitKey;
  readonly suitSymbol: string;
  readonly suitLetter: string;
  /** `"ace of hearts"` — the accessible name. */
  readonly accessibleName: string;
}

/** True for an integer in 0..51. */
export function isCardValue(value: unknown): value is CardValue {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < DECK_SIZE;
}

/**
 * Everything needed to render one card, or `null` if the value is not a card.
 *
 * Returning `null` rather than throwing is deliberate. This runs inside `render`,
 * and a throw there takes out the whole tree — a table would go blank because one
 * integer was wrong. `PlayingCard` renders a visible "unknown card" placeholder
 * instead, which is a loud failure that does not destroy the page around it.
 */
export function describeCard(card: number): CardDescription | null {
  if (!isCardValue(card)) return null;
  const rankIndex = Math.floor(card / SUIT_COUNT);
  const suitIndex = card % SUIT_COUNT;
  const face = RANK_FACES[rankIndex];
  const short = RANK_SHORT[rankIndex];
  const word = RANK_WORDS[rankIndex];
  const suit = SUITS[suitIndex];
  // Every one of these is provably defined for a value in 0..51, but
  // `noUncheckedIndexedAccess` types them as possibly undefined and a `!` is banned
  // repo-wide. The guard costs nothing and keeps the function total.
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

/**
 * Parses `"Ah"`, `"ah"`, `"10d"` back into a card integer, or `null`.
 *
 * Needed because `CoachReport.outs` carries its out cards as *strings* (they cross
 * the wire that way), and rendering them as real cards rather than a monospaced blob
 * is worth the parse. `null` on failure, again so a malformed string degrades to a
 * text chip instead of taking the panel down.
 */
export function parseCardText(text: string): CardValue | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;
  const rankIndex = RANK_INDEX_BY_TEXT.get(trimmed.slice(0, -1));
  const suitIndex = SUIT_INDEX_BY_LETTER.get(trimmed.slice(-1));
  if (rankIndex === undefined || suitIndex === undefined) return null;
  return rankIndex * SUIT_COUNT + suitIndex;
}

/** `"queen of hearts, seven of hearts and two of clubs"`, for a spoken summary. */
export function listCardNames(cards: readonly number[]): string {
  const names = cards.map((card) => describeCard(card)?.accessibleName ?? 'unknown card');
  if (names.length === 0) return 'no cards';
  if (names.length === 1) return names.join('');
  const last = names[names.length - 1] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${last}`;
}

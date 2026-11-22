/**
 * A player's own spot for the Lab editor: the cards, stacks and bets of one decision. Not a `Scenario`,
 * which is authored content with prose the validator demands; a built-in converts into this to be edited.
 *
 * Stacks are what a seat had when this street's betting began, and `bet` is what it has put in since,
 * so a bet larger than its stack is a field error and "all in" is `bet === stack`. The pot and the price
 * are derived from the seats, so no editable combination can disagree with itself.
 * Cards are the engine's integers (`rank * 4 + suit`), decoded through `@prl/ui/cards`, which carries
 * no shuffler.
 */

import { type CardValue, describeCard, parseCardText } from '@prl/ui/cards';

/** Five is `buildCoachReport`'s ceiling. */
export const MAX_OPPONENTS = 5;
/** Above the longest built-in range label (116), which an unedited copy carries as the name. */
export const MAX_NAME_LENGTH = 160;
/** Generous for any notation a person types, and above every built-in range. */
export const MAX_RANGE_LENGTH = 200;
/** A ceiling well above any stack the Lab uses, so a pasted digit run cannot reach float precision. */
export const MAX_CHIPS = 100_000_000;

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/** 0, 3, 4 or 5 cards, entered street by street. */
export type Board =
  | readonly []
  | readonly [CardValue, CardValue, CardValue]
  | readonly [CardValue, CardValue, CardValue, CardValue]
  | readonly [CardValue, CardValue, CardValue, CardValue, CardValue];

/**
 * What the analysis assumes an opponent holds. `none` is a seat still in the hand whose cards the
 * analysis does not model, as in a built-in where one of five players behind continues.
 */
export type OpponentHand =
  | { readonly kind: 'range'; readonly text: string }
  | { readonly kind: 'cards'; readonly cards: readonly [CardValue, CardValue] }
  | { readonly kind: 'none' };

export interface SpotOpponent {
  /** The label the analysis uses for this opponent. */
  readonly name: string;
  readonly stack: number;
  readonly bet: number;
  readonly hand: OpponentHand;
}

export interface SpotHero {
  readonly cards: readonly [CardValue, CardValue];
  readonly stack: number;
  /** Chips already in on this street, such as a blind. */
  readonly bet: number;
}

/** A spot whose every field has passed `validateDraft`. */
export interface Spot {
  readonly name: string;
  readonly hero: SpotHero;
  readonly board: Board;
  /** Chips in the middle before this street's bets, including anything a folded player put in. */
  readonly potBefore: number;
  readonly bigBlind: number;
  readonly opponents: readonly SpotOpponent[];
  /** The opponent continues against any bet, as some built-ins state. */
  readonly neverFolds: boolean;
  /** A fold rate for every bet and raise, 0..1, or `null` for the analysis's own reading. */
  readonly foldRate: number | null;
}

/** A spot as saved: the player's own, or an edit of the built-in scenario `from`. */
export interface SavedSpot {
  readonly id: string;
  readonly from: string | null;
  readonly updatedAt: number;
  readonly draft: SpotDraft;
}

export type CardSlotId = 'hole1' | 'hole2' | 'flop1' | 'flop2' | 'flop3' | 'turn' | 'river';

export const HERO_SLOTS = ['hole1', 'hole2'] as const satisfies readonly CardSlotId[];
export const BOARD_SLOTS = [
  'flop1',
  'flop2',
  'flop3',
  'turn',
  'river',
] as const satisfies readonly CardSlotId[];
export const CARD_SLOTS: readonly CardSlotId[] = [...HERO_SLOTS, ...BOARD_SLOTS];

export const SLOT_LABELS: Readonly<Record<CardSlotId, string>> = {
  hole1: 'Hole 1',
  hole2: 'Hole 2',
  flop1: 'Flop 1',
  flop2: 'Flop 2',
  flop3: 'Flop 3',
  turn: 'Turn',
  river: 'River',
};

export type HandKind = OpponentHand['kind'];

/**
 * What the editor holds while a person types: amounts as text so "12a" can sit in a field beside its
 * error, and cards that may be missing. `validateDraft` is the only way from here to a `Spot`.
 */
export interface OpponentDraft {
  /** Stable across edits, for React keys and slot ids. Never shown. */
  readonly key: string;
  readonly name: string;
  readonly stack: string;
  readonly bet: string;
  readonly handKind: HandKind;
  readonly range: string;
  readonly cards: readonly [CardValue | null, CardValue | null];
}

export interface SpotDraft {
  readonly name: string;
  readonly cards: Readonly<Record<CardSlotId, CardValue | null>>;
  readonly heroStack: string;
  readonly heroBet: string;
  readonly potBefore: string;
  readonly bigBlind: string;
  readonly opponents: readonly OpponentDraft[];
  readonly neverFolds: boolean;
  /** A percentage as typed, or blank. */
  readonly foldRate: string;
}

export const EMPTY_CARDS: Readonly<Record<CardSlotId, CardValue | null>> = {
  hole1: null,
  hole2: null,
  flop1: null,
  flop2: null,
  flop3: null,
  turn: null,
  river: null,
};

/** A plain notation, because `top:NN` costs seconds the first time a page builds its ordering. */
export const DEFAULT_RANGE = '22+, A2s+, A8o+, K9s+, KTo+, QTs+, QJo, JTs';

export function blankOpponent(key: string, index: number): OpponentDraft {
  return {
    key,
    name: `Opponent ${index + 1}`,
    stack: '1000',
    bet: '0',
    handKind: 'range',
    range: DEFAULT_RANGE,
    cards: [null, null],
  };
}

export function blankDraft(): SpotDraft {
  return {
    name: 'New spot',
    cards: EMPTY_CARDS,
    heroStack: '1000',
    heroBet: '0',
    potBefore: '30',
    bigBlind: '20',
    opponents: [blankOpponent('o1', 0)],
    neverFolds: false,
    foldRate: '',
  };
}

export interface TablePrice {
  /** Every chip in the middle before hero acts. */
  readonly pot: number;
  /** What hero adds to call: the gap to the largest bet, never more than hero has behind. */
  readonly toCall: number;
  /** The part of `pot` hero can win: from each bet, only what hero's total can match. */
  readonly winnable: number;
  /** Calling uses every chip hero has behind. */
  readonly allIn: boolean;
}

/**
 * The one reading of the seats both the price line and the analysis use. Capped as the engine's
 * `amountToCall` caps it, because an uncapped call priced 500 against a stack of 100.
 */
export function tablePrice(seats: {
  readonly potBefore: number;
  readonly heroStack: number;
  readonly heroBet: number;
  readonly bets: readonly number[];
}): TablePrice {
  const { potBefore, heroStack, heroBet, bets } = seats;
  const behind = heroStack - heroBet;
  const toCall = Math.max(0, Math.min(Math.max(0, ...bets) - heroBet, behind));
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  return {
    pot: potBefore + heroBet + sum(bets),
    toCall,
    winnable: potBefore + heroBet + sum(bets.map((bet) => Math.min(bet, heroStack))),
    allIn: toCall > 0 && toCall === behind,
  };
}

export function streetOf(board: Board): Street {
  return board.length === 0 ? 'preflop' : board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river';
}

/** The opponent slot ids the picker uses for an exact hand. */
export function opponentSlotIds(key: string): readonly [string, string] {
  return [`opp-${key}-1`, `opp-${key}-2`];
}

/**
 * Cards written as content writes them, `"Ah Kd"` or `"AhKd"`, or `null` when any token is not a card.
 * The engine's `parseCards` accepts the same forms; `test/lab-spot-convert.test.ts` holds them equal.
 */
export function cardsFromText(text: string): CardValue[] | null {
  const out: CardValue[] = [];
  for (const token of text.trim().split(/[\s,]+/u)) {
    if (token === '') continue;
    let rest = token;
    while (rest.length > 0) {
      const width = rest.startsWith('10') ? 3 : 2;
      if (rest.length < width) return null;
      const card = parseCardText(rest.slice(0, width));
      if (card === null) return null;
      out.push(card);
      rest = rest.slice(width);
    }
  }
  return out;
}

/** `"Ah"`, the compact form storage keeps. */
export function cardToText(card: CardValue): string {
  return describeCard(card)?.short ?? '??';
}

export function cardName(card: CardValue): string {
  return describeCard(card)?.accessibleName ?? 'an unknown card';
}

export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

/** `crypto.getRandomValues`, never the engine's shuffler, which must stay out of the browser. */
export function fillRandom(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  crypto.getRandomValues(bytes);
  return bytes;
}

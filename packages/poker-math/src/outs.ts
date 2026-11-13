/**
 * Classifies every card that can come next as a clean out, a dirty out or neither, against the
 * opponent's range, with hero's equity once it lands and a sentence saying why.
 * clean is equityAfter >= cleanThreshold (0.90), dirty is >= aheadThreshold (0.50), neutral is below.
 * The thresholds are a modelling choice, so they are parameters and every result names them.
 * Only the next card counts as an out. Equity is exact. At most 990 combos x 44 boards = 43,560 units,
 * far under `equity()`'s 4,000,000 budget, and any sampled call is still named in `assumptions`.
 * A hand already in front has no outs count, so the result carries `refusal` and its sentences stop
 * saying "outs". `totalOuts` stays clean + dirty, because zero would read as drawing dead.
 */

import {
  type Card,
  cardsToString,
  cardToString,
  categoryOf,
  DECK_SIZE,
  describeScore,
  evaluate,
  HAND_CATEGORY,
  HAND_CATEGORY_NAMES,
  type HandCategory,
  type HandScore,
  isCard,
  remainingDeck,
} from '@prl/poker-engine';
import { type EquitySpec, equity } from './equity.ts';
import { type Combo, comboCountOf, comboToString, exactRange, type ParsedRange } from './ranges.ts';

export class OutsError extends Error {
  override readonly name = 'OutsError';
}

export type OutClassification = 'clean' | 'dirty' | 'neutral';

/**
 * Why this result carries no outs count. Modelled on `RuleOfThumbRefusal` in `coach.ts`.
 * One member today, written as a union so a second reason is an additive change.
 */
export type OutsCountRefusal = {
  readonly kind: 'already-ahead';
  /** Hero's equity before any card arrives, the figure that cleared the bar. */
  readonly equityNow: number;
  /** The equity a card has to reach to count as an out at all. */
  readonly threshold: number;
};

/**
 * The one definition of "this spot has no outs to count". It uses the same `aheadThreshold` a card
 * is judged by, because two bars let the panel say 100% to win and 45 outs at once.
 */
export function outsCountRefusalFor(equityNow: number, aheadThreshold: number): OutsCountRefusal | null {
  if (equityNow >= aheadThreshold) return { kind: 'already-ahead', equityNow, threshold: aheadThreshold };
  return null;
}

export interface CardOutcome {
  readonly card: Card;
  /** The card as a player would write it, e.g. "Th". */
  readonly label: string;
  readonly classification: OutClassification;
  /** Hero's equity once this card lands, 0..1. */
  readonly equityAfter: number;
  /** Hero's equity on the current board. The same for every card in one result. */
  readonly equityBefore: number;
  /** Why it is clean, dirty or neutral, in plain language. */
  readonly note: string;
}

export interface OutsResult {
  readonly clean: readonly CardOutcome[];
  readonly dirty: readonly CardOutcome[];
  readonly neutral: readonly CardOutcome[];
  readonly cleanCount: number;
  readonly dirtyCount: number;
  /** `cleanCount + dirtyCount`. A number of outs only while `refusal` is null. */
  readonly totalOuts: number;
  /** Why the counts above are not outs, or `null` when they are. */
  readonly refusal: OutsCountRefusal | null;
  readonly equityNow: number;
  /** Candidate cards actually evaluated. */
  readonly cardsConsidered: number;
  readonly explanation: string;
  readonly assumptions: readonly string[];
  readonly method: 'exact-per-card';
}

export interface OutsInput {
  /** Exactly 2 cards. */
  readonly heroCards: readonly Card[];
  /** 3 cards (flop) or 4 cards (turn). */
  readonly board: readonly Card[];
  /** A single known hand or a whole range. The counts depend on which. */
  readonly opponent: ParsedRange;
  readonly deadCards?: readonly Card[];
  /** Equity at or above this makes a card clean. Default 0.90. */
  readonly cleanThreshold?: number;
  /** Equity at or above this makes a card an out at all. Default 0.50. */
  readonly aheadThreshold?: number;
}

export const DEFAULT_CLEAN_THRESHOLD = 0.9;
export const DEFAULT_AHEAD_THRESHOLD = 0.5;

/** Tolerance for the "did this card help the range" comparison of two fractions. */
const SHARE_EPSILON = 1e-9;

function formatPercent(value: number): string {
  // One decimal below 10% so a 4-out draw does not render as a flat "9%".
  const digits = value > 0 && value < 0.1 ? 1 : 0;
  return `${(value * 100).toFixed(digits)}%`;
}

function pluralCombos(count: number): string {
  return count === 1 ? '1 combination' : `${count} combinations`;
}

/** True for the categories English wants an article in front of, "a flush" but "two pair". */
function takesArticle(category: HandCategory): boolean {
  switch (category) {
    case HAND_CATEGORY.pair:
    case HAND_CATEGORY.straight:
    case HAND_CATEGORY.flush:
    case HAND_CATEGORY.fullHouse:
    case HAND_CATEGORY.straightFlush:
      return true;
    default:
      return false;
  }
}

function categoryLabel(category: HandCategory): string {
  const name = HAND_CATEGORY_NAMES[category];
  if (name === undefined) throw new OutsError(`unknown hand category ${category}`);
  return takesArticle(category) ? `a ${name}` : name;
}

/** "a flush, ace high" or "two pair, sixes and fives". */
function handPhrase(score: HandScore): string {
  const text = describeScore(score);
  return takesArticle(categoryOf(score)) ? `a ${text}` : text;
}

/** What can still beat a made hand of this category, for the run-down warning on a flop card. */
function whatStillBeats(category: HandCategory): string {
  switch (category) {
    case HAND_CATEGORY.highCard:
      return 'any pair and up';
    case HAND_CATEGORY.pair:
      return 'a bigger pair, two pair and up';
    case HAND_CATEGORY.twoPair:
      return 'a bigger two pair, a set and up';
    case HAND_CATEGORY.threeOfAKind:
      return 'a bigger set, a straight and up';
    case HAND_CATEGORY.straight:
      return 'a bigger straight, a flush and up';
    case HAND_CATEGORY.flush:
      return 'a bigger flush, a full house and up';
    case HAND_CATEGORY.fullHouse:
      return 'a bigger full house, four of a kind and up';
    case HAND_CATEGORY.fourOfAKind:
      return 'a bigger four of a kind or a straight flush';
    default:
      return 'a bigger straight flush';
  }
}

function capitalise(text: string): string {
  const first = text.slice(0, 1);
  return `${first.toUpperCase()}${text.slice(1)}`;
}

/** The combinations of `combos` that none of `blocked` makes impossible. */
function legalCombos(combos: readonly Combo[], blocked: readonly Card[]): Combo[] {
  const seen = new Set<Card>(blocked);
  return combos.filter((combo) => !seen.has(combo[0]) && !seen.has(combo[1]));
}

interface CategoryCount {
  readonly category: HandCategory;
  readonly combos: number;
}

/**
 * How the opponent's possible hands compare to hero's on one board at that moment. On four cards
 * this differs from equity, which is what makes a dirty out dirty.
 */
interface Standing {
  readonly combos: number;
  readonly heroScore: HandScore;
  readonly heroCategory: HandCategory;
  readonly heroPhrase: string;
  readonly ahead: number;
  readonly tied: number;
  readonly behind: number;
  /** The categories those beating combinations make, strongest first. */
  readonly beaters: readonly CategoryCount[];
  /** Set only when the range has collapsed to one combination. */
  readonly soleOpponent: { readonly label: string; readonly phrase: string } | null;
}

function standingAt(heroCards: readonly Card[], board: readonly Card[], combos: readonly Combo[]): Standing {
  const heroScore = evaluate([...heroCards, ...board]);
  const byCategory = new Map<HandCategory, number>();
  let ahead = 0;
  let tied = 0;
  let behind = 0;
  let soleOpponent: Standing['soleOpponent'] = null;

  for (const combo of combos) {
    const score = evaluate([combo[0], combo[1], ...board]);
    if (combos.length === 1) {
      soleOpponent = { label: comboToString(combo), phrase: handPhrase(score) };
    }
    if (score > heroScore) {
      behind += 1;
      const category = categoryOf(score);
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    } else if (score === heroScore) {
      tied += 1;
    } else {
      ahead += 1;
    }
  }

  const beaters = [...byCategory.entries()]
    .map(([category, count]): CategoryCount => ({ category, combos: count }))
    .sort((left, right) => right.category - left.category);

  return {
    combos: combos.length,
    heroScore,
    heroCategory: categoryOf(heroScore),
    heroPhrase: handPhrase(heroScore),
    ahead,
    tied,
    behind,
    beaters,
    soleOpponent,
  };
}

/** "2 make a full house, 1 makes a flush". */
function describeBeaters(beaters: readonly CategoryCount[]): string {
  return beaters
    .map(
      (entry) => `${entry.combos} ${entry.combos === 1 ? 'makes' : 'make'} ${categoryLabel(entry.category)}`,
    )
    .join(', ');
}

/** Only a category change gets "gives you", so a kicker upgrade does not make a dead card sound useful. */
function heroHandClause(before: Standing, after: Standing): string {
  if (after.heroCategory > before.heroCategory) return `gives you ${after.heroPhrase}`;
  return `leaves you with ${after.heroPhrase}`;
}

function soleOpponentClause(after: Standing, sole: NonNullable<Standing['soleOpponent']>): string {
  if (after.behind > 0) return `but ${sole.label} has ${sole.phrase}, which is better`;
  if (after.tied > 0) return `and ${sole.label} has the same hand, so the pot chops`;
  return `and beats ${sole.label}, which has ${sole.phrase}`;
}

function rangeClause(after: Standing): string {
  if (after.behind === after.combos) {
    return `but every one of the ${after.combos} combinations the range can still hold beats it (${describeBeaters(after.beaters)})`;
  }
  if (after.behind > 0) {
    return (
      `but ${after.behind} of the ${after.combos} combinations the range can still hold ` +
      `${after.behind === 1 ? 'beats' : 'beat'} it (${describeBeaters(after.beaters)})`
    );
  }
  if (after.tied > 0) {
    return `and beats ${after.ahead} of ${after.combos} combinations, chopping with the other ${after.tied}`;
  }
  return `and beats all ${pluralCombos(after.combos)} the range can still hold`;
}

function riskSentence(after: Standing, equityAfter: number, boardComplete: boolean): string | null {
  if (boardComplete) return null;
  if (equityAfter >= 1) return 'No river card can change that';
  if (after.behind > 0) return null;
  return `With the river still to come, ${whatStillBeats(after.heroCategory)} can still get there`;
}

/** Stated only when the card raised the share of the range that beats hero, the counterfeit case. */
function rangeHelpSentence(before: Standing, after: Standing): string | null {
  const shareBefore = before.combos === 0 ? 0 : before.behind / before.combos;
  const shareAfter = after.combos === 0 ? 0 : after.behind / after.combos;
  if (shareAfter <= shareBefore + SHARE_EPSILON) return null;
  if (after.combos === 1 && before.combos === 1) {
    return 'They were behind before this card, so this card is what flipped it';
  }
  return (
    'This card helps the opponent too: it takes the part of the range that beats you from ' +
    `${before.behind} of ${before.combos} combinations to ${after.behind} of ${after.combos}`
  );
}

function buildNote(args: {
  readonly before: Standing;
  readonly after: Standing;
  readonly equityAfter: number;
  readonly boardComplete: boolean;
}): string {
  const { before, after, equityAfter, boardComplete } = args;
  const sole = after.soleOpponent;
  const comparison = sole === null ? rangeClause(after) : soleOpponentClause(after, sole);
  const sentences = [capitalise(`${heroHandClause(before, after)}, ${comparison}`)];

  const help = rangeHelpSentence(before, after);
  if (help !== null) sentences.push(help);
  const risk = riskSentence(after, equityAfter, boardComplete);
  if (risk !== null) sentences.push(risk);
  sentences.push(`Your equity after this card is ${formatPercent(equityAfter)}`);

  return `${sentences.join('. ')}.`;
}

interface ValidatedInput {
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly deadCards: readonly Card[];
  readonly opponent: ParsedRange;
  readonly cleanThreshold: number;
  readonly aheadThreshold: number;
}

function assertCards(cards: readonly Card[], what: string): void {
  for (const card of cards) {
    if (!isCard(card)) {
      throw new OutsError(
        `${what} contains ${String(card)}, which is not a card id (expected an integer 0..51)`,
      );
    }
  }
}

function assertThreshold(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new OutsError(`${name} must be a fraction between 0 and 1, received ${String(value)}`);
  }
}

function validateInput(input: OutsInput): ValidatedInput {
  if (input.heroCards.length !== 2) {
    throw new OutsError(`computeOuts needs exactly 2 hero cards, received ${input.heroCards.length}`);
  }
  if (input.board.length !== 3 && input.board.length !== 4) {
    throw new OutsError(
      `computeOuts needs a flop (3 cards) or a turn (4 cards), received ${input.board.length}: ` +
        'with 5 cards there is no card left to come and no out to count, and with fewer than 3 ' +
        'there is no made hand to compare against',
    );
  }
  const deadCards = input.deadCards ?? [];
  assertCards(input.heroCards, "hero's hand");
  assertCards(input.board, 'the board');
  assertCards(deadCards, 'the dead cards');

  const seen = new Set<Card>();
  for (const card of [...input.heroCards, ...input.board, ...deadCards]) {
    if (seen.has(card)) {
      throw new OutsError(
        `${cardToString(card)} appears twice across hero's hand, the board and the dead cards`,
      );
    }
    seen.add(card);
  }

  const cleanThreshold = input.cleanThreshold ?? DEFAULT_CLEAN_THRESHOLD;
  const aheadThreshold = input.aheadThreshold ?? DEFAULT_AHEAD_THRESHOLD;
  assertThreshold(cleanThreshold, 'cleanThreshold');
  assertThreshold(aheadThreshold, 'aheadThreshold');
  if (aheadThreshold > cleanThreshold) {
    throw new OutsError(
      `aheadThreshold (${aheadThreshold}) must not exceed cleanThreshold (${cleanThreshold}): ` +
        'a card cannot need more equity to be an out than it needs to be a clean one',
    );
  }

  if (input.opponent.combos.length === 0) {
    throw new OutsError(
      `the opponent range "${input.opponent.notation}" holds no combinations, so there is nothing to ` +
        'compute outs against',
    );
  }

  // Reachable only with absurd dead cards, but it keeps the failure an OutsError, not an EquityError.
  const unseen = DECK_SIZE - input.heroCards.length - input.board.length - deadCards.length;
  if (unseen < 4) {
    throw new OutsError(
      `only ${unseen} cards are unseen after hero's hand, the board and ${deadCards.length} dead cards, ` +
        'which is not enough for a card to come, an opponent hand and a run-out (at least 4 are needed)',
    );
  }

  return {
    heroCards: input.heroCards,
    board: input.board,
    deadCards,
    opponent: input.opponent,
    cleanThreshold,
    aheadThreshold,
  };
}

interface HeroEquity {
  readonly value: number;
  readonly exact: boolean;
}

function heroEquityOn(
  heroRange: ParsedRange,
  opponent: ParsedRange,
  board: readonly Card[],
  deadCards: readonly Card[],
): HeroEquity {
  const spec: EquitySpec = {
    players: [
      { label: 'you', range: heroRange },
      { label: 'the opponent', range: opponent },
    ],
    board,
    deadCards,
  };
  const result = equity(spec);
  const hero = result.players[0];
  if (hero === undefined) throw new OutsError('the equity calculation returned no players');
  return { value: hero.equity, exact: result.method === 'exact-enumeration' };
}

function classify(equityAfter: number, cleanThreshold: number, aheadThreshold: number): OutClassification {
  if (equityAfter >= cleanThreshold) return 'clean';
  if (equityAfter >= aheadThreshold) return 'dirty';
  return 'neutral';
}

/** Best cards first, then by card id, so a result is stable. */
function byStrengthThenCard(left: CardOutcome, right: CardOutcome): number {
  if (right.equityAfter !== left.equityAfter) return right.equityAfter - left.equityAfter;
  return left.card - right.card;
}

function describeOpponent(opponent: ParsedRange, legal: readonly Combo[]): string {
  const sole = legal.length === 1 ? legal[0] : undefined;
  if (sole !== undefined) return `exactly ${comboToString(sole)}`;
  return `"${opponent.notation}" (${pluralCombos(legal.length)} still possible)`;
}

/**
 * The sentence that explains the refusal. It must return non-null for exactly the spots
 * `outsCountRefusalFor` refuses, `equityNow >= aheadThreshold`.
 */
function alreadyAheadNote(equityNow: number, cleanThreshold: number, aheadThreshold: number): string | null {
  if (equityNow >= cleanThreshold) {
    return (
      'You are already at or above the clean threshold before any card arrives, so this is not a drawing ' +
      'spot: the counts are cards that keep you in front, not cards that rescue the hand'
    );
  }
  if (equityNow >= aheadThreshold) {
    return (
      'You are already in front before any card arrives — your equity now is above the same threshold a ' +
      'card has to clear to count as an out — so read the counts as cards that keep you ahead rather than ' +
      'as the size of a draw'
    );
  }
  return null;
}

/** Refused, it still states both counts and says in the same sentence that neither is a number of outs. */
function countSentence(args: {
  readonly cleanCount: number;
  readonly dirtyCount: number;
  readonly cardsConsidered: number;
  readonly refusal: OutsCountRefusal | null;
}): string {
  // Verbs and nouns agree with their counts. "1 are clean ... 1 outs" reached 9 of 36 Lab scenarios.
  const total = args.cleanCount + args.dirtyCount;
  const preamble =
    `Of the ${args.cardsConsidered} cards that can come next, ${args.cleanCount} ` +
    `${args.cleanCount === 1 ? 'is' : 'are'} clean and ${args.dirtyCount} ` +
    `${args.dirtyCount === 1 ? 'is' : 'are'} dirty`;
  if (args.refusal === null) {
    return `${preamble}, which is ${total} ${total === 1 ? 'out' : 'outs'} in total`;
  }
  return (
    `${preamble} — but none of them is an out and there is no outs count here, deliberately: an out is ` +
    'a card that rescues a hand that is behind, and yours is not behind'
  );
}

function buildExplanation(args: {
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly opponentText: string;
  readonly standingNow: Standing;
  readonly equityNow: number;
  readonly cleanCount: number;
  readonly dirtyCount: number;
  readonly cardsConsidered: number;
  readonly cleanThreshold: number;
  readonly aheadThreshold: number;
  readonly refusal: OutsCountRefusal | null;
}): string {
  const sentences = [
    `On ${cardsToString(args.board)} you hold ${cardsToString(args.heroCards)} — ` +
      `${args.standingNow.heroPhrase} — for ${formatPercent(args.equityNow)} equity against ${args.opponentText}`,
    countSentence({
      cleanCount: args.cleanCount,
      dirtyCount: args.dirtyCount,
      cardsConsidered: args.cardsConsidered,
      refusal: args.refusal,
    }),
    `Clean means your equity after that card is at least ${formatPercent(args.cleanThreshold)}; dirty ` +
      `means at least ${formatPercent(args.aheadThreshold)} but below ${formatPercent(args.cleanThreshold)}`,
  ];
  const ahead = alreadyAheadNote(args.equityNow, args.cleanThreshold, args.aheadThreshold);
  if (ahead !== null) sentences.push(ahead);
  return `${sentences.join('. ')}.`;
}

function soleComboLabel(legal: readonly Combo[]): string {
  const sole = legal[0];
  if (sole === undefined) throw new OutsError('expected one remaining combination');
  return comboToString(sole);
}

function buildAssumptions(args: {
  readonly opponent: ParsedRange;
  readonly legalNow: readonly Combo[];
  readonly opponentHeld: readonly Card[];
  readonly cardsConsidered: number;
  readonly cleanThreshold: number;
  readonly aheadThreshold: number;
  readonly equityNow: number;
  readonly skipped: readonly string[];
  readonly sampled: readonly string[];
}): string[] {
  const notes: string[] = [];
  notes.push(
    args.legalNow.length === 1
      ? `The opponent is taken to hold exactly ${soleComboLabel(args.legalNow)} — a known hand, not a range.`
      : `Every one of the ${args.legalNow.length} combinations in "${args.opponent.notation}" is treated as equally likely; a real opponent does not play every hand in a range the same way, so this is the range assumption rather than a prediction.`,
  );
  notes.push(
    `"Clean" means your equity is at least ${formatPercent(args.cleanThreshold)} after the card and "dirty" at least ${formatPercent(args.aheadThreshold)} but below that. Both thresholds are a modelling choice, not a rule of poker — move them and the counts move with them.`,
  );
  notes.push(
    'Equity after each card is computed by enumerating every remaining board exactly, so there is no sampling error in these figures.',
  );
  notes.push(
    'The hand is assumed to run to the river with no further betting: these are card facts, not the value of the spot, and they say nothing about how much either player would bet.',
  );
  notes.push(
    'Only the next single card counts as an out. A draw that needs both the turn and the river is not counted here, though the equity figures do account for the river.',
  );
  // Counted from the notation's classes, because `parseRange` may already have removed blockers.
  const declared = comboCountOf(args.opponent);
  const blocked = declared - args.legalNow.length;
  if (args.legalNow.length > 1 && blocked > 0) {
    notes.push(
      `The opponent cannot hold a card you can see, so ${blocked} of the ${declared} combinations in "${args.opponent.notation}" are removed as blocked, leaving ${args.legalNow.length}.`,
    );
  }
  if (args.opponentHeld.length > 0) {
    notes.push(
      `The two cards the opponent is assumed to hold cannot come off the deck either, which is why ${args.cardsConsidered} cards are considered rather than ${args.cardsConsidered + 2}.`,
    );
  }
  if (args.skipped.length > 0) {
    const cards = args.skipped.length === 1 ? 'card' : 'cards';
    notes.push(
      `${args.skipped.length} ${cards} (${args.skipped.join(', ')}) ${args.skipped.length === 1 ? 'is' : 'are'} left out of the count because the opponent's range cannot exist behind ${args.skipped.length === 1 ? 'it' : 'them'}: every combination the range has left uses that card.`,
    );
  }
  if (args.sampled.length > 0) {
    const cards = args.sampled.length === 1 ? 'case' : 'cases';
    notes.push(
      `${args.sampled.length} ${cards} (${args.sampled.join(', ')}) came back sampled rather than enumerated, so ${args.sampled.length === 1 ? 'that equity carries' : 'those equities carry'} sampling error — treat those classifications as provisional.`,
    );
  }
  const ahead = alreadyAheadNote(args.equityNow, args.cleanThreshold, args.aheadThreshold);
  if (ahead !== null) notes.push(`${ahead}.`);
  return notes;
}

/** Pure and deterministic. Every figure comes from full enumeration. */
export function computeOuts(input: OutsInput): OutsResult {
  const checked = validateInput(input);
  const { heroCards, board, deadCards, opponent, cleanThreshold, aheadThreshold } = checked;

  const known: Card[] = [...heroCards, ...board, ...deadCards];
  const legalNow = legalCombos(opponent.combos, known);
  if (legalNow.length === 0) {
    throw new OutsError(
      `every combination in the opponent range "${opponent.notation}" uses a card hero can see, so the ` +
        'opponent cannot hold any hand in it — widen the range or check the dead cards',
    );
  }

  // A range down to one combination is a known hand, so its two cards cannot come off the deck.
  const sole = legalNow.length === 1 ? legalNow[0] : undefined;
  const opponentHeld: Card[] = sole === undefined ? [] : [sole[0], sole[1]];

  const heroRange = exactRange(heroCards);
  const nowEquity = heroEquityOn(heroRange, opponent, board, deadCards);
  const standingNow = standingAt(heroCards, board, legalNow);
  const boardCompleteAfter = board.length === 4;

  const outcomes: CardOutcome[] = [];
  const skipped: string[] = [];
  const sampled: string[] = [];
  if (!nowEquity.exact) sampled.push('the current board');

  for (const card of remainingDeck([...known, ...opponentHeld])) {
    const legalAfter = legalCombos(opponent.combos, [...known, card]);
    if (legalAfter.length === 0) {
      // Every hand the range can hold uses this card, so the card and the range cannot both be true.
      skipped.push(cardToString(card));
      continue;
    }
    const boardAfter = [...board, card];
    const after = heroEquityOn(heroRange, opponent, boardAfter, deadCards);
    if (!after.exact) sampled.push(cardToString(card));
    const standingAfter = standingAt(heroCards, boardAfter, legalAfter);
    outcomes.push({
      card,
      label: cardToString(card),
      classification: classify(after.value, cleanThreshold, aheadThreshold),
      equityAfter: after.value,
      equityBefore: nowEquity.value,
      note: buildNote({
        before: standingNow,
        after: standingAfter,
        equityAfter: after.value,
        boardComplete: boardCompleteAfter,
      }),
    });
  }

  const sorted = [...outcomes].sort(byStrengthThenCard);
  const clean = sorted.filter((outcome) => outcome.classification === 'clean');
  const dirty = sorted.filter((outcome) => outcome.classification === 'dirty');
  const neutral = sorted.filter((outcome) => outcome.classification === 'neutral');

  // Decided once and carried on the result, so no consumer re-tests the equity against another bar.
  const refusal = outsCountRefusalFor(nowEquity.value, aheadThreshold);

  const explanation = buildExplanation({
    heroCards,
    board,
    opponentText: describeOpponent(opponent, legalNow),
    standingNow,
    equityNow: nowEquity.value,
    cleanCount: clean.length,
    dirtyCount: dirty.length,
    cardsConsidered: outcomes.length,
    cleanThreshold,
    aheadThreshold,
    refusal,
  });

  return {
    clean,
    dirty,
    neutral,
    cleanCount: clean.length,
    dirtyCount: dirty.length,
    totalOuts: clean.length + dirty.length,
    refusal,
    equityNow: nowEquity.value,
    cardsConsidered: outcomes.length,
    explanation,
    assumptions: buildAssumptions({
      opponent,
      legalNow,
      opponentHeld,
      cardsConsidered: outcomes.length,
      cleanThreshold,
      aheadThreshold,
      equityNow: nowEquity.value,
      skipped,
      sampled,
    }),
    method: 'exact-per-card',
  };
}

/**
 * The flat shape the Coach renders. `refusal` travels with the counts because flattening is where
 * "these are not outs" gets lost, so check it before printing `total` beside the word "outs".
 */
export function outsSummaryFor(result: OutsResult): {
  clean: number;
  dirty: number;
  total: number;
  refusal: OutsCountRefusal | null;
  cleanCards: string[];
  dirtyCards: string[];
  explanation: string;
} {
  return {
    clean: result.cleanCount,
    dirty: result.dirtyCount,
    total: result.totalOuts,
    refusal: result.refusal,
    cleanCards: result.clean.map((outcome) => outcome.label),
    dirtyCards: result.dirty.map((outcome) => outcome.label),
    explanation: result.explanation,
  };
}

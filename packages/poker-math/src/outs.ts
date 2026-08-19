/**
 * Outs: which cards actually rescue a hand, and which ones only look like they do.
 *
 * ## The thing most material gets wrong
 *
 * "You have nine outs to the flush." That sentence is true about the *deck* and
 * often false about the *hand*. Nine cards complete the flush; how many of them win
 * depends entirely on what the opponent can hold. Put hero's nut flush draw against
 * a set and every one of those nine cards leaves the opponent live to a full house.
 * Put two of hero's flush cards where they also complete a straight for part of the
 * opponent's range and those two are not outs in the same sense as the other seven.
 * Counting all nine as if they were identical is how a learner ends up calling a
 * price the situation does not offer: the pot-odds arithmetic is fine, the input to
 * it was a fiction.
 *
 * So this module never returns a single number. Every candidate card is evaluated
 * individually against the opponent's range, and comes back with hero's equity once
 * it lands plus a sentence saying why it is or is not good enough.
 *
 * ## The definitions, exactly as implemented
 *
 * For each card `c` still available — not in hero's hand, not on the board, not in
 * `deadCards`, and (when the opponent's range has collapsed to a single possible
 * combination) not one of the two cards the opponent is then known to hold:
 *
 *   equityBefore  hero's equity on the current board, before any card arrives.
 *   equityAfter(c) hero's equity with `c` appended to the board.
 *
 *   clean    equityAfter(c) >= cleanThreshold   (default 0.90)
 *   dirty    aheadThreshold <= equityAfter(c) < cleanThreshold  (default 0.50)
 *   neutral  equityAfter(c) < aheadThreshold — not an out at all
 *
 *   totalOuts = cleanCount + dirtyCount
 *
 * A clean out does not merely put hero in front, it puts hero in front and keeps
 * hero there. A dirty out puts hero in front but leaves a way to lose: either the
 * remaining card can run hero down, or the same card improved part of the opponent's
 * range too.
 *
 * ## The thresholds are a modelling choice, not a law
 *
 * There is no rule of poker that says 90%. The pair (0.90, 0.50) is a convention
 * chosen here because it separates "in front and safe" from "in front and sweating"
 * in a way that matches how players talk. They are function parameters precisely so
 * that nobody mistakes them for facts: raise `cleanThreshold` to 0.95 and cards that
 * were clean become dirty without a single card changing. Every result says which
 * thresholds produced it, in `assumptions`.
 *
 * ## Why the equity numbers here are exact
 *
 * `equity()` picks exact enumeration when the work fits its budget and bounded Monte
 * Carlo otherwise. At the sizes this module produces it always picks exact, and that
 * is arithmetic rather than hope. Two players, and a board of four or five cards:
 *
 *   - board of 4 → one card to come → C(44, 1) = 44 boards per matchup;
 *   - board of 5 → nothing to come → 1 board per matchup;
 *   - at most C(45, 2) = 990 legal combinations for the opponent.
 *
 * The worst case is 990 x 44 = 43,560 units of work against a default budget of
 * 4,000,000. The method returned by every call is still checked rather than assumed,
 * and any call that somehow came back sampled is named in `assumptions` — a figure
 * that quietly changed method is exactly the kind of thing this app exists to stop.
 *
 * ## One card at a time
 *
 * Only the immediate next card is considered. A backdoor draw needing both the turn
 * and the river is not an out here, because it is not a card, it is a pair of cards
 * — and folding "backdoor outs" into the same count is another way the number gets
 * inflated. On a flop, `equityAfter` does account for the river; it just does not
 * count river-only improvements as outs.
 *
 * ## When hero is already in front, this result HAS NO OUTS COUNT
 *
 * An out is a card that rescues a hand that is behind. Hero who is already in front is
 * not behind, so no card rescues anything and there is no count to report — however
 * many cards happen to clear the thresholds. Applied to a made hand the definitions
 * above degenerate: on a flop with two pair against a range, every one of the 47
 * unseen cards leaves hero at or above `aheadThreshold`, and the module used to
 * publish that as "47 outs in total" while the app's own lesson — *Outs: Clean, Dirty
 * and Imaginary* — teaches the standard meaning. A learner saw a textbook 15 on a real
 * draw and a nonsensical 47 one spot later, from the same panel.
 *
 * So `computeOuts` refuses, the way `coach.ts` already refuses the rule of 2 and 4
 * (`already-ahead` / `no-clean-outs` / `not-a-probability`): the result carries a typed
 * `refusal`, and every sentence it generates stops calling the counts outs. What the
 * counts still are is worth reading and is still reported — `cleanCount` cards leave
 * hero at or above `cleanThreshold`, `dirtyCount` leave hero in front but beatable —
 * they are simply cards that KEEP hero ahead rather than the size of a draw, and the
 * explanation says so in those words.
 *
 * `totalOuts` deliberately stays `cleanCount + dirtyCount` rather than going null or
 * zero. Zero would read as "drawing dead", which is the opposite of the truth here, and
 * a null would only move the decision to whichever consumer forgot to handle it. The
 * number is honest arithmetic on the classifications; `refusal` is what says the word
 * "outs" does not apply to it. Consumers that print the word must check it — `coach.ts`
 * does, in the explanation, the teaching notes and the suggestion, and `@prl/ui`'s
 * `CoachPanel` refuses the same headline independently at the render boundary.
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
 * Why this result carries no outs count, or `null` when it carries one.
 *
 * Modelled on `RuleOfThumbRefusal` in `coach.ts`, and for the same reason: a shortcut
 * that has stopped meaning anything should say which of its own preconditions failed,
 * not return a number and hope the caveat underneath is read. "An out is a card that
 * rescues a hand that is behind" has exactly one precondition — that hero is behind —
 * so this union has exactly one member. It is written as a union anyway so that adding
 * a second reason later is an additive change rather than a shape change at every call
 * site.
 *
 * A discriminated `kind` rather than a boolean because the *reason* is what the reader
 * needs. `refusal !== null` tells a consumer to stop saying "outs"; `refusal.kind` tells
 * it what to say instead.
 */
export type OutsCountRefusal = {
  readonly kind: 'already-ahead';
  /** Hero's equity before any card arrives — the figure that cleared the bar. */
  readonly equityNow: number;
  /** The bar: the equity a card has to reach to count as an out at all. */
  readonly threshold: number;
};

/**
 * The one definition of "this spot has no outs to count", so nothing re-derives it.
 *
 * Deliberately the SAME yardstick a card is judged by. A card counts as an out once it
 * puts hero at or above `aheadThreshold`; a hand already there does not need one. Using
 * two different bars for the two halves is how the panel ended up saying a hand was
 * 100% to win and had 45 outs at the same time — see the note above
 * `ruleOfThumbRefusalFor`, which now asks this same question through `OutsResult.refusal`.
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
  /**
   * `cleanCount + dirtyCount`. Neutral cards are not outs.
   *
   * **An outs count only while `refusal` is null.** When hero is already in front this is
   * still the honest sum of the two classifications, and it is still not a number of
   * outs — see the file comment. Anything that prints it beside the word "outs" has to
   * check `refusal` first.
   */
  readonly totalOuts: number;
  /**
   * Why the counts above are not outs, or `null` when they are.
   *
   * Read this before the numbers, not after them. The counts are always computed; this
   * is what says whether the word "outs" may be attached to them.
   */
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
  /** A single known hand or a whole range — the counts depend on which. */
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

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function formatPercent(value: number): string {
  // One decimal below 10% so a 4-out draw does not render as a flat "9%".
  const digits = value > 0 && value < 0.1 ? 1 : 0;
  return `${(value * 100).toFixed(digits)}%`;
}

function pluralCombos(count: number): string {
  return count === 1 ? '1 combination' : `${count} combinations`;
}

/**
 * True for the categories English wants an article in front of: "a flush" but
 * "two pair". Used by both the category names and the full hand descriptions so
 * generated notes read like a sentence someone would say out loud.
 */
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

/**
 * The hand named the way a player would say it, e.g. "a flush, ace high" or
 * "two pair, sixes and fives".
 */
function handPhrase(score: HandScore): string {
  const text = describeScore(score);
  return takesArticle(categoryOf(score)) ? `a ${text}` : text;
}

/**
 * What can still beat a made hand of this category, as a noun phrase.
 *
 * Used for the run-down warning on a flop card, where hero can be ahead of the whole
 * range and still lose to the river. Naming the shape of the danger teaches more
 * than a bare probability does.
 */
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

// ---------------------------------------------------------------------------
// Where hero stands on a given board
// ---------------------------------------------------------------------------

interface CategoryCount {
  readonly category: HandCategory;
  readonly combos: number;
}

/**
 * Hero's made hand on one board, and how the opponent's possible hands compare to it
 * *at that moment*.
 *
 * On a five-card board this is the showdown. On a four-card board it is "who is
 * ahead with one card to come", which is a different question from equity and is
 * exactly what makes a dirty out dirty: hero can be ahead of every combination in
 * the range and still be a long way from safe.
 */
interface Standing {
  readonly combos: number;
  readonly heroScore: HandScore;
  readonly heroCategory: HandCategory;
  /** Hero's hand as a phrase, e.g. "a flush, ace high". */
  readonly heroPhrase: string;
  /** Combinations hero's hand currently beats. */
  readonly ahead: number;
  readonly tied: number;
  /** Combinations that currently beat hero. */
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

/** "2 make a full house, 1 makes a flush" — what is beating hero, by shape. */
function describeBeaters(beaters: readonly CategoryCount[]): string {
  return beaters
    .map(
      (entry) => `${entry.combos} ${entry.combos === 1 ? 'makes' : 'make'} ${categoryLabel(entry.category)}`,
    )
    .join(', ');
}

// ---------------------------------------------------------------------------
// The note: why this card is clean, dirty or neutral
// ---------------------------------------------------------------------------

/**
 * A category change is the only improvement worth a verb. A kicker moving up inside
 * the same category is real but rarely relevant, and calling it an improvement makes
 * a dead card sound like progress, so those cards get the neutral wording.
 */
function heroHandClause(before: Standing, after: Standing): string {
  if (after.heroCategory > before.heroCategory) return `makes hero ${after.heroPhrase}`;
  return `leaves hero with ${after.heroPhrase}`;
}

/** How the opponent's one known hand compares. Only used when the range is a hand. */
function soleOpponentClause(after: Standing, sole: NonNullable<Standing['soleOpponent']>): string {
  if (after.behind > 0) return `but ${sole.label} has ${sole.phrase}, which is better`;
  if (after.tied > 0) return `and ${sole.label} has the same hand, so the pot chops`;
  return `and beats ${sole.label}, which has ${sole.phrase}`;
}

/** How a multi-combination range compares. */
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

/**
 * The sentence about the card still to come. Only meaningful when the board is not
 * yet complete: on the river there is nothing left to run hero down.
 */
function riskSentence(after: Standing, equityAfter: number, boardComplete: boolean): string | null {
  if (boardComplete) return null;
  if (equityAfter >= 1) return 'No river card can change that';
  if (after.behind > 0) return null;
  return `With the river still to come, ${whatStillBeats(after.heroCategory)} can still get there`;
}

/**
 * Stated only when the card measurably improved the opponent's side of it — the
 * counterfeit case, and the reason a card that helps hero can still be a bad card.
 */
function rangeHelpSentence(before: Standing, after: Standing): string | null {
  const shareBefore = before.combos === 0 ? 0 : before.behind / before.combos;
  const shareAfter = after.combos === 0 ? 0 : after.behind / after.combos;
  if (shareAfter <= shareBefore + SHARE_EPSILON) return null;
  if (after.combos === 1 && before.combos === 1) {
    return 'They were behind before this card, so this card is what flipped it';
  }
  return (
    'This card helps the opponent too: it takes the part of the range that beats hero from ' +
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
  sentences.push(`Hero's equity after this card is ${formatPercent(equityAfter)}`);

  return `${sentences.join('. ')}.`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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

  // Enough of the deck has to be left for a candidate card, the opponent's two cards
  // and the run-out. Only reachable with an absurd number of dead cards, but checking
  // it here keeps every failure an OutsError rather than letting an EquityError about
  // empty enumerations surface from two layers down.
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

// ---------------------------------------------------------------------------
// Equity, with the method checked rather than assumed
// ---------------------------------------------------------------------------

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
      { label: 'hero', range: heroRange },
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

/** Best cards first, then by card id, so a result is stable and displayable as-is. */
function byStrengthThenCard(left: CardOutcome, right: CardOutcome): number {
  if (right.equityAfter !== left.equityAfter) return right.equityAfter - left.equityAfter;
  return left.card - right.card;
}

// ---------------------------------------------------------------------------
// Explanation and assumptions
// ---------------------------------------------------------------------------

function describeOpponent(opponent: ParsedRange, legal: readonly Combo[]): string {
  const sole = legal.length === 1 ? legal[0] : undefined;
  if (sole !== undefined) return `exactly ${comboToString(sole)}`;
  return `"${opponent.notation}" (${pluralCombos(legal.length)} still possible)`;
}

/**
 * Outs are a concept for a hand that is behind. When hero is already in front the
 * definitions still classify every card, and the counts are still literally correct,
 * but reading "38 clean outs" as a draw would be a serious misunderstanding — so a
 * result computed for a hand that is already ahead says so in as many words. Graded,
 * because "already ahead of the clean threshold" and "ahead but not safe" are
 * different situations and deserve different sentences.
 *
 * This returns a sentence for exactly the spots `outsCountRefusalFor` refuses — both
 * ask `equityNow >= aheadThreshold`, the higher branch being a sharper case of the
 * same thing. The two must stay in step: this is the paragraph that explains the
 * refusal, and a refusal with no explanation, or an explanation with no refusal, would
 * be half the fix.
 */
function alreadyAheadNote(equityNow: number, cleanThreshold: number, aheadThreshold: number): string | null {
  if (equityNow >= cleanThreshold) {
    return (
      'Hero is already at or above the clean threshold before any card arrives, so this is not a drawing ' +
      'spot: the counts are cards that keep hero in front, not cards that rescue the hand'
    );
  }
  if (equityNow >= aheadThreshold) {
    return (
      'Hero is already in front before any card arrives — equity now is above the same threshold a card ' +
      'has to clear to count as an out — so read the counts as cards that keep hero ahead rather than ' +
      'as the size of a draw'
    );
  }
  return null;
}

/**
 * The sentence carrying the two counts.
 *
 * The whole point of the refusal lives in this one string. It used to read "…which is 47
 * outs in total" whatever the spot was, and 47 is every unseen card: a headline number
 * that contradicted the lesson naming it. Refused, it states the same two counts — they
 * are real and they are informative — and says in the same breath that neither is a
 * number of outs, so a reader who stops at this sentence has still not been misled.
 */
function countSentence(args: {
  readonly cleanCount: number;
  readonly dirtyCount: number;
  readonly cardsConsidered: number;
  readonly refusal: OutsCountRefusal | null;
}): string {
  const preamble =
    `Of the ${args.cardsConsidered} cards that can come next, ${args.cleanCount} are clean and ` +
    `${args.dirtyCount} are dirty`;
  if (args.refusal === null) {
    return `${preamble}, which is ${args.cleanCount + args.dirtyCount} outs in total`;
  }
  return (
    `${preamble} — but none of them is an out and there is no outs count here, deliberately: an out is ` +
    'a card that rescues a hand that is behind, and hero is not behind'
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
    `On ${cardsToString(args.board)} hero holds ${cardsToString(args.heroCards)} — ` +
      `${args.standingNow.heroPhrase} — for ${formatPercent(args.equityNow)} equity against ${args.opponentText}`,
    countSentence({
      cleanCount: args.cleanCount,
      dirtyCount: args.dirtyCount,
      cardsConsidered: args.cardsConsidered,
      refusal: args.refusal,
    }),
    `Clean means hero's equity after that card is at least ${formatPercent(args.cleanThreshold)}; dirty ` +
      `means at least ${formatPercent(args.aheadThreshold)} but below ${formatPercent(args.cleanThreshold)}`,
  ];
  // The honest paragraph that was already here, kept. It is the sentence that explains
  // WHY the counts are what they are; the refusal above is what stops the headline
  // number contradicting it.
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
    `"Clean" means hero equity of at least ${formatPercent(args.cleanThreshold)} after the card and "dirty" at least ${formatPercent(args.aheadThreshold)} but below that. Both thresholds are a modelling choice, not a rule of poker — move them and the counts move with them.`,
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
  // Counted from the range's CLASSES rather than from the combinations handed in,
  // because `parseRange` may already have removed blockers before the range reached
  // this function. Counting what is left against what the notation names is the only
  // way to state the blocker effect regardless of who applied it — and the blocker
  // effect is the single most commonly dropped step in range arithmetic.
  const declared = comboCountOf(args.opponent);
  const blocked = declared - args.legalNow.length;
  if (args.legalNow.length > 1 && blocked > 0) {
    notes.push(
      `The opponent cannot hold a card hero can see, so ${blocked} of the ${declared} combinations in "${args.opponent.notation}" are removed as blocked, leaving ${args.legalNow.length}.`,
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

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Classifies every card that can come next as a clean out, a dirty out or neither.
 *
 * Pure and deterministic: same input, same output, byte for byte. There is no
 * randomness anywhere in here — every figure comes from full enumeration.
 */
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

  // A range with exactly one possible combination *is* a known hand, however it was
  // written. Those two cards are then behind the opponent rather than in the deck,
  // so they are not candidates to come. Getting this wrong shifts every denominator.
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
      // Every hand the range can hold uses this card, so the card and the range
      // cannot both be true. Counting it either way would be a claim about a
      // situation that does not exist.
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

  // Decided once, from the same threshold every card was judged against, and then
  // carried on the result. Every sentence below and every consumer downstream asks this
  // one value rather than re-testing the equity, so there is no second place for the two
  // definitions of "drawing" to drift apart.
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
 * The shape the Coach renders. Deliberately flat and plain: the Coach shows the two
 * counts, the two card lists and one sentence, and never a bare "outs" number
 * without the split behind it.
 *
 * `refusal` travels with the counts rather than being left behind on the full result,
 * because this is the flattened shape a display layer reaches for and the flattening is
 * exactly where "these are not outs" gets lost. A caller that renders `total` beside the
 * word "outs" without consulting `refusal` is reintroducing the defect this field exists
 * to close.
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
